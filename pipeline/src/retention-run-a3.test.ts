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
  let loOid = '';
  const pendingRevokes: string[] = []; // every revoke of every widened grant, replayed in finally even when an assertion fails
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
      create schema ret_test_vault; create table ret_test_vault.decrypted_secrets (id int, note text); create sequence public.ret_test_seq;
      create foreign data wrapper ret_test_fdw; create server ret_test_srv foreign data wrapper ret_test_fdw; create type public.ret_test_type as enum ('a')`);
    testObjects = true;
    loOid = String((await admin.query('select lo_create(0) as o')).rows[0].o);
    const lo = loOid;
    assert.equal(dry.checks.length, 32, 'the dry run has 32 checks');
    const OTHER = 'no ACL entry naming this role on any other object';
    const RM = 'recruiter_maintenance';
    for (const [grant, revoke, expected] of [
      ['grant delete on internal.backout_window to recruiter_maintenance', 'revoke delete on internal.backout_window from recruiter_maintenance', 'delete is held on exactly the five ledgers'],
      ['grant update on internal.recovery_codes to recruiter_maintenance', 'revoke update on internal.recovery_codes from recruiter_maintenance', 'no insert, update, truncate, references or trigger privilege on any table'],
      ['grant select (id) on public.profiles to recruiter_maintenance', 'revoke select (id) on public.profiles from recruiter_maintenance', 'select is held on no table outside the five ledgers (application schemas)'],
      ['grant recruiter_api to recruiter_maintenance', 'revoke recruiter_api from recruiter_maintenance', 'member of no other role'],
      ['grant execute on function public.ret_test_secdef() to recruiter_maintenance', 'revoke execute on function public.ret_test_secdef() from recruiter_maintenance', 'no execute privilege on any non-extension function in public or internal'],
      ['grant execute on function public.ret_test_secdef() to recruiter_maintenance', 'revoke execute on function public.ret_test_secdef() from recruiter_maintenance', 'no direct execute grant on any function in any schema'],
      ['grant usage on schema ret_test_vault to recruiter_maintenance; grant select on ret_test_vault.decrypted_secrets to recruiter_maintenance', 'revoke all on ret_test_vault.decrypted_secrets from recruiter_maintenance; revoke usage on schema ret_test_vault from recruiter_maintenance', 'no direct grant of any kind on any relation, sequence or column outside the five ledgers (every schema, system catalogues included)'],
      ['grant select (note) on ret_test_vault.decrypted_secrets to recruiter_maintenance', 'revoke all on ret_test_vault.decrypted_secrets from recruiter_maintenance', 'no direct grant of any kind on any relation, sequence or column outside the five ledgers (every schema, system catalogues included)'],
      ['grant create on schema public to recruiter_maintenance', 'revoke create on schema public from recruiter_maintenance', 'no create privilege on any schema'],
      ['grant create on schema internal to recruiter_maintenance', 'revoke create on schema internal from recruiter_maintenance', 'no create privilege on any schema'],
      ['grant create on schema ret_test_vault to recruiter_maintenance', 'revoke create on schema ret_test_vault from recruiter_maintenance', 'no create privilege on any schema'],
      ['grant usage, update on sequence public.ret_test_seq to recruiter_maintenance', 'revoke all on sequence public.ret_test_seq from recruiter_maintenance', 'no usage, select or update privilege on any sequence'],
      [`grant create on database ${dbName} to recruiter_maintenance`, `revoke create on database ${dbName} from recruiter_maintenance`, 'no create privilege on the database'],
      // Reviewer r2 note 1: the kinds the first 25 checks did not walk.
      [`grant select on pg_catalog.pg_authid to ${RM}`, `revoke select on pg_catalog.pg_authid from ${RM}`, 'no select on a password-hash or secret catalogue'],
      [`grant select on pg_catalog.pg_authid to ${RM}`, `revoke select on pg_catalog.pg_authid from ${RM}`, 'no direct grant of any kind on any relation, sequence or column outside the five ledgers (every schema, system catalogues included)'],
      [`grant select (rolname) on pg_catalog.pg_roles to ${RM}`, `revoke select (rolname) on pg_catalog.pg_roles from ${RM}`, 'no direct grant of any kind on any relation, sequence or column outside the five ledgers (every schema, system catalogues included)'],
      ['grant select on pg_catalog.pg_authid to public', 'revoke select on pg_catalog.pg_authid from public', 'no select on a password-hash or secret catalogue'],
      [`grant execute on function pg_catalog.pg_read_file(text) to ${RM}`, `revoke execute on function pg_catalog.pg_read_file(text) from ${RM}`, 'no execute privilege on a server file function'],
      [`grant execute on function pg_catalog.pg_read_file(text) to ${RM}`, `revoke execute on function pg_catalog.pg_read_file(text) from ${RM}`, 'no direct execute grant on any function in any schema (system and extension functions included)'],
      ['grant execute on function pg_catalog.pg_ls_dir(text) to public', 'revoke execute on function pg_catalog.pg_ls_dir(text) from public', 'no execute privilege on a server file function'],
      [`grant usage on foreign server ret_test_srv to ${RM}`, `revoke usage on foreign server ret_test_srv from ${RM}`, OTHER],
      [`grant usage on foreign data wrapper ret_test_fdw to ${RM}`, `revoke usage on foreign data wrapper ret_test_fdw from ${RM}`, OTHER],
      [`grant set on parameter session_replication_role to ${RM}`, `revoke set on parameter session_replication_role from ${RM}`, OTHER],
      [`grant create on tablespace pg_default to ${RM}`, `revoke create on tablespace pg_default from ${RM}`, OTHER],
      [`grant select on large object ${lo} to ${RM}`, `revoke select on large object ${lo} from ${RM}`, OTHER],
      [`grant usage on language plpgsql to ${RM}`, `revoke usage on language plpgsql from ${RM}`, OTHER],
      [`grant usage on type public.ret_test_type to ${RM}`, `revoke usage on type public.ret_test_type from ${RM}`, OTHER],
      [`grant usage on schema ret_test_vault to ${RM}`, `revoke usage on schema ret_test_vault from ${RM}`, OTHER],
      // Reviewer r3 note 3: the last permission gaps.
      [`grant temporary on database ${dbName} to ${RM}`, `revoke temporary on database ${dbName} from ${RM}`, 'no privilege on any database except CONNECT'],
      [`grant connect on database postgres to ${RM}`, `revoke connect on database postgres from ${RM}`, 'no privilege on any database except CONNECT'],
      [`grant select on internal.signin_links to ${RM} with grant option`, `revoke grant option for select on internal.signin_links from ${RM}`, 'no grant option on any of the five ledgers'],
      [`grant delete on internal.app_sessions to ${RM} with grant option`, `revoke grant option for delete on internal.app_sessions from ${RM}`, 'no grant option on any of the five ledgers'],
      ['grant select on pg_catalog.pg_statistic to public', 'revoke select on pg_catalog.pg_statistic from public', 'no select on a catalogue that shows table values'],
      ['grant select (subconninfo) on pg_catalog.pg_subscription to public', 'revoke select (subconninfo) on pg_catalog.pg_subscription from public', 'no select on a catalogue that shows table values'],
      [`alter table ret_test_vault.decrypted_secrets owner to ${RM}`, 'alter table ret_test_vault.decrypted_secrets owner to tr_test_admin', 'owns no object'],
    ] as const) {
      pendingRevokes.push(revoke);
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

    // 6d. The least-privilege checks run INSIDE the delete transaction, after the lock. Another session holds the lock, the run
    // waits for it, and the grant is widened (committed) while the run waits: the run sees it and refuses before any delete. A dry run
    // done before the transaction (the r2 shape) would have passed.
    const beforeGap = await counts();
    await admin.query('begin');
    await admin.query('lock table internal.signin_links in share row exclusive mode');
    const gapRun = runRetentionFixtureRun(maint, 'recruiter_maintenance', undefined, { lockAttempts: 40, lockRetryDelayMs: 100 }); // patient: retries NOWAIT for ~4 s
    await sleep(1000);
    await admin.query('grant select on pg_catalog.pg_authid to recruiter_maintenance');
    await admin.query('commit');
    r = await gapRun;
    await admin.query('revoke select on pg_catalog.pg_authid from recruiter_maintenance');
    assert.equal(r.ok, false);
    assert.equal(r.deletesSent, false);
    assert.equal(r.committed, false);
    assert.deepEqual(r.failed, ['least_privilege_checks_failed']);
    assert.deepEqual(await counts(), beforeGap, 'the refused run deleted nothing');
    assert.equal((await maint.query('select 1 as one')).rows[0].one, 1, 'the maintenance session is usable (transaction closed)');

    // 6e. One transaction on the wire: the successful path sends a single begin, the checks sit between the lock and the delete, and COMMIT is last.
    const wire: string[] = [];
    const spy = { query: (sql: string, params?: unknown[]) => { wire.push(sql); return maint.query(sql, params as unknown[]); } };
    const ghost = await runRetentionFixtureRun(spy as never, 'recruiter_maintenance', async () => ({ deleted: { request_buckets: 0, recovery_failures: 0, email_events: 0, signin_links: 0, app_sessions: 0 }, failed: [] }));
    assert.equal(ghost.ok, false);
    assert.equal(wire.filter((q) => q === 'begin').length, 1, 'exactly one begin');
    assert.ok(!wire.some((q) => /^begin read only$/.test(q)), 'no separate read-only transaction');
    const iLock = wire.findIndex((q) => /^lock table/.test(q));
    const iWho = wire.indexOf('select current_user as u');
    assert.ok(iLock > 0 && iWho > iLock, 'the privilege checks come after the lock, inside the transaction');
    assert.equal(wire[wire.length - 1], 'rollback', 'a refused run ends with ROLLBACK, never COMMIT');
    assert.ok(!wire.includes('commit'));

    // 6f. COMMIT answered with the ROLLBACK tag (the transaction had failed and the failure was swallowed): ok false, committed false, nothing deleted.
    const beforeTag = await counts();
    const poisoned = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql === 'commit') await maint.query('select 1/0').catch(() => undefined); // abort the transaction, swallow the error
        return maint.query(sql, params as unknown[]);
      },
    };
    r = await runRetentionFixtureRun(poisoned as never, 'recruiter_maintenance');
    assert.equal(r.ok, false);
    assert.equal(r.committed, false);
    assert.equal(r.deletesSent, true);
    assert.deepEqual(r.failed, ['commit_answered_rollback']);
    assert.deepEqual(await counts(), beforeTag, 'the server rolled back: nothing was deleted');
    assert.equal((await maint.query('select 1 as one')).rows[0].one, 1, 'the session is idle again');

    // 6g. Deadlocks (reviewer r3 note 1). The app writes app_sessions and then signin_links (the revoke-on-identity-change order) while the
    // run locks the ledgers in its own order. The old waiting lock let PostgreSQL cancel the APP's transaction (40P01 after the app's
    // second write came more than deadlock_timeout later). NOWAIT never waits, so the app's transaction is never the one cancelled: the
    // run gives up with lock_busy_nothing_deleted and the app's second write succeeds.
    const beforeDl = await counts();
    const app = new pg.Client({ connectionString: loopback(ADMIN) });
    await app.connect();
    try {
      await app.query('begin');
      await app.query('update internal.app_sessions set token_hash = token_hash where false'); // ROW EXCLUSIVE on app_sessions
      const t0 = Date.now();
      const busyRun = runRetentionFixtureRun(maint, 'recruiter_maintenance', undefined, { lockAttempts: 4, lockRetryDelayMs: 100 }); // gives up at ~0.3 s
      await sleep(1500); // longer than the default deadlock_timeout of 1 s: the case that cancelled the app before
      let appError: unknown = null;
      try { await app.query('update internal.signin_links set token_hash = token_hash where false'); } catch (e) { appError = e; }
      assert.equal(appError, null, 'the app transaction is never the one cancelled (no 40P01)');
      await app.query('commit');
      r = await busyRun;
      assert.deepEqual([r.ok, r.committed, r.deletesSent, r.failed], [false, false, false, ['lock_busy_nothing_deleted']]);
      assert.ok(Date.now() - t0 >= 1500, 'sanity: the app write really came after the deadlock timeout');
      assert.deepEqual(await counts(), beforeDl, 'nothing deleted');
      assert.equal((await maint.query('select 1 as one')).rows[0].one, 1, 'the maintenance session is idle again');
      // The same interleave, app commits quickly: a patient run gets the lock on a later attempt.
      await app.query('begin');
      await app.query('update internal.app_sessions set token_hash = token_hash where false');
      const patient = runRetentionFixtureRun(maint, 'recruiter_maintenance', async () => ({ deleted: { request_buckets: 0, recovery_failures: 0, email_events: 0, signin_links: 0, app_sessions: 0 }, failed: [] }), { lockAttempts: 20, lockRetryDelayMs: 100 });
      await sleep(400);
      await app.query('commit');
      r = await patient;
      assert.ok(!r.failed.includes('lock_busy_nothing_deleted') && r.deletesSent, 'a lock that frees up within the attempts lets the run proceed (the stub delete is then refused by the post-check)');
      assert.deepEqual(await counts(), beforeDl, 'nothing deleted');
    } finally {
      await app.query('rollback').catch(() => undefined);
      await app.end();
    }

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
    await admin.query('rollback').catch(() => undefined);
    for (const revoke of pendingRevokes.reverse()) await admin.query(revoke).catch(() => undefined);
    await admin.query('revoke select on pg_catalog.pg_authid from recruiter_maintenance').catch(() => undefined);
    if (testObjects) {
      for (const drop of [`select lo_unlink(${loOid || 0})`, 'drop function public.ret_test_secdef()', 'drop schema ret_test_vault cascade', 'drop sequence public.ret_test_seq', 'drop server ret_test_srv', 'drop foreign data wrapper ret_test_fdw', 'drop type public.ret_test_type']) await admin.query(drop).catch(() => undefined);
    }
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
