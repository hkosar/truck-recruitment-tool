// A3 LOCAL test of the retention step's database side (doc 16 §4 step 3, local half): runs the
// real retention rules as the real `recruiter_maintenance` login against a task-owned throwaway
// database built by scripts/a3-build-test-db.mjs (M1 applied), and proves that role's least
// privilege. Skipped unless RETENTION_A3_ADMIN_URL and RETENTION_A3_MAINT_URL are set; both must
// be LOOPBACK URLs (refused otherwise). Run: npx tsx src/retention-a3.test.ts
// The hosted half (staging, through the pooler) is the separately approved test in doc 16 §4.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { runRetention } from './retention.js';

const ADMIN = process.env.RETENTION_A3_ADMIN_URL;
const MAINT = process.env.RETENTION_A3_MAINT_URL;
const MANAGER = '71000000-0000-4000-8000-000000000001';

function loopback(raw: string): string {
  const u = new URL(raw);
  if (u.search || u.hash) throw new Error('refusing: a test URL must not carry a query string or fragment');
  if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') throw new Error('refusing: test URLs must be loopback');
  return raw;
}

async function denied(p: Promise<unknown>, what: string): Promise<void> {
  await p.then(
    () => assert.fail(`${what}: expected permission denied`),
    (err: { code?: string }) => assert.equal(err.code, '42501', `${what}: expected SQLSTATE 42501, got ${err.code}`),
  );
}

async function main(): Promise<void> {
  if (!ADMIN || !MAINT) {
    console.log('skip retention A3 test (set RETENTION_A3_ADMIN_URL and RETENTION_A3_MAINT_URL, loopback only)');
    return;
  }
  const admin = new pg.Client({ connectionString: loopback(ADMIN) });
  const maint = new pg.Client({ connectionString: loopback(MAINT) });
  await admin.connect();
  await maint.connect();
  const tag = `ra3-${randomBytes(6).toString('hex')}`;
  try {
    assert.equal((await maint.query('select current_user as u')).rows[0].u, 'recruiter_maintenance');

    // Aged rows (past every window) and fresh rows (inside every window), all tagged.
    await admin.query(`insert into internal.auth_request_buckets (dimension, key_hash, window_start, count) values
      ('ip', $1 || '-old', now() - interval '3 days', 1), ('ip', $1 || '-new', now(), 1)`, [tag]);
    await admin.query(`insert into internal.recovery_failures (email_hash, at) values ($1 || '-old', now() - interval '3 days'), ($1 || '-new', now())`, [tag]);
    await admin.query(`insert into internal.signin_links (user_id, token_hash, recipient_email, created_at, expires_at) values
      ($2, $1 || '-old', 'ra3@example.invalid', now() - interval '40 days', now() - interval '40 days' + interval '15 minutes'),
      ($2, $1 || '-new', 'ra3@example.invalid', now(), now() + interval '15 minutes')`, [tag, MANAGER]);
    await admin.query(`insert into internal.app_sessions (user_id, token_hash, kind, email_at_issue, created_at, last_seen_at, idle_window, expires_at, absolute_expires_at) values
      ($2, $1 || '-old', 'link', 'ra3@example.invalid', now() - interval '200 days', now() - interval '200 days', interval '30 days', now() - interval '170 days', now() - interval '110 days'),
      ($2, $1 || '-new', 'link', 'ra3@example.invalid', now(), now(), interval '30 days', now() + interval '30 days', now() + interval '90 days')`, [tag, MANAGER]);
    await admin.query(`insert into internal.email_events (provider_event_id, recipient_email, event_type, occurred_at, received_at) values
      ($1 || '-old', 'ra3@example.invalid', 'delivered', now() - interval '200 days', now() - interval '200 days'),
      ($1 || '-new', 'ra3@example.invalid', 'delivered', now(), now())`, [tag]);

    const result = await runRetention(maint);
    assert.deepEqual(result.failed, [], 'no rule failed');
    const left = async (sql: string) => (await admin.query(sql, [`${tag}-old`, `${tag}-new`])).rows[0] as { old: number; fresh: number };
    for (const [name, sql] of [
      ['request_buckets', `select count(*) filter (where key_hash = $1)::int as old, count(*) filter (where key_hash = $2)::int as fresh from internal.auth_request_buckets`],
      ['recovery_failures', `select count(*) filter (where email_hash = $1)::int as old, count(*) filter (where email_hash = $2)::int as fresh from internal.recovery_failures`],
      ['signin_links', `select count(*) filter (where token_hash = $1)::int as old, count(*) filter (where token_hash = $2)::int as fresh from internal.signin_links`],
      ['app_sessions', `select count(*) filter (where token_hash = $1)::int as old, count(*) filter (where token_hash = $2)::int as fresh from internal.app_sessions`],
      ['email_events', `select count(*) filter (where provider_event_id = $1)::int as old, count(*) filter (where provider_event_id = $2)::int as fresh from internal.email_events`],
    ] as const) {
      assert.deepEqual(await left(sql), { old: 0, fresh: 1 }, `${name}: aged row deleted, fresh row kept`);
      assert.ok((result.deleted[name] ?? 0) >= 1, `${name}: counted`);
    }
    console.log(`PASS retention as recruiter_maintenance deleted only aged rows (${JSON.stringify(result.deleted)})`);

    // Least privilege: nothing beyond select/delete on the five ledgers.
    await denied(maint.query('select 1 from public.profiles limit 1'), 'select profiles');
    await denied(maint.query('select 1 from public.carriers limit 1'), 'select carriers');
    await denied(maint.query(`select internal.auth_link_check('x')`), 'execute a sign-in function');
    await denied(maint.query(`update internal.signin_links set recipient_email = recipient_email where token_hash = $1`, [`${tag}-new`]), 'update a ledger');
    await denied(maint.query(`insert into internal.recovery_failures (email_hash) values ('x')`), 'insert into a ledger');
    await denied(maint.query('select 1 from internal.backout_window'), 'select another internal table');
    console.log('PASS recruiter_maintenance is refused everything outside select/delete on the five ledgers');
  } finally {
    for (const [table, col] of [['internal.auth_request_buckets', 'key_hash'], ['internal.recovery_failures', 'email_hash'], ['internal.signin_links', 'token_hash'], ['internal.app_sessions', 'token_hash'], ['internal.email_events', 'provider_event_id']]) {
      await admin.query(`delete from ${table} where ${col} like $1`, [`${tag}-%`]).catch(() => undefined);
    }
    await maint.end();
    await admin.end();
  }
}

main().catch((err: unknown) => {
  console.error('FAIL retention A3 test:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
