// A3 LOCAL test of the first-manager bootstrap against a REAL PostgreSQL 16 database that holds the 20 baseline migrations,
// the 7 profile fixtures, the A3 business fixtures and M1 + M1b + M1c (scripts/a3-build-test-db.mjs, default flags).
// It runs the tool's real planner and executor with an injected loopback client. Skipped unless FIRST_MANAGER_A3_ADMIN_URL is set;
// it must be a LOOPBACK URL, a tr_ database, and the database comment must be "a3-task-owned:...". Optional FIRST_MANAGER_A3_APP_URL
// (recruiter_app, LOGIN enabled in the throwaway cluster only) additionally proves the new manager can add a person (M1b).
//
// DESTRUCTIVE TO THE THROWAWAY DATABASE ONLY: it truncates public.profiles (cascade) to model an empty production roster, so build a
// fresh database for each run. The first case runs on the untouched fixtures (a manager exists -> refused).
// The hosted half (the hosted runner login's privileges, Supabase's own roles and event triggers, TLS) is not covered.
// Run: FIRST_MANAGER_A3_ADMIN_URL=... npx tsx src/first-manager-bootstrap-a3.test.ts

import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import {
  FIRST_MANAGER_CHECK_CONFIRMATION, FIRST_MANAGER_CREATE_CONFIRMATION, FIRST_MANAGER_EMAIL, REQUIRED_FUNCTION_SIGNATURES, executeFirstManagerPlan, planFirstManager,
} from './first-manager-bootstrap.js';
import { walkReachableFunctions } from './first-manager-dependency-walk.js';
import { validateA3Urls } from './first-manager-a3-urls.js';
import { RunnerRefusal, classifyRunnerFailure } from './refusals.js';
import { REPOSITORY_ROOT } from './staging-rebuilt.js';
import { RECORDED_PROJECT_REFS } from './target-guard.js';

const ADMIN = process.env.FIRST_MANAGER_A3_ADMIN_URL;
const APP = process.env.FIRST_MANAGER_A3_APP_URL;
const url = (ref: string) => `postgresql://postgres.${ref}:redacted-pw@aws-0-us-east-2.pooler.supabase.com:5432/postgres`;
const PROD = RECORDED_PROJECT_REFS.production;
const MANAGER_FIXTURE = '71000000-0000-4000-8000-000000000001';

interface Outcome { events: Array<Record<string, unknown>>; error?: unknown; sent: string[] }

async function main(): Promise<void> {
  if (!ADMIN) {
    console.log('skip first-manager A3 test (set FIRST_MANAGER_A3_ADMIN_URL, loopback only)');
    return;
  }
  // Both URLs are validated here, offline, before any client exists: loopback, no overrides, the same owned cluster and database, app role recruiter_app.
  validateA3Urls(ADMIN, APP);
  const admin = new pg.Client({ connectionString: ADMIN });
  admin.on('error', () => console.error('A3 test: the admin connection reported an error'));
  await admin.connect();
  const q = (sql: string, params?: unknown[]) => admin.query(sql, params);
  assert.match((await q('select current_database() as d')).rows[0].d as string, /^tr_/, 'refusing: the test database name must start with tr_');
  assert.match((await q("select shobj_description(oid, 'pg_database') as c from pg_database where datname = current_database()")).rows[0].c as string, /^a3-task-owned:/, 'refusing: the database is not task-owned');
  let n = 0;
  const check = (name: string, ok: boolean) => { assert.ok(ok, name); console.log(`PASS ${name}`); n += 1; };

  const profileSnapshot = async () => JSON.stringify([
    (await q('select id, email, role, status, approved_by, approved_at from public.profiles order by id')).rows,
    (await q('select count(*)::int as n from internal.auth_events')).rows,
    (await q('select count(*)::int as n from auth.users')).rows,
  ]);
  const asService = async (sql: string, params?: unknown[]) => {
    await q('begin');
    try { await q("select set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true)"); await q(sql, params); await q('commit'); } catch (e) { await q('rollback'); throw e; }
  };
  /** An empty production-like roster: no profiles, no sign-in ledgers, no events, no blocks. Throwaway database only. */
  const emptyRoster = async () => {
    await q('truncate public.profiles cascade');
    await q('truncate internal.auth_events, internal.blocked_email_addresses cascade');
  };

  const run = async (action: 'first-manager-check' | 'first-manager-create', wrap?: (c: pg.Client, sent: string[]) => unknown): Promise<Outcome> => {
    const plan = planFirstManager({
      target: 'production', action, dbUrl: url(PROD),
      confirm: action === 'first-manager-check' ? FIRST_MANAGER_CHECK_CONFIRMATION : FIRST_MANAGER_CREATE_CONFIRMATION.production,
    });
    const events: Array<Record<string, unknown>> = [];
    const sent: string[] = [];
    const client = new pg.Client({ connectionString: ADMIN });
    const wrapped = wrap ? wrap(client, sent) : { connect: () => client.connect(), query: (sql: string, p?: unknown[]) => { sent.push(sql.replace(/\s+/g, ' ').trim()); return client.query(sql, p); }, end: () => client.end(), on: (ev: 'error', l: () => void) => client.on(ev, l) };
    const log = console.log; const err = console.error;
    console.log = (...a: unknown[]) => { try { events.push(JSON.parse(String(a[0]))); } catch { /* not an event */ } };
    console.error = () => undefined;
    try {
      await executeFirstManagerPlan(plan, () => wrapped as never);
      return { events, sent };
    } catch (e) {
      return { events, sent, error: e };
    } finally {
      console.log = log; console.error = err;
    }
  };
  const failedBefore = (o: Outcome) => o.events.filter((e) => e.msg === 'first-manager.check' && e.phase === 'before' && e.ok === false).map((e) => e.check as string);
  const refused = (o: Outcome) => o.error instanceof RunnerRefusal && o.error.id === 'first_manager_refused';
  const resultOf = (o: Outcome) => o.events.find((e) => e.msg === 'first-manager.result')?.result;
  const stateOf = (o: Outcome) => o.events.find((e) => e.msg === 'first-manager.state')?.state;

  // ---- 1. The untouched fixtures already hold a manager: refused, nothing changes.
  {
    assert.equal((await q("select count(*)::int as n from public.profiles where role = 'manager'")).rows[0].n >= 1, true, 'the fresh database must hold the manager fixture');
    const before = await profileSnapshot();
    const checkOut = await run('first-manager-check');
    check('fixtures: the read-only check reports manager_exists and changes nothing', checkOut.error === undefined && stateOf(checkOut) === 'manager_exists' && (await profileSnapshot()) === before);
    const o = await run('first-manager-create');
    check('fixtures: a manager already exists -> refused, rolled back, nothing changed', refused(o) && failedBefore(o).includes('no_manager_profile_exists_in_any_status') && resultOf(o) === 'rolled_back' && (await profileSnapshot()) === before);
  }

  // ---- 1b. The server drops the connection in the middle of the create transaction: the profile write is rolled back by the server, the run ends
  // in the tool's own refusal path (a controlled failure, not a crash), and no uncaught exception is raised.
  await emptyRoster();
  {
    const before = await profileSnapshot();
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => { uncaught.push(e); };
    process.on('uncaughtException', onUncaught);
    let killed = false;
    const o = await run('first-manager-create', (client, sent) => ({
      connect: () => client.connect(),
      on: (ev: 'error', l: () => void) => client.on(ev, l),
      end: () => client.end(),
      query: async (sql: string, p?: unknown[]) => {
        const text = sql.replace(/\s+/g, ' ').trim();
        sent.push(text);
        if (!killed && text.startsWith('with n as')) {
          killed = true;
          const pid = (await client.query('select pg_backend_pid() as pid')).rows[0].pid as number;
          await q('select pg_terminate_backend($1)', [pid]);
          await new Promise((r) => setTimeout(r, 200));
        }
        return client.query(sql, p);
      },
    }));
    await new Promise((r) => setTimeout(r, 200));
    process.off('uncaughtException', onUncaught);
    check('dropped connection: the server really ended the connection mid-transaction', killed);
    check('dropped connection: no uncaught exception', uncaught.length === 0);
    check('dropped connection: the run failed (no commit was sent) and reported rollback_not_confirmed through the existing path', o.error !== undefined && !o.sent.includes('commit') && resultOf(o) === 'rollback_not_confirmed');
    check('dropped connection: the profile write was rolled back by the server, nothing changed', (await profileSnapshot()) === before);
    const failure = classifyRunnerFailure(o.error);
    check('dropped connection: the failure classifies to a fixed identifier and a driver code, never the driver text', typeof failure.refusal === 'string' && !JSON.stringify(failure).toLowerCase().includes('terminat'));
  }

  // ---- 2. Empty roster: the insert path, then the proof that sign-in and Team add work for that person.
  await emptyRoster();
  const authUsersBefore = (await q('select count(*)::int as n from auth.users')).rows[0].n as number;
  {
    const checkOut = await run('first-manager-check');
    check('empty roster: the check reports ready_to_create', stateOf(checkOut) === 'ready_to_create');
    const o = await run('first-manager-create');
    check('empty roster: created and committed', o.error === undefined && resultOf(o) === 'committed' && o.events.find((e) => e.msg === 'first-manager.result')?.path === 'insert');
    const rows = (await q('select id, email, full_name, role::text as role, status::text as status, approved_by, approved_at is not null as has_at from public.profiles')).rows;
    check('empty roster: exactly one profile, the approved manager, approved by itself, address stored in lower case',
      rows.length === 1 && rows[0].email === FIRST_MANAGER_EMAIL && rows[0].role === 'manager' && rows[0].status === 'approved' && rows[0].approved_by === rows[0].id && rows[0].has_at === true);
    const events = (await q("select user_id, kind, detail from internal.auth_events where kind = 'first_manager_bootstrap'")).rows;
    check('empty roster: one audit event naming the target, linked to the profile', events.length === 1 && events[0].user_id === rows[0].id && events[0].detail.target === 'production');
    check('empty roster: no Auth user was created or changed', (await q('select count(*)::int as n from auth.users')).rows[0].n === authUsersBefore);
    const lookup = (await q('select user_id from internal.auth_mint_lock($1, now() - interval \'1 day\', now() + interval \'1 day\')', [FIRST_MANAGER_EMAIL])).rows;
    check('empty roster: the real sign-in lookup (internal.auth_mint_lock) finds exactly that person', lookup.length === 1 && lookup[0].user_id === rows[0].id);
    const lookupUpper = (await q('select user_id from internal.auth_mint_lock($1, now() - interval \'1 day\', now() + interval \'1 day\')', [FIRST_MANAGER_EMAIL.toUpperCase()])).rows;
    check('empty roster: the lookup is case-insensitive, as the sign-in request is', lookupUpper.length === 1);
    if (APP) {
      const hash = `fm-session-${Date.now()}`;
      await q(`insert into internal.app_sessions (user_id, token_hash, kind, email_at_issue, created_at, last_seen_at, idle_window, expires_at, absolute_expires_at)
               select id, $2, 'link', email, now(), now(), interval '30 days', now() + interval '30 days', now() + interval '90 days' from public.profiles where id = $1`, [rows[0].id, hash]);
      const app = new pg.Client({ connectionString: APP });
      app.on('error', () => console.error('A3 test: the app connection reported an error'));
      await app.connect();
      try {
        const who = (await app.query('select current_database() as d, current_user as u, inet_server_port()::text as p')).rows[0];
        const mine = (await q('select current_database() as d, inet_server_port()::text as p')).rows[0];
        assert.ok(who.d === mine.d && who.p === mine.p && who.u === 'recruiter_app', 'refusing: the app connection is not the same owned database as the admin connection');
        await app.query('begin');
        await app.query("select set_config('app.session_hash', $1, true)", [hash]);
        const added = await app.query("select public.team_add_person('Second Person', 'second.person@example.invalid', 'edit'::user_role, null) as id");
        await app.query('commit');
        check('empty roster: the new manager, through a link session as recruiter_app, can add a person (M1b team_add_person)', typeof added.rows[0].id === 'string');
      } finally { await app.end(); }
      const added = (await q("select role::text as role, status::text as status, approved_by from public.profiles where email = 'second.person@example.invalid'")).rows[0];
      check('empty roster: the added person is an approved editor approved by the first manager', added.role === 'edit' && added.status === 'approved' && added.approved_by === rows[0].id);
      await q('delete from internal.auth_events where user_id = (select id from public.profiles where email = $1)', ['second.person@example.invalid']);
      await q("delete from public.profiles where email = 'second.person@example.invalid'");
      await q('delete from internal.app_sessions where token_hash = $1', [hash]);
    } else {
      console.log('skip the Team-add proof (set FIRST_MANAGER_A3_APP_URL)');
    }
  }
  // ---- 3. Single use: a second run is refused; after the manager is demoted the recorded event still refuses it.
  {
    const before = await profileSnapshot();
    const second = await run('first-manager-create');
    check('single use: a second run is refused because a manager exists', refused(second) && failedBefore(second).includes('no_manager_profile_exists_in_any_status') && (await profileSnapshot()) === before);
    await asService("update public.profiles set role = 'view' where email = $1", [FIRST_MANAGER_EMAIL]);
    const third = await run('first-manager-create');
    const failed = failedBefore(third);
    check('single use: with no manager left, the recorded bootstrap event alone still refuses a re-run', refused(third) && !failed.includes('no_manager_profile_exists_in_any_status') && failed.includes('no_earlier_bootstrap_event_is_recorded'));
  }
  // ---- 4. Promote path: a pristine pending guest for the address.
  await emptyRoster();
  {
    await q("insert into public.profiles (email, full_name) values ($1, 'Owner Pending')", [FIRST_MANAGER_EMAIL]);
    const idBefore = (await q('select id from public.profiles where email = $1', [FIRST_MANAGER_EMAIL])).rows[0].id as string;
    const o = await run('first-manager-create');
    const row = (await q('select id, full_name, role::text as role, status::text as status, approved_by from public.profiles where email = $1', [FIRST_MANAGER_EMAIL])).rows[0];
    check('promote: the pristine pending guest becomes the approved manager in place (same id, same name, approved by itself)',
      o.error === undefined && o.events.find((e) => e.msg === 'first-manager.result')?.path === 'promote' && row.id === idBefore && row.role === 'manager' && row.status === 'approved' && row.approved_by === idBefore && row.full_name === 'Owner Pending');
    check('promote: still exactly one profile and one bootstrap event', (await q('select count(*)::int as n from public.profiles')).rows[0].n === 1 && (await q("select count(*)::int as n from internal.auth_events where kind = 'first_manager_bootstrap'")).rows[0].n === 1);
  }
  // ---- 5. Refusals that must leave the roster untouched.
  await emptyRoster();
  {
    await q("insert into public.profiles (email, full_name, role, status) values ($1, 'Already Editor', 'edit', 'approved')", [FIRST_MANAGER_EMAIL]);
    const before = await profileSnapshot();
    const o = await run('first-manager-create');
    check('refused: the address is already an approved editor -> nothing changes', refused(o) && failedBefore(o).includes('the_owner_address_is_absent_or_one_pristine_pending_guest') && (await profileSnapshot()) === before);
  }
  await emptyRoster();
  {
    await q("insert into public.profiles (email, full_name, role, status) values (upper($1), 'Odd Case', 'guest', 'pending')", [FIRST_MANAGER_EMAIL]);
    const before = await profileSnapshot();
    const o = await run('first-manager-create');
    check('refused: a differently-cased pending row for the address is not touched (decision for the owner)', refused(o) && (await profileSnapshot()) === before);
  }
  await emptyRoster();
  {
    await q("insert into internal.blocked_email_addresses (normalized_email, reason, evidence_at) values ($1, 'a3_test', now())", [FIRST_MANAGER_EMAIL]);
    const before = await profileSnapshot();
    const o = await run('first-manager-create');
    check('refused: the address is on the active block list -> nothing changes', refused(o) && failedBefore(o).includes('the_owner_address_is_not_blocked') && (await profileSnapshot()) === before);
    await q('delete from internal.blocked_email_addresses where normalized_email = $1', [FIRST_MANAGER_EMAIL]);
  }
  await emptyRoster();
  {
    await q('alter table public.profiles add constraint profiles_id_fkey foreign key (id) references auth.users(id)');
    const before = await profileSnapshot();
    const o = await run('first-manager-create');
    check('refused: the account link (profiles_id_fkey) is still present -> refused before any lock', refused(o) && !o.sent.some((s) => /for update|lock table/.test(s)) && (await profileSnapshot()) === before);
    await q('alter table public.profiles drop constraint profiles_id_fkey');
  }
  // ---- 6. A database error after the profile is written rolls the whole thing back.
  await emptyRoster();
  {
    await q(`create function public.zz_fail_event() returns trigger language plpgsql as $$ begin raise exception 'a3 injected failure' using errcode = '54001'; end $$;
             create trigger zz_fail_event before insert on internal.auth_events for each row execute function public.zz_fail_event()`);
    const before = await profileSnapshot();
    const o = await run('first-manager-create');
    const c = classifyRunnerFailure(o.error);
    check('failure injection: an error on the audit write rolls back the profile too; only a SQLSTATE class is printed', c.refusal === 'server_or_driver_error' && c.err_code === '54001' && resultOf(o) === 'rolled_back' && (await profileSnapshot()) === before);
    await q('drop trigger zz_fail_event on internal.auth_events; drop function public.zz_fail_event()');
  }
  // ---- 6b. Readiness: the roster control row and the real sign-in lookup are required (review finding 3). Each case changes the throwaway schema and puts it back.
  await emptyRoster();
  {
    const LOOKUP = 'internal.auth_mint_lock(text, timestamptz, timestamptz)';
    const rosterIsEmpty = async () => (await q('select count(*)::int as n from public.profiles')).rows[0].n === 0 && (await q("select count(*)::int as n from internal.auth_events where kind = 'first_manager_bootstrap'")).rows[0].n === 0;
    // (a) no roster control row: the lock would take nothing
    await q('delete from internal.roster_lock');
    let o = await run('first-manager-create');
    const noRow = refused(o) && failedBefore(o).includes('the_roster_control_row_is_exactly_one') && resultOf(o) === 'rolled_back' && !o.sent.some((x) => /lock table/.test(x)) && await rosterIsEmpty();
    const checkNoRow = stateOf(await run('first-manager-check')) === 'schema_not_ready';
    await q('insert into internal.roster_lock default values');
    check('readiness: an empty roster control table refuses the create, takes no lock and writes nothing; the check reports schema_not_ready', noRow && checkNoRow);
    // (b) two roster control rows (only if the table allows them)
    let two = true;
    try { await q('insert into internal.roster_lock default values'); } catch { two = false; }
    if (two) {
      o = await run('first-manager-create');
      const ok = refused(o) && failedBefore(o).includes('the_roster_control_row_is_exactly_one') && await rosterIsEmpty();
      await q('delete from internal.roster_lock where ctid in (select ctid from internal.roster_lock limit 1)');
      check('readiness: a second roster control row refuses the create and writes nothing', ok && (await q('select count(*)::int as n from internal.roster_lock')).rows[0].n === 1);
    } else {
      console.log('skip: the roster control table does not allow a second row');
    }
    // (c) the real sign-in lookup is missing
    await q(`alter function ${LOOKUP} rename to auth_mint_lock_hidden`);
    o = await run('first-manager-create');
    const noLookup = refused(o) && failedBefore(o).includes('m1_sign_in_functions_are_installed') && resultOf(o) === 'rolled_back' && !o.sent.some((x) => /for update|lock table/.test(x)) && await rosterIsEmpty();
    const checkNoLookup = stateOf(await run('first-manager-check')) === 'schema_not_ready';
    await q('alter function internal.auth_mint_lock_hidden(text, timestamptz, timestamptz) rename to auth_mint_lock');
    check('readiness: a missing internal.auth_mint_lock refuses the create before any lock or write; the check reports schema_not_ready', noLookup && checkNoLookup);
    // (c2) EVERY function in the generated required list (first-manager-required-functions.ts: the server's own calls plus everything reached through the policies,
    // triggers and function bodies of the tables it touches) is required: hide each one in turn; the create must refuse before any lock or write and the check must say
    // schema_not_ready. This covers the sign-in functions, the write guard and session functions, and the reviewer's ten ordinary-work functions (recheck_session,
    // actor_can_write, current_app_role, is_manager, is_app_login, matching_carriers, zone_geom, zone_radius_m, batch_members_ordered, is_contactable).
    // The signatures to hide come from a fresh walk of the sources, NOT from the shipped list, so a function dropped from the shipped list is still hidden here and the create is seen to succeed.
    const walked = walkReachableFunctions({ repositoryRoot: REPOSITORY_ROOT }).signatures;
    const notRefused: string[] = [];
    for (const sig of walked) {
      const m = /^(\w+)\.(\w+)\((.*)\)$/.exec(sig)!;
      const [, schema, fn, args] = m as unknown as [string, string, string, string];
      await q(`alter function ${sig} rename to ${fn}_hidden`);
      let refusedHere = false;
      try {
        const created = await run('first-manager-create');
        refusedHere = refused(created) && failedBefore(created).includes('m1_sign_in_functions_are_installed') && resultOf(created) === 'rolled_back' && !created.sent.some((x) => /for update|lock table/.test(x)) && await rosterIsEmpty()
          && stateOf(await run('first-manager-check')) === 'schema_not_ready';
      } finally {
        await q(`alter function ${schema}.${fn}_hidden(${args}) rename to ${fn}`);
      }
      if (!refusedHere) { notRefused.push(sig); break; } // a create that was not refused has committed a manager, so later iterations would be noise
    }
    check(`readiness: hiding any one of the ${walked.length} reachable functions (fresh walk) refuses the create before any lock or write and the check reports schema_not_ready${notRefused.length ? ` (NOT refused: ${notRefused.join('; ')})` : ''}`, notRefused.length === 0);
    for (const named of ['recheck_session', 'actor_can_write', 'current_app_role', 'is_manager', 'is_app_login', 'matching_carriers', 'zone_geom', 'zone_radius_m', 'batch_members_ordered', 'is_contactable']) {
      check(`readiness list covers internal.${named} (a reviewer-found ordinary-work dependency)`, REQUIRED_FUNCTION_SIGNATURES.some((s) => s.startsWith(`internal.${named}(`)));
    }
    // (d) the postcondition calls the REAL lookup: a stand-in that finds nobody makes the whole write roll back
    await q('alter function internal.auth_mint_lock(text, timestamptz, timestamptz) rename to auth_mint_lock_hidden');
    await q('create function internal.auth_mint_lock(p_email text, p_day_start timestamptz, p_day_end timestamptz) returns table (user_id uuid) language sql as $$ select null::uuid where false $$');
    o = await run('first-manager-create');
    const failedAfter = o.events.filter((e) => e.msg === 'first-manager.check' && e.phase === 'after' && e.ok === false).map((e) => e.check as string);
    const rolledBack = refused(o) && failedAfter.includes('the_sign_in_lookup_finds_exactly_that_person') && resultOf(o) === 'rolled_back' && await rosterIsEmpty();
    await q('drop function internal.auth_mint_lock(text, timestamptz, timestamptz)');
    await q('alter function internal.auth_mint_lock_hidden(text, timestamptz, timestamptz) rename to auth_mint_lock');
    check('postcondition: the real sign-in lookup is called; when it does not find the new person the write is rolled back', rolledBack);
    o = await run('first-manager-create');
    check('readiness: with the control row and the lookup back in place the create succeeds', o.error === undefined && resultOf(o) === 'committed');
  }
  await emptyRoster();
  // ---- 7. Two runs at once: exactly one commits.
  await emptyRoster();
  {
    // One shared console capture for both runs (two overlapping per-run captures would restore each other's console).
    const shared: Array<Record<string, unknown>> = [];
    const log = console.log; const err = console.error;
    console.log = (...x: unknown[]) => { try { shared.push(JSON.parse(String(x[0]))); } catch { /* not an event */ } };
    console.error = () => undefined;
    const attempt = async () => {
      const plan = planFirstManager({ target: 'production', action: 'first-manager-create', dbUrl: url(PROD), confirm: FIRST_MANAGER_CREATE_CONFIRMATION.production });
      const client = new pg.Client({ connectionString: ADMIN });
      try { await executeFirstManagerPlan(plan, () => client as never); return undefined; } catch (e) { return e; }
    };
    let errors: unknown[];
    try { errors = await Promise.all([attempt(), attempt()]); } finally { console.log = log; console.error = err; }
    const committed = errors.filter((e) => e === undefined).length;
    const refusedCount = errors.filter((e) => e instanceof RunnerRefusal && e.id === 'first_manager_refused').length;
    check('concurrency: two simultaneous runs -> exactly one commits and the other is refused', committed === 1 && refusedCount === 1 && shared.filter((e) => e.msg === 'first-manager.result' && e.result === 'committed').length === 1);    check('concurrency: one manager, one event', (await q("select count(*)::int as n from public.profiles where role = 'manager'")).rows[0].n === 1 && (await q("select count(*)::int as n from internal.auth_events where kind = 'first_manager_bootstrap'")).rows[0].n === 1);
  }
  // ---- 8. Everything printed by real runs passes the output wrapper with nothing withheld.
  {
    const w = await import(pathToFileURL(resolve(REPOSITORY_ROOT, 'scripts/run-with-secrets.mjs')).href);
    await emptyRoster();
    const all = [...(await run('first-manager-check')).events, ...(await run('first-manager-create')).events, ...(await run('first-manager-create')).events];
    const counter = { fields: 0 };
    const shown = all.map((e) => w.allowListLine(JSON.stringify(e), counter));
    check(`output: ${all.length} real events pass the allow-list, none withheld, and none carries the address`, shown.every((s: unknown) => s !== null) && counter.fields === 0 && !JSON.stringify(all).toLowerCase().includes('twistednail'));
  }
  await admin.end();
  console.log(`first-manager A3 (real PostgreSQL 16) tests: ${n} passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
