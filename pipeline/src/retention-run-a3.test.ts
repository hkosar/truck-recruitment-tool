// LOCAL test of the hosted retention fixture run (doc 16 section 4 step 3, approval 11) against a task-owned
// throwaway database built by scripts/a3-build-test-db.mjs (M1 applied): the seed and removal SQL files, the
// boundary refusals and the real run as the real `recruiter_maintenance` login, plus the catalogue-wide
// least-privilege checks failing when a grant is widened. Skipped unless RETENTION_A3_ADMIN_URL and
// RETENTION_A3_MAINT_URL are set; both must be LOOPBACK URLs (refused otherwise).
// Run: npx tsx src/retention-run-a3.test.ts
// It creates a minimal staging_identity.marker in the throwaway database and removes everything it made.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { RETENTION_RULES } from './retention.js';
import { runRetentionDryRun } from './retention-dry-run.js';
import { deleteTaggedFixtures, runRetentionFixtureRun } from './retention-run.js';
import { retargetSqlToRebuiltRef } from './staging-rebuilt.js';

const ADMIN = process.env.RETENTION_A3_ADMIN_URL;
const MAINT = process.env.RETENTION_A3_MAINT_URL;
const REF = 'zzzzzzzzzzzzzzzzzzzz'; // a fake ref for the throwaway database only
const ROOT = resolve(import.meta.dirname, '..', '..');
const MARKER_ID = 'a8512f81-fe47-485d-95cd-092c46e4920b';
const MANAGER = '71000000-0000-4000-8000-000000000001';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function loopback(raw: string): string {
  const u = new URL(raw);
  if (u.search || u.hash) throw new Error('refusing: a test URL must not carry a query string or fragment');
  if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') throw new Error('refusing: test URLs must be loopback');
  return raw;
}

const LEDGERS = RETENTION_RULES.map((r) => r.table);

async function main(): Promise<void> {
  if (!ADMIN || !MAINT) {
    console.log('skip retention run A3 test (set RETENTION_A3_ADMIN_URL and RETENTION_A3_MAINT_URL, loopback only)');
    return;
  }
  const admin = new pg.Client({ connectionString: loopback(ADMIN) });
  const maint = new pg.Client({ connectionString: loopback(MAINT) });
  const other = new pg.Client({ connectionString: loopback(ADMIN) }); // a second, concurrent writer session
  await admin.connect();
  await maint.connect();
  await other.connect();
  const counts = async () => { const out: Record<string, number> = {}; for (const t of LEDGERS) out[t] = Number((await admin.query(`select count(*)::int as n from ${t}`)).rows[0].n); return out; };
  const sqlFile = (rel: string) => retargetSqlToRebuiltRef(readFileSync(resolve(ROOT, rel), 'utf8'), REF, true);
  const runFile = async (rel: string, _unused: string, confirmation: string | null) => {
    const sql = sqlFile(rel);
    await admin.query(`select set_config('app.staging_runner_verified_ref', $1, false), set_config('app.staging_retention_fixtures_confirmation', $2, false)`, [REF, confirmation ?? '']);
    try { await admin.query(sql); } catch (e) { await admin.query('rollback').catch(() => undefined); throw e; }
  };
  const INSTALL = 'supabase/staging/rebuild/install-retention-fixtures.sql';
  const REMOVE = 'supabase/staging/rebuild/remove-retention-fixtures.sql';
  const strayAged = async () => admin.query(`insert into internal.recovery_failures (email_hash, at) values ('stray-aged-nonfixture', now() - interval '5 days')`);
  const strayFresh = async () => admin.query(`insert into internal.recovery_failures (email_hash, at) values ('stray-fresh-nonfixture', now())`);
  const rejects = async (p: Promise<unknown>, re: RegExp, what: string) => p.then(() => assert.fail(`${what}: expected refusal`), (e: Error) => assert.match(e.message, re, what));

  let markerMade = false;
  let testObjects = false;
  try {
    const hadMarker = (await admin.query(`select to_regclass('staging_identity.marker') as t`)).rows[0].t !== null;
    assert.equal(hadMarker, false, 'the throwaway database must not already have a staging marker');
    await admin.query(`create schema staging_identity; create table staging_identity.marker (singleton boolean primary key default true, environment text not null, marker_id uuid not null, project_ref text not null, project_name text not null default 'x', installed_at timestamptz not null default now(), installed_by text not null default current_user);
      insert into staging_identity.marker (environment, marker_id, project_ref) values ('staging', '${MARKER_ID}', '${REF}')`);
    markerMade = true;
    const baseline = await counts();

    // 1. Least privilege holds, including the catalogue-wide checks.
    const dry = await runRetentionDryRun(maint, 'recruiter_maintenance');
    assert.deepEqual(dry.checks.filter((c) => !c.ok), [], 'every dry-run check passes');
    assert.ok(dry.checks.some((c) => c.name.startsWith('delete is held on exactly the five ledgers')), 'the catalogue-wide delete check ran');

    // 2. Widened grants are caught (each is reverted straight away). The test-only objects are dropped in finally.
    const dbName = String((await admin.query('select current_database() as d')).rows[0].d);
    await admin.query(`create function public.ret_test_secdef() returns int language sql security definer as 'select 1'; revoke execute on function public.ret_test_secdef() from public;
      create schema ret_test_vault; create table ret_test_vault.decrypted_secrets (id int, note text); create sequence public.ret_test_seq`);
    testObjects = true;
    assert.equal(dry.checks.length, 25, 'the dry run has 25 checks');
    for (const [grant, revoke, expected] of [
      ['grant delete on internal.backout_window to recruiter_maintenance', 'revoke delete on internal.backout_window from recruiter_maintenance', 'delete is held on exactly the five ledgers'],
      ['grant update on internal.recovery_codes to recruiter_maintenance', 'revoke update on internal.recovery_codes from recruiter_maintenance', 'no insert, update, truncate, references or trigger privilege on any table'],
      ['grant select (id) on public.profiles to recruiter_maintenance', 'revoke select (id) on public.profiles from recruiter_maintenance', 'select is held on no table outside the five ledgers (application schemas)'],
      ['grant recruiter_api to recruiter_maintenance', 'revoke recruiter_api from recruiter_maintenance', 'member of no other role'],
      ['grant execute on function public.ret_test_secdef() to recruiter_maintenance', 'revoke execute on function public.ret_test_secdef() from recruiter_maintenance', 'no execute privilege on any non-extension function in public or internal'],
      ['grant execute on function public.ret_test_secdef() to recruiter_maintenance', 'revoke execute on function public.ret_test_secdef() from recruiter_maintenance', 'no direct execute grant on any function in any schema'],
      ['grant usage on schema ret_test_vault to recruiter_maintenance; grant select on ret_test_vault.decrypted_secrets to recruiter_maintenance', 'revoke all on ret_test_vault.decrypted_secrets from recruiter_maintenance; revoke usage on schema ret_test_vault from recruiter_maintenance', 'no direct grant of any kind on any relation, sequence or column outside the five ledgers (every schema)'],
      ['grant select (note) on ret_test_vault.decrypted_secrets to recruiter_maintenance', 'revoke all on ret_test_vault.decrypted_secrets from recruiter_maintenance', 'no direct grant of any kind on any relation, sequence or column outside the five ledgers (every schema)'],
      ['grant create on schema public to recruiter_maintenance', 'revoke create on schema public from recruiter_maintenance', 'no create privilege on any schema'],
      ['grant create on schema internal to recruiter_maintenance', 'revoke create on schema internal from recruiter_maintenance', 'no create privilege on any schema'],
      ['grant create on schema ret_test_vault to recruiter_maintenance', 'revoke create on schema ret_test_vault from recruiter_maintenance', 'no create privilege on any schema'],
      ['grant usage, update on sequence public.ret_test_seq to recruiter_maintenance', 'revoke all on sequence public.ret_test_seq from recruiter_maintenance', 'no usage, select or update privilege on any sequence'],
      [`grant create on database ${dbName} to recruiter_maintenance`, `revoke create on database ${dbName} from recruiter_maintenance`, 'no create privilege on the database'],
    ] as const) {
      await admin.query(grant);
      try {
        const widened = await runRetentionDryRun(maint, 'recruiter_maintenance');
        assert.equal(widened.ok, false, grant);
        assert.ok(widened.checks.some((c) => c.name.startsWith(expected) && !c.ok), `${grant}: caught by "${expected}"`);
      } finally {
        await admin.query(revoke);
      }
    }
    assert.equal((await runRetentionDryRun(maint, 'recruiter_maintenance')).ok, true, 'grants reverted');

    // 3. With no fixtures the run is refused before any delete.
    let r = await runRetentionFixtureRun(maint, 'recruiter_maintenance');
    assert.equal(r.ok, false);
    assert.equal(r.deletesSent, false);
    assert.ok(r.failed.includes('each_rule_must_match_exactly_one_row'));

    // 4. The seed file's gates: confirmation, and an existing aged row.
    await rejects(runFile(INSTALL, '', null), /confirmation phrase missing/, 'install without confirmation');
    await strayAged();
    await rejects(runFile(INSTALL, '', 'INSTALL TNBS RETENTION TEST FIXTURES'), /aged ledger rows already exist/, 'install with an aged non-fixture row');
    await admin.query(`delete from internal.recovery_failures where email_hash = 'stray-aged-nonfixture'`);
    assert.deepEqual(await counts(), baseline, 'a refused install changed nothing');

    // 5. Install; exactly one aged row per rule, and a second install is refused.
    await runFile(INSTALL, '', 'INSTALL TNBS RETENTION TEST FIXTURES');
    const afterInstall = await counts();
    for (const t of LEDGERS) assert.equal(afterInstall[t], baseline[t]! + 2, `${t}: one aged and one fresh fixture added`);
    const dry2 = await runRetentionDryRun(maint, 'recruiter_maintenance');
    assert.deepEqual(dry2.wouldDelete, { request_buckets: 1, recovery_failures: 1, email_events: 1, signin_links: 1, app_sessions: 1 });
    await rejects(runFile(INSTALL, '', 'INSTALL TNBS RETENTION TEST FIXTURES'), /aged ledger rows already exist|already installed/, 'second install');

    // 6. A non-fixture aged row appearing later makes the run refuse, with nothing deleted.
    await strayAged();
    r = await runRetentionFixtureRun(maint, 'recruiter_maintenance');
    assert.equal(r.ok, false);
    assert.equal(r.deletesSent, false);
    assert.ok(r.failed.includes('each_rule_must_match_exactly_one_row'));
    await admin.query(`delete from internal.recovery_failures where email_hash = 'stray-aged-nonfixture'`);
    assert.deepEqual(await counts(), afterInstall, 'the refused run deleted nothing');

    // 6b. Reviewer R3: an identity change revokes the aged fixture link (so it is no longer due) while a DIFFERENT
    // non-fixture old link is due. Counts are 1 and 1, but the due row is not the fixture: the run must refuse before any delete.
    await admin.query("update public.profiles set email = replace(email, '@', '+r@') where id = $1", [MANAGER]);
    await admin.query("update public.profiles set email = replace(email, '+r@', '@') where id = $1", [MANAGER]);
    assert.equal(Number((await admin.query("select count(*)::int as n from internal.signin_links where token_hash = 'ret-fixture-20261101-aged' and revoked_at is not null")).rows[0].n), 1, 'the trigger revoked the aged fixture link');
    await admin.query("insert into internal.signin_links (user_id, token_hash, recipient_email, created_at, expires_at) values ($1, 'other-old-link-nonfixture', 'x@tnbs-recruiter.example.invalid', now() - interval '45 days', now() - interval '45 days' + interval '15 minutes')", [MANAGER]);
    const beforeR3 = await counts();
    r = await runRetentionFixtureRun(maint, 'recruiter_maintenance');
    assert.equal(r.ok, false);
    assert.equal(r.deletesSent, false);
    assert.equal(r.committed, false);
    assert.ok(r.failed.includes('due_row_is_not_the_tagged_fixture'), JSON.stringify(r.failed));
    assert.deepEqual(await counts(), beforeR3, 'the refused run deleted nothing');
    assert.equal(Number((await admin.query("select count(*)::int as n from internal.signin_links where token_hash = 'other-old-link-nonfixture'")).rows[0].n), 1, 'the non-fixture link survived');
    await admin.query("delete from internal.signin_links where token_hash = 'other-old-link-nonfixture'");
    await runFile(REMOVE, '', 'REMOVE TNBS RETENTION TEST FIXTURES');
    await runFile(INSTALL, '', 'INSTALL TNBS RETENTION TEST FIXTURES');
    assert.deepEqual(await counts(), afterInstall, 'fixtures reinstalled');

    // 6c. Reviewer R1: a non-fixture row 4 s short of its cutoff when checked becomes due before the delete. The post-check
    // finds it due, the whole transaction rolls back, and nothing (the fixtures included) is deleted.
    await admin.query("insert into internal.recovery_failures (email_hash, at) values ('boundary-nonfixture', clock_timestamp() - interval '48 hours' + interval '4 seconds')");
    r = await runRetentionFixtureRun(maint, 'recruiter_maintenance', async (db) => { await sleep(5000); return deleteTaggedFixtures(db); });
    assert.equal(r.ok, false);
    assert.equal(r.deletesSent, true);
    assert.equal(r.committed, false);
    assert.ok(r.failed.includes('aged_rows_remain'), JSON.stringify(r.failed));
    const afterR1 = await counts();
    for (const t of LEDGERS) assert.equal(afterR1[t], afterInstall[t]! + (t === 'internal.recovery_failures' ? 1 : 0), `${t}: rolled back, nothing deleted`);
    assert.equal(Number((await admin.query("select count(*)::int as n from internal.recovery_failures where email_hash = 'boundary-nonfixture'")).rows[0].n), 1, 'the boundary row survived');
    await admin.query("delete from internal.recovery_failures where email_hash = 'boundary-nonfixture'");

    // 7. A delete step that did not delete is reported as a failure and rolled back (post-run proof).
    r = await runRetentionFixtureRun(maint, 'recruiter_maintenance', async () => ({ deleted: { request_buckets: 0, recovery_failures: 0, email_events: 0, signin_links: 0, app_sessions: 0 }, failed: [] }));
    assert.equal(r.ok, false);
    assert.equal(r.deletesSent, true);
    assert.equal(r.committed, false);
    assert.ok(r.failed.includes('each_rule_must_delete_exactly_one_row'));
    assert.deepEqual(await counts(), afterInstall, 'the stub deleted nothing');

    // 7b. A delete that also removes a fresh control is caught by the post-checks and rolled back.
    r = await runRetentionFixtureRun(maint, 'recruiter_maintenance', async (db) => {
      const out = await deleteTaggedFixtures(db);
      await db.query("delete from internal.recovery_failures where email_hash = 'ret-fixture-20261101-fresh'");
      return out;
    });
    assert.equal(r.ok, false);
    assert.equal(r.committed, false);
    assert.ok(r.failed.includes('fresh_control_missing_after'), JSON.stringify(r.failed));
    assert.deepEqual(await counts(), afterInstall, 'the rolled-back run deleted nothing');

    // 8. The real run: deletes exactly the five aged fixtures; a non-fixture FRESH row and everything else stays.
    await strayFresh();
    const profilesBefore = Number((await admin.query('select count(*)::int as n from public.profiles')).rows[0].n);
    // Reviewer R2: another session inserts an aged non-fixture bucket row DURING the run. The table lock holds the insert back
    // until the run has committed, so the run never sees it and never deletes it; it lands afterwards, intact.
    let concurrent: Promise<unknown> | undefined;
    let insertSettledDuringRun = false;
    r = await runRetentionFixtureRun(maint, 'recruiter_maintenance', async (db) => {
      concurrent = other.query("insert into internal.auth_request_buckets (dimension, key_hash, window_start, count) values ('ip', 'concurrent-nonfixture', now() - interval '3 days', 1)")
        .then(() => { insertSettledDuringRun = true; });
      await sleep(1500);
      assert.equal(insertSettledDuringRun, false, 'the concurrent insert is blocked by the lock while the run is open');
      return deleteTaggedFixtures(db);
    });
    await concurrent;
    assert.deepEqual(r.failed, []);
    assert.equal(r.ok, true);
    assert.equal(r.committed, true);
    assert.deepEqual(r.deleted, { request_buckets: 1, recovery_failures: 1, email_events: 1, signin_links: 1, app_sessions: 1 });
    const afterRun = await counts();
    for (const t of LEDGERS) assert.equal(afterRun[t], afterInstall[t]! - 1 + (t === 'internal.recovery_failures' ? 1 : 0) + (t === 'internal.auth_request_buckets' ? 1 : 0), `${t}: exactly one row deleted (plus the stray fresh row and the late concurrent row)`);
    assert.equal(Number((await admin.query("select count(*)::int as n from internal.auth_request_buckets where key_hash = 'concurrent-nonfixture'")).rows[0].n), 1, 'the concurrent non-fixture row survived');
    await admin.query("delete from internal.auth_request_buckets where key_hash = 'concurrent-nonfixture'");
    assert.equal((await admin.query(`select count(*)::int as n from internal.recovery_failures where email_hash = 'stray-fresh-nonfixture'`)).rows[0].n, 1, 'the non-fixture fresh row survived');
    assert.equal(Number((await admin.query('select count(*)::int as n from public.profiles')).rows[0].n), profilesBefore, 'profiles untouched');
    assert.equal(Number((await admin.query(`select count(*)::int as n from internal.signin_links where token_hash = 'ret-fixture-20261101-fresh'`)).rows[0].n), 1, 'fresh control survived');

    // 9. Removal deletes only the tagged controls.
    await rejects(runFile(REMOVE, '', null), /confirmation phrase missing/, 'remove without confirmation');
    await runFile(REMOVE, '', 'REMOVE TNBS RETENTION TEST FIXTURES');
    const afterRemove = await counts();
    for (const t of LEDGERS) assert.equal(afterRemove[t], baseline[t]! + (t === 'internal.recovery_failures' ? 1 : 0), `${t}: back to baseline (plus the stray fresh row)`);
    console.log('PASS retention fixture run: boundary refusals, real run deletes only the five aged fixtures, removal is tag-scoped, widened grants are caught');
  } finally {
    await admin.query(`delete from internal.recovery_failures where email_hash like 'stray-%-nonfixture' or email_hash = 'boundary-nonfixture'`).catch(() => undefined);
    await admin.query(`delete from internal.signin_links where token_hash = 'other-old-link-nonfixture'`).catch(() => undefined);
    await admin.query(`delete from internal.auth_request_buckets where key_hash = 'concurrent-nonfixture'`).catch(() => undefined);
    for (const [table, col] of [['internal.auth_request_buckets', 'key_hash'], ['internal.recovery_failures', 'email_hash'], ['internal.signin_links', 'token_hash'], ['internal.app_sessions', 'token_hash'], ['internal.email_events', 'provider_event_id']]) {
      await admin.query(`delete from ${table} where ${col} like 'ret-fixture-20261101-%'`).catch(() => undefined);
    }
    for (const revoke of ['revoke delete on internal.backout_window from recruiter_maintenance', 'revoke update on internal.recovery_codes from recruiter_maintenance', 'revoke select (id) on public.profiles from recruiter_maintenance', 'revoke recruiter_api from recruiter_maintenance', 'revoke create on schema public from recruiter_maintenance', 'revoke create on schema internal from recruiter_maintenance']) await admin.query(revoke).catch(() => undefined);
    if (testObjects) await admin.query('drop function public.ret_test_secdef(); drop schema ret_test_vault cascade; drop sequence public.ret_test_seq').catch(() => undefined);
    if (markerMade) await admin.query('drop schema staging_identity cascade').catch(() => undefined);
    await other.end();
    await maint.end();
    await admin.end();
  }
}

main().catch((err: unknown) => {
  console.error('FAIL retention run A3 test:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
