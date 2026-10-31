// DRAFT, PENDING REVIEW. A3 LOCAL test of the DRAFT production SQL files: the read-only actions read-only-inventory and bootstrap-identity-check (run through the real planner and
// executor), and the two DO NOT USE backouts (profile-bootstrap-backout, dnc-enum-cast-backout), which the planner refuses and which are applied here DIRECTLY, only as a negative control
// against a REAL PostgreSQL database on a throwaway local cluster. It builds the state BEFORE the July A2 migrations itself (the Supabase shim, the staging
// profile fixtures, the A3 business fixtures, and the migrations up to and including 20260722223300_security_hardening.sql), then:
//   forward migration -> ASSERT the destination is usable and safe (passes) -> the historical backout text applied directly -> the SAME assertion FAILS (the catalogue is nevertheless
//   identical to the pre-migration state) -> the forward migration applies again and the assertion passes. "Retain the forward fix" is the documented disposition for both. The comparison is a catalogue fingerprint (function definitions, ACLs, owners, settings, triggers, tables, columns,
//   indexes, constraints, policies, roles, default privileges, enums) taken per section, so a difference names the section.
// The plan is made with a synthetic production address (the production guard refuses local URLs by design); only the CLIENT is replaced by a loopback client.
// Skipped unless PROD_SQL_A3_ADMIN_URL is set; it must be a LOOPBACK URL on the owned cluster's own port, a tr_ database, an EMPTY one (no public tables, no auth
// schema) whose comment is "a3-task-owned:...". DESTRUCTIVE TO THE THROWAWAY DATABASE ONLY. Build a fresh database for each run.
// The hosted half (Supabase's own roles and event triggers, TLS, the hosted runner login) is not covered.
// Run: PROD_SQL_A3_ADMIN_URL=... npx tsx src/prod-sql-a2-backouts-a3.test.ts

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { PROD_SQL_ACTIONS, executeProdSqlPlan, planProdSql } from './prod-sql.js';
import { RunnerRefusal } from './refusals.js';
import { splitSqlStatements, sqlControl } from './prod-sql-split.js';
import { REPOSITORY_ROOT } from './staging-rebuilt.js';
import { RECORDED_PROJECT_REFS } from './target-guard.js';

const ADMIN = process.env.PROD_SQL_A3_ADMIN_URL;
const PROD_URL = `postgresql://postgres.${RECORDED_PROJECT_REFS.production}:redacted-pw@aws-0-us-east-2.pooler.supabase.com:5432/postgres`;
const read = (rel: string) => readFileSync(resolve(REPOSITORY_ROOT, rel), 'utf8');

/** The same stand-in substitutions scripts/a3-build-test-db.mjs applies (PostGIS, pg_trgm and citext are replaced by the shim on this machine). */
const TRANSFORMS: Array<[RegExp, string]> = [
  [/create extension if not exists postgis;/g, '-- [A3 shim] postgis replaced by supabase-shim.sql stand-ins'],
  [/geography\(Point,\s*4326\)/g, 'geography'],
  [/using gist \(geom\)/g, 'using btree (geom)'],
  [/create extension if not exists pg_trgm;/g, '-- [A3 shim] pg_trgm unavailable'],
  [/create extension if not exists citext;/g, '-- [A3 shim] citext unavailable; citext is a text domain in supabase-shim.sql'],
  [/create index [a-z_]+ +on public\.[a-z_]+ using gin \([^;]*gin_trgm_ops\);/g, '-- [A3 shim] trigram index skipped'],
];
const HARDENING = '20260722223300_security_hardening.sql';
const FORWARD_PROFILE = 'supabase/migrations/20260723004500_profile_service_bootstrap.sql';
const FORWARD_DNC = 'supabase/migrations/20260723010400_dnc_activity_enum_cast.sql';

interface Outcome { events: Array<Record<string, unknown>>; error?: unknown; sent: string[] }
const ctlOf = (s: string) => { const first = splitSqlStatements(s)[0]; return first === undefined ? null : sqlControl(first); };

async function main(): Promise<void> {
  if (!ADMIN) {
    console.log('skip prod-sql A2-backouts A3 test (set PROD_SQL_A3_ADMIN_URL, loopback only)');
    return;
  }
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
  assert.equal((await q("select count(*)::int as n from pg_tables where schemaname in ('public', 'internal', 'auth')")).rows[0].n, 0, 'refusing: the database is not empty; build a fresh one');
  const wrapper = await import(pathToFileURL(resolve(REPOSITORY_ROOT, 'scripts/run-with-secrets.mjs')).href);
  let n = 0;
  const check = (name: string, ok: boolean) => { assert.ok(ok, name); console.log(`PASS ${name}`); n += 1; };

  // ---- Build the state before the July A2 migrations: shim, the 17 migrations up to and including the hardening one, fixtures.
  await q(read('supabase/tests/a3/harness/supabase-shim.sql'));
  const applied: string[] = [];
  for (const file of readdirSync(resolve(REPOSITORY_ROOT, 'supabase/migrations')).filter((f) => /^\d{14}_.+\.sql$/.test(f)).sort()) {
    if (file > HARDENING) break;
    let sql = read(`supabase/migrations/${file}`);
    for (const [re, rep] of TRANSFORMS) sql = sql.replace(re, rep);
    await q(sql);
    applied.push(file);
  }
  await q(read('supabase/staging/profile-fixtures.sql'));
  await q(read('supabase/tests/a3/harness/business-fixtures.sql'));
  check(`the pre-July database is built: ${applied.length} migrations, the last one is the hardening migration, and the three July migrations are NOT applied`, applied[applied.length - 1] === HARDENING && applied.length === 17
    && ((await q("select p.prosrc like '%service_role%' as has from pg_proc p where p.oid = 'internal.guard_profile_update()'::regprocedure")).rows[0].has === false)
    && ((await q("select p.prosrc like '%::activity_type%' as has from pg_proc p where p.oid = 'public.set_do_not_contact(bigint,boolean,text)'::regprocedure")).rows[0].has === false));

  /** The catalogue state the two backouts could touch, one md5 per section. */
  const fingerprint = async (): Promise<Record<string, string>> => {
    const sections: Record<string, string> = {
      functions: `select 'f:' || p.oid::regprocedure::text || ':' || md5(pg_get_functiondef(p.oid)) || ':' || md5(p.prosrc) || ':' || coalesce(p.proacl::text, '') || ':' || pg_get_userbyid(p.proowner) || ':' || coalesce(p.proconfig::text, '') || ':' || p.prosecdef::text || ':' || p.provolatile::text || ':' || p.prokind::text || ':' || p.proleakproof::text as x from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'internal', 'auth')`,
      triggers: `select 't:' || pg_get_triggerdef(t.oid) || ':' || t.tgenabled::text as x from pg_trigger t where not t.tgisinternal`,
      relations: `select 'c:' || n.nspname || '.' || c.relname || ':' || c.relkind::text || ':' || coalesce(c.relacl::text, '') || ':' || c.relrowsecurity::text || ':' || pg_get_userbyid(c.relowner) as x from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public', 'internal', 'auth')`,
      columns: `select 'a:' || a.attrelid::regclass::text || '.' || a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text || ':' || coalesce(a.attacl::text, '') || ':' || coalesce(pg_get_expr(d.adbin, d.adrelid), '') as x from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum where n.nspname in ('public', 'internal', 'auth') and a.attnum > 0 and not a.attisdropped`,
      indexes: `select 'i:' || schemaname || ':' || indexdef as x from pg_indexes where schemaname in ('public', 'internal', 'auth')`,
      constraints: `select 'k:' || conrelid::regclass::text || ':' || conname || ':' || pg_get_constraintdef(oid) || ':' || convalidated::text as x from pg_constraint where connamespace in (select oid from pg_namespace where nspname in ('public', 'internal', 'auth'))`,
      policies: `select 'pol:' || schemaname || '.' || tablename || ':' || policyname || ':' || coalesce(qual, '') || ':' || coalesce(with_check, '') || ':' || roles::text as x from pg_policies`,
      roles: `select 'r:' || rolname || ':' || rolcanlogin::text || ':' || rolsuper::text as x from pg_roles where rolname not like 'pg\\_%' and rolname <> 'tr_test_admin'`,
      defaultprivs: `select 'd:' || coalesce(defaclnamespace::regnamespace::text, '') || ':' || defaclobjtype::text || ':' || defaclacl::text as x from pg_default_acl`,
      schemas: `select 's:' || nspname || ':' || coalesce(nspacl::text, '') as x from pg_namespace where nspname in ('public', 'internal', 'auth')`,
      enums: `select 'e:' || t.typname || ':' || e.enumlabel as x from pg_enum e join pg_type t on t.oid = e.enumtypid`,
      rows: `select 'n:' || (select count(*) from public.profiles)::text || ':' || (select count(*) from public.carriers)::text || ':' || (select count(*) from public.batch_activity)::text || ':' || (select count(*) from auth.users)::text as x`,
    };
    const out: Record<string, string> = {};
    for (const [name, sql] of Object.entries(sections)) out[name] = (await q(`select coalesce(md5(string_agg(x, '|' order by x)), '') as h from (${sql}) s`)).rows[0].h as string;
    return out;
  };
  const differing = (a: Record<string, string>, b: Record<string, string>) => Object.keys(a).filter((k) => a[k] !== b[k]);
  const sameFp = (a: Record<string, string>, b: Record<string, string>) => differing(a, b).length === 0;

  const run = async (id: string, opts: { failAtQuery?: number } = {}): Promise<Outcome> => {
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
  const allEvents: Array<Record<string, unknown>> = [];
  const track = (o: Outcome) => { allEvents.push(...o.events); return o; };
  const bodyHas = async (fn: string, like: string) => (await q('select p.prosrc like $1 as has from pg_proc p where p.oid = $2::regprocedure', [like, fn])).rows[0].has as boolean;
  /** Runs `body` inside a transaction that is always rolled back; the claims are set for that transaction only. */
  const asClaims = async (claims: Record<string, string>, sql: string): Promise<{ ok: boolean; message?: string }> => {
    await q('begin');
    try {
      await q('select set_config($1, $2, true)', ['request.jwt.claims', JSON.stringify(claims)]);
      await q(sql);
      return { ok: true };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    } finally {
      await q('rollback');
    }
  };
  const EDITOR = '71000000-0000-4000-8000-000000000002';
  const dot = Number((await q('select dot_number from public.batch_carriers limit 1')).rows[0]?.dot_number ?? (await q('select dot_number from public.carriers limit 1')).rows[0].dot_number);

  const f0 = await fingerprint();

  // ---- The two DO NOT USE backouts are never runnable. The test applies their historical text DIRECTLY (never through the runner) only as a negative control: the acceptance
  // assertion for a rollback destination is "it is usable and safe", and the assertion must FAIL for each historical restore and PASS for "retain the forward fix".
  const PENDING = '71000000-0000-4000-8000-000000000005';
  const DISABLED = '71000000-0000-4000-8000-000000000007';
  const refusalId = (id: string): string | undefined => {
    try { planProdSql({ target: 'production', action: id, dbUrl: PROD_URL, confirm: `RUN TNBS PRODUCTION SQL ${id.toUpperCase()}` }); return undefined; } catch (e) { return e instanceof RunnerRefusal ? e.id : 'other'; }
  };
  check('profile-bootstrap-backout and dnc-enum-cast-backout are refused by the real planner (prod_sql_action_do_not_use) even with the exact old phrase and a production address, and are not in the action table', ['profile-bootstrap-backout', 'dnc-enum-cast-backout'].every((id) => refusalId(id) === 'prod_sql_action_do_not_use' && !PROD_SQL_ACTIONS.some((a) => a.id === id)));
  check('both DO NOT USE files say DO NOT USE in their first lines and that the forward fix is retained', ['supabase/backout/profile-bootstrap-backout.sql', 'supabase/backout/dnc-enum-cast-backout.sql'].every((f) => /^-- DO NOT USE\. DO NOT RUN THIS FILE\./m.test(read(f).split('\n').slice(0, 3).join('\n')) && /RETAIN THE FORWARD FIX/.test(read(f))));

  /** Runs `body` as the given database role with the given token claims, always rolled back. */
  const asRole = async (dbRole: string, claims: Record<string, string>, sql: string, params: unknown[] = []): Promise<{ ok: boolean; message?: string; code?: string; rows?: Array<Record<string, unknown>> }> => {
    await q('begin');
    try {
      await q(`set local role ${dbRole}`);
      await q('select set_config($1, $2, true)', ['request.jwt.claims', JSON.stringify(claims)]);
      const r = await q(sql, params);
      return { ok: true, rows: r.rows as Array<Record<string, unknown>> };
    } catch (e) {
      return { ok: false, message: (e as Error).message, code: (e as { code?: string }).code };
    } finally {
      await q('rollback');
    }
  };
  /** Can this user, acting as the authenticated role with RLS enforced, make themselves an approved manager? */
  const selfPromotes = async (userId: string): Promise<boolean> => {
    const r = await asRole('authenticated', { role: 'authenticated', sub: userId }, "update public.profiles set role = 'manager', status = 'approved', approved_by = id, approved_at = now() where id = $1 returning role::text as role, status::text as status", [userId]);
    return r.ok === true && (r.rows ?? []).length === 1 && r.rows![0]!.role === 'manager' && r.rows![0]!.status === 'approved';
  };
  const dncCall = (on: boolean) => asRole('authenticated', { role: 'authenticated', sub: EDITOR }, 'select public.set_do_not_contact($1, $2, $3)', [dot, on, 'A3 PROBE']);
  /** THE ASSERTIONS for a rollback destination. They throw when the destination is unusable. */
  const assertProfileDestinationSafe = async (): Promise<void> => {
    assert.equal(await selfPromotes(PENDING), false, 'a PENDING user can approve themselves as manager');
    assert.equal(await selfPromotes(DISABLED), false, 'a DISABLED user can approve themselves as manager');
  };
  const assertDncDestinationUsable = async (): Promise<void> => {
    const set = await dncCall(true);
    assert.ok(set.ok, `an authorized editor cannot SET do-not-contact: ${set.code ?? ''} ${set.message ?? ''}`);
    const clear = await dncCall(false);
    assert.ok(clear.ok, `an authorized editor cannot CLEAR do-not-contact: ${clear.code ?? ''} ${clear.message ?? ''}`);
  };
  const fails = async (fn: () => Promise<void>): Promise<string | undefined> => { try { await fn(); return undefined; } catch (e) { return e instanceof assert.AssertionError ? e.message : `other:${String(e)}`; } };

  // ---- profile: forward fix retained passes; the historical restore fails the same assertion
  {
    await q(read(FORWARD_PROFILE));
    const f1 = await fingerprint();
    check('profile: the forward migration changes only the guard function (the catalogue differs from the pre-migration state in the functions section)', !sameFp(f0, f1) && differing(f0, f1).join() === 'functions' && (await bodyHas('internal.guard_profile_update()', '%service_role%')));
    check('profile: RETAIN THE FORWARD FIX passes the destination assertion: a pending user and a disabled user cannot approve themselves (authenticated role, RLS enforced)', (await fails(assertProfileDestinationSafe)) === undefined);
    const provision = await asClaims({ role: 'service_role', sub: EDITOR }, `update public.profiles set role = 'view', status = 'approved' where id = '71000000-0000-4000-8000-000000000006'`);
    check('profile: with the forward fix, the trusted service role can still provision a role (the reason the forward migration exists)', provision.ok);
    // Negative control: the historical text applied directly. It is catalogue-identical to the pre-migration state, and still unsafe.
    await q(read('supabase/backout/profile-bootstrap-backout.sql'));
    const f2 = await fingerprint();
    check('profile: the DO NOT USE file is catalogue-identical to the pre-migration state in every section (so a catalogue comparison alone cannot show it is unsafe)', sameFp(f0, f2));
    const why = await fails(assertProfileDestinationSafe);
    check(`profile: the destination assertion FAILS for the historical restore (${(why ?? 'no failure').split('\n')[0]}): a pending user can approve themselves as manager, so this backout must not run`, why !== undefined && /PENDING user can approve themselves/.test(why));
    await q(read(FORWARD_PROFILE));
    check('profile: re-applying the forward migration reaches the same catalogue as the first time and passes the destination assertion again', sameFp(f1, await fingerprint()) && (await fails(assertProfileDestinationSafe)) === undefined);
  }

  // ---- dnc: forward fix retained passes; the historical restore fails the same assertion
  {
    const fBase = await fingerprint(); // the profile forward fix is still applied here, so the baseline for this section is not f0
    await q(read(FORWARD_DNC));
    const f1 = await fingerprint();
    check('dnc: the forward migration changes only the set_do_not_contact function (functions section only; the body now casts the CASE to activity_type)', !sameFp(fBase, f1) && differing(fBase, f1).join() === 'functions' && (await bodyHas('public.set_do_not_contact(bigint,boolean,text)', '%::activity_type%')));
    check('dnc: RETAIN THE FORWARD FIX passes the destination assertion: an authorized editor can set and clear do-not-contact (authenticated role; each call rolled back)', (await fails(assertDncDestinationUsable)) === undefined);
    await q(read('supabase/backout/dnc-enum-cast-backout.sql'));
    const f2 = await fingerprint();
    check('dnc: the DO NOT USE file is catalogue-identical to the pre-migration state in every section (so a catalogue comparison alone cannot show it is unusable)', sameFp(fBase, f2));
    const why = await fails(assertDncDestinationUsable);
    check(`dnc: the destination assertion FAILS for the historical restore (${(why ?? 'no failure').split('\n')[0]}): the editor call aborts, so this backout must not run`, why !== undefined && /cannot SET do-not-contact: 42804/.test(why) && /activity_type/.test(why));
    const clearOnly = await dncCall(false);
    check('dnc: clearing do-not-contact also fails (SQLSTATE 42804), not only setting it', !clearOnly.ok && clearOnly.code === '42804');
    await q(read(FORWARD_DNC));
    check('dnc: re-applying the forward migration reaches the same catalogue as the first time and passes the destination assertion again', sameFp(f1, await fingerprint()) && (await fails(assertDncDestinationUsable)) === undefined);
  }

  // ---- read-only-inventory: fixed counts only, read-only ------------------------------------------------------------------------------------------------
  {
    const inv = PROD_SQL_ACTIONS.find((x) => x.id === 'read-only-inventory')!;
    const names = inv.countNames ?? [];
    // Real data first: the staging profile fixtures (7 Auth users, 7 profiles) plus extra rows that exercise every count. All of it is synthetic and throwaway.
    await q('begin');
    await q("set local session_replication_role = replica"); // this load only: no triggers and no foreign keys, so a profile can exist without an Auth user
    await q(`insert into auth.users (id, email) values ('72000000-0000-4000-8000-000000000001', 'alpha@a3.example.invalid'), ('72000000-0000-4000-8000-000000000002', 'bravo@a3.example.invalid'), ('72000000-0000-4000-8000-000000000003', null)`);
    await q(`insert into public.profiles (id, email, role, status) values
      ('72000000-0000-4000-8000-000000000001', 'ALPHA@a3.example.invalid', 'edit', 'approved'),
      ('72000000-0000-4000-8000-000000000002', 'other@a3.example.invalid', 'view', 'approved'),
      ('72000000-0000-4000-8000-000000000003', 'nullmail@a3.example.invalid', 'view', 'approved'),
      ('72000000-0000-4000-8000-000000000004', 'noauth@a3.example.invalid', 'manager', 'approved'),
      ('72000000-0000-4000-8000-000000000005', 'dup@a3.example.invalid', 'guest', 'pending'),
      ('72000000-0000-4000-8000-000000000006', 'DUP@a3.example.invalid', 'guest', 'pending'),
      ('72000000-0000-4000-8000-000000000007', 'dup@a3.example.invalid', 'edit', 'disabled')`);
    await q('commit');
    // Independent expectation, computed in this test from the rows themselves (not with the file's SQL).
    const rows = (await q('select id, lower(email) as email, role::text as role, status::text as status from public.profiles')).rows as Array<{ id: string; email: string; role: string; status: string }>;
    const auth = (await q('select id, lower(email) as email from auth.users')).rows as Array<{ id: string; email: string | null }>;
    const expected: Record<string, number> = { profiles_total: rows.length, auth_users_total: auth.length, profiles_other_role_status: 0 };
    for (const r of ['manager', 'edit', 'view', 'guest']) for (const s of ['pending', 'approved', 'disabled']) expected[`profiles_${r}_${s}`] = rows.filter((x) => x.role === r && x.status === s).length;
    const byEmail = new Map<string, number>();
    for (const r of rows) byEmail.set(r.email, (byEmail.get(r.email) ?? 0) + 1);
    expected.duplicate_email_groups = [...byEmail.values()].filter((c) => c > 1).length;
    expected.duplicate_email_rows = [...byEmail.values()].filter((c) => c > 1).reduce((a, c) => a + c, 0);
    const approved = rows.filter((x) => x.status === 'approved');
    const au = new Map(auth.map((x) => [x.id, x.email]));
    expected.email_mismatches = approved.filter((x) => au.has(x.id) && au.get(x.id) !== null && au.get(x.id) !== x.email).length;
    expected.approved_profiles_without_auth_user = approved.filter((x) => !au.has(x.id)).length;
    expected.approved_auth_email_null = approved.filter((x) => au.has(x.id) && au.get(x.id) === null).length;
    check('the inventory fixture exercises every count at least once except the guard (a duplicate group, a mismatch, a profile with no Auth user, an Auth user with no email)', expected.duplicate_email_groups >= 1 && expected.email_mismatches >= 1 && expected.approved_profiles_without_auth_user >= 1 && expected.approved_auth_email_null >= 1 && expected.profiles_manager_approved >= 1);

    const fp = await fingerprint();
    const o = track(await run('read-only-inventory'));
    const ev = o.events.filter((e) => e.msg === 'prod-sql.counts');
    const counts = (ev[0]?.counts ?? {}) as Record<string, number>;
    check('inventory: began read only, sent the one pinned select, rolled back, never sent a commit; result read_only_done', o.error === undefined && o.sent[0] === 'begin read only' && o.sent.length === 3 && o.sent[2] === 'rollback' && !o.sent.some((x) => ctlOf(x) === 'commit') && resultOf(o) === 'read_only_done');
    check('inventory: exactly one counts event, with exactly the 20 pinned names, every value a whole number', ev.length === 1 && JSON.stringify(Object.keys(counts)) === JSON.stringify(names) && names.length === 20 && Object.values(counts).every((v) => Number.isInteger(v) && v >= 0));
    check(`inventory: every count equals the independent expectation computed from the rows (${names.map((x) => `${x}=${counts[x]}`).join(' ')})`, names.every((x) => counts[x] === expected[x]));
    check('inventory: no email, id or name from the database appears anywhere in the printed events', !/a3\.example|7[12]000000-0000/i.test(JSON.stringify(o.events)));
    check('inventory: it changed nothing (catalogue fingerprint and row counts identical before and after)', sameFp(fp, await fingerprint()));
    const wrote = await q('begin read only').then(async () => { try { await q("insert into public.profiles (id, email) values ('73000000-0000-4000-8000-000000000001', 'x@a3.example.invalid')"); return false; } catch { return true; } finally { await q('rollback'); } });
    check('control: a write inside "begin read only" really is refused by this server, so the runner\'s read-only transaction would stop a write', wrote);
    // The same file against an EMPTY set of tables returns one row of zeros (the A1 comparison with 2026-10-22: 0 Auth users, 0 profiles).
    await q('begin');
    await q('truncate public.profiles cascade');
    await q('delete from auth.users');
    await q('commit');
    const empty = track(await run('read-only-inventory'));
    const zero = (empty.events.find((e) => e.msg === 'prod-sql.counts')?.counts ?? {}) as Record<string, number>;
    check('inventory on empty tables: one row, every count 0 (not -1): the aggregate select returns a row even when nothing exists', empty.error === undefined && names.every((x) => zero[x] === 0));
  }

  // ---- bootstrap-identity-check (BO3): ties the first-manager exception to the actual bootstrap identity in internal.auth_events -------------------------------
  {
    const idc = PROD_SQL_ACTIONS.find((x) => x.id === 'bootstrap-identity-check')!;
    const inv = PROD_SQL_ACTIONS.find((x) => x.id === 'read-only-inventory')!;
    const idNames = idc.countNames ?? [];
    // internal.auth_events is created by M1, which this pre-M1 database does not have: create exactly that table from the M1 file's own text.
    const fp0 = await fingerprint();
    const ddl = /create table internal\.auth_events \([\s\S]*?\n\);/.exec(read('supabase/pending/M1_same_origin_signin.sql'));
    assert.ok(ddl, 'the auth_events DDL must be found in the M1 file');
    await q(ddl[0]);
    const B = '75000000-0000-4000-8000-000000000001'; // the bootstrap identity (synthetic)
    const O = '75000000-0000-4000-8000-000000000002'; // another approved manager
    const X = '75000000-0000-4000-8000-000000000003'; // an extra approved person (for example one added later)
    const P = '75000000-0000-4000-8000-000000000004'; // a pending profile with no Auth user
    interface Person { id: string; role: string; status: string; auth: boolean }
    const setup = async (people: Person[], events: string[]): Promise<void> => {
      await q('begin');
      await q('set local session_replication_role = replica');
      await q('delete from internal.auth_events');
      await q('delete from public.profiles');
      await q('delete from auth.users');
      for (const p of people) {
        if (p.auth) await q('insert into auth.users (id, email) values ($1, $2)', [p.id, `${p.id.slice(-1)}@a3.example.invalid`]);
        await q('insert into public.profiles (id, email, role, status) values ($1, $2, $3::user_role, $4::user_status)', [p.id, `${p.id.slice(-1)}@a3.example.invalid`, p.role, p.status]);
      }
      for (const uid of events) await q("insert into internal.auth_events (user_id, kind) values ($1, 'first_manager_bootstrap')", [uid]);
      await q('commit');
    };
    const countsOf = (o: Outcome) => (o.events.find((e) => e.msg === 'prod-sql.counts')?.counts ?? {}) as Record<string, number>;
    const both = async () => {
      const a = track(await run('bootstrap-identity-check'));
      const b = track(await run('read-only-inventory'));
      assert.ok(a.error === undefined && b.error === undefined && resultOf(a) === 'read_only_done' && resultOf(b) === 'read_only_done', 'both read-only actions must complete');
      return { idc: countsOf(a), inv: countsOf(b), events: [...a.events, ...b.events], a };
    };
    check('bootstrap-identity-check plans through the real planner with its own phrase and the four pinned names', idNames.join() === 'bootstrap_events,bootstrap_profiles_present,bootstrap_profiles_with_auth_user,other_approved_profiles_without_auth_user' && idc.phrase === 'RUN TNBS PRODUCTION SQL BOOTSTRAP-IDENTITY-CHECK');

    // State 1 (the expected state after the first-manager bootstrap): B is the bootstrap manager with NO Auth user; O is another approved manager that has one.
    await setup([{ id: B, role: 'manager', status: 'approved', auth: false }, { id: O, role: 'manager', status: 'approved', auth: true }], [B]);
    const s1 = await both();
    check(`state 1 (bootstrap manager has no Auth user, the other manager has one): ${JSON.stringify(s1.idc)}`, JSON.stringify(s1.idc) === JSON.stringify({ bootstrap_events: 1, bootstrap_profiles_present: 1, bootstrap_profiles_with_auth_user: 0, other_approved_profiles_without_auth_user: 0 }));

    // State 2, the reviewer's SWAPPED-IDENTITY counterexample: the same two managers, but now the OTHER manager is the one without an Auth user.
    await setup([{ id: B, role: 'manager', status: 'approved', auth: true }, { id: O, role: 'manager', status: 'approved', auth: false }], [B]);
    const s2 = await both();
    check('the swap leaves all 20 aggregate inventory counts identical (approved_profiles_without_auth_user = 1 in both states): the inventory alone cannot tell the exception from a stranded manager', JSON.stringify(s1.inv) === JSON.stringify(s2.inv) && s1.inv.approved_profiles_without_auth_user === 1 && (inv.countNames ?? []).length === 20);
    check(`state 2 (swapped): the identity check DOES tell them apart: the bootstrap profile has an Auth user and ONE other approved profile has none (${JSON.stringify(s2.idc)})`, JSON.stringify(s2.idc) === JSON.stringify({ bootstrap_events: 1, bootstrap_profiles_present: 1, bootstrap_profiles_with_auth_user: 1, other_approved_profiles_without_auth_user: 1 }));

    // State 3: the exception holds AND there is an extra non-bootstrap orphan.
    await setup([{ id: B, role: 'manager', status: 'approved', auth: false }, { id: O, role: 'manager', status: 'approved', auth: true }, { id: X, role: 'edit', status: 'approved', auth: false }], [B]);
    const s3 = await both();
    check(`state 3 (the exception plus an extra non-bootstrap orphan): the inventory total is 2 but the identity check counts exactly the extra one (${JSON.stringify(s3.idc)})`, s3.inv.approved_profiles_without_auth_user === 2 && JSON.stringify(s3.idc) === JSON.stringify({ bootstrap_events: 1, bootstrap_profiles_present: 1, bootstrap_profiles_with_auth_user: 0, other_approved_profiles_without_auth_user: 1 }));

    // State 4: the bootstrap profile has since acquired an Auth user, nothing else is missing.
    await setup([{ id: B, role: 'manager', status: 'approved', auth: true }, { id: O, role: 'manager', status: 'approved', auth: true }], [B]);
    const s4 = await both();
    check(`state 4 (the bootstrap profile has since acquired an Auth user): no orphan at all (${JSON.stringify(s4.idc)})`, s4.inv.approved_profiles_without_auth_user === 0 && JSON.stringify(s4.idc) === JSON.stringify({ bootstrap_events: 1, bootstrap_profiles_present: 1, bootstrap_profiles_with_auth_user: 1, other_approved_profiles_without_auth_user: 0 }));

    // State 5: no bootstrap event at all (the evidence is missing), and an approved profile without an Auth user: it is NOT excused.
    await setup([{ id: B, role: 'manager', status: 'approved', auth: false }, { id: O, role: 'manager', status: 'approved', auth: true }], []);
    const s5 = await both();
    check(`state 5 (no bootstrap event): the orphan is not excused; events 0, present 0, other orphans 1 (${JSON.stringify(s5.idc)})`, JSON.stringify(s5.idc) === JSON.stringify({ bootstrap_events: 0, bootstrap_profiles_present: 0, bootstrap_profiles_with_auth_user: 0, other_approved_profiles_without_auth_user: 1 }));

    // State 6: a bootstrap event whose profile is gone, and a pending profile with no Auth user (only APPROVED profiles count as orphans).
    await setup([{ id: O, role: 'manager', status: 'approved', auth: true }, { id: P, role: 'guest', status: 'pending', auth: false }], []);
    await q('begin');
    await q('set local session_replication_role = replica');
    await q("insert into internal.auth_events (user_id, kind) values ('75000000-0000-4000-8000-0000000000ff', 'first_manager_bootstrap')"); // a user_id with no profile (FK not enforced in this load only)
    await q('commit');
    const s6 = await both();
    check(`state 6 (event for a profile that is gone; a pending profile without Auth is not counted): events 1, present 0, other orphans 0 (${JSON.stringify(s6.idc)})`, JSON.stringify(s6.idc) === JSON.stringify({ bootstrap_events: 1, bootstrap_profiles_present: 0, bootstrap_profiles_with_auth_user: 0, other_approved_profiles_without_auth_user: 0 }));

    check('identity check: counts only, exactly the four pinned names, whole numbers; no id, email or user_id from the database appears in any printed event', [s1, s2, s3, s4, s5, s6].every((s) => JSON.stringify(Object.keys(s.idc)) === JSON.stringify(idNames) && Object.values(s.idc).every((v) => Number.isInteger(v) && v >= 0)) && ![s1, s2, s3, s4, s5, s6].some((s) => /a3\.example|75000000-0000/i.test(JSON.stringify(s.events))));
    check('identity check: began read only, sent the one pinned select, rolled back, never a commit', s1.a.sent[0] === 'begin read only' && s1.a.sent.length === 3 && s1.a.sent[2] === 'rollback' && !s1.a.sent.some((x) => ctlOf(x) === 'commit'));
    // Order: BO3 runs while internal.auth_events exists. After the table is gone (as after the M1 backout) the select fails, read-only, and nothing changes.
    await q('drop table internal.auth_events');
    const gone = track(await run('bootstrap-identity-check'));
    check('after internal.auth_events is gone (as after the M1 backouts) the identity check fails closed with rolled_back and no counts: BO3 must run BEFORE the M1 backouts', gone.error !== undefined && resultOf(gone) === 'rolled_back' && !gone.events.some((e) => e.msg === 'prod-sql.counts'));
    check('after this section drops the table it created, the catalogue equals the one before it in every section except row counts (the fixture rows)', differing(fp0, await fingerprint()).every((k) => k === 'rows'));
  }

  // ---- Everything printed passes the wrapper allow-list with nothing withheld and carries no database text.
  {
    const counter = { fields: 0 };
    const withheld = allEvents.filter((e) => wrapper.allowListLine(JSON.stringify(e), counter) === null).length;
    check('every event of the whole run passes the wrapper allow-list: 0 withheld lines, 0 withheld fields', withheld === 0 && counter.fields === 0 && allEvents.length > 10);
    check('no event carries SQL text, an address, a role password or driver text', !/redacted-pw|pooler|127\.0\.0\.1|relation |already exists|insert into|create table|drop function|postgres:/i.test(JSON.stringify(allEvents)));
  }

  await admin.end();
  console.log(`prod-sql A2-backouts A3: ${n} checks passed`);
}

await main();
