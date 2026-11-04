// A3 LOCAL test of the backout-rehearsal runner actions against a REAL PostgreSQL 16 database that holds the baseline, the profile and
// business fixtures and a FRESH apply of M1, M1b and M1c (scripts/a3-build-test-db.mjs). It runs the rebuilt staging runner's real
// planner (with the real, pinned repository files and a synthetic staging address) and real executor through the injected-client seam;
// only the CLIENT is replaced by a loopback client. Covered: postgis-placement, identity-alignment-check, the window-on / window-off
// read-back line, and retire-app-credentials end to end (an open recruiter_app connection is ended and cannot come back, the seeded
// live credentials are revoked, the checks read 0), then the three M1 backouts and the identity check again on the backed-out database.
// Skipped unless BACKOUT_A3_ADMIN_URL and BACKOUT_A3_APP_URL are set; both must be LOOPBACK URLs on the owned cluster's own port and a
// tr_ database whose comment is "a3-task-owned:...". DESTRUCTIVE TO THE THROWAWAY DATABASE ONLY (and to the cluster-wide recruiter_app
// login, which scripts/run-real-db-suites.mjs gives back after every suite). The hosted half (Supabase roles, TLS, pooler) is not covered.
// Run: BACKOUT_A3_ADMIN_URL=... BACKOUT_A3_APP_URL=... npx tsx src/backout-rehearsal-a3.test.ts

import assert from 'node:assert/strict';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { POSTGIS_PLACEMENT_SQL, RETIRE_PRIVILEGE_SQL, RETIRE_STAGES, classifyPostgisPlacement, runRetirePrivilegeCheck } from './backout-rehearsal.js';
import { RunnerRefusal } from './refusals.js';
import { REBUILT_STAGING_SQL_ACTIONS, executeRebuiltSqlPlan, planRebuiltSqlRun } from './staging-rebuilt.js';

const ADMIN = process.env.BACKOUT_A3_ADMIN_URL;
const APP = process.env.BACKOUT_A3_APP_URL;
const REF = 'abcdefghijklmnopqrst';
const STAGING_URL = `postgresql://postgres.${REF}:redacted-pw@aws-0-us-east-2.pooler.supabase.com:5432/postgres`;
const MANAGER = '71000000-0000-4000-8000-000000000001';

function ownedLoopback(raw: string, name: string): URL {
  const u = new URL(raw);
  assert.ok(['postgresql:', 'postgres:'].includes(u.protocol) && u.search === '' && u.hash === '', `refusing: ${name} must be a plain postgresql URL`);
  assert.ok(['127.0.0.1', 'localhost'].includes(u.hostname), `refusing: ${name} must be loopback`);
  assert.ok(u.port !== '' && u.port !== '5432' && u.port !== '6543', `refusing: ${name} must name the owned cluster's own port`);
  assert.match(decodeURIComponent(u.pathname.replace(/^\//, '')), /^tr_[a-z0-9_]+$/, `refusing: the ${name} database name must start with tr_`);
  return u;
}

interface Outcome { events: Array<Record<string, unknown>>; error?: unknown; sent: string[] }
/** Every client this test opens itself, so a failed check still closes them and the process exits instead of waiting for the suite time limit. */
const opened: pg.Client[] = [];

async function main(): Promise<void> {
  if (!ADMIN || !APP) {
    console.log('skip backout-rehearsal A3 test (set BACKOUT_A3_ADMIN_URL and BACKOUT_A3_APP_URL, loopback only)');
    return;
  }
  const a = ownedLoopback(ADMIN, 'BACKOUT_A3_ADMIN_URL');
  const b = ownedLoopback(APP, 'BACKOUT_A3_APP_URL');
  assert.ok(a.port === b.port && a.pathname === b.pathname && decodeURIComponent(b.username) === 'recruiter_app', 'refusing: the app URL must be recruiter_app on the same cluster and database');
  const admin = new pg.Client({ connectionString: ADMIN });
  opened.push(admin);
  admin.on('error', () => console.error('A3 test: the admin connection reported an error'));
  await admin.connect();
  const q = (sql: string, params?: unknown[]) => admin.query(sql, params);
  assert.match((await q("select shobj_description(oid, 'pg_database') as c from pg_database where datname = current_database()")).rows[0].c as string, /^a3-task-owned:/, 'refusing: the database is not task-owned');
  let n = 0;
  const check = (name: string, ok: boolean) => { assert.ok(ok, name); console.log(`PASS ${name}`); n += 1; };

  /** The real planner and executor for one action; the client is a loopback pg client that records what was sent. */
  async function run(action: string, connectionString: string = ADMIN!): Promise<Outcome> {
    const plan = planRebuiltSqlRun({ action, dbUrl: STAGING_URL, confirm: REBUILT_STAGING_SQL_ACTIONS[action]!.confirmation, recordedRebuiltRef: REF });
    const sent: string[] = [];
    const events: Array<Record<string, unknown>> = [];
    const client = new pg.Client({ connectionString });
    const wrapped = {
      on: (e: 'error', l: (err: Error) => void) => client.on(e, l),
      connect: () => client.connect(),
      query: (sql: string, params?: unknown[]) => { if (!/^select set_config\(\$1, \$2, false\)$/.test(sql)) sent.push(sql); return client.query(sql, params as never); },
      end: () => client.end(),
    };
    const log = console.log; const err = console.error;
    const grab = (l: unknown[]) => { try { events.push(JSON.parse(String(l[0])) as Record<string, unknown>); } catch { events.push({ msg: 'non-event-line' }); } };
    console.log = (...x: unknown[]) => grab(x); console.error = (...x: unknown[]) => grab(x);
    try {
      await executeRebuiltSqlPlan(plan, () => wrapped as never);
      return { events, sent };
    } catch (e) {
      return { events, sent, error: e };
    } finally {
      console.log = log; console.error = err;
    }
  }
  const ev = (o: Outcome, msg: string) => o.events.find((e) => e.msg === msg);
  const idOf = (o: Outcome) => (o.error instanceof RunnerRefusal ? o.error.id : undefined);
  const onlyFixedEvents = (o: Outcome) => o.events.every((e) => e.msg !== 'non-event-line') && !JSON.stringify(o.events).match(/@|tnbs-recruiter|71000000|postgres:\/\//);
  const fingerprint = async (): Promise<string> => (await q(`select md5(string_agg(x, '|' order by x)) as f from (
      select 'c:' || n.nspname || '.' || c.relname || ':' || coalesce(c.relacl::text, '') as x from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public', 'internal', 'auth')
      union all select 'p:' || p.oid::regprocedure::text || ':' || md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'internal', 'auth')
      union all select 'r:' || rolname || ':' || rolcanlogin::text from pg_roles where rolname like 'recruiter%'
      union all select 'u:' || id::text || ':' || coalesce(email, '') from auth.users
      union all select 'w:' || email_edits_paused::text from internal.backout_window) s`)).rows[0].f as string;

  // ---- 1. postgis-placement: read-only, one word. There is no PostGIS here, so the real answer is "absent"; the same catalogue
  //         select is then proved on real extension rows (pg_stat_statements moved between schemas, plpgsql in pg_catalog).
  {
    const before = await fingerprint();
    const r = await run('postgis-placement');
    check('postgis-placement: real catalogue, no PostGIS: "absent"; begin read only, the fixed select, rollback; nothing changed', r.error === undefined && JSON.stringify(r.events) === JSON.stringify([{ msg: 'staging-sql.postgis_placement', schema: 'absent' }])
      && JSON.stringify(r.sent) === JSON.stringify(['begin read only', POSTGIS_PLACEMENT_SQL, 'rollback']) && (await fingerprint()) === before);
    const shape = (ext: string) => POSTGIS_PLACEMENT_SQL.replace("e.extname = 'postgis'", `e.extname = '${ext}'`);
    assert.notEqual(shape('pg_stat_statements'), POSTGIS_PLACEMENT_SQL);
    await q('create schema if not exists extensions');
    await q('create extension pg_stat_statements schema extensions');
    try {
      check('postgis-placement select shape on a real extension row: an extension in schema extensions reads "extensions"', classifyPostgisPlacement(await q(shape('pg_stat_statements'))) === 'extensions');
      await q('alter extension pg_stat_statements set schema public');
      check('postgis-placement select shape: the same extension moved to public reads "public"', classifyPostgisPlacement(await q(shape('pg_stat_statements'))) === 'public');
      check('postgis-placement select shape: an extension in any other schema (plpgsql in pg_catalog) reads "other"', classifyPostgisPlacement(await q(shape('plpgsql'))) === 'other');
    } finally {
      await q('drop extension if exists pg_stat_statements');
      await q('drop schema if exists extensions');
    }
  }

  // ---- 2. identity-alignment-check on the fresh M1 database (the seven profile fixtures each have an Auth row with the same email).
  const direct = async () => (await q(`select count(*) filter (where u.id is not null and lower(p.email) <> lower(u.email))::int as mism, count(*) filter (where u.id is null)::int as missing,
      count(*) filter (where u.id is not null and u.email is null)::int as nul, count(*)::int as approved from public.profiles p left join auth.users u on u.id = p.id where p.status::text = 'approved'`)).rows[0] as { mism: number; missing: number; nul: number; approved: number };
  {
    const before = await fingerprint();
    const truth = await direct();
    const r = await run('identity-alignment-check');
    const e = ev(r, 'staging-sql.identity_alignment');
    check('identity-alignment-check: aligned fixtures pass with counts equal to an independent query, read-only, rolled back, nothing changed', r.error === undefined && truth.approved > 0 && e?.ok === true && e.approved_profiles === truth.approved
      && e.email_mismatches === 0 && e.approved_auth_email_null === 0 && e.approved_profiles_without_auth_user === truth.missing && r.sent[0] === 'begin read only' && r.sent[r.sent.length - 1] === 'rollback' && !r.sent.includes('commit') && (await fingerprint()) === before && onlyFixedEvents(r));
    const email = (await q('select email from auth.users where id = $1', [MANAGER])).rows[0].email as string;
    await q("update auth.users set email = 'drifted-manager@tnbs-recruiter.example.invalid' where id = $1", [MANAGER]);
    try {
      const m = await run('identity-alignment-check');
      check('identity-alignment-check: one approved profile whose Auth email drifted: refused identity_alignment_failed, email_mismatches 1, no address printed', idOf(m) === 'identity_alignment_failed' && ev(m, 'staging-sql.identity_alignment')?.email_mismatches === 1 && onlyFixedEvents(m));
      await q('update auth.users set email = null where id = $1', [MANAGER]);
      const nul = await run('identity-alignment-check');
      check('identity-alignment-check: an approved profile whose Auth email is NULL (invisible to the mismatch count): refused, approved_auth_email_null 1, email_mismatches 0', idOf(nul) === 'identity_alignment_failed' && ev(nul, 'staging-sql.identity_alignment')?.approved_auth_email_null === 1 && ev(nul, 'staging-sql.identity_alignment')?.email_mismatches === 0);
    } finally {
      await q('update auth.users set email = $2 where id = $1', [MANAGER, email]);
    }
    check('identity-alignment-check: aligned again after the restore', idOf(await run('identity-alignment-check')) === undefined);
  }

  // ---- 3. window-on / window-off: the read-back is a fixed line taken inside the transaction; a wrong read-back rolls back.
  const paused = async (): Promise<unknown[]> => (await q('select email_edits_paused from internal.backout_window')).rows.map((r) => r.email_edits_paused);
  {
    check('window: the control table has exactly one row and starts false', JSON.stringify(await paused()) === '[false]');
    const on = await run('window-on');
    check('window-on: committed; the read-back line says true (rows 1, ok) before step_done; the table is true', on.error === undefined && JSON.stringify(on.events) === JSON.stringify([{ msg: 'staging-sql.backout_window', action: 'window-on', email_edits_paused: true, rows: 1, ok: true }, { msg: 'staging-sql.step_done', step: 'window-on' }])
      && on.sent[0] === 'begin' && on.sent[on.sent.length - 1] === 'commit' && JSON.stringify(await paused()) === '[true]');
    const off = await run('window-off');
    check('window-off: committed; the read-back line says false; the table is false', off.error === undefined && JSON.stringify(ev(off, 'staging-sql.backout_window')) === JSON.stringify({ msg: 'staging-sql.backout_window', action: 'window-off', email_edits_paused: false, rows: 1, ok: true }) && JSON.stringify(await paused()) === '[false]');
    await q('create table internal.zz_window_probe (n int)');
    await q("create function internal.zz_window_force() returns trigger language plpgsql as $f$ begin insert into internal.zz_window_probe values (1); new.email_edits_paused := false; return new; end $f$");
    await q('create trigger zz_window_force before update on internal.backout_window for each row execute function internal.zz_window_force()');
    try {
      const forced = await run('window-on');
      check('window-on with a server trigger that keeps the flag false: refused backout_window_not_expected, the read-back line says false/ok false, rolled back (no commit), the trigger\'s own write rolled back too',
        idOf(forced) === 'backout_window_not_expected' && JSON.stringify(ev(forced, 'staging-sql.backout_window')) === JSON.stringify({ msg: 'staging-sql.backout_window', action: 'window-on', email_edits_paused: false, rows: 1, ok: false })
        && forced.sent.includes('rollback') && !forced.sent.includes('commit') && ev(forced, 'staging-sql.step_done') === undefined && JSON.stringify(await paused()) === '[false]' && Number((await q('select count(*) as n from internal.zz_window_probe')).rows[0].n) === 0);
    } finally {
      await q('drop trigger if exists zz_window_force on internal.backout_window');
      await q('drop function if exists internal.zz_window_force()');
      await q('drop table if exists internal.zz_window_probe');
    }
  }

  // ---- 4. retire-app-credentials end to end: live credentials seeded for the fixture manager, an open recruiter_app connection held.
  await q(`insert into internal.app_sessions (user_id, token_hash, kind, email_at_issue, idle_window, expires_at, absolute_expires_at)
             values ($1, 'zz-backout-a3-session', 'link', 'manager@tnbs-recruiter.example.invalid', interval '30 days', now() + interval '30 days', now() + interval '90 days')`, [MANAGER]);
  await q(`insert into internal.signin_links (user_id, token_hash, recipient_email, expires_at) values ($1, 'zz-backout-a3-link', 'manager@tnbs-recruiter.example.invalid', now() + interval '15 minutes')`, [MANAGER]);
  const setId = (await q('insert into internal.recovery_sets (user_id) values ($1) returning id', [MANAGER])).rows[0].id as string;
  await q("insert into internal.recovery_codes (set_id, user_id, code_hash, expires_at) values ($1, $2, 'zz-backout-a3-code', now() + interval '365 days')", [setId, MANAGER]);
  const live = async () => (await q(`select (select count(*) from internal.app_sessions where revoked_at is null)::int as s, (select count(*) from internal.signin_links where used_at is null and revoked_at is null)::int as l,
      (select count(*) from internal.recovery_sets where revoked_at is null)::int as rs, (select count(*) from internal.recovery_codes where used_at is null and revoked_at is null)::int as c`)).rows[0] as { s: number; l: number; rs: number; c: number };
  const seeded = await live();
  check('retire: seeded at least one live session, link, recovery set and code', seeded.s >= 1 && seeded.l >= 1 && seeded.rs >= 1 && seeded.c >= 1);
  const appClient = new pg.Client({ connectionString: APP });
  opened.push(appClient);
  let appError = false;
  appClient.on('error', () => { appError = true; });
  await appClient.connect();
  check('retire: an open recruiter_app connection works before the run', (await appClient.query('select current_user as u')).rows[0].u === 'recruiter_app');
  // ---- 4a. T76: the privilege pre-check on real PostgreSQL 16 roles. Three throwaway logins (cluster-wide zz_ roles, dropped below):
  //          none = no privilege at all; alter = CREATEROLE + ADMIN OPTION on recruiter_app but no pg_signal_backend and no inherited
  //          privileges of recruiter_app (INHERIT FALSE), so it may change the login but may NOT end its sessions; full = alter plus
  //          pg_signal_backend. The pre-check's answer is compared with what the server itself allows (ground truth, rolled back).
  {
    const pw = randomBytes(18).toString('hex');
    const ZZ = ['zz_t76_none', 'zz_t76_alter', 'zz_t76_full', 'zz_t76_noadmin'] as const;
    const as = (role: string) => { const u = new URL(ADMIN!); u.username = role; u.password = pw; return u.toString(); };
    const appLogin = async () => (await q("select rolcanlogin, rolpassword is not null as haspw from pg_authid where rolname = 'recruiter_app'")).rows[0] as { rolcanlogin: boolean; haspw: boolean };
    const sqlState = async (role: string, fn: (c: pg.Client) => Promise<unknown>): Promise<string> => {
      const c = new pg.Client({ connectionString: as(role) });
      opened.push(c);
      c.on('error', () => undefined);
      await c.connect();
      try { await fn(c); return 'ok'; } catch (e) { return String((e as { code?: string }).code); } finally { await c.query('rollback').catch(() => undefined); await c.end(); }
    };
    const alterTruth = (role: string) => sqlState(role, async (c) => { await c.query('begin'); await c.query('alter role recruiter_app nologin password null'); });
    try {
      for (const r of ZZ) await q(`drop role if exists ${r}`);
      await q(`create role zz_t76_none login password '${pw}'`);
      await q(`create role zz_t76_alter login createrole password '${pw}'`);
      await q(`create role zz_t76_full login createrole password '${pw}'`);
      await q('grant recruiter_app to zz_t76_alter, zz_t76_full with admin true, inherit false, set false');
      await q('grant pg_signal_backend to zz_t76_full');
      // noadmin = CREATEROLE + pg_signal_backend but NO grant on recruiter_app, while zz_t76_alter/zz_t76_full hold ADMIN OPTION on it (T89, review note N3).
      await q(`create role zz_t76_noadmin login createrole password '${pw}'`);
      await q('grant pg_signal_backend to zz_t76_noadmin');
      for (const role of ['zz_t76_none', 'zz_t76_alter', 'zz_t76_noadmin'] as const) {
        const before = await fingerprint();
        const r = await run('retire-app-credentials', as(role));
        const login = await appLogin();
        let appStillWorks = false;
        try { appStillWorks = (await appClient.query('select current_user as u')).rows[0].u === 'recruiter_app'; } catch { /* stays false */ }
        check(`retire pre-check (real PG16), login ${role}: refused retire_privileges_missing; only begin read only, the pre-check, rollback were sent`, idOf(r) === 'retire_privileges_missing' && JSON.stringify(r.sent) === JSON.stringify(['begin read only', RETIRE_PRIVILEGE_SQL, 'rollback']));
        check(`retire pre-check (real PG16), login ${role}: nothing committed: recruiter_app is still LOGIN with its password, the open app connection still works, roles/grants/functions/users fingerprint unchanged`, login.rolcanlogin === true && login.haspw === true && appStillWorks && (await fingerprint()) === before);
        const lines = Object.fromEntries(r.events.filter((e) => e.msg === 'staging-sql.retire_privilege').map((e) => [e.check, e.answer]));
        check(`retire pre-check (real PG16), login ${role}: fixed yes/no lines only (end sessions ${role === 'zz_t76_noadmin' ? 'yes' : 'no'}; change login ${role === 'zz_t76_alter' ? 'yes' : 'no'}), no partial-state line`, onlyFixedEvents(r) && lines.can_end_app_sessions === (role === 'zz_t76_noadmin' ? 'yes' : 'no') && lines.can_alter_app_role === (role === 'zz_t76_alter' ? 'yes' : 'no') && lines.login_superuser === 'no' && ev(r, 'staging-sql.retire_partial_state') === undefined);
      }
      // Ground truth from the server itself (each inside a transaction that is rolled back; the terminate is aimed at a throwaway connection).
      check('retire pre-check ground truth: zz_t76_none may not change recruiter_app (42501)', (await alterTruth('zz_t76_none')) === '42501');
      check('retire pre-check ground truth: zz_t76_noadmin (CREATEROLE + pg_signal_backend, no ADMIN OPTION on recruiter_app) may not change it (42501)', (await alterTruth('zz_t76_noadmin')) === '42501');
      check('retire pre-check ground truth: zz_t76_alter may change recruiter_app (CREATEROLE + ADMIN OPTION; rolled back)', (await alterTruth('zz_t76_alter')) === 'ok' && (await appLogin()).rolcanlogin === true);
      check('retire pre-check ground truth: zz_t76_alter may not end a recruiter_app session (42501)', (await sqlState('zz_t76_alter', (c) => c.query('select pg_terminate_backend(pid) from pg_stat_activity where usename = $1', ['recruiter_app']))) === '42501');
      const spare = new pg.Client({ connectionString: APP });
      opened.push(spare);
      spare.on('error', () => undefined);
      await spare.connect();
      const sparePid = (await spare.query('select pg_backend_pid() as p')).rows[0].p as number;
      check('retire pre-check ground truth: zz_t76_full may end a recruiter_app session (pg_signal_backend; aimed at a spare app connection only)', (await sqlState('zz_t76_full', (c) => c.query('select pg_terminate_backend($1::int, 5000)', [sparePid]))) === 'ok');
      await spare.end().catch(() => undefined);
      const full = new pg.Client({ connectionString: as('zz_t76_full') });
      opened.push(full);
      await full.connect();
      const lines: Array<Record<string, unknown>> = [];
      const log = console.log; const err = console.error;
      console.log = (...x: unknown[]) => { lines.push(JSON.parse(String(x[0])) as Record<string, unknown>); }; console.error = console.log;
      let fullError: unknown;
      try { await runRetirePrivilegeCheck(full as never); } catch (e) { fullError = e; } finally { console.log = log; console.error = err; await full.end(); }
      check('retire pre-check (real PG16), login zz_t76_full (non-superuser, CREATEROLE + ADMIN OPTION + pg_signal_backend): proceeds (ok true), matching the ground truth', fullError === undefined && lines.some((l) => l.msg === 'staging-sql.retire_privilege_precheck' && l.ok === true)
        && lines.some((l) => l.check === 'can_end_app_sessions' && l.answer === 'yes') && lines.some((l) => l.check === 'can_alter_app_role' && l.answer === 'yes') && (await appLogin()).rolcanlogin === true);
    } finally {
      for (const r of ZZ) await q(`drop role if exists ${r}`);
    }
  }
  {
    const started = Date.now();
    const r = await run('retire-app-credentials');
    const after = await live();
    let appQueryFailed = false;
    try { await appClient.query('select 1'); } catch { appQueryFailed = true; }
    await appClient.end().catch(() => undefined);
    let reconnect: string | undefined;
    const again = new pg.Client({ connectionString: APP });
    opened.push(again);
    again.on('error', () => undefined);
    try { await again.connect(); reconnect = 'connected'; await again.end(); } catch (e) { reconnect = (e as { code?: string }).code; }
    check('retire: the run passes, prints only fixed lines, and every step_done in the file\'s order', r.error === undefined && onlyFixedEvents(r) && r.events.filter((e) => e.msg === 'staging-sql.step_done').map((e) => e.step).join() === RETIRE_STAGES.map((s) => s.label).join());
    check('retire: step 2: recruiter_app can no longer log in (rolcanlogin false, no password)', (await q("select rolcanlogin, rolpassword is null as nopw from pg_authid where rolname = 'recruiter_app'")).rows[0].rolcanlogin === false && (await q("select rolpassword is null as nopw from pg_authid where rolname = 'recruiter_app'")).rows[0].nopw === true);
    check('retire: step 3: at least one recruiter_app backend was signalled', (ev(r, 'staging-sql.retire_terminate')?.backends_signalled as number) >= 1);
    check('retire: step 3: the open app connection was ended (its next query fails)', appQueryFailed || appError);
    // NOLOGIN plus a null password: the server refuses the password exchange (28P01) or the login itself (28000); either way no new session.
    check(`retire: a new recruiter_app login is refused (SQLSTATE 28P01 or 28000; got ${reconnect})`, reconnect === '28P01' || reconnect === '28000');
    check('retire: step 3 poll: three zero reads in a row, inside the 60-second limit', ev(r, 'staging-sql.retire_backends')?.ok === true && ev(r, 'staging-sql.retire_backends')?.zero_reads_in_a_row === 3 && Date.now() - started < 60_000);
    const rev = ev(r, 'staging-sql.retire_revoked') as Record<string, number> | undefined;
    check('retire: step 4: the seeded live credentials were revoked (row counts printed as numbers) and none is left live', rev !== undefined && rev.sessions === seeded.s && rev.links === seeded.l && rev.recovery_sets === seeded.rs && rev.codes === seeded.c && after.s === 0 && after.l === 0 && after.rs === 0 && after.c === 0);
    check('retire: step 4 wrote its audit event in the same transaction', Number((await q("select count(*) as n from internal.auth_events where kind = 'backout_credentials_retired'")).rows[0].n) === 1);
    check('retire: steps 5 and 6: every check reads 0', JSON.stringify(ev(r, 'staging-sql.retire_checks')) === JSON.stringify({ msg: 'staging-sql.retire_checks', ok: true, backends: 0, live_sessions: 0, live_links: 0, live_codes: 0, email_mismatches: 0 }));
    check('retire: the runner sent the read-only pre-check first, then exactly the pinned file\'s statements (no extra statement)', JSON.stringify(r.sent.slice(0, 3)) === JSON.stringify(['begin read only', RETIRE_PRIVILEGE_SQL, 'rollback']) && r.sent.slice(3).filter((s) => !/recruiter_app_backends/.test(s)).length === 12 - 1);
  }
  {
    const twice = await run('retire-app-credentials');
    check('retire: a second run is safe: nothing left to end or revoke, checks still 0', twice.error === undefined && ev(twice, 'staging-sql.retire_terminate')?.backends_signalled === 0 && JSON.stringify(ev(twice, 'staging-sql.retire_revoked')) === JSON.stringify({ msg: 'staging-sql.retire_revoked', sessions: 0, links: 0, recovery_sets: 0, codes: 0 }) && ev(twice, 'staging-sql.retire_checks')?.ok === true);
  }
  {
    // T76 / N3: a step after NOLOGIN forced to fail (a trigger makes step 4's audit insert raise). recruiter_app's login is given back
    // first (the same statement scripts/run-real-db-suites.mjs uses between suites), so the run itself is what turns it off again.
    const restore = (await q('select format($f$alter role recruiter_app login password %L$f$, $1::text) as s', [decodeURIComponent(new URL(APP).password)])).rows[0].s as string;
    await q(restore);
    const loginBefore = (await q("select rolcanlogin from pg_roles where rolname = 'recruiter_app'")).rows[0].rolcanlogin as boolean;
    const auditBefore = Number((await q("select count(*) as n from internal.auth_events where kind = 'backout_credentials_retired'")).rows[0].n);
    await q("create function internal.zz_t76_fail() returns trigger language plpgsql as $f$ begin raise exception 'zz t76 forced failure'; end $f$");
    await q("create trigger zz_t76_fail before insert on internal.auth_events for each row when (new.kind = 'backout_credentials_retired') execute function internal.zz_t76_fail()");
    try {
      const failed = await run('retire-app-credentials');
      const loginAfter = (await q("select rolcanlogin from pg_roles where rolname = 'recruiter_app'")).rows[0].rolcanlogin as boolean;
      check('retire partial state (real PG16): the pre-check passed and NOLOGIN committed, then step 4 failed and was rolled back (no new audit row)', failed.error !== undefined && ev(failed, 'staging-sql.retire_privilege_precheck')?.ok === true
        && failed.events.some((e) => e.msg === 'staging-sql.step_done' && e.step === 'retire-step-2-nologin') && JSON.stringify(ev(failed, 'staging-sql.step_failed')) === JSON.stringify({ msg: 'staging-sql.step_failed', step: 'retire-step-4-revoke' })
        && Number((await q("select count(*) as n from internal.auth_events where kind = 'backout_credentials_retired'")).rows[0].n) === auditBefore);
      check('retire partial state (real PG16): the app login was ON before and is OFF now, and exactly one fixed line says so (restore with set-app-password)', loginBefore === true && loginAfter === false && onlyFixedEvents(failed)
        && failed.events.filter((e) => e.msg === 'staging-sql.retire_partial_state').length === 1 && JSON.stringify(ev(failed, 'staging-sql.retire_partial_state')) === JSON.stringify({ msg: 'staging-sql.retire_partial_state', app_login: 'off', restore_with: 'set-app-password' }));
    } finally {
      await q('drop trigger if exists zz_t76_fail on internal.auth_events');
      await q('drop function if exists internal.zz_t76_fail()');
    }
  }
  {
    // A live session that appears between step 4 and step 5 is caught by the checks (a trigger on the audit insert adds one inside step 4's transaction).
    await q(`create function internal.zz_backout_sneak() returns trigger language plpgsql as $f$ begin
      insert into internal.app_sessions (user_id, token_hash, kind, email_at_issue, idle_window, expires_at, absolute_expires_at)
      values ('${MANAGER}', 'zz-backout-a3-sneak-' || gen_random_uuid()::text, 'link', 'manager@tnbs-recruiter.example.invalid', interval '30 days', now() + interval '30 days', now() + interval '90 days');
      return new; end $f$`);
    await q("create trigger zz_backout_sneak after insert on internal.auth_events for each row when (new.kind = 'backout_credentials_retired') execute function internal.zz_backout_sneak()");
    try {
      const sneak = await run('retire-app-credentials');
      check('retire: a live session left after step 4: refused retire_checks_failed with live_sessions 1, the step 5 and 6 step_done lines are not printed', idOf(sneak) === 'retire_checks_failed' && ev(sneak, 'staging-sql.retire_checks')?.live_sessions === 1 && ev(sneak, 'staging-sql.retire_checks')?.ok === false && !sneak.events.some((e) => e.step === 'retire-step-5-checks'));
    } finally {
      await q('drop trigger if exists zz_backout_sneak on internal.auth_events');
      await q('drop function if exists internal.zz_backout_sneak()');
      await q("update internal.app_sessions set revoked_at = now(), revoked_reason = 'backout' where revoked_at is null");
    }
  }

  // ---- 5. The rest of the rehearsal order (doc 16 section 3.3): identity check, then the three backouts, then the identity check and the placement record again.
  {
    check('rehearsal: identity-alignment-check passes after retire, before the backouts', idOf(await run('identity-alignment-check')) === undefined);
    for (const action of ['backout-m1c', 'backout-m1b', 'backout-m1']) {
      const r = await run(action);
      check(`rehearsal: ${action} runs through the runner on the retired database`, r.error === undefined && ev(r, 'staging-sql.step_done') !== undefined);
    }
    check('rehearsal: M1 is backed out (public.team_list is gone)', (await q("select to_regprocedure('public.team_list()') is null as gone")).rows[0].gone === true);
    const after = await run('identity-alignment-check');
    check('rehearsal: identity-alignment-check runs on the backed-out database (it needs no M1 object) and passes', after.error === undefined && ev(after, 'staging-sql.identity_alignment')?.ok === true);
    check('rehearsal: postgis-placement runs on the backed-out database too', JSON.stringify((await run('postgis-placement')).events) === JSON.stringify([{ msg: 'staging-sql.postgis_placement', schema: 'absent' }]));
  }

  await admin.end();
  console.log(`${n} checks passed`);
}

main().catch(async (err) => {
  console.error(`FAIL backout-rehearsal A3 test: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
  await Promise.all(opened.map((c) => c.end().catch(() => undefined)));
});
