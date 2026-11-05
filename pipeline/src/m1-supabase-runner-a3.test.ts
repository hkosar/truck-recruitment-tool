// A3 LOCAL test (TRUCKRECRU-125): M1 applied by a Supabase-like runner login, not by a superuser. On PostgreSQL 16+ a
// NOSUPERUSER CREATEROLE login (Supabase "postgres") that creates recruiter_api gets an ADMIN-only membership (no SET, no
// INHERIT), and a PostGIS schema it does not own may give it USAGE without GRANT OPTION. Both made apply-m1 stop with P0001 on
// staging-2 (thread-storage thr_c6aiqd8jbs/m1-p0001-investigation.md); the other A3 builds apply M1 as the superuser and so
// never saw it. This suite runs the runner's real apply-m1 plan and executor (planRebuiltSqlRun / executeRebuiltSqlPlan: two
// session settings, then the whole file as ONE simple query, no begin) with an injected loopback client logged in as that login.
//   1. negative: PostGIS in "extensions", the login has USAGE there WITHOUT grant option: M1 must stop with the specific
//      message, and the database (catalogue snapshot) and the cluster's roles must be exactly as before;
//   2. PostGIS in public (PUBLIC keeps EXECUTE on the PostGIS routines, as on hosted Supabase): M1 must apply;
//   3. PostGIS in "extensions", USAGE WITH GRANT OPTION: M1 must apply;
//   4. negative: PostGIS in "extensions", USAGE WITH GRANT OPTION, but PUBLIC EXECUTE removed from the PostGIS stand-ins and the login
//      has EXECUTE on them WITHOUT grant option: M1 must stop with the specific EXECUTE message and leave nothing behind (case 4 runs
//      on a copy of the pristine negative database, made at the start with CREATE DATABASE ... TEMPLATE, so no fourth URL is needed).
// After an apply: recruiter_api works for spatial calls, and the login's recruiter_api membership is again only the ADMIN-only
// grant PostgreSQL made (the self-check revoked exactly what it granted). Then, as the same login and through the real runner
// plans, runbook v3.3 sections 3.2-3.6 (TRUCKRECRU-126): apply-m1b, apply-m1c, batch-delete-compare (match true), role-matrix-m1
// (62/62, catalogue unchanged afterwards, membership still ADMIN-only) and postgis-placement. Like hosted Supabase (assumed, not
// verified), the login is made a member of anon, authenticated and service_role by the superuser.
// Before the passing role-matrix run, its failure paths (TRUCKRECRU-134, from Codex review thr_yb422uqwxk): a wrong gate, an error
// right after its SET-option grant, an error mid-probe (both injected into the plan in memory, never into the file), and a second
// login without ADMIN on recruiter_api. Each must fail closed and, once the executor has closed the connection, leave nothing behind:
// the catalogue (memberships with grantor and options), every table's rows, and every sequence's settings and stored counter (counters
// never roll back, so only the matrix's own measured counters may move forward; every other sequence must be byte-identical, and a
// regression check proves a setval(..., false) on a never-called counter is caught, round 2 from Codex review thr_iygk8stb9p). Not covered: other databases and cluster settings, statistics, WAL/xid counters.
// Needs its OWN throwaway cluster (roles are cluster-wide and no recruiter_* role may exist before a case) with three databases
// built by scripts/a3-build-test-db.mjs --no-m1 --no-m1b --no-m1c (the two "extensions" ones with --postgis-schema extensions).
// Each case drops its database and the roles it made afterwards. Skipped unless all three URLs are set; loopback tr_ only.
// Run: M1SR_A3_PUBLIC_ADMIN_URL=... M1SR_A3_EXT_ADMIN_URL=... M1SR_A3_NEG_ADMIN_URL=... npx tsx src/m1-supabase-runner-a3.test.ts

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { executeRebuiltSqlPlan, planRebuiltSqlRun, REBUILT_STAGING_SQL_ACTIONS, type RebuiltSqlPlan } from './staging-rebuilt.js';
import { classifyRunnerFailure } from './refusals.js';

const URLS = { public: process.env.M1SR_A3_PUBLIC_ADMIN_URL, ext: process.env.M1SR_A3_EXT_ADMIN_URL, neg: process.env.M1SR_A3_NEG_ADMIN_URL };
const REF = 'abcdefghijklmnopqrst';
const FAKE_URL = `postgresql://postgres.${REF}:redacted-pw@aws-0-us-east-2.pooler.supabase.com:5432/postgres`;
const RUNNER = 'tr_m1_runner';
/** A second Supabase-like login that did not create recruiter_api, so it has no ADMIN on it (the role matrix's missing-ADMIN case). */
const NO_ADMIN_RUNNER = 'tr_m1_runner_noadmin';
const M1_ROLES = ['recruiter_api', 'recruiter_app', 'recruiter_maintenance'];
const NEG_EXEC_MESSAGE = 'M1: the runner cannot pass on EXECUTE on PostGIS routine(s) st_distance, st_dwithin, st_makeline, st_makepoint, st_setsrid, st_x, st_y to recruiter_api (it needs EXECUTE WITH GRANT OPTION, or PUBLIC must keep EXECUTE)';
const NEG_MESSAGE = 'M1: the runner cannot pass on USAGE on PostGIS schema extensions to recruiter_api (it needs USAGE WITH GRANT OPTION on that schema)';

/** Gives the runner login what Supabase's postgres has: the database, schema internal and every non-extension object of public and
 *  internal (the PostGIS routines stay with the superuser, as supabase_admin owns PostGIS), and the realtime publication. */
const HANDOVER_SQL = `do $x$
declare r record;
begin
  execute format('alter database %I owner to ${RUNNER}', current_database());
  execute 'alter schema internal owner to ${RUNNER}';
  for r in select c.oid::regclass as o from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname in ('public', 'internal') and c.relkind in ('r', 'v', 'm', 'p', 'f')
             and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e') loop
    execute format('alter table %s owner to ${RUNNER}', r.o);
  end loop;
  for r in select c.oid::regclass as o from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname in ('public', 'internal') and c.relkind = 'S'
             and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype in ('a', 'i', 'e')) loop
    execute format('alter sequence %s owner to ${RUNNER}', r.o);
  end loop;
  for r in select p.oid::regprocedure as o from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname in ('public', 'internal')
             and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e') loop
    execute format('alter routine %s owner to ${RUNNER}', r.o);
  end loop;
  for r in select t.oid::regtype as o from pg_type t join pg_namespace n on n.oid = t.typnamespace
           where n.nspname in ('public', 'internal') and t.typtype in ('e', 'd', 'c') and t.typrelid = 0
             and not exists (select 1 from pg_depend d where d.classid = 'pg_type'::regclass and d.objid = t.oid and d.deptype = 'e') loop
    execute format('alter type %s owner to ${RUNNER}', r.o);
  end loop;
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    execute 'alter publication supabase_realtime owner to ${RUNNER}';
  end if;
end $x$`;

/** The shim's empty stand-in extension (test_ext5, or tsm_system_rows emptied by a3-build-test-db.mjs where test_ext5 is not installed, as in the
 *  PostgreSQL 17 binaries): the one extension that owns st_x, found the way M1 finds PostGIS. A scalar subquery, so two owners are an error. */
const STANDIN_EXT_SQL = `(select d0.refobjid from pg_depend d0 join pg_proc p0 on p0.oid = d0.objid where d0.classid = 'pg_proc'::regclass and d0.refclassid = 'pg_extension'::regclass and d0.deptype = 'e' and p0.proname = 'st_x')`;

/** Hosted Supabase: the migrations' "revoke ... from public" on the PostGIS routines was run by a non-owner, so PUBLIC keeps EXECUTE. */
const PUBLIC_EXECUTE_SQL = `do $p$ declare r record; begin
  for r in select d.objid::regprocedure as fn from pg_depend d join pg_extension e on e.oid = d.refobjid
           where d.classid = 'pg_proc'::regclass and d.refclassid = 'pg_extension'::regclass and d.deptype = 'e' and e.oid = ${STANDIN_EXT_SQL} loop
    execute format('grant execute on routine %s to public', r.fn);
  end loop;
end $p$`;

/** Hosted-like worst case for EXECUTE: PUBLIC has none on the PostGIS stand-ins, the runner has it without grant option. */
const NO_PUBLIC_EXECUTE_SQL = `do $p$ declare r record; begin
  for r in select d.objid::regprocedure as fn from pg_depend d join pg_extension e on e.oid = d.refobjid
           where d.classid = 'pg_proc'::regclass and d.refclassid = 'pg_extension'::regclass and d.deptype = 'e' and e.oid = ${STANDIN_EXT_SQL} loop
    execute format('revoke execute on routine %s from public', r.fn);
    execute format('grant execute on routine %s to ${RUNNER}', r.fn);
  end loop;
end $p$`;

/** Everything M1 creates or changes in a database (relations, routines and their settings and ACLs, policies, triggers, schema ACLs,
 *  role settings, memberships, publication tables), as one digest. */
const SNAPSHOT_SQL = `select md5(string_agg(x, E'\\n' order by x)) as digest, count(*)::int as n from (
  select 'role:' || rolname from pg_roles where rolname like 'recruiter\\_%'
  union all select 'rel:' || n.nspname || '.' || c.relname || ':' || c.relkind::text || ':' || coalesce(c.relacl::text, '') || ':' || pg_get_userbyid(c.relowner)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg\\_toast%' and n.nspname not like 'pg\\_temp%'
  union all select 'att:' || attrelid::regclass::text || '.' || attname || ':' || coalesce(attacl::text, '') from pg_attribute where attacl is not null
  union all select 'proc:' || p.oid::regprocedure::text || ':' || coalesce(p.proconfig::text, '') || ':' || coalesce(p.proacl::text, '') || ':' || md5(p.prosrc) || ':' || pg_get_userbyid(p.proowner)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname not in ('pg_catalog', 'information_schema')
  union all select 'pol:' || polrelid::regclass::text || '.' || polname || ':' || coalesce(pg_get_expr(polqual, polrelid), '') || ':' || coalesce(pg_get_expr(polwithcheck, polrelid), '') || ':' || polroles::text from pg_policy
  union all select 'trg:' || tgrelid::regclass::text || '.' || tgname from pg_trigger where not tgisinternal
  union all select 'nsp:' || nspname || ':' || coalesce(nspacl::text, '') || ':' || pg_get_userbyid(nspowner) from pg_namespace
  union all select 'set:' || setdatabase::text || ':' || setrole::text || ':' || setconfig::text from pg_db_role_setting
  union all select 'mem:' || roleid::regrole::text || '>' || member::regrole::text || ':' || admin_option::text || inherit_option::text || set_option::text || ':by:' || grantor::regrole::text from pg_auth_members
  union all select 'defacl:' || defaclrole::regrole::text || ':' || defaclnamespace::text || ':' || defaclobjtype::text || ':' || defaclacl::text from pg_default_acl
  union all select 'pubrel:' || prpubid::text || ':' || prrelid::regclass::text from pg_publication_rel
  union all select 'seqdef:' || seqrelid::regclass::text || ':' || seqtypid::regtype::text || ':' || seqstart || ':' || seqincrement || ':' || seqmin || ':' || seqmax || ':' || seqcache || ':' || seqcycle::text from pg_sequence
) s(x)`;

/** Every row of every ordinary table outside the system schemas (application data, the auth shim, the ledgers), as one digest:
 *  per table its row count and an md5 over its rows as text. Read by the superuser admin, so row-level security hides nothing. */
const DATA_SNAPSHOT_SQL = `select md5(string_agg(x, E'\\n' order by x)) as digest, count(*)::int as n from (
  select c.oid::regclass::text || ':' || query_to_xml(format('select count(*) as n, md5(coalesce(string_agg(t::text, %L order by t::text), %L)) as h from %s t', E'\\n', '', c.oid::regclass), false, true, '')::text
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where c.relkind = 'r' and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg\\_toast%' and n.nspname not like 'pg\\_temp%'
) s(x)`;

/** Every sequence (temporary ones excluded) with its settings. Its stored counter (last_value, is_called, log_cnt) is then read from
 *  the sequence relation itself: pg_sequences.last_value is null while is_called is false, so it misses a setval(..., false) on a
 *  never-called counter (Codex review thr_iygk8stb9p). PostgreSQL never rolls a counter back (nextval is not transactional), so a
 *  rolled-back run may only move the allow-listed counters forward; every other sequence must be byte-identical. The catalogue
 *  snapshot above covers definitions, owners and ACLs as well. */
const SEQUENCE_LIST_SQL = `select n.nspname || '.' || c.relname as s, c.oid::regclass::text as rel, q.seqincrement::text as inc,
    q.seqtypid::regtype::text || ':' || q.seqstart || ':' || q.seqincrement || ':' || q.seqmin || ':' || q.seqmax || ':' || q.seqcache || ':' || q.seqcycle::text as settings
  from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_sequence q on q.seqrelid = c.oid
 where c.relkind = 'S' and n.nspname not like 'pg\\_temp%' and n.nspname not like 'pg\\_toast\\_temp%' order by 1`;
/** The only counters the role matrix may move (measured on this suite's databases; any other counter moving is a failure): its
 *  fixture rows in public.batch_activity and public.contact_suppressions, inserted before the probes, and in a full run also the
 *  rows M1's own functions write to internal.auth_events during the probes. */
const MATRIX_FIXTURE_SEQUENCES = ['public.batch_activity_id_seq', 'public.contact_suppressions_id_seq'];
const MATRIX_FULL_RUN_SEQUENCES = ['internal.auth_events_id_seq', ...MATRIX_FIXTURE_SEQUENCES];

async function main(): Promise<void> {
  if (!URLS.public || !URLS.ext || !URLS.neg) {
    console.log('skip M1 Supabase-runner A3 test (set M1SR_A3_PUBLIC_ADMIN_URL, M1SR_A3_EXT_ADMIN_URL and M1SR_A3_NEG_ADMIN_URL, loopback only)');
    return;
  }
  for (const v of Object.values(URLS)) {
    const u = new URL(v as string);
    if (u.search || u.hash || (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost')) throw new Error('refusing: test URLs must be loopback, without query or fragment');
    if (!/^\/tr_[a-z0-9_]+$/.test(u.pathname)) throw new Error('refusing: the test database names must start with tr_');
  }
  let n = 0;
  const check = (name: string, ok: boolean, detail = '') => { assert.ok(ok, `${name} ${detail}`); console.log(`PASS ${name}`); n += 1; };
  const runnerPw = randomBytes(24).toString('base64url');
  const maintenanceUrl = (() => { const u = new URL(URLS.public as string); u.pathname = '/postgres'; return u.toString(); })();

  /** One query on the cluster's maintenance database as the admin. */
  const onCluster = async <T>(fn: (c: pg.Client) => Promise<T>): Promise<T> => {
    const c = new pg.Client({ connectionString: maintenanceUrl });
    await c.connect();
    try { return await fn(c); } finally { await c.end(); }
  };
  // Case 4's database: a copy of the pristine negative database (taken before case 1 touches it; nobody is connected to it yet).
  const negCopyUrl = (() => { const u = new URL(URLS.neg as string); u.pathname = `${u.pathname}_exec`; return u.toString(); })();
  const existingM1Roles = () => onCluster(async (c) => (await c.query("select rolname from pg_roles where rolname = any($1) order by rolname", [[...M1_ROLES, RUNNER, NO_ADMIN_RUNNER]])).rows.map((r) => r.rolname as string));

  /** Drops the case's database (only if it carries a task ownership comment) and every role the case made. */
  const dropCase = async (dbUrl: string) => {
    const db = new URL(dbUrl).pathname.slice(1);
    await onCluster(async (c) => {
      const comment = (await c.query("select shobj_description(oid, 'pg_database') as c from pg_database where datname = $1", [db])).rows[0]?.c as string | undefined;
      if (comment !== undefined) {
        assert.match(comment ?? '', /^a3-task-owned:/, `refusing: ${db} is not task-owned`);
        await c.query(`drop database ${db}`);
      }
      for (const r of [...M1_ROLES, RUNNER, NO_ADMIN_RUNNER]) await c.query(`drop role if exists ${r}`);
    });
  };

  /** Sets up the runner login on one database the Supabase way, applies M1 through the real runner path, and returns the outcome. */
  const applyAsRunner = async (dbUrl: string, setup: (admin: pg.Client) => Promise<void>) => {
    assert.deepEqual(await existingM1Roles(), [], 'no recruiter_* role and no runner login may exist before a case (the PG16 rule only bites on creation)');
    const admin = new pg.Client({ connectionString: dbUrl });
    await admin.connect();
    try {
      const pwLiteral = `'${runnerPw.replace(/'/g, "''")}'`;
      await admin.query(`create role ${RUNNER} login nosuperuser createrole inherit password ${pwLiteral}`);
      await admin.query(HANDOVER_SQL);
      // Hosted Supabase makes postgres a member of anon, authenticated and service_role (granted by the superuser, so with the SET
      // option); the role matrix switches to anon and authenticated. Assumed from Supabase's role setup, not verified on staging-2.
      await admin.query(`grant anon, authenticated, service_role to ${RUNNER}`);
      await setup(admin);
      const runnerFacts = (await admin.query(`select rolsuper, rolcreaterole, rolinherit, current_setting('server_version_num')::int >= 160000 as pg16 from pg_roles where rolname = $1`, [RUNNER])).rows[0];
      check(`${new URL(dbUrl).pathname.slice(1)}: the runner login is NOSUPERUSER CREATEROLE INHERIT on PostgreSQL 16+`, runnerFacts.rolsuper === false && runnerFacts.rolcreaterole === true && runnerFacts.rolinherit === true && runnerFacts.pg16 === true);
      const before = (await admin.query(SNAPSHOT_SQL)).rows[0];

      const { error, events, plan } = await runAsRunner(dbUrl, 'apply-m1');
      const after = (await admin.query(SNAPSHOT_SQL)).rows[0];
      return { admin, error, events, before, after, plan };
    } catch (e) {
      await admin.end();
      throw e;
    }
  };

  /** One staging-runner action (its real plan and executor) as the runner login (or `login`), on its own connection. `alter` changes
   *  the real plan in memory only, for the injected failure cases; the SQL files are never touched. */
  const runAsRunner = async (dbUrl: string, action: string, opts: { login?: string; alter?: (p: RebuiltSqlPlan) => RebuiltSqlPlan } = {}) => {
    const runnerUrl = new URL(dbUrl);
    runnerUrl.username = opts.login ?? RUNNER;
    runnerUrl.password = runnerPw;
    const client = new pg.Client({ connectionString: runnerUrl.toString() });
    const real = planRebuiltSqlRun({ action, dbUrl: FAKE_URL, confirm: REBUILT_STAGING_SQL_ACTIONS[action]!.confirmation, recordedRebuiltRef: REF });
    const plan = opts.alter ? opts.alter(real) : real;
    const log = console.log; const err = console.error;
    const events: Array<Record<string, unknown>> = [];
    console.log = (...a: unknown[]) => { try { events.push(JSON.parse(String(a[0]))); } catch { /* not an event */ } };
    console.error = console.log;
    let error: (Error & { code?: string; id?: string }) | undefined;
    try {
      await executeRebuiltSqlPlan(plan, () => client as never);
    } catch (e) {
      error = e as Error & { code?: string; id?: string };
    } finally {
      console.log = log; console.error = err;
      await client.end().catch(() => undefined);
    }
    return { error, events, plan };
  };
  const describe = (e: (Error & { code?: string; id?: string }) | undefined) => `error=${e?.id ?? ''} ${e?.code ?? ''} ${e?.message ?? ''}`;

  type SequenceState = { settings: string; inc: string; lastValue: string; isCalled: boolean; logCnt: string };
  /** Every sequence's settings and stored counter, read by the superuser admin from the sequence relation itself. */
  const sequenceStates = async (admin: pg.Client) => {
    const out = new Map<string, SequenceState>();
    for (const r of (await admin.query(SEQUENCE_LIST_SQL)).rows) {
      const v = (await admin.query(`select last_value::text as v, is_called, log_cnt::text as l from ${r.rel as string}`)).rows[0];
      out.set(r.s as string, { settings: r.settings as string, inc: r.inc as string, lastValue: v.v as string, isCalled: v.is_called as boolean, logCnt: v.l as string });
    }
    return out;
  };
  /** What a rolled-back role matrix run must not change: the catalogue snapshot (memberships with grantor and options included), every
   *  table's rows, and every sequence's settings and stored counter (read separately: only allow-listed counters may move forward). */
  const stateOf = async (admin: pg.Client) => ({
    catalogue: (await admin.query(SNAPSHOT_SQL)).rows[0] as { digest: string; n: number },
    data: (await admin.query(DATA_SNAPSHOT_SQL)).rows[0] as { digest: string; n: number },
    sequences: await sequenceStates(admin),
  });
  type State = Awaited<ReturnType<typeof stateOf>>;
  /** True if `a` is where nextval calls can take a counter that was at `b` (same settings, called, never back past b). */
  const movedForward = (b: SequenceState, a: SequenceState) => {
    if (a.settings !== b.settings || !a.isCalled) return false;
    const up = BigInt(b.inc) > 0n, bv = BigInt(b.lastValue), av = BigInt(a.lastValue);
    // An uncalled counter's next nextval returns last_value itself, so it may stay equal; a called one must have moved past it.
    return b.isCalled ? (up ? av > bv : av < bv) : (up ? av >= bv : av <= bv);
  };
  /** Empty problems when nothing was left behind; otherwise what differs. Only the `allowed` counters may differ, and only by moving
   *  forward; every other sequence must be byte-identical (settings, last_value, is_called, log_cnt). The counters that moved are
   *  returned separately, so the caller can require exactly the expected set. */
  const compareStates = (before: State, after: State, allowed: readonly string[]) => {
    const problems: string[] = [];
    if (before.catalogue.digest !== after.catalogue.digest || before.catalogue.n !== after.catalogue.n) problems.push(`catalogue ${before.catalogue.n}->${after.catalogue.n}`);
    if (before.data.digest !== after.data.digest || before.data.n !== after.data.n) problems.push(`table rows (${before.data.n}->${after.data.n} tables)`);
    const advanced: string[] = [];
    for (const name of new Set([...before.sequences.keys(), ...after.sequences.keys()])) {
      const b = before.sequences.get(name), a = after.sequences.get(name);
      if (!b || !a) { problems.push(`sequence ${name} appeared or vanished`); continue; }
      if (JSON.stringify(a) === JSON.stringify(b)) continue;
      if (allowed.includes(name) && movedForward(b, a)) advanced.push(name);
      else problems.push(`sequence ${name} changed${allowed.includes(name) ? ' other than forward' : ' (not allow-listed)'}: ${JSON.stringify(b)} -> ${JSON.stringify(a)}`);
    }
    return { problems, advanced: advanced.sort() };
  };

  const assertApplied = async (label: string, dbUrl: string, schema: string, setup: (admin: pg.Client) => Promise<void>) => {
    const o = await applyAsRunner(dbUrl, setup);
    try {
      check(`${label}: the runner's apply-m1 plan is the M1 file as one step without a transaction`, o.plan.steps.length === 1 && o.plan.steps[0]!.transaction === false);
      check(`${label}: M1 applies as the Supabase-like runner`, o.error === undefined && o.events.some((e) => e.msg === 'staging-sql.step_done'), `error=${o.error?.code ?? ''} ${o.error?.message ?? ''}`);
      const q = async (sql: string, params?: unknown[]) => (await o.admin.query(sql, params)).rows;
      const mem = await q(`select admin_option, inherit_option, set_option from pg_auth_members where roleid = 'recruiter_api'::regrole and member = $1::regrole`, [RUNNER]);
      check(`${label}: the runner's recruiter_api membership is again only PostgreSQL's ADMIN-only grant (the self-check revoked exactly its own grant)`,
        JSON.stringify(mem) === '[{"admin_option":true,"inherit_option":false,"set_option":false}]', JSON.stringify(mem));
      const facts = (await q(`select pg_has_role($1, 'recruiter_api', 'SET') as can_set, pg_has_role($1, 'recruiter_api', 'USAGE') as uses,
          has_schema_privilege('recruiter_api', $2, 'usage') as api_usage, to_regclass('internal.app_sessions') is not null as sessions,
          (select count(*)::int from pg_trigger where tgname like '%\\_recheck\\_session') as rechecks`, [RUNNER, schema]))[0];
      check(`${label}: afterwards the runner can neither SET ROLE recruiter_api nor use its rights; M1's objects exist`,
        facts.can_set === false && facts.uses === false && facts.api_usage === true && facts.sessions === true && facts.rechecks > 0, JSON.stringify(facts));
      if (schema !== 'public') {
        const path = (await q(`select setconfig::text as s from pg_db_role_setting where setrole = 'recruiter_app'::regrole and setdatabase = (select oid from pg_database where datname = current_database())`))[0]?.s as string | undefined;
        check(`${label}: recruiter_app's search_path in this database includes ${schema}`, path === `{"search_path=public, ${schema}"}`, String(path));
      }
      await o.admin.query('begin');
      try {
        await o.admin.query('set local role recruiter_api');
        const r = (await o.admin.query(`select count(*)::int as n from internal.matching_carriers('{"zones":[{"zone_type":"radius","params":{"lat":30.27,"lng":-97.74,"radius_miles":1}}]}'::jsonb)`)).rows[0];
        check(`${label}: recruiter_api can run the spatial matcher`, typeof r.n === 'number');
      } finally {
        await o.admin.query('rollback');
      }
      // Runbook v3.3 sections 3.2-3.6 after M1, as the same runner login, through the real runner plans (TRUCKRECRU-126).
      for (const action of ['apply-m1b', 'apply-m1c']) {
        const s = await runAsRunner(dbUrl, action);
        check(`${label}: ${action} applies as the Supabase-like runner`, s.error === undefined && s.events.some((e) => e.msg === 'staging-sql.step_done'), describe(s.error));
      }
      {
        const s = await runAsRunner(dbUrl, 'batch-delete-compare');
        const ev = s.events.find((e) => e.msg === 'staging-sql.batch_delete_compare');
        check(`${label}: batch-delete-compare as the runner reports match true`, s.error === undefined && ev?.match === true, `${describe(s.error)} ${JSON.stringify(ev)}`);
      }
      // PostgreSQL records the bootstrap superuser as grantor of the ADMIN-only membership it gives a CREATEROLE creator (PG16).
      const runnerGrantor = (await q(`select grantor::regrole::text as g from pg_auth_members where roleid = 'recruiter_api'::regrole and member = $1::regrole`, [RUNNER]))[0]?.g as string;
      check(`${label}: the runner's ADMIN-only recruiter_api membership was granted by the bootstrap superuser`,
        runnerGrantor === (await q(`select rolname from pg_roles where oid = 10`))[0]?.rolname, String(runnerGrantor));
      const adminOnlyMembership = async () => {
        const mem = (await o.admin.query(`select admin_option, inherit_option, set_option, grantor::regrole::text as grantor from pg_auth_members where roleid = 'recruiter_api'::regrole and member = $1::regrole`, [RUNNER])).rows;
        return { ok: JSON.stringify(mem) === `[{"admin_option":true,"inherit_option":false,"set_option":false,"grantor":"${runnerGrantor}"}]`, detail: JSON.stringify(mem) };
      };
      // Failure paths of role-matrix-m1 as the runner (Codex review thr_yb422uqwxk, TRUCKRECRU-134), before the passing run. Each must fail
      // closed (the error, step_failed, no step_done), and after the executor has closed the failed connection nothing may be left
      // behind: catalogue (memberships with grantor and options), every table's rows, sequences byte-identical but for allow-listed counters moving forward, and the runner's
      // recruiter_api membership again the ADMIN-only grant (so the matrix's SET-option grant was undone, not kept).
      const failsClosed = async (name: string, expect: { code: string; message: (m: string) => boolean }, opts: Parameters<typeof runAsRunner>[2], allowedAdvance: string[]) => {
        const before = await stateOf(o.admin);
        const s = await runAsRunner(dbUrl, 'role-matrix-m1', opts);
        check(`${label}: ${name} fails closed with ${expect.code} (step_failed, no step_done, no matrix counts)`, s.error?.code === expect.code && expect.message(s.error?.message ?? '')
          && s.events.some((e) => e.msg === 'staging-sql.step_failed') && !s.events.some((e) => e.msg === 'staging-sql.step_done' || e.msg === 'staging-sql.role_matrix'), describe(s.error));
        const cmp = compareStates(before, await stateOf(o.admin), allowedAdvance);
        const mem = await adminOnlyMembership();
        check(`${label}: ${name} left nothing behind once the executor closed the failed connection (catalogue incl. membership grantor/options, table rows, sequences${allowedAdvance.length ? ` only ${allowedAdvance.join(', ')} moved forward` : ' unmoved'})`,
          cmp.problems.length === 0 && JSON.stringify(cmp.advanced) === JSON.stringify(allowedAdvance) && mem.ok, `${cmp.problems.join('; ')} advanced=${cmp.advanced.join(',')} membership=${mem.detail}`);
      };
      /** Inserts `sql` once after the only match of `anchor` in the matrix step, in memory; refuses if the anchor is not exactly once there. */
      const inject = (anchor: string, sql: string) => (p: RebuiltSqlPlan): RebuiltSqlPlan => {
        assert.equal(p.steps.length, 1, 'role-matrix-m1 is one step');
        const text = p.steps[0]!.sql;
        assert.equal(text.split(anchor).length, 2, `injection anchor must occur exactly once: ${anchor}`);
        return { ...p, steps: [{ ...p.steps[0]!, sql: text.replace(anchor, `${anchor}\n${sql}\n`) }] };
      };
      // Regression (Codex review thr_iygk8stb9p): between two snapshots the superuser moves a never-called counter outside the allow-list
      // with setval(..., false), which pg_sequences.last_value (null while is_called is false) does not show. The comparison must report
      // it; with the counter put back, every sequence must be byte-identical again.
      {
        const pick = (await q(`select schemaname || '.' || sequencename as s, format('%I.%I', schemaname, sequencename) as rel from pg_sequences
            where last_value is null and not (schemaname || '.' || sequencename) = any($1)
            order by (schemaname || '.' || sequencename) <> 'internal.batch_delete_audit_id_seq', 1 limit 1`, [MATRIX_FULL_RUN_SEQUENCES]))[0];
        assert.ok(pick, 'a never-called sequence outside the allow-list must exist for the regression check');
        const old = (await q(`select last_value::text as v, is_called from ${pick.rel as string}`))[0];
        assert.equal(old.is_called, false, `${pick.s} must be never-called`);
        const before = await stateOf(o.admin);
        await o.admin.query(`select setval($1::regclass, $2::bigint + 1000, false)`, [pick.rel, old.v]);
        const moved = compareStates(before, await stateOf(o.admin), MATRIX_FULL_RUN_SEQUENCES);
        check(`${label}: regression: setval(${pick.s}, ${old.v} -> ${BigInt(old.v) + 1000n}, false) on a never-called, not allow-listed counter is reported`,
          moved.problems.some((p) => p.includes(`sequence ${pick.s} `)), `${moved.problems.join('; ')} advanced=${moved.advanced.join(',')}`);
        await o.admin.query(`select setval($1::regclass, $2::bigint, false)`, [pick.rel, old.v]);
        const back = compareStates(before, await stateOf(o.admin), MATRIX_FULL_RUN_SEQUENCES);
        check(`${label}: regression: with ${pick.s} put back, every sequence is byte-identical again`, back.problems.length === 0 && back.advanced.length === 0,
          `${back.problems.join('; ')} advanced=${back.advanced.join(',')}`);
      }
      await failsClosed('wrong gate (the runner verified a different project ref)', { code: 'P0001', message: (m) => m.startsWith('role matrix refused:') },
        { alter: (p) => ({ ...p, settings: p.settings.map(([k, v]) => (k === 'app.staging_runner_verified_ref' ? [k, 'zzzzzzzzzzzzzzzzzzzz'] as const : [k, v] as const)) }) }, []);
      // P0098 instead of 22012 would mean the SET option was not there yet, i.e. the injection did not land after the grant.
      await failsClosed('error right after the SET-option grant', { code: '22012', message: () => true },
        { alter: inject('$set_option$;', `do $inj$ begin if not pg_has_role(current_user, 'recruiter_api', 'SET') then raise exception using errcode = 'P0098', message = 'injected: no SET option yet'; end if; perform 1/0; end $inj$;`) }, []);
      await failsClosed('error mid-probe (after SET ROLE recruiter_api and earlier probes recorded)', { code: '22012', message: () => true },
        { alter: inject('select pg_temp.as_session(null);', `do $inj$ begin if current_user <> 'recruiter_api' or (select count(*) from _results) = 0 then raise exception using errcode = 'P0098', message = 'injected: not mid-probe'; end if; perform 1/0; end $inj$;`) }, MATRIX_FIXTURE_SEQUENCES);
      {
        // A second Supabase-like login with no ADMIN on recruiter_api (it did not create it): the matrix's grant is refused.
        await o.admin.query(`create role ${NO_ADMIN_RUNNER} login nosuperuser createrole inherit password '${runnerPw.replace(/'/g, "''")}'`);
        try {
          check(`${label}: the second login has no ADMIN, SET or membership on recruiter_api`,
            (await q(`select not pg_has_role($1, 'recruiter_api', 'MEMBER') and not exists (select 1 from pg_auth_members where roleid = 'recruiter_api'::regrole and member = $1::regrole) as ok`, [NO_ADMIN_RUNNER]))[0]?.ok === true);
          await failsClosed('a runner without ADMIN on recruiter_api', { code: '42501', message: (m) => m === 'permission denied to grant role "recruiter_api"' }, { login: NO_ADMIN_RUNNER }, []);
        } finally {
          await o.admin.query(`drop role ${NO_ADMIN_RUNNER}`);
        }
      }
      {
        const before = await stateOf(o.admin);
        const s = await runAsRunner(dbUrl, 'role-matrix-m1');
        const ev = s.events.find((e) => e.msg === 'staging-sql.role_matrix');
        check(`${label}: role-matrix-m1 as the runner passes 62/62`, s.error === undefined && JSON.stringify(ev) === '{"msg":"staging-sql.role_matrix","ok":true,"total":62,"passed":62,"failed":0}'
          && s.events.some((e) => e.msg === 'staging-sql.step_done'), `${describe(s.error)} ${JSON.stringify(ev)}`);
        const cmp = compareStates(before, await stateOf(o.admin), MATRIX_FULL_RUN_SEQUENCES);
        check(`${label}: the role matrix left nothing behind (catalogue snapshot incl. membership grantor/options identical, every table's rows identical, sequences only ${MATRIX_FULL_RUN_SEQUENCES.join(', ')} moved forward)`,
          cmp.problems.length === 0 && JSON.stringify(cmp.advanced) === JSON.stringify(MATRIX_FULL_RUN_SEQUENCES), `${cmp.problems.join('; ')} advanced=${cmp.advanced.join(',')}`);
        const mem = await adminOnlyMembership();
        check(`${label}: after the role matrix the runner's recruiter_api membership is still only the ADMIN-only grant (same grantor)`, mem.ok, mem.detail);
      }
      {
        const s = await runAsRunner(dbUrl, 'postgis-placement');
        const ev = s.events.find((e) => e.msg === 'staging-sql.postgis_placement');
        // The shim's PostGIS stand-ins belong to its stand-in extension (STANDIN_EXT_SQL), not an extension named postgis, so the true answer here is "absent"
        // (as in backout-rehearsal-a3.test.ts); this proves only that the read runs for the runner login.
        check(`${label}: postgis-placement runs as the runner (stand-in extension: "absent")`, s.error === undefined && ev?.schema === 'absent', `${describe(s.error)} ${JSON.stringify(ev)}`);
      }
    } finally {
      await o.admin.end();
    }
    await dropCase(dbUrl);
    check(`${label}: case cleaned up (its database and roles dropped)`, (await existingM1Roles()).length === 0);
  };

  try {
    {
      const src = new URL(URLS.neg as string).pathname.slice(1);
      const copy = new URL(negCopyUrl).pathname.slice(1);
      await onCluster(async (c) => {
        const comment = (await c.query("select shobj_description(oid, 'pg_database') as c from pg_database where datname = $1", [src])).rows[0]?.c as string | undefined;
        assert.match(comment ?? '', /^a3-task-owned:/, `refusing: ${src} is not task-owned`);
        await c.query(`create database ${copy} template ${src}`);
        await c.query(`comment on database ${copy} is '${comment!.replace(/'/g, "''")}'`);
      });
    }
    // 1. Negative: PostGIS in extensions, USAGE without grant option, PUBLIC has none there (the shim grants anon/authenticated/
    //    service_role only). M1 must stop with the specific message and leave nothing behind.
    {
      const o = await applyAsRunner(URLS.neg, async (a) => { await a.query(`grant usage on schema extensions to ${RUNNER}`); });
      try {
        check('negative: the runner has USAGE on extensions without grant option and PUBLIC has no USAGE there',
          (await o.admin.query(`select has_schema_privilege($1, 'extensions', 'usage') and not has_schema_privilege($1, 'extensions', 'usage with grant option') and not has_schema_privilege('public', 'extensions', 'usage') as ok`, [RUNNER])).rows[0].ok === true);
        check('negative: M1 stops with P0001 and the specific grant-option message', o.error?.code === 'P0001' && o.error?.message === NEG_MESSAGE, `error=${o.error?.code ?? ''} ${o.error?.message ?? ''}`);
        check('negative: the refusal carries only the fixed M1 check id (TRUCKRECRU-127), never the message', JSON.stringify(classifyRunnerFailure(o.error)) === '{"refusal":"server_or_driver_error","err_code":"P0001","m1_check":"m1_postgis_schema_usage_no_grant_option"}', JSON.stringify(classifyRunnerFailure(o.error)));
        check('negative: the runner reported the failed step and no step_done', o.events.some((e) => e.msg === 'staging-sql.step_failed') && !o.events.some((e) => e.msg === 'staging-sql.step_done'));
        check('negative: nothing was applied (catalogue snapshot identical, no recruiter_* role)', o.before.digest === o.after.digest && o.before.n === o.after.n
          && (await o.admin.query("select count(*)::int as n from pg_roles where rolname like 'recruiter\\_%'")).rows[0].n === 0, `before=${o.before.n} after=${o.after.n}`);
      } finally {
        await o.admin.end();
      }
      await dropCase(URLS.neg);
    }
    // 4. Negative: USAGE WITH GRANT OPTION, but no EXECUTE to pass on (PUBLIC has none, the runner has it without grant option).
    {
      const o = await applyAsRunner(negCopyUrl, async (a) => { await a.query(`grant usage on schema extensions to ${RUNNER} with grant option`); await a.query(NO_PUBLIC_EXECUTE_SQL); });
      try {
        check('negative EXECUTE: the runner has EXECUTE on the PostGIS stand-ins without grant option and PUBLIC has none',
          (await o.admin.query(`select count(*)::int as n, bool_and(has_function_privilege($1, p.oid, 'execute') and not has_function_privilege($1, p.oid, 'execute with grant option') and not has_function_privilege('public', p.oid, 'execute')) as ok
             from pg_proc p join pg_depend d on d.objid = p.oid and d.classid = 'pg_proc'::regclass and d.deptype = 'e' join pg_extension e on e.oid = d.refobjid where e.oid = ${STANDIN_EXT_SQL}`, [RUNNER])).rows[0].ok === true);
        check('negative EXECUTE: M1 stops with P0001 and the specific EXECUTE grant-option message', o.error?.code === 'P0001' && o.error?.message === NEG_EXEC_MESSAGE, `error=${o.error?.code ?? ''} ${o.error?.message ?? ''}`);
        check('negative EXECUTE: the runner reported the failed step and no step_done', o.events.some((e) => e.msg === 'staging-sql.step_failed') && !o.events.some((e) => e.msg === 'staging-sql.step_done'));
        check('negative EXECUTE: nothing was applied (catalogue snapshot incl. default privileges identical, no recruiter_* role)', o.before.digest === o.after.digest && o.before.n === o.after.n
          && (await o.admin.query("select count(*)::int as n from pg_roles where rolname like 'recruiter\\_%'")).rows[0].n === 0, `before=${o.before.n} after=${o.after.n}`);
      } finally {
        await o.admin.end();
      }
      await dropCase(negCopyUrl);
    }
    // 2. PostGIS in public.
    await assertApplied('public', URLS.public, 'public', async (a) => { await a.query(PUBLIC_EXECUTE_SQL); });
    // 3. PostGIS in extensions, USAGE WITH GRANT OPTION (what Supabase is believed to give postgres; not verified on hosted).
    await assertApplied('extensions', URLS.ext, 'extensions', async (a) => { await a.query(`grant usage on schema extensions to ${RUNNER} with grant option`); });
  } finally {
    // Leaves the cluster without the case roles even after a failed check (later cases and reruns need them absent).
    for (const v of [...Object.values(URLS), negCopyUrl]) await dropCase(v as string).catch(() => undefined);
  }
  console.log(`PASS m1-supabase-runner: ${n} checks passed`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
