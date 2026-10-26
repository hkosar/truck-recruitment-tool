// A3 LOCAL test of the environment preflight (doc 16 section 1.3 step 4a) against a REAL PostgreSQL catalogue. It
// needs a task-owned throwaway database and an admin (superuser) login; it is skipped unless ENVPRE_A3_ADMIN_URL is
// set and it must be a LOOPBACK URL. It creates and removes its own event trigger, default-privilege entries and
// authenticator setting, and removes the authenticator role only if it created it.
// Run: ENVPRE_A3_ADMIN_URL=... npx tsx src/environment-preflight-a3.test.ts

import assert from 'node:assert/strict';
import pg from 'pg';
import { runEnvironmentPreflight } from './environment-preflight.js';

const ADMIN = process.env.ENVPRE_A3_ADMIN_URL;

async function main(): Promise<void> {
  if (!ADMIN) {
    console.log('skip environment preflight A3 test (set ENVPRE_A3_ADMIN_URL, loopback only)');
    return;
  }
  const u = new URL(ADMIN);
  if (u.search || u.hash || (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost')) throw new Error('refusing: test URLs must be loopback, without query or fragment');
  const c = new pg.Client({ connectionString: ADMIN });
  await c.connect();
  const db = (await c.query('select current_database() as d')).rows[0].d as string;
  assert.match(db, /^tr_/, 'refusing: the test database name must start with tr_');
  const roles = async () => (await c.query("select rolname from pg_roles where rolname in ('anon', 'authenticated', 'service_role', 'authenticator')")).rows.map((r) => r.rolname as string);
  const had = await roles();
  const created: string[] = [];
  const priorConfig = had.includes('authenticator') ? (await c.query("select rolconfig from pg_roles where rolname = 'authenticator'")).rows[0].rolconfig as string[] | null : null;
  for (const r of ['anon', 'authenticated', 'service_role', 'authenticator']) {
    if (!had.includes(r)) { await c.query(`create role ${r} nologin`); created.push(r); }
  }
  let n = 0;
  const check = (name: string, ok: boolean, detail = '') => { assert.ok(ok, `${name} ${detail}`); console.log(`PASS ${name}`); n += 1; };
  const run = () => runEnvironmentPreflight(c as never);
  const defaultsOf = (rep: Awaited<ReturnType<typeof run>>, role: string) => rep.defaults.find((d) => d.role === role)!;
  try {
    await c.query('alter role authenticator reset all');
    await c.query('alter default privileges in schema public revoke all on tables from anon, authenticated, service_role; alter default privileges in schema public revoke all on sequences from anon, authenticated, service_role; alter default privileges in schema public revoke all on functions from anon, authenticated, service_role;');
    const base = await run();
    check('baseline: the three API roles are reported', base.defaults.length === 3 && base.dataApi.api_roles_present === 3);
    check('baseline: no default privileges for anon/authenticated/service_role', base.defaults.every((d) => d.tables_public === false && d.sequences_public === false && d.functions_public === false));
    check('baseline: no schema list on authenticator is reported as unknown (null)', base.dataApi.authenticator_exists === true && base.dataApi.schema_list_entries === 0 && base.dataApi.public_listed === null);
    check('baseline: no RLS-enabling event trigger', base.eventTriggers.every((e) => e.enables_rls === false));

    await c.query('alter default privileges in schema public grant select, insert, update, delete on tables to anon, authenticated, service_role; alter default privileges in schema public grant usage, select on sequences to authenticated;');
    const withDef = await run();
    check('default privileges: tables for all three, sequences only for authenticated, functions for none', ['anon', 'authenticated', 'service_role'].every((r) => defaultsOf(withDef, r).tables_public === true) && defaultsOf(withDef, 'authenticated').sequences_public === true && defaultsOf(withDef, 'anon').sequences_public === false && defaultsOf(withDef, 'service_role').functions_public === false);
    await c.query('alter default privileges in schema public revoke all on tables from anon, authenticated, service_role; alter default privileges in schema public revoke all on sequences from authenticated;');
    await c.query('alter default privileges grant execute on functions to service_role');
    const glob = await run();
    check('global (not schema-limited) default privileges are reported separately', defaultsOf(glob, 'service_role').functions_global === true && defaultsOf(glob, 'service_role').functions_public === false);
    await c.query('alter default privileges revoke execute on functions from service_role');

    await c.query("alter role authenticator set pgrst.db_schemas = 'public, graphql_public'");
    check('data api: public in the schema list', (await run()).dataApi.public_listed === true);
    await c.query("alter role authenticator set pgrst.db_schemas = 'graphql_public,storage'");
    const noPub = (await run()).dataApi;
    check('data api: a list without public (including a name that merely contains it) is false', noPub.public_listed === false && noPub.schema_list_entries === 1);
    await c.query("alter role authenticator set pgrst.db_schemas = 'public_extra'");
    check('data api: public_extra is not public', (await run()).dataApi.public_listed === false);
    await c.query('alter role authenticator reset all');

    await c.query("create function public.zz_rls_auto() returns event_trigger language plpgsql as $f$ begin execute 'alter table x enable row level security'; end $f$; create function public.zz_noop_evt() returns event_trigger language plpgsql as $f$ begin null; end $f$;");
    await c.query("create event trigger zz_auto_rls on ddl_command_end when tag in ('CREATE TABLE') execute function public.zz_rls_auto(); create event trigger zz_plain on ddl_command_end execute function public.zz_noop_evt();");
    const ev = await run();
    const auto = ev.eventTriggers.find((e) => e.name === 'zz_auto_rls');
    const plain = ev.eventTriggers.find((e) => e.name === 'zz_plain');
    check('event triggers: an RLS-enabling trigger is flagged and a plain one is not', auto?.enables_rls === true && plain?.enables_rls === false && auto.function === 'zz_rls_auto');
    check('event triggers: the report is read-only (a read-only transaction can run it)', await (async () => { await c.query('begin read only'); try { await run(); return true; } finally { await c.query('rollback'); } })());
  } finally {
    await c.query('drop event trigger if exists zz_auto_rls; drop event trigger if exists zz_plain; drop function if exists public.zz_rls_auto(); drop function if exists public.zz_noop_evt();').catch(() => undefined);
    await c.query('alter role authenticator reset all').catch(() => undefined);
    for (const kv of priorConfig ?? []) { const [k, ...v] = kv.split('='); await c.query(`alter role authenticator set ${k} = ${pg.escapeLiteral(v.join('='))}`).catch(() => undefined); }
    await c.query('alter default privileges in schema public revoke all on tables from anon, authenticated, service_role; alter default privileges in schema public revoke all on sequences from anon, authenticated, service_role; alter default privileges in schema public revoke all on functions from anon, authenticated, service_role;').catch(() => undefined);
    for (const r of created) await c.query(`drop owned by ${r}; drop role if exists ${r}`).catch(() => undefined);
    await c.end();
  }
  console.log(`PASS ${n} environment-preflight catalogue checks`);
}

main().catch((err) => { console.error(err); process.exit(1); });
