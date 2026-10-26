// A3 LOCAL test of the owner login bootstrap (doc 16 approval 4, G1) against a REAL PostgreSQL 16 database that holds
// the 20 baseline migrations and the 7 profile fixtures (scripts/a3-build-test-db.mjs --no-m1 --no-m1b --no-m1c).
// It runs the runner's real plan and executor (owner-login-check, owner-promote) with an injected loopback client.
// Skipped unless OWNER_A3_ADMIN_URL is set; it must be a LOOPBACK URL and a tr_ database. It changes only rows it
// creates (the owner user, extra users, a test trigger and a test marker schema) and removes them after every case.
// The hosted half (the real Supabase auth schema, GoTrue identities, the hosted runner login's privileges) is not covered.
// Run: OWNER_A3_ADMIN_URL=... npx tsx src/owner-bootstrap-a3.test.ts

import assert from 'node:assert/strict';
import pg from 'pg';
import { APPROVED_OWNER_EMAIL, OWNER_CHECK_CONFIRMATION, OWNER_PROMOTE_CONFIRMATION, runOwnerPromotion } from './owner-bootstrap.js';
import { RunnerRefusal, classifyRunnerFailure } from './refusals.js';
import { executeRebuiltSqlPlan, planRebuiltSqlRun } from './staging-rebuilt.js';

const ADMIN = process.env.OWNER_A3_ADMIN_URL;
const REF = 'abcdefghijklmnopqrst';
const FAKE_URL = `postgresql://postgres.${REF}:redacted-pw@aws-0-us-east-2.pooler.supabase.com:5432/postgres`;
const EXTRA = (n: number) => `f0000000-0000-4000-8000-00000000000${n}`;
const OWNER_ID = 'a0000000-0000-4000-8000-000000000001';

interface Outcome { events: Array<Record<string, unknown>>; error?: unknown; sent: string[] }

async function main(): Promise<void> {
  if (!ADMIN) {
    console.log('skip owner bootstrap A3 test (set OWNER_A3_ADMIN_URL, loopback only)');
    return;
  }
  const u = new URL(ADMIN);
  if (u.search || u.hash || (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost')) throw new Error('refusing: test URLs must be loopback, without query or fragment');
  const admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  assert.match((await admin.query('select current_database() as d')).rows[0].d as string, /^tr_/, 'refusing: the test database name must start with tr_');
  const q = (sql: string, params?: unknown[]) => admin.query(sql, params);
  const baseline = (await q("select count(*)::int as n from auth.users")).rows[0].n as number;
  const fixtures = (await q("select count(*)::int as n from public.profiles where email like '%@tnbs-recruiter.example.invalid'")).rows[0].n as number;
  assert.equal(baseline, 7, 'the test database must hold exactly the 7 profile fixtures and nothing else');
  assert.equal(fixtures, 7);

  let n = 0;
  const check = (name: string, ok: boolean, detail = '') => { assert.ok(ok, `${name} ${detail}`); console.log(`PASS ${name}`); n += 1; };

  const insertUser = (id: string, email: string, opts: { password?: string | null; confirmed?: boolean; meta?: string } = {}) => q(
    `insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, is_sso_user, is_anonymous)
     values ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2, $3, $4, '{"provider":"email","providers":["email"]}', $5, now(), now(), false, false)`,
    [id, email, opts.password === undefined ? '$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012' : opts.password, opts.confirmed === false ? null : new Date().toISOString(), opts.meta ?? '{}'],
  );
  const insertOwner = (opts: Parameters<typeof insertUser>[2] = {}) => insertUser(OWNER_ID, APPROVED_OWNER_EMAIL, opts);
  const cleanup = async () => {
    await q('drop trigger if exists zz_revert_owner on public.profiles; drop function if exists public.zz_revert_owner()').catch(() => undefined);
    await q("delete from auth.users where id::text like 'f0000000%' or id = $1 or lower(email) like 'hunter@twistednail.com%'", [OWNER_ID]);
    await q("update auth.users set raw_user_meta_data = raw_user_meta_data || '{\"test_only\":true}' where raw_user_meta_data->>'test_run_id' = 'stg-db-20260723-0042'");
    await q('drop schema if exists staging_identity cascade');
    await q("create schema staging_identity; create table staging_identity.marker (environment text not null, marker_id uuid not null, project_ref text not null); insert into staging_identity.marker values ('staging', 'a8512f81-fe47-485d-95cd-092c46e4920b', $1)".replace('$1', `'${REF}'`));
  };
  /** Test setup that needs the privileged column change: a short transaction with the transaction-local service-role claim. */
  const asService = async (sql: string, params?: unknown[]) => {
    await q('begin');
    try {
      await q("select set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true)");
      await q(sql, params);
      await q('commit');
    } catch (e) { await q('rollback'); throw e; }
  };
  const snapshot = async () => JSON.stringify([
    (await q('select id, email, role, status, approved_by, approved_at from public.profiles order by id')).rows,
    (await q('select id, email, encrypted_password is not null as pw from auth.users order by id')).rows,
  ]);

  const run = async (action: 'owner-login-check' | 'owner-promote', wrap?: (c: pg.Client, sent: string[]) => unknown): Promise<Outcome> => {
    const spec = action === 'owner-promote' ? OWNER_PROMOTE_CONFIRMATION : OWNER_CHECK_CONFIRMATION;
    const plan = planRebuiltSqlRun({ action, dbUrl: FAKE_URL, confirm: spec, recordedRebuiltRef: REF });
    const events: Array<Record<string, unknown>> = [];
    const sent: string[] = [];
    const client = new pg.Client({ connectionString: ADMIN });
    const wrapped = wrap ? wrap(client, sent) : { connect: () => client.connect(), query: (sql: string, p?: unknown[]) => { sent.push(sql); return client.query(sql, p); }, end: () => client.end() };
    const log = console.log; const err = console.error;
    console.log = (...a: unknown[]) => { try { events.push(JSON.parse(String(a[0]))); } catch { /* not an event */ } };
    console.error = () => undefined;
    try {
      await executeRebuiltSqlPlan(plan, () => wrapped as never);
      return { events, sent };
    } catch (e) {
      return { events, sent, error: e };
    } finally {
      console.log = log; console.error = err;
    }
  };
  const failed = (o: Outcome, phase = 'before') => o.events.filter((e) => e.msg === 'staging-sql.owner_check' && e.phase === phase && e.ok === false).map((e) => e.check as string);
  const refused = (o: Outcome) => o.error instanceof RunnerRefusal && o.error.id === 'owner_promotion_refused';
  const rolledBack = (o: Outcome) => o.events.some((e) => e.msg === 'staging-sql.owner_promote_result' && e.result === 'rolled_back');
  const state = (o: Outcome) => o.events.find((e) => e.msg === 'staging-sql.owner_state')?.state;

  /** Runs a refused case: a refusal naming exactly these checks, a rollback, and byte-identical data afterwards. */
  const mustRefuse = async (name: string, setup: () => Promise<unknown>, expectChecks: string[]) => {
    await cleanup();
    await setup();
    const before = await snapshot();
    const o = await run('owner-promote');
    const after = await snapshot();
    const names = failed(o);
    check(`refused: ${name}`, refused(o) && rolledBack(o) && before === after && expectChecks.every((c) => names.includes(c)), `error=${String((o.error as Error | undefined)?.message)} failed=${names.join(',')} unchanged=${before === after}`);
    assert.deepEqual(classifyRunnerFailure(o.error), { refusal: 'owner_promotion_refused' });
  };

  try {
    // ---- the privileged change really needs the service-role claim (the reviewed guard is intact)
    await cleanup();
    await insertOwner();
    check('the auth trigger created a pristine pending guest profile for the new owner user', JSON.stringify((await q('select role::text, status::text, approved_by, approved_at from public.profiles where id = $1', [OWNER_ID])).rows[0]) === '{"role":"guest","status":"pending","approved_by":null,"approved_at":null}');
    await q('begin');
    await assert.rejects(q("update public.profiles set role = 'manager', status = 'approved' where id = $1", [OWNER_ID]), /only managers or the trusted service role/);
    await q('rollback');
    check('without the service-role claim the same update is refused by the reviewed guard', true);

    // ---- read-only check: states
    let o = await run('owner-login-check');
    check('read-only check: a pristine new owner is "ready_to_promote" and nothing is written', state(o) === 'ready_to_promote' && o.error === undefined && o.sent.includes('begin read only') && o.sent.includes('rollback') && o.sent.every((s) => !/^\s*(insert|update|delete|create|alter|drop|grant|revoke)/i.test(s)));
    await cleanup();
    o = await run('owner-login-check');
    check('read-only check: no owner account is "no_owner_login"', state(o) === 'no_owner_login');

    // ---- happy path
    await cleanup();
    await insertOwner();
    const othersBefore = JSON.stringify((await q('select id, email, role, status, approved_by, approved_at from public.profiles where id <> $1 order by id', [OWNER_ID])).rows);
    o = await run('owner-promote');
    const row = (await q('select role::text, status::text, approved_by::text, approved_at is not null as has_at from public.profiles where id = $1', [OWNER_ID])).rows[0];
    const othersAfter = JSON.stringify((await q('select id, email, role, status, approved_by, approved_at from public.profiles where id <> $1 order by id', [OWNER_ID])).rows);
    check('promotion: the exact owner profile becomes manager/approved, approved by itself, with a timestamp', o.error === undefined && row.role === 'manager' && row.status === 'approved' && row.approved_by === OWNER_ID && row.has_at === true);
    check('promotion: no other profile or auth user changed', othersBefore === othersAfter && (await q('select count(*)::int as n from auth.users')).rows[0].n === 8);
    check('promotion: events end in committed, after-checks all pass', o.events.some((e) => e.msg === 'staging-sql.owner_promote_result' && e.result === 'committed') && failed(o, 'after').length === 0 && o.events.some((e) => e.msg === 'staging-sql.owner_checks' && e.phase === 'after' && e.ok === true));
    check('promotion: the claim and lock settings are transaction-local (nothing left on the session)', await (async () => {
      const c = new pg.Client({ connectionString: ADMIN }); await c.connect();
      try { await runOwnerPromotionOnFreshOwner(c); return ((await c.query("select current_setting('request.jwt.claims', true) as v")).rows[0].v ?? '') === ''; } finally { await c.end(); }
    })());
    o = await run('owner-login-check');
    check('read-only check after promotion: state "promoted"', state(o) === 'promoted');

    // ---- already manager: refuse, change nothing
    await mustRefuse('the owner profile is already the approved manager', async () => { await insertOwner(); await asService("update public.profiles set role = 'manager', status = 'approved', approved_at = now() where id = $1", [OWNER_ID]); }, ['owner_profile_is_still_pristine_pending_guest', 'no_approved_manager_profile_for_the_owner_yet']);

    // ---- identity and account-shape guards
    await mustRefuse('wrong email only (no account for the approved email)', async () => { await insertUser(OWNER_ID, 'someone.else@example.invalid'); }, ['exactly_one_auth_user_with_the_approved_email']);
    await mustRefuse('near-miss email (approved email with a suffix) is not the owner', async () => { await insertUser(OWNER_ID, `${APPROVED_OWNER_EMAIL}.invalid`); }, ['exactly_one_auth_user_with_the_approved_email']);
    await mustRefuse('duplicate user: the approved email twice (differing only by case)', async () => { await insertOwner(); await insertUser(EXTRA(1), 'Hunter@TwistedNail.com'); }, ['exactly_one_auth_user_with_the_approved_email']);
    await mustRefuse('extra password account (a second account that can sign in)', async () => { await insertOwner(); await insertUser(EXTRA(2), 'another.person@example.invalid', { meta: '{"x":1}' }); }, ['the_owner_is_the_only_password_account']);
    await mustRefuse('missing profile for the owner auth user', async () => { await insertOwner(); await q('delete from public.profiles where id = $1', [OWNER_ID]); }, ['exactly_one_profile_joined_to_the_owner_auth_user']);
    await mustRefuse('owner has no password', async () => { await insertOwner({ password: null }); }, ['owner_has_a_nonempty_password_and_confirmed_email', 'the_owner_is_the_only_password_account']);
    await mustRefuse('owner has an empty password string', async () => { await insertOwner({ password: '' }); }, ['owner_has_a_nonempty_password_and_confirmed_email']);
    await mustRefuse('owner email is not confirmed', async () => { await insertOwner({ confirmed: false }); }, ['owner_has_a_nonempty_password_and_confirmed_email']);
    await mustRefuse('profile email differs from the auth email', async () => { await insertOwner(); await asService("update public.profiles set email = 'other@example.invalid' where id = $1", [OWNER_ID]); }, ['exactly_one_profile_joined_to_the_owner_auth_user']);
    await mustRefuse('profile already changed (role view, still pending)', async () => { await insertOwner(); await asService("update public.profiles set role = 'view' where id = $1", [OWNER_ID]); }, ['owner_profile_is_still_pristine_pending_guest']);
    await mustRefuse('fixture count mismatch: only six of the seven fixtures are recognised', async () => { await insertOwner(); await q("update auth.users set raw_user_meta_data = raw_user_meta_data || '{\"test_only\":false}' where id = '71000000-0000-4000-8000-000000000001'"); }, ['exactly_seven_passwordless_fixture_profiles', 'no_other_profiles']);
    await mustRefuse('fixture count mismatch: an eighth fixture-looking profile', async () => { await insertOwner(); await insertUser(EXTRA(3), 'extra@tnbs-recruiter.example.invalid', { password: null, meta: '{"test_only":true,"test_run_id":"stg-db-20260723-0042"}' }); }, ['exactly_seven_passwordless_fixture_profiles', 'auth_users_are_the_owner_plus_seven_fixtures']);
    await mustRefuse('an unknown extra profile (not a fixture)', async () => { await insertOwner(); await insertUser(EXTRA(4), 'stranger@example.invalid', { password: null }); }, ['no_other_profiles']);
    await mustRefuse('no staging marker', async () => { await insertOwner(); await q('drop schema staging_identity cascade'); }, ['staging_marker_names_this_project']);
    await mustRefuse('the staging marker names another project', async () => { await insertOwner(); await q("update staging_identity.marker set project_ref = 'zzzzzzzzzzzzzzzzzzzz'"); }, ['staging_marker_names_this_project']);

    // ---- a failing postcondition rolls back (a trigger undoes the promotion inside the transaction)
    await cleanup();
    await insertOwner();
    await q("create function public.zz_revert_owner() returns trigger language plpgsql as $f$ begin new.role := 'guest'; return new; end $f$; create trigger zz_revert_owner before update on public.profiles for each row when (new.role = 'manager') execute function public.zz_revert_owner()");
    const before = await snapshot();
    o = await run('owner-promote');
    check('postcondition failure: refused, rolled back, data identical', refused(o) && rolledBack(o) && before === (await snapshot()) && failed(o, 'after').includes('the_same_account_has_the_approved_manager_profile'));

    // ---- a trigger that keeps role/status/timestamp but rewrites ONLY approved_by is caught by the postcondition (review r7 finding 2)
    for (const [label, expr] of [['NULL', 'null'], ['another existing profile', "'71000000-0000-4000-8000-000000000001'::uuid"]] as const) {
      await cleanup();
      await insertOwner();
      await q(`create function public.zz_revert_owner() returns trigger language plpgsql as $f$ begin new.approved_by := ${expr}; return new; end $f$; create trigger zz_revert_owner before update on public.profiles for each row when (new.role = 'manager') execute function public.zz_revert_owner()`);
      const snap = await snapshot();
      o = await run('owner-promote');
      check(`postcondition: approved_by rewritten to ${label} -> refused, rolled back, data identical`, refused(o) && rolledBack(o) && snap === (await snapshot()) && failed(o, 'after').includes('the_profile_is_approved_by_the_owner_account_itself'), `failed=${failed(o, 'after').join(',')}`);
    }
    await cleanup();

    // ---- a rollback the server did not acknowledge is NOT reported as rolled back (review r7 finding 4)
    await cleanup();
    await insertOwner();
    await asService("update public.profiles set role = 'manager', status = 'approved', approved_at = now() where id = $1", [OWNER_ID]);
    o = await run('owner-promote', (c, sent) => ({
      connect: () => c.connect(),
      query: async (sql: string, p?: unknown[]) => { sent.push(sql); if (sql === 'rollback') throw new Error('connection terminated unexpectedly'); return c.query(sql, p); },
      end: () => c.end(),
    }));
    check('rollback failure: reported as rollback_not_confirmed (never rolled_back), no commit was sent', refused(o) && o.events.some((e) => e.msg === 'staging-sql.owner_promote_result' && e.result === 'rollback_not_confirmed') && !rolledBack(o) && !o.sent.includes('commit'));

    // ---- the commit really happens but its acknowledgement is lost: unknown, no retry, and the read-only check then sees the committed state
    await cleanup();
    await insertOwner();
    const sentOnLostAck: string[] = [];
    o = await run('owner-promote', (c, sent) => ({
      connect: () => c.connect(),
      query: async (sql: string, p?: unknown[]) => { sent.push(sql); sentOnLostAck.push(sql); const r = await c.query(sql, p); if (sql === 'commit') throw Object.assign(new Error('connection terminated unexpectedly'), { code: 'ECONNRESET' }); return r; },
      end: () => c.end(),
    }));
    const lostAckRow = (await q('select role::text, status::text, approved_by::text from public.profiles where id = $1', [OWNER_ID])).rows[0];
    const afterLostAck = await run('owner-login-check');
    check('lost commit acknowledgement: reported unknown (not committed), one COMMIT, no rollback or retry, and the committed account is visible to the read-only check as "promoted"', o.events.some((e) => e.msg === 'staging-sql.owner_promote_result' && e.result === 'unknown') && !o.events.some((e) => e.msg === 'staging-sql.owner_promote_result' && e.result === 'committed') && sentOnLostAck.filter((s) => s === 'commit').length === 1 && !sentOnLostAck.includes('rollback') && lostAckRow.role === 'manager' && lostAckRow.approved_by === OWNER_ID && state(afterLostAck) === 'promoted');

    // ---- an unknown commit result stops without a rollback attempt or a retry
    await cleanup();
    await insertOwner();
    const sentOnCommitFailure: string[] = [];
    o = await run('owner-promote', (c, sent) => ({
      connect: () => c.connect(),
      query: async (sql: string, p?: unknown[]) => { sent.push(sql); sentOnCommitFailure.push(sql); if (sql === 'commit') throw Object.assign(new Error('connection terminated unexpectedly'), { code: 'ECONNRESET' }); return c.query(sql, p); },
      end: () => c.end(),
    }));
    check('commit failure: reported as unknown, no rollback or retry is attempted, and the classified failure carries only a code', o.events.some((e) => e.msg === 'staging-sql.owner_promote_result' && e.result === 'unknown') && sentOnCommitFailure.filter((s) => s === 'commit').length === 1 && !sentOnCommitFailure.slice(sentOnCommitFailure.indexOf('commit') + 1).some((s) => s === 'rollback') && JSON.stringify(classifyRunnerFailure(o.error)) === '{"refusal":"server_or_driver_error","err_code":"ECONNRESET"}');

    // ---- guards in front of the transaction
    check('plan: owner-promote and owner-login-check need the typed confirmation, the recorded ref and port 5432', (() => {
      for (const action of ['owner-promote', 'owner-login-check'] as const) {
        assert.throws(() => planRebuiltSqlRun({ action, dbUrl: FAKE_URL, confirm: 'wrong', recordedRebuiltRef: REF }), /requires --confirm/);
        assert.throws(() => planRebuiltSqlRun({ action, dbUrl: FAKE_URL.replace(REF, 'zzzzzzzzzzzzzzzzzzzz'), confirm: action === 'owner-promote' ? OWNER_PROMOTE_CONFIRMATION : OWNER_CHECK_CONFIRMATION, recordedRebuiltRef: REF }), /only targets the recorded rebuilt/);
        assert.throws(() => planRebuiltSqlRun({ action, dbUrl: FAKE_URL.replace(':5432/', ':6543/'), confirm: action === 'owner-promote' ? OWNER_PROMOTE_CONFIRMATION : OWNER_CHECK_CONFIRMATION, recordedRebuiltRef: REF }), /port 5432/);
      }
      return true;
    })());
  } finally {
    await cleanup().catch(() => undefined);
    await q('drop schema if exists staging_identity cascade').catch(() => undefined);
    await admin.end();
  }
  console.log(`PASS ${n} owner bootstrap checks against a real PostgreSQL catalogue`);

  /** Helper kept at the bottom: promote a freshly inserted owner on a given client (used to test transaction-local settings). */
  async function runOwnerPromotionOnFreshOwner(c: pg.Client): Promise<void> {
    await cleanup();
    await insertOwner();
    const log = console.log; console.log = () => undefined;
    try { await runOwnerPromotion(c as never, REF); } finally { console.log = log; }
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
