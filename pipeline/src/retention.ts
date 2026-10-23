// Sign-in ledger retention (Quote-Queue scripts/retention.ts windows; own code). Runs as the
// least-privilege `recruiter_maintenance` role, as a step in the existing nightly pipeline job
// (doc 15 §23, doc 16 §4). Written against a minimal query interface; the pipeline hook
// (retention-step.ts) supplies a `pg` client for that role. Moved here from app/server/scripts
// so the pipeline package can run it.
//
// Windows: request buckets and recovery failures 48 hours; links and sessions 30 days after
// they ended; email events 180 days. Events outlive links: email_events.link_id is
// ON DELETE SET NULL and each event keeps its own recipient and message-id snapshot, so
// deleting an aged link never fails on the foreign key and never deletes delivery evidence
// early.

export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rowCount: number | null }>;
}

export interface RetentionRule {
  name: string;
  table: string;
  /** Rows to delete. Uses clock_timestamp() so a long run cannot use a stale time. */
  where: string;
}

export const RETENTION_RULES: readonly RetentionRule[] = [
  { name: 'request_buckets', table: 'internal.auth_request_buckets', where: "window_start < clock_timestamp() - interval '48 hours'" },
  { name: 'recovery_failures', table: 'internal.recovery_failures', where: "at < clock_timestamp() - interval '48 hours'" },
  { name: 'email_events', table: 'internal.email_events', where: "received_at < clock_timestamp() - interval '180 days'" },
  {
    name: 'signin_links',
    table: 'internal.signin_links',
    where: "coalesce(used_at, revoked_at, expires_at) < clock_timestamp() - interval '30 days'",
  },
  {
    name: 'app_sessions',
    table: 'internal.app_sessions',
    where: "least(coalesce(revoked_at, 'infinity'::timestamptz), expires_at) < clock_timestamp() - interval '30 days'",
  },
];

export interface RetentionResult {
  deleted: Record<string, number>;
  failed: string[];
}

/**
 * Deletes in bounded batches, one rule at a time. A failing rule is recorded and the others
 * still run; the caller logs counts only and never fails the pipeline because of retention.
 */
export async function runRetention(
  db: Queryable,
  options: { batchSize?: number; maxBatchesPerRule?: number } = {},
): Promise<RetentionResult> {
  const batchSize = options.batchSize ?? 5_000;
  const maxBatches = options.maxBatchesPerRule ?? 200;
  const result: RetentionResult = { deleted: {}, failed: [] };
  await db.query("set statement_timeout = '30s'");
  for (const rule of RETENTION_RULES) {
    let total = 0;
    try {
      for (let batch = 0; batch < maxBatches; batch++) {
        const { rowCount } = await db.query(
          `delete from ${rule.table} where ctid in (select ctid from ${rule.table} where ${rule.where} limit $1)`,
          [batchSize],
        );
        const n = rowCount ?? 0;
        total += n;
        if (n < batchSize) break;
      }
      result.deleted[rule.name] = total;
    } catch {
      result.deleted[rule.name] = total;
      result.failed.push(rule.name);
    }
  }
  return result;
}
