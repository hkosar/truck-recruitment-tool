// DRAFT, PENDING REVIEW. A3 LOCAL test of the three DRAFT production SQL actions (read-only-inventory, profile-bootstrap-backout, dnc-enum-cast-backout)
// against a REAL PostgreSQL database on a throwaway local cluster. It builds the state BEFORE the July A2 migrations itself (the Supabase shim, the staging
// profile fixtures, the A3 business fixtures, and the migrations up to and including 20260722223300_security_hardening.sql), then:
//   forward migration -> backout (through the real planner and executor, with the real pinned files) -> the catalogue is back to the pre-migration state
//   -> the forward migration applies again. The comparison is a catalogue fingerprint (function definitions, ACLs, owners, settings, triggers, tables, columns,
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
  const info = (name: string, text: string) => console.log(`INFO ${name}: ${text}`);

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

  // ---- profile-bootstrap-backout --------------------------------------------------------------------------------------------------------------
  {
    await q(read(FORWARD_PROFILE));
    const f1 = await fingerprint();
    check('profile: the forward migration changes the catalogue (the guard function definition differs from the pre-migration state)', !sameFp(f0, f1) && differing(f0, f1).join() === 'functions' && (await bodyHas('internal.guard_profile_update()', '%service_role%')));
    const promote = `update public.profiles set role = 'view', status = 'approved' where id = '71000000-0000-4000-8000-000000000006'`;
    const before = await asClaims({ role: 'service_role', sub: EDITOR }, promote);
    check('profile: with the forward migration, a service_role request may change a profile role even when a non-manager user is named in the token', before.ok);

    const failed = track(await run('profile-bootstrap-backout', { failAtQuery: 5 })); // 1 begin, 2 set local, 3 pre-check, 4 create or replace, 5 post-check (injected)
    check('profile backout with an injected failure after the function was replaced: rolled_back, nothing committed, the catalogue is still the forward state', failed.error !== undefined && resultOf(failed) === 'rolled_back' && sameFp(await fingerprint(), f1));
    const o = track(await run('profile-bootstrap-backout'));
    const f2 = await fingerprint();
    check('profile backout: committed as written (one begin and one commit, both from the file; 5 statements)', o.error === undefined && resultOf(o) === 'committed' && o.sent.filter((x) => ctlOf(x) === 'begin').length === 1 && o.sent.filter((x) => ctlOf(x) === 'commit').length === 1 && o.sent.length === 6);
    check(`profile backout: the catalogue is back to the pre-migration state in every section (functions, ACLs, owners, settings, triggers, tables, columns, indexes, constraints, policies, roles, default privileges, enums, row counts); differing sections: [${differing(f0, f2).join()}]`, sameFp(f0, f2));
    const after = await asClaims({ role: 'service_role', sub: EDITOR }, promote);
    check('profile backout: the restored guard refuses that same service_role change again (only managers may change role/approval)', !after.ok && /only managers may change role\/approval/.test(after.message ?? ''));
    const again = track(await run('profile-bootstrap-backout'));
    check('profile backout again is safe to repeat: committed, the catalogue is unchanged', again.error === undefined && resultOf(again) === 'committed' && sameFp(f0, await fingerprint()));
    await q(read(FORWARD_PROFILE));
    check('profile: the forward migration applies again after the backout and reaches the same forward state as the first time', sameFp(f1, await fingerprint()));
    const o2 = track(await run('profile-bootstrap-backout'));
    check('profile backout after the re-apply: committed, back to the pre-migration state', o2.error === undefined && resultOf(o2) === 'committed' && sameFp(f0, await fingerprint()));
  }

  // ---- dnc-enum-cast-backout ------------------------------------------------------------------------------------------------------------------
  {
    await q(read(FORWARD_DNC));
    const f1 = await fingerprint();
    check('dnc: the forward migration changes the catalogue (the set_do_not_contact definition differs from the pre-migration state)', !sameFp(f0, f1) && differing(f0, f1).join() === 'functions' && (await bodyHas('public.set_do_not_contact(bigint,boolean,text)', '%::activity_type%')));
    const call = `select public.set_do_not_contact(${dot}, true, 'A3 PROBE')`;
    const fwd = await asClaims({ role: 'authenticated', sub: EDITOR }, call);
    check('dnc: with the forward migration, an authorized editor can set do-not-contact (the call runs to the end and is rolled back)', fwd.ok);

    const failed = track(await run('dnc-enum-cast-backout', { failAtQuery: 5 }));
    check('dnc backout with an injected failure after the function was replaced: rolled_back, nothing committed, the catalogue is still the forward state', failed.error !== undefined && resultOf(failed) === 'rolled_back' && sameFp(await fingerprint(), f1));
    const o = track(await run('dnc-enum-cast-backout'));
    const f2 = await fingerprint();
    check('dnc backout: committed as written (one begin and one commit, both from the file; 5 statements)', o.error === undefined && resultOf(o) === 'committed' && o.sent.filter((x) => ctlOf(x) === 'begin').length === 1 && o.sent.filter((x) => ctlOf(x) === 'commit').length === 1 && o.sent.length === 6);
    check(`dnc backout: the catalogue is back to the pre-migration state in every section; differing sections: [${differing(f0, f2).join()}]`, sameFp(f0, f2));
    const old = await asClaims({ role: 'authenticated', sub: EDITOR }, call);
    info('dnc: the restored (earlier) body on this local server', old.ok ? 'the editor call also runs to the end here (the failure the migration header describes was not reproduced on this server version)' : `the editor call fails: ${old.message ?? ''}`);
    const again = track(await run('dnc-enum-cast-backout'));
    check('dnc backout again is safe to repeat: committed, the catalogue is unchanged', again.error === undefined && resultOf(again) === 'committed' && sameFp(f0, await fingerprint()));
    await q(read(FORWARD_DNC));
    check('dnc: the forward migration applies again after the backout and reaches the same forward state as the first time', sameFp(f1, await fingerprint()));
    const o2 = track(await run('dnc-enum-cast-backout'));
    check('dnc backout after the re-apply: committed, back to the pre-migration state', o2.error === undefined && resultOf(o2) === 'committed' && sameFp(f0, await fingerprint()));
  }

  // ---- both together, in the runbook's reverse order ---------------------------------------------------------------------------------------------
  {
    await q(read(FORWARD_PROFILE));
    await q(read(FORWARD_DNC));
    const both = await fingerprint();
    const a = track(await run('dnc-enum-cast-backout'));
    const b = track(await run('profile-bootstrap-backout'));
    check('both forward migrations, then dnc-enum-cast-backout and profile-bootstrap-backout (reverse order): both commit and the catalogue equals the pre-migration state', !sameFp(f0, both) && a.error === undefined && b.error === undefined && sameFp(f0, await fingerprint()));
  }

  // ---- A precondition that is not met refuses and keeps the state ---------------------------------------------------------------------------------
  {
    await q('alter table public.profiles disable trigger guard_profile_update');
    await q('drop trigger guard_profile_update on public.profiles');
    const fp = await fingerprint();
    const o = track(await run('profile-bootstrap-backout'));
    check('profile backout refuses (rolled_back) when the guard trigger is gone, and changes nothing', o.error !== undefined && resultOf(o) === 'rolled_back' && sameFp(fp, await fingerprint()));
    await q('create trigger guard_profile_update before update on public.profiles for each row execute function internal.guard_profile_update()');
    check('the guard trigger is restored by the test and the catalogue is the pre-migration state again', sameFp(f0, await fingerprint()));
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
