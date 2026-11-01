// The ONE real retention run of the hosted least-privilege test (doc 16 section 4 step 3), run by the
// rebuilt staging runner action `retention-run` while connected AS recruiter_maintenance.
//
// What makes "deletes only aged fixture rows" provable: the retention rules delete EVERY aged row in
// the five ledgers, so the run is refused unless the ONLY aged rows are the fixtures seeded by
// supabase/staging/rebuild/install-retention-fixtures.sql. Before the first delete (everything read-only):
//   1. the dry-run least-privilege checks all pass (catalogue-wide, retention-dry-run.ts);
//   2. each rule would delete exactly ONE row, and exactly one tagged aged fixture exists per ledger
//      (so every row the rules would delete is a fixture), plus one tagged fresh control per ledger;
//   3. each ledger's total row count is recorded.
// After the real run: each rule deleted exactly one row, nothing is left to delete, no tagged aged row is
// left, every fresh control survives, and every ledger shrank by exactly one row. Any miss is a refusal.
// Output carries counts and fixed names only: no row data, no connection details.

import { RETENTION_RULES, runRetention, type RetentionResult } from './retention.js';
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
  /** True once the delete statements were sent: a failure after this point cannot be rolled back. */
  deletesSent: boolean;
}

interface TableCounts { total: number; aged: number; fresh: number }

async function tableCounts(client: DryRunClient, table: string): Promise<TableCounts> {
  const column = FIXTURE_KEY_COLUMN[table]!;
  const row = (await client.query(
    `select count(*)::int as total, count(*) filter (where ${column} = $1)::int as aged, count(*) filter (where ${column} = $2)::int as fresh from ${table}`,
    [AGED, FRESH],
  )).rows[0];
  return { total: Number(row?.total ?? -1), aged: Number(row?.aged ?? -1), fresh: Number(row?.fresh ?? -1) };
}

async function snapshot(client: DryRunClient): Promise<{ wouldDelete: Record<string, number>; tables: Record<string, TableCounts> }> {
  await client.query('begin read only');
  try {
    await client.query("set local statement_timeout = '30s'");
    const wouldDelete: Record<string, number> = {};
    const tables: Record<string, TableCounts> = {};
    for (const rule of RETENTION_RULES) {
      wouldDelete[rule.name] = Number((await client.query(`select count(*)::int as n from ${rule.table} where ${rule.where}`)).rows[0]?.n ?? -1);
      tables[rule.table] = await tableCounts(client, rule.table);
    }
    return { wouldDelete, tables };
  } finally {
    await client.query('rollback');
  }
}

/** Run the least-privilege checks, then the fixture-bounded real delete. `deleteRun` is injectable for tests. */
export async function runRetentionFixtureRun(
  client: DryRunClient & { query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }> },
  expectedRole: string,
  deleteRun: (db: { query(sql: string, params?: unknown[]): Promise<{ rowCount: number | null }> }) => Promise<RetentionResult> = runRetention,
): Promise<RetentionRunReport> {
  const report: RetentionRunReport = { ok: false, failed: [], deleted: {}, deletesSent: false };
  const refuse = (name: string): RetentionRunReport => { report.failed.push(name); return report; };

  const dry = await runRetentionDryRun(client, expectedRole);
  if (!dry.ok) return refuse('least_privilege_checks_failed');

  const before = await snapshot(client);
  for (const rule of RETENTION_RULES) {
    if (before.wouldDelete[rule.name] !== 1) return refuse('each_rule_must_match_exactly_one_row');
    const t = before.tables[rule.table]!;
    if (t.aged !== 1) return refuse('aged_fixture_missing_or_duplicated');
    if (t.fresh !== 1) return refuse('fresh_control_missing_or_duplicated');
  }

  report.deletesSent = true;
  const result = await deleteRun(client as unknown as { query(sql: string, params?: unknown[]): Promise<{ rowCount: number | null }> });
  report.deleted = result.deleted;
  if (result.failed.length > 0) report.failed.push('a_retention_rule_failed');
  for (const rule of RETENTION_RULES) {
    if (result.deleted[rule.name] !== 1) report.failed.push('each_rule_must_delete_exactly_one_row');
  }

  const after = await snapshot(client);
  for (const rule of RETENTION_RULES) {
    const b = before.tables[rule.table]!;
    const a = after.tables[rule.table]!;
    if (after.wouldDelete[rule.name] !== 0) report.failed.push('aged_rows_remain');
    if (a.aged !== 0) report.failed.push('aged_fixture_not_deleted');
    if (a.fresh !== 1) report.failed.push('fresh_control_missing_after');
    if (a.total !== b.total - 1) report.failed.push('ledger_did_not_shrink_by_exactly_one');
  }
  report.failed = [...new Set(report.failed)];
  report.ok = report.failed.length === 0;
  return report;
}
