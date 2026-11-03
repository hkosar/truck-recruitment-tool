// The ONE real retention run of the hosted least-privilege test (doc 16 section 4 step 3), run by the
// rebuilt staging runner action `retention-run` while connected AS recruiter_maintenance.
//
// What makes "deletes only aged fixture rows" provable: the dry-run least-privilege checks pass first, then
// EVERYTHING else happens in ONE transaction on the maintenance connection:
//   1. lock the five ledgers in SHARE ROW EXCLUSIVE mode (DELETE privilege is enough), so no other session can
//      insert or change a row between the checks and the delete;
//   2. identity pre-check: per ledger, the rows the retention rule would delete are EXACTLY the one tagged aged
//      fixture (due count 1, tagged-and-due count 1, tagged aged count 1), and the tagged fresh control exists and
//      is not due; each ledger's total row count is recorded;
//   3. delete ONLY the tagged aged fixture rows (the delete filters on the exact tag, never on "whatever is due");
//   4. post-checks in the same transaction: one row deleted per ledger, nothing due is left, no tagged aged row
//      is left, every fresh control survives, every ledger shrank by exactly one row.
// COMMIT only if every check passes; any miss rolls back, so nothing is deleted. Output carries counts and
// fixed names only: no row data, no connection details.

import { RETENTION_RULES, type RetentionResult, type RetentionRule } from './retention.js';
import { runRetentionDryRun, type DryRunClient } from './retention-dry-run.js';

/** Tag prefix in every fixture key; the seed file (install-retention-fixtures.sql) uses the same literal. */
export const RETENTION_FIXTURE_TAG = 'ret-fixture-20261101';
const AGED = `${RETENTION_FIXTURE_TAG}-aged`;
const FRESH = `${RETENTION_FIXTURE_TAG}-fresh`;

/** The column that carries the fixture tag in each ledger (names are repository constants). */
export const FIXTURE_KEY_COLUMN: Readonly<Record<string, string>> = {
  'internal.auth_request_buckets': 'key_hash',
  'internal.recovery_failures': 'email_hash',
  'internal.email_events': 'provider_event_id',
  'internal.signin_links': 'token_hash',
  'internal.app_sessions': 'token_hash',
};

export interface RetentionRunReport {
  ok: boolean;
  /** Names of the failed checks; fixed strings only. */
  failed: string[];
  deleted: Record<string, number>;
  /** True once the delete statements were sent (they are rolled back unless `committed`). */
  deletesSent: boolean;
  /** True only if the transaction committed: the fixture deletes are permanent. */
  committed: boolean;
}

type RunClient = DryRunClient & { query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }> };
type DeleteRun = (db: { query(sql: string, params?: unknown[]): Promise<{ rowCount: number | null }> }) => Promise<RetentionResult>;

interface TableState { total: number; due: number; agedDue: number; aged: number; fresh: number; freshDue: number }

async function tableState(client: DryRunClient, rule: RetentionRule): Promise<TableState> {
  const column = FIXTURE_KEY_COLUMN[rule.table]!;
  const row = (await client.query(
    `select count(*)::int as total,
            count(*) filter (where ${rule.where})::int as due,
            count(*) filter (where ${column} = $1 and ${rule.where})::int as aged_due,
            count(*) filter (where ${column} = $1)::int as aged,
            count(*) filter (where ${column} = $2)::int as fresh,
            count(*) filter (where ${column} = $2 and ${rule.where})::int as fresh_due
       from ${rule.table}`,
    [AGED, FRESH],
  )).rows[0];
  const n = (v: unknown) => Number(v ?? -1);
  return { total: n(row?.total), due: n(row?.due), agedDue: n(row?.aged_due), aged: n(row?.aged), fresh: n(row?.fresh), freshDue: n(row?.fresh_due) };
}

/** Delete ONLY the exact tagged aged fixture rows, one statement per ledger. Never "whatever is due". */
export const deleteTaggedFixtures: DeleteRun = async (db) => {
  const result: RetentionResult = { deleted: {}, failed: [] };
  for (const rule of RETENTION_RULES) {
    try {
      const { rowCount } = await db.query(`delete from ${rule.table} where ${FIXTURE_KEY_COLUMN[rule.table]!} = $1`, [AGED]);
      result.deleted[rule.name] = rowCount ?? 0;
    } catch {
      result.deleted[rule.name] = 0;
      result.failed.push(rule.name);
    }
  }
  return result;
};

/**
 * Run the least-privilege checks, then the fixture-bounded real delete in one locked transaction.
 * `deleteRun` is injectable for tests (it runs inside the transaction, after the identity pre-check).
 */
export async function runRetentionFixtureRun(client: RunClient, expectedRole: string, deleteRun: DeleteRun = deleteTaggedFixtures): Promise<RetentionRunReport> {
  const report: RetentionRunReport = { ok: false, failed: [], deleted: {}, deletesSent: false, committed: false };
  const refuse = (name: string): RetentionRunReport => { report.failed.push(name); return report; };

  const dry = await runRetentionDryRun(client, expectedRole);
  if (!dry.ok) return refuse('least_privilege_checks_failed');

  let open = false;
  try {
    await client.query('begin');
    open = true;
    await client.query("set local statement_timeout = '30s'");
    await client.query("set local lock_timeout = '10s'");
    await client.query(`lock table ${RETENTION_RULES.map((r) => r.table).join(', ')} in share row exclusive mode`);

    const before: Record<string, TableState> = {};
    for (const rule of RETENTION_RULES) before[rule.table] = await tableState(client, rule);
    for (const rule of RETENTION_RULES) {
      const t = before[rule.table]!;
      if (t.due !== 1) return refuse('each_rule_must_match_exactly_one_row');
      if (t.aged !== 1) return refuse('aged_fixture_missing_or_duplicated');
      if (t.agedDue !== 1) return refuse('due_row_is_not_the_tagged_fixture');
      if (t.fresh !== 1) return refuse('fresh_control_missing_or_duplicated');
      if (t.freshDue !== 0) return refuse('fresh_control_is_due');
    }

    report.deletesSent = true;
    const result = await deleteRun(client as unknown as { query(sql: string, params?: unknown[]): Promise<{ rowCount: number | null }> });
    report.deleted = result.deleted;
    if (result.failed.length > 0) report.failed.push('a_retention_rule_failed');
    for (const rule of RETENTION_RULES) {
      if (result.deleted[rule.name] !== 1) report.failed.push('each_rule_must_delete_exactly_one_row');
    }

    if (report.failed.length === 0) {
      for (const rule of RETENTION_RULES) {
        const b = before[rule.table]!;
        const a = await tableState(client, rule);
        if (a.due !== 0) report.failed.push('aged_rows_remain');
        if (a.aged !== 0) report.failed.push('aged_fixture_not_deleted');
        if (a.fresh !== 1) report.failed.push('fresh_control_missing_after');
        if (a.total !== b.total - 1) report.failed.push('ledger_did_not_shrink_by_exactly_one');
      }
    }
    report.failed = [...new Set(report.failed)];
    if (report.failed.length > 0) return report;

    await client.query('commit');
    open = false;
    report.committed = true;
    report.ok = true;
    return report;
  } finally {
    if (open) await client.query('rollback').catch(() => undefined);
  }
}
