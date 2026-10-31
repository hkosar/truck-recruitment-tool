// A3 LOCAL test of the guarded production SQL runner against a REAL PostgreSQL 16 database that holds the 20 baseline migrations, the profile
// and business fixtures and NO M1 (scripts/a3-build-test-db.mjs --no-m1 --no-m1b --no-m1c). It runs the tool's real planner (with the real,
// pinned repository files) and real executor through the injected-client seam the first-manager A3 test uses: the production guard refuses
// local URLs by design, so the plan is made with a synthetic production address and only the CLIENT is replaced by a loopback client.
// Skipped unless PROD_SQL_A3_ADMIN_URL is set; it must be a LOOPBACK URL on the owned cluster's own port, a tr_ database, and the database
// comment must be "a3-task-owned:...". DESTRUCTIVE TO THE THROWAWAY DATABASE ONLY: build a fresh database for each run.
// The hosted half (Supabase's own roles and event triggers, TLS, the hosted runner login) is not covered.
// Run: PROD_SQL_A3_ADMIN_URL=... npx tsx src/prod-sql-a3.test.ts

import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { PROD_SQL_ACTIONS, executeProdSqlPlan, planProdSql } from './prod-sql.js';
import { splitSqlStatements, sqlControl } from './prod-sql-split.js';
import { RunnerRefusal } from './refusals.js';
import { REBUILT_STAGING_SQL_ACTIONS, REPOSITORY_ROOT, executeRebuiltSqlPlan, planRebuiltSqlRun } from './staging-rebuilt.js';
import { RECORDED_PROJECT_REFS } from './target-guard.js';

const ADMIN = process.env.PROD_SQL_A3_ADMIN_URL;
const PROD_URL = `postgresql://postgres.${RECORDED_PROJECT_REFS.production}:redacted-pw@aws-0-us-east-2.pooler.supabase.com:5432/postgres`;

interface Outcome { events: Array<Record<string, unknown>>; error?: unknown; sent: string[] }
const ctlOf = (s: string) => { const first = splitSqlStatements(s)[0]; return first === undefined ? null : sqlControl(first); };

async function main(): Promise<void> {
  if (!ADMIN) {
    console.log('skip prod-sql A3 test (set PROD_SQL_A3_ADMIN_URL, loopback only)');
    return;
  }
  // Validated offline, before any client exists: loopback, no overrides, the owned cluster's own port, a tr_ database.
  const u = new URL(ADMIN);
  assert.ok(['postgresql:', 'postgres:'].includes(u.protocol) && u.search === '' && u.hash === '', 'refusing: PROD_SQL_A3_ADMIN_URL must be a plain postgresql URL');
  assert.ok(['127.0.0.1', 'localhost'].includes(u.hostname), 'refusing: PROD_SQL_A3_ADMIN_URL must be loopback');
  assert.ok(u.port !== '' && u.port !== '5432' && u.port !== '6543', 'refusing: PROD_SQL_A3_ADMIN_URL must name the owned cluster\'s own port');
  assert.match(decodeURIComponent(u.pathname.replace(/^\//, '')), /^tr_[a-z0-9_]+$/, 'refusing: the test database name must start with tr_');
  const admin = new pg.Client({ connectionString: ADMIN });
  admin.on('error', () => console.error('A3 test: the admin connection reported an error'));
  await admin.connect();
  const q = (sql: string, params?: unknown[]) => admin.query(sql, params);
  assert.match((await q('select current_database() as d')).rows[0].d as string, /^tr_/, 'refusing: the test database name must start with tr_');
  assert.match((await q("select shobj_description(oid, 'pg_database') as c from pg_database where datname = current_database()")).rows[0].c as string, /^a3-task-owned:/, 'refusing: the database is not task-owned');
  const wrapper = await import(pathToFileURL(resolve(REPOSITORY_ROOT, 'scripts/run-with-secrets.mjs')).href);
  let n = 0;
  const check = (name: string, ok: boolean) => { assert.ok(ok, name); console.log(`PASS ${name}`); n += 1; };
  const info = (name: string, text: string) => console.log(`INFO ${name}: ${text}`);

  /** One fingerprint of the catalogue state the files touch: relations and their ACLs, functions (body hash and ACL), constraints, triggers, policies, the sign-in roles, and row counts. */
  const fingerprint = async (): Promise<string> => (await q(`select md5(string_agg(x, '|' order by x)) as f from (
      select 'c:' || n.nspname || '.' || c.relname || ':' || c.relkind::text || ':' || coalesce(c.relacl::text, '') as x from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public', 'internal', 'auth')
      union all select 'p:' || p.oid::regprocedure::text || ':' || md5(p.prosrc) || ':' || coalesce(p.proacl::text, '') from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'internal', 'auth')
      union all select 'k:' || conrelid::regclass::text || ':' || conname || ':' || convalidated::text from pg_constraint where connamespace in (select oid from pg_namespace where nspname in ('public', 'internal', 'auth'))
      union all select 't:' || tgrelid::regclass::text || ':' || tgname from pg_trigger where not tgisinternal
      union all select 'pol:' || schemaname || '.' || tablename || ':' || policyname from pg_policies
      union all select 'r:' || rolname || ':' || rolcanlogin::text from pg_roles where rolname like 'recruiter%'
      union all select 'n:' || (select count(*) from public.profiles)::text) s`)).rows[0].f as string;
  const exists = async (sql: string): Promise<boolean> => (await q(`select ${sql} is not null as ok`)).rows[0].ok === true;

  const run = async (id: string, opts: { failAtQuery?: number; killBeforeCommit?: boolean } = {}): Promise<Outcome> => {
    const a = PROD_SQL_ACTIONS.find((x) => x.id === id)!;
    const plan = planProdSql({ target: 'production', action: id, dbUrl: PROD_URL, confirm: a.phrase });
    const events: Array<Record<string, unknown>> = [];
    const sent: string[] = [];
    const client = new pg.Client({ connectionString: ADMIN });
    let count = 0;
    const seam = {
      connect: () => client.connect(),
      end: () => client.end(),
      on: (ev: 'error', l: () => void) => client.on(ev, l),
      query: async (sql: string, p?: unknown[]) => {
        count += 1;
        sent.push(sql.trim());
        if (opts.failAtQuery === count) throw Object.assign(new Error('injected failure'), { code: 'XX999' });
        if (opts.killBeforeCommit && ctlOf(sql) === 'commit') {
          const pid = (await client.query('select pg_backend_pid() as pid')).rows[0].pid as number;
          await q('select pg_terminate_backend($1)', [pid]);
          await new Promise((r) => setTimeout(r, 200));
        }
        return client.query(sql, p);
      },
    };
    const log = console.log; const err = console.error;
    console.log = (...x: unknown[]) => { try { events.push(JSON.parse(String(x[0]))); } catch { /* not an event */ } };
    console.error = () => undefined;
    try {
      await executeProdSqlPlan(plan, () => seam as never);
      return { events, sent };
    } catch (e) {
      return { events, sent, error: e };
    } finally {
      console.log = log; console.error = err;
    }
  };
  const resultOf = (o: Outcome) => o.events.find((e) => e.msg === 'prod-sql.result')?.result;
  const ranOf = (o: Outcome) => Number(o.events.find((e) => e.msg === 'prod-sql.result')?.statements);
  const allEvents: Array<Record<string, unknown>> = [];
  const track = (o: Outcome) => { allEvents.push(...o.events); return o; };

  // Roles are cluster-wide: on a reused throwaway cluster the earlier run's roles may still exist, so only the tables are asserted absent.
  check('the database starts with no M1 sign-in tables', !(await exists("to_regclass('internal.app_sessions')")) && !(await exists("to_regclass('internal.roster_lock')")));
  const preM1 = await fingerprint();

  // ---- 0. The auth-schema inventory action (re-review B1), through the REAL staging-rebuilt planner and executor with a loopback client: the plan is made with a
  // synthetic rebuilt-project address (the recorded-ref guard is the unit under test elsewhere), only the CLIENT is replaced. Read-only, names and types only.
  {
    const inventoryRef = 'abcdefghijklmnopqrst';
    const spec = REBUILT_STAGING_SQL_ACTIONS['auth-schema-inventory']!;
    const out = resolve(tmpdir(), `tnbs-auth-inventory-a3-${process.pid}.json`);
    rmSync(out, { force: true });
    const authRowCounts = async (): Promise<string> => JSON.stringify((await q(`select (select count(*) from auth.users) as u, (select count(*) from auth.sessions) as s, (select count(*) from auth.refresh_tokens) as r,
      (select count(*) from auth.one_time_tokens) as o, (select count(*) from auth.flow_state) as f, (select count(*) from auth.identities) as i`)).rows);
    await q("create table auth.identities (id uuid primary key, user_id uuid, provider_id text not null, identity_data jsonb, email text)");
    await q("create table auth.mfa_factors (id uuid primary key, user_id uuid, secret text)");
    await q("alter table auth.identities add constraint review_identities_user_fk foreign key (user_id) references auth.users(id) on delete cascade");
    await q("insert into auth.identities (id, provider_id, identity_data, email) values ('f1000000-0000-4000-8000-000000000001', 'SENTINEL-PROVIDER-VALUE', '{\"token\":\"SENTINEL-SECRET-VALUE\"}', 'sentinel-address@example.invalid')");
    await q("insert into auth.mfa_factors (id, secret) values ('f1000000-0000-4000-8000-000000000002', 'SENTINEL-FACTOR-SECRET')");
    try {
      const before = await fingerprint();
      const countsBefore = await authRowCounts();
      const plan = planRebuiltSqlRun({ action: 'auth-schema-inventory', dbUrl: `postgresql://postgres.${inventoryRef}:redacted-pw@aws-0-us-east-2.pooler.supabase.com:5432/postgres`, confirm: spec.confirmation, out, recordedRebuiltRef: inventoryRef });
      const sent: string[] = [];
      const client = new pg.Client({ connectionString: ADMIN });
      const seam = { connect: () => client.connect(), end: () => client.end(), query: async (sql: string, p?: unknown[]) => { sent.push(sql.trim()); return client.query(sql, p); } };
      const log = console.log;
      const printed: string[] = [];
      console.log = (...x: unknown[]) => { printed.push(String(x[0])); };
      let error: unknown;
      try { await executeRebuiltSqlPlan(plan, () => seam as never); } catch (e) { error = e; } finally { console.log = log; }
      const written = existsSync(out) ? readFileSync(out, 'utf8') : '';
      const results = written === '' ? [] : (JSON.parse(written) as Array<{ statement: number; rowCount: number | null; rows: Array<Record<string, unknown>> }>);
      const columns = results.find((r) => r.rows.length > 0 && 'column_name' in r.rows[0]!)?.rows ?? [];
      const foreignKeys = results.find((r) => r.rows.length > 0 && 'foreign_key_definition' in r.rows[0]!)?.rows ?? [];
      const relations = new Set(columns.map((r) => r.relation_name as string));
      check('inventory: the executor opened a read-only transaction before the file, sent the pinned file once, rolled back, and never sent a commit', error === undefined && sent.includes('begin read only') && sent.indexOf('begin read only') < sent.indexOf(plan.steps[0]!.sql.trim()) && sent[sent.length - 1] === 'rollback' && !sent.some((x) => ctlOf(x) === 'commit') && sent.filter((x) => x === plan.steps[0]!.sql.trim()).length === 1);
      check('inventory: the result file lists the auth relations with their column names and types, including the extra synthetic tables (no row of any table is read)', relations.has('users') && relations.has('sessions') && relations.has('refresh_tokens') && relations.has('one_time_tokens') && relations.has('flow_state') && relations.has('identities') && relations.has('mfa_factors')
        && columns.some((r) => r.relation_name === 'identities' && r.column_name === 'identity_data' && r.column_type === 'jsonb' && r.attnotnull === false) && columns.some((r) => r.relation_name === 'identities' && r.column_name === 'provider_id' && r.column_type === 'text' && r.attnotnull === true));
      check('inventory: the foreign keys are listed as definitions (names and referenced columns), e.g. the cascade on identities', foreignKeys.some((r) => r.relation_name === 'identities' && /REFERENCES auth\.users\(id\) ON DELETE CASCADE/.test(String(r.foreign_key_definition))));
      check('inventory: every result row has only the fixed name/type keys (no value column), and the file has no sentinel value, address, token or secret from the seeded rows',
        columns.every((r) => Object.keys(r).sort().join() === 'attnotnull,column_name,column_type,relation_name,relkind') && foreignKeys.every((r) => Object.keys(r).sort().join() === 'conname,foreign_key_definition,relation_name') && !/SENTINEL|sentinel|example\.invalid|redacted-pw/.test(written));
      check('inventory: the terminal shows nothing from the database (the executor prints no event of its own for this action) and the run changed nothing: catalogue fingerprint and auth row counts are identical', printed.length === 0 && (await fingerprint()) === before && (await authRowCounts()) === countsBefore);
      // The server itself refuses a write in the transaction mode the executor uses, so even a changed file could not write.
      const writer = new pg.Client({ connectionString: ADMIN });
      await writer.connect();
      let refused: unknown;
      try { await writer.query('begin read only'); await writer.query("insert into auth.mfa_factors (id, secret) values ('f1000000-0000-4000-8000-000000000003', 'x')"); } catch (e) { refused = e; } finally { await writer.query('rollback').catch(() => undefined); await writer.end(); }
      check('inventory: a write inside begin read only is refused by the server (SQLSTATE 25006), so the read-only mode the executor uses is enforced, not assumed', (refused as { code?: string } | undefined)?.code === '25006' && (await authRowCounts()) === countsBefore);
      let secondRefused = false;
      try { planRebuiltSqlRun({ action: 'auth-schema-inventory', dbUrl: `postgresql://postgres.${inventoryRef}:redacted-pw@aws-0-us-east-2.pooler.supabase.com:5432/postgres`, confirm: spec.confirmation, out, recordedRebuiltRef: inventoryRef }); } catch (e) { secondRefused = /already exists/.test(String((e as Error).message)); }
      check('inventory: a second plan with the same --out is refused because the result file already exists (never overwritten)', secondRefused);
    } finally {
      rmSync(out, { force: true });
      await q('drop table if exists auth.identities');
      await q('drop table if exists auth.mfa_factors');
    }
  }

  // ---- 1. The read-only snapshot, twice: nothing changes and the per-statement digests are identical (the before/after comparison).
  {
    const a = track(await run('snapshot'));
    const b = track(await run('snapshot'));
    const digests = (o: Outcome) => o.events.filter((e) => e.msg === 'prod-sql.statement').map((e) => e.digest as string);
    check('snapshot: read-only, never a commit, reported read_only_done, 8 statements with digests, and the database is untouched', a.error === undefined && resultOf(a) === 'read_only_done' && !a.sent.some((s) => ctlOf(s) === 'commit') && a.sent[0] === 'begin read only' && digests(a).length === 8 && (await fingerprint()) === preM1);
    check('snapshot: two runs give identical digests', JSON.stringify(digests(a)) === JSON.stringify(digests(b)) && digests(a).every((d) => /^[0-9a-f]{64}$/.test(d)));
    (globalThis as { __snapBefore?: string[] }).__snapBefore = digests(a);
  }

  // ---- 2. M1 (no top-level begin/commit): the runner wraps it in one transaction.
  {
    const o = track(await run('m1'));
    check('m1: wrapped in one transaction and committed (142 statements, one begin, one commit)', o.error === undefined && resultOf(o) === 'committed' && ranOf(o) === 142 && o.sent.filter((s) => ctlOf(s) === 'begin').length === 1 && o.sent.filter((s) => ctlOf(s) === 'commit').length === 1 && o.sent[0] === 'begin');
    check('m1: the sign-in tables and the roles exist afterwards', (await exists("to_regclass('internal.app_sessions')")) && (await q("select count(*)::int as n from pg_roles where rolname in ('recruiter_api', 'recruiter_app', 'recruiter_maintenance')")).rows[0].n === 3);
  }
  const postM1 = await fingerprint();
  check('the catalogue changed by applying M1', postM1 !== preM1);

  // ---- 3. A REAL server failure in the middle of the 142-statement file: M1 run again fails at its first create that already exists.
  {
    const o = track(await run('m1'));
    check('m1 again: the server refuses mid-file with a SQLSTATE, the run is reported rolled_back, no commit was sent', o.error !== undefined && !(o.error instanceof RunnerRefusal) && /^[0-9A-Z]{5}$/.test(String((o.error as { code?: unknown }).code)) && resultOf(o) === 'rolled_back' && !o.sent.some((s) => ctlOf(s) === 'commit'));
    check('m1 again: it failed in the MIDDLE of the file (some statements ran, not all)', ranOf(o) > 0 && ranOf(o) < 142);
    check('m1 again: everything it ran before the failure was rolled back (the catalogue fingerprint equals the post-M1 state)', (await fingerprint()) === postM1);
  }

  // ---- 4. M1b and M1c carry their own begin ... commit: run as written, one begin, one commit, no double wrap.
  for (const id of ['m1b', 'm1c']) {
    const o = track(await run(id));
    check(`${id}: has its own begin/commit; the runner sent exactly one of each (from the file) and committed`, o.error === undefined && resultOf(o) === 'committed' && o.sent.filter((s) => ctlOf(s) === 'begin').length === 1 && o.sent.filter((s) => ctlOf(s) === 'commit').length === 1 && o.sent[0] !== 'begin');
  }
  check('m1b and m1c took effect (add-person and batch-delete functions exist; the profiles account link is gone)', (await exists("to_regprocedure('public.team_add_person(text,text,public.user_role,text)')")) && (await exists("to_regprocedure('public.batch_delete(uuid)')")) && (await q("select count(*)::int as n from pg_constraint where conname = 'profiles_id_fkey' and conrelid = 'public.profiles'::regclass")).rows[0].n === 0);

  // ---- 4b. The backout window (window-on / window-off) for real: M1 created internal.backout_window with email_edits_paused = false.
  {
    const paused = async (): Promise<unknown[]> => (await q('select email_edits_paused from internal.backout_window')).rows.map((r) => r.email_edits_paused);
    const flagOf = (o: Outcome) => o.events.find((e) => e.msg === 'prod-sql.flag')?.flag as Record<string, unknown> | undefined;
    check('window: the control table has exactly one row and it starts OFF (false)', JSON.stringify(await paused()) === '[false]');
    const on = track(await run('window-on'));
    check('window-on: one transaction (begin, lock timeout, update, verify select, commit), committed, the flag event says true, and the table is true', on.error === undefined && resultOf(on) === 'committed' && on.sent.length === 5 && on.sent[0] === 'begin' && ctlOf(on.sent[4]!) === 'commit'
      && JSON.stringify(flagOf(on)) === JSON.stringify({ email_edits_paused: true }) && JSON.stringify(await paused()) === '[true]');
    const onAgain = track(await run('window-on'));
    check('window-on again is safe to repeat: committed, still true', onAgain.error === undefined && resultOf(onAgain) === 'committed' && JSON.stringify(await paused()) === '[true]');
    const off = track(await run('window-off'));
    check('window-off: committed, the flag event says false, and the table is false (the round trip is exact)', off.error === undefined && resultOf(off) === 'committed' && JSON.stringify(flagOf(off)) === JSON.stringify({ email_edits_paused: false }) && JSON.stringify(await paused()) === '[false]');
    // A REAL server-side surprise: a trigger forces the flag back to false (and leaves a side effect). window-on must read false inside the transaction, refuse and roll everything back.
    await q('create table internal.review_window_probe (n int)');
    await q("create function internal.review_window_force() returns trigger language plpgsql as $f$ begin insert into internal.review_window_probe values (1); new.email_edits_paused := false; return new; end $f$");
    await q('create trigger review_window_force before update on internal.backout_window for each row execute function internal.review_window_force()');
    try {
      const refused = track(await run('window-on'));
      check('window-on with a trigger that keeps the flag false: refused (prod_sql_flag_not_expected), rolled_back, no commit was sent, and the trigger\'s own write was rolled back too',
        refused.error instanceof RunnerRefusal && refused.error.id === 'prod_sql_flag_not_expected' && resultOf(refused) === 'rolled_back' && !refused.sent.some((x) => ctlOf(x) === 'commit') && JSON.stringify(flagOf(refused)) === JSON.stringify({ email_edits_paused: false })
        && JSON.stringify(await paused()) === '[false]' && Number((await q('select count(*) as n from internal.review_window_probe')).rows[0].n) === 0);
    } finally {
      await q('drop trigger if exists review_window_force on internal.backout_window');
      await q('drop function if exists internal.review_window_force()');
      await q('drop table if exists internal.review_window_probe');
    }
    // A failure injected at the update (query 3) leaves the flag as it was.
    const failed = track(await run('window-on', { failAtQuery: 3 }));
    check('window-on with an injected failure at the update: rolled_back, nothing committed, the flag is unchanged', failed.error !== undefined && resultOf(failed) === 'rolled_back' && JSON.stringify(await paused()) === '[false]');
  }

  // ---- 5. The staged files (retire-app-credentials and L1), stage by stage, on the database as it is now.
  {
    const nologin = track(await run('retire-nologin'));
    check('retire-nologin: a one-statement stage is wrapped; the app role can no longer log in', nologin.error === undefined && resultOf(nologin) === 'committed' && (await q("select rolcanlogin from pg_roles where rolname = 'recruiter_app'")).rows[0].rolcanlogin === false);
    const backends = track(await run('retire-backends'));
    check('retire-backends: a counts event with the pinned name and a number', backends.error === undefined && JSON.stringify(backends.events.find((e) => e.msg === 'prod-sql.counts')?.counts) === JSON.stringify({ recruiter_app_backends: 0 }));
    const term = track(await run('retire-terminate'));
    check('retire-terminate: runs, reports a row count only', term.error === undefined && term.events.some((e) => e.msg === 'prod-sql.statement' && e.command === 'select' && typeof e.rows === 'number'));
    const revoke = track(await run('retire-revoke'));
    check('retire-revoke: own begin/commit run as written, committed, five statements reported with row counts', revoke.error === undefined && resultOf(revoke) === 'committed' && revoke.events.filter((e) => e.msg === 'prod-sql.statement').length === 5 && revoke.sent[0] !== 'begin');
    const checks = track(await run('retire-checks'));
    check('retire-checks: four pinned counts, all 0', checks.error === undefined && JSON.stringify(checks.events.find((e) => e.msg === 'prod-sql.counts')?.counts) === JSON.stringify({ backends: 0, live_sessions: 0, live_links: 0, live_codes: 0 }));
    const email = track(await run('retire-email'));
    check('retire-email: the pinned count column, a number', email.error === undefined && Object.keys((email.events.find((e) => e.msg === 'prod-sql.counts')?.counts ?? {}) as object).join() === 'email_mismatches');
    const hasAuth = await exists("to_regclass('auth.refresh_tokens')") && await exists("to_regclass('auth.one_time_tokens')") && await exists("to_regclass('auth.flow_state')") && await exists("to_regclass('auth.sessions')");
    if (hasAuth) {
      const shape = track(await run('l1-shape'));
      const shapeEvent = shape.events.find((e) => e.msg === 'prod-sql.shape') as { passed?: boolean; checks?: Record<string, boolean>; auth_tables_unreviewed?: number } | undefined;
      check('l1-shape against the local auth stand-ins: every fixed check true, nothing unreviewed, read_only_done', shape.error === undefined && resultOf(shape) === 'read_only_done' && shapeEvent?.passed === true && Object.values(shapeEvent.checks ?? {}).every((v) => v === true) && shapeEvent.auth_tables_unreviewed === 0);

      // R1 regressions (review of 47b43e2): the gate must STOP, and a sweep must not delete anything, when the shape is wrong. Seeded synthetic rows only.
      const seed = "insert into auth.sessions(id) values ('f0000000-0000-4000-8000-000000000001'); insert into auth.refresh_tokens(session_id) values ('f0000000-0000-4000-8000-000000000001'); insert into auth.one_time_tokens(id) values ('f0000000-0000-4000-8000-000000000002'); insert into auth.flow_state(id) values ('f0000000-0000-4000-8000-000000000003')";
      const authCounts = async (): Promise<string> => JSON.stringify((await q('select (select count(*) from auth.sessions) as s, (select count(*) from auth.refresh_tokens) as r, (select count(*) from auth.one_time_tokens) as o, (select count(*) from auth.flow_state) as f')).rows);
      await q(seed);
      const seeded = await authCounts();
      try {
        await q('create table auth.review_unlisted_credentials (token text)');
        await q("insert into auth.review_unlisted_credentials values ('review-synthetic')");
        const stopShape = track(await run('l1-shape'));
        const stopSweep = track(await run('l1-sweep'));
        const unlistedEvent = stopShape.events.find((e) => e.msg === 'prod-sql.shape') as { auth_tables_unreviewed?: number; checks?: Record<string, boolean> } | undefined;
        check('an extra unlisted auth table with a credential row: l1-shape refuses (prod_sql_l1_shape_not_ok) and counts it without naming it', stopShape.error instanceof RunnerRefusal && stopShape.error.id === 'prod_sql_l1_shape_not_ok' && unlistedEvent?.auth_tables_unreviewed === 1 && unlistedEvent.checks?.no_unreviewed_auth_tables === false && !JSON.stringify(stopShape.events).includes('review_unlisted'));
        check('an extra unlisted auth table: l1-sweep refuses in the same run before any delete, nothing is committed, every seeded row and the unlisted row survive', stopSweep.error instanceof RunnerRefusal && stopSweep.error.id === 'prod_sql_l1_shape_not_ok' && resultOf(stopSweep) === 'rolled_back' && !stopSweep.sent.some((s) => ctlOf(s) === 'commit') && !stopSweep.sent.some((s) => /^(delete|update)\b/i.test(s))
          && (await authCounts()) === seeded && Number((await q('select count(*) as n from auth.review_unlisted_credentials')).rows[0].n) === 1);
      } finally {
        await q('drop table if exists auth.review_unlisted_credentials');
      }
      await q('alter table auth.users rename column confirmation_token to review_hidden_confirmation_token');
      try {
        const hiddenShape = track(await run('l1-shape'));
        const hiddenSweep = track(await run('l1-sweep'));
        const hiddenEvent = hiddenShape.events.find((e) => e.msg === 'prod-sql.shape') as { checks?: Record<string, boolean> } | undefined;
        check('a hidden confirmation_token column: l1-shape refuses and names only the fixed failing check', hiddenShape.error instanceof RunnerRefusal && hiddenShape.error.id === 'prod_sql_l1_shape_not_ok' && hiddenEvent?.checks?.users_confirmation_token === false && Object.entries(hiddenEvent.checks ?? {}).filter(([, v]) => !v).length === 1);
        check('a hidden confirmation_token column: l1-sweep refuses before any delete or update; nothing committed; seeded rows survive', hiddenSweep.error instanceof RunnerRefusal && hiddenSweep.error.id === 'prod_sql_l1_shape_not_ok' && resultOf(hiddenSweep) === 'rolled_back' && !hiddenSweep.sent.some((s) => ctlOf(s) === 'commit') && !hiddenSweep.sent.some((s) => /^(delete|update)\b/i.test(s)) && (await authCounts()) === seeded);
      } finally {
        await q('alter table auth.users rename column review_hidden_confirmation_token to confirmation_token');
      }

      const counts = track(await run('l1-counts'));
      const sweep = track(await run('l1-sweep'));
      check('L1 stages run against the local auth stand-ins: counts (numbers), then the gated sweep passes its shape gate, runs as own begin/commit with rows, and clears the seeded rows', counts.error === undefined && sweep.error === undefined && resultOf(sweep) === 'committed' && sweep.events.some((e) => e.msg === 'prod-sql.shape' && e.passed === true) && Object.keys(counts.events.find((e) => e.msg === 'prod-sql.counts')!.counts as object).length === 5
        && JSON.stringify((counts.events.find((e) => e.msg === 'prod-sql.counts')!.counts as Record<string, number>).sessions) === '1' && (await authCounts()) === JSON.stringify([{ s: '0', r: '0', o: '0', f: '0' }]));
    } else {
      info('L1 stages', 'skipped: the local auth stand-in lacks the Supabase auth tables the L1 file reads (refresh_tokens, one_time_tokens, flow_state); not covered here');
    }
  }

  // ---- 6. A failure injected after real statements ran, in an "own" file: the server rolls them back.
  {
    const before = await fingerprint();
    const o = track(await run('backout-m1c', { failAtQuery: 4 })); // 1 begin, 2 set local, 3 drop function (runs), 4 grant (injected failure)
    check('injected failure inside a file with its own begin: the earlier real statement (drop function) was rolled back, nothing committed', o.error !== undefined && resultOf(o) === 'rolled_back' && ranOf(o) === 1 && (await fingerprint()) === before && (await exists("to_regprocedure('public.batch_delete(uuid)')")));
  }

  // ---- 7. The connection is killed just before COMMIT: the server rolled back; the runner reports UNKNOWN (never retried, never rolled back).
  {
    const before = await fingerprint();
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => { uncaught.push(e); };
    process.on('uncaughtException', onUncaught);
    const o = track(await run('backout-m1c', { killBeforeCommit: true }));
    await new Promise((r) => setTimeout(r, 200));
    process.off('uncaughtException', onUncaught);
    check('killed before COMMIT: reported unknown, exactly one commit attempt, no rollback sent, no uncaught exception', o.error !== undefined && (o.error as Error).name === 'ProdSqlResultUnknown' && resultOf(o) === 'unknown' && o.sent.filter((s) => ctlOf(s) === 'commit').length === 1 && !o.sent.includes('rollback') && uncaught.length === 0);
    check('killed before COMMIT: the server ended the transaction, so nothing changed (the operator would read the state to decide)', (await fingerprint()) === before);
  }

  // ---- 8. The backouts for real, in doc 17 order (BO4, BO5, BO6): each has its own begin/commit.
  for (const id of ['backout-m1c', 'backout-m1b', 'backout-m1']) {
    const o = track(await run(id));
    check(`${id}: committed as written (one begin, one commit)`, o.error === undefined && resultOf(o) === 'committed' && o.sent.filter((s) => ctlOf(s) === 'begin').length === 1 && o.sent.filter((s) => ctlOf(s) === 'commit').length === 1);
  }
  check('the backouts removed the M1 interfaces (team_list, team_add_person and batch_delete are gone)', !(await exists("to_regprocedure('public.team_add_person(text,text,public.user_role,text)')")) && !(await exists("to_regprocedure('public.batch_delete(uuid)')")) && (await q("select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'team_list'")).rows[0].n === 0);
  {
    const after = track(await run('snapshot'));
    const same = JSON.stringify(after.events.filter((e) => e.msg === 'prod-sql.statement').map((e) => e.digest)) === JSON.stringify((globalThis as { __snapBefore?: string[] }).__snapBefore);
    info('T-BACKOUT (snapshot before M1 vs after all backouts, digests)', same ? 'identical' : 'DIFFERENT (the sign-in tables and roles are retained by design; not asserted here)');
  }

  // ---- 8b. security-hardening-backout for real, on the database the forward hardening migration (20260722223300) built: anon starts WITHOUT execute on the functions.
  {
    const anonCan = async (): Promise<string> => JSON.stringify((await q("select has_function_privilege('anon', 'public.dashboard_totals()', 'execute') as public_fn, has_function_privilege('anon', 'internal.is_staff()', 'execute') as internal_fn")).rows[0]);
    const bodies = async (): Promise<string> => (await q("select md5(string_agg(p.oid::regprocedure::text || ':' || md5(p.prosrc), '|' order by p.oid::regprocedure::text)) as h from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'internal')")).rows[0].h as string;
    const profiles = async (): Promise<string> => String((await q('select count(*) as n from public.profiles')).rows[0].n);
    check('hardening backout, before: the forward hardening is in force (anon cannot execute a public or an internal function)', (await anonCan()) === JSON.stringify({ public_fn: false, internal_fn: false }));
    const fp = await fingerprint();
    const bodiesBefore = await bodies();
    const profilesBefore = await profiles();
    const failed = track(await run('security-hardening-backout', { failAtQuery: 4 })); // 1 begin (the file's own), 2 set local, 3 first grant (runs), 4 second grant (injected failure)
    check('hardening backout with an injected failure after the first re-grant: rolled_back, nothing committed, the catalogue fingerprint and anon privileges are unchanged', failed.error !== undefined && resultOf(failed) === 'rolled_back' && ranOf(failed) === 1 && (await fingerprint()) === fp && (await anonCan()) === JSON.stringify({ public_fn: false, internal_fn: false }));
    const o = track(await run('security-hardening-backout'));
    check('hardening backout: committed as written (one begin and one commit, both from the file) and anon can now execute the public and the internal function', o.error === undefined && resultOf(o) === 'committed' && o.sent.filter((x) => ctlOf(x) === 'begin').length === 1 && o.sent.filter((x) => ctlOf(x) === 'commit').length === 1 && o.sent.length === 7
      && (await anonCan()) === JSON.stringify({ public_fn: true, internal_fn: true }));
    check('hardening backout changed no function body, no table and no row (function bodies and the profile count are identical)', (await bodies()) === bodiesBefore && (await profiles()) === profilesBefore);
    const again = track(await run('security-hardening-backout'));
    check('hardening backout again is safe to repeat: committed, same privileges', again.error === undefined && resultOf(again) === 'committed' && (await anonCan()) === JSON.stringify({ public_fn: true, internal_fn: true }));
  }

  // ---- Everything printed passes the wrapper allow-list with nothing withheld and carries no database text.
  {
    const counter = { fields: 0 };
    const withheld = allEvents.filter((e) => wrapper.allowListLine(JSON.stringify(e), counter) === null).length;
    check('every event of the whole run passes the wrapper allow-list: 0 withheld lines, 0 withheld fields', withheld === 0 && counter.fields === 0 && allEvents.length > 20);
    check('no event carries SQL text, an address, a role password or driver text', !/redacted-pw|pooler|127\.0\.0\.1|relation |already exists|insert into|create table|drop function|postgres:/i.test(JSON.stringify(allEvents)));
  }

  await admin.end();
  console.log(`prod-sql A3: ${n} checks passed`);
}

await main();
