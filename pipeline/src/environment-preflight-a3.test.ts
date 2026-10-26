// A3 LOCAL test of the environment preflight (doc 16 section 1.3 step 4a) against a REAL PostgreSQL catalogue. It
// needs a task-owned throwaway database and an admin (superuser) login; it is skipped unless ENVPRE_A3_ADMIN_URL is
// set and it must be a LOOPBACK URL. It creates and removes its own event triggers, default-privilege entries and
// authenticator settings, and removes the roles it created.
// Run: ENVPRE_A3_ADMIN_URL=... npx tsx src/environment-preflight-a3.test.ts

import assert from 'node:assert/strict';
import pg from 'pg';
import { LIST_LIMIT, reportEnvironmentPreflight, runEnvironmentPreflight, summariseDefaults } from './environment-preflight.js';

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
  const cells = async (role: string) => summariseDefaults((await run()).defaults.rows).byGrantee[role]!;
  const wipe = 'alter default privileges in schema public revoke all on tables from anon, authenticated, service_role, public; alter default privileges in schema public revoke all on sequences from anon, authenticated, service_role, public; alter default privileges in schema public revoke all on functions from anon, authenticated, service_role, public; alter default privileges revoke all on tables from anon, authenticated, service_role, public; alter default privileges revoke all on sequences from anon, authenticated, service_role, public; alter default privileges revoke all on functions from anon, authenticated, service_role, public;';
  const dropTriggers = async () => {
    for (const r of (await c.query("select evtname from pg_event_trigger where evtname like 'zz\\_%'")).rows) await c.query(`drop event trigger ${r.evtname}`);
  };
  try {
    await c.query('alter role authenticator reset all');
    await c.query('alter role authenticator in database ' + db + ' reset all');
    await c.query(wipe);
    await dropTriggers();
    const base = await run();
    const reported = (rows: typeof base.defaults.rows) => rows.filter((r) => r.grantee !== null && ['anon', 'authenticated', 'service_role', 'PUBLIC'].includes(r.grantee) && r.scope !== 'other');
    check('baseline: no explicit default-ACL entry for anon/authenticated/service_role/PUBLIC (owner-only entries left by a revoke are counted as outside the cells, not hidden)', reported(base.defaults.rows).length === 0 && summariseDefaults(base.defaults.rows).entries === base.defaults.rows.length);
    check('baseline: all four API-related roles are seen as present', ['anon', 'authenticated', 'service_role', 'authenticator'].every((r) => base.rolesPresent.includes(r)));
    check('baseline: zero event triggers is a valid, observed zero', base.eventTriggers.total === 0 && base.eventTriggers.listed.length === 0);
    check('baseline: no pgrst.db_schemas setting on authenticator', base.authenticator.authenticator_exists === true && base.authenticator.role_wide_entries === 0 && base.authenticator.this_database_entries === 0 && base.authenticator.names_public_if_single === null);

    // ---- partial grants are told apart from full ones (the review's counterexample)
    await c.query('alter default privileges in schema public grant select on tables to authenticated; alter default privileges in schema public grant select on sequences to authenticated;');
    const selOnly = await cells('authenticated');
    await c.query('alter default privileges in schema public grant insert, update, delete on tables to authenticated; alter default privileges in schema public grant usage on sequences to authenticated;');
    const full = await cells('authenticated');
    check('privilege types: SELECT-only tables differ from SELECT/INSERT/UPDATE/DELETE', JSON.stringify(selOnly.tables_public) === '["SELECT"]' && JSON.stringify(full.tables_public) === '["DELETE","INSERT","SELECT","UPDATE"]');
    check('privilege types: sequence SELECT-only differs from USAGE+SELECT', JSON.stringify(selOnly.sequences_public) === '["SELECT"]' && JSON.stringify(full.sequences_public) === '["SELECT","USAGE"]');
    check('privilege types: roles without entries stay empty', (await cells('anon')).tables_public.length === 0 && (await cells('service_role')).functions_public.length === 0);

    // ---- global (not schema-limited), PUBLIC, grant option, other schema
    await c.query(wipe);
    await c.query('alter default privileges grant execute on functions to service_role');
    const glob = await cells('service_role');
    check('global entries are reported separately from schema public', JSON.stringify(glob.functions_global) === '["EXECUTE"]' && glob.functions_public.length === 0);
    await c.query(wipe);
    await c.query('alter default privileges in schema public grant execute on functions to public');
    check('PUBLIC is reported as its own grantee', JSON.stringify((await cells('PUBLIC')).functions_public) === '["EXECUTE"]' && (await cells('anon')).functions_public.length === 0);
    await c.query(wipe);
    await c.query('alter default privileges in schema public grant select on tables to anon with grant option');
    check('grant option is reported', (await cells('anon')).grant_option === true && (await cells('authenticated')).grant_option === false);
    await c.query(wipe);
    const before = summariseDefaults((await run()).defaults.rows);
    await c.query('create schema if not exists zz_env_other; alter default privileges in schema zz_env_other grant select on tables to anon; alter default privileges in schema public grant select on tables to anon');
    const outside = summariseDefaults((await run()).defaults.rows);
    check('entries in another schema are counted as outside the reported cells, not hidden', outside.entries === before.entries + 2 && outside.otherEntries === before.otherEntries + 1 && outside.byGrantee.anon!.tables_public.length === 1);
    await c.query('alter default privileges in schema zz_env_other revoke all on tables from anon; drop schema zz_env_other');
    await c.query(wipe);

    // ---- authenticator setting: facts only, ambiguity is "unknown"
    await c.query("alter role authenticator set pgrst.db_schemas = 'public, graphql_public'");
    const roleWide = (await run()).authenticator;
    check('authenticator: one role-wide setting naming public', roleWide.role_wide_entries === 1 && roleWide.this_database_entries === 0 && roleWide.names_public_if_single === true);
    await c.query('alter role authenticator reset all');
    await c.query(`alter role authenticator in database ${db} set pgrst.db_schemas = 'graphql_public,storage'`);
    const dbOnly = (await run()).authenticator;
    check('authenticator: a database-specific setting is seen too (the role-wide view alone would miss it)', dbOnly.role_wide_entries === 0 && dbOnly.this_database_entries === 1 && dbOnly.names_public_if_single === false);
    await c.query("alter role authenticator set pgrst.db_schemas = 'public'");
    const both = await run();
    check('authenticator: two settings are ambiguous and are reported as unknown, not guessed', both.authenticator.role_wide_entries === 1 && both.authenticator.this_database_entries === 1);
    const out: string[] = []; const l = console.log;
    console.log = (...a: unknown[]) => { out.push(String(a[0])); };
    try { reportEnvironmentPreflight(both); } finally { console.log = l; }
    check('report: ambiguous authenticator settings print names_public "unknown" and never claim to be the Data API switch', out.some((x) => /"msg":"staging-sql.environment_authenticator_setting".*"names_public":"unknown","is_the_data_api_switch":false/.test(x)));
    await c.query('alter role authenticator reset all');
    await c.query(`alter role authenticator in database ${db} reset all`);
    await c.query("alter role authenticator set pgrst.db_schemas = 'public_extra'");
    check('authenticator: public_extra is not public', (await run()).authenticator.names_public_if_single === false);
    await c.query('alter role authenticator reset all');

    // ---- event triggers: listed by name only, no interpretation of function text; truncation is visible
    await c.query("create function public.zz_rls_helper() returns event_trigger language plpgsql as $f$ begin perform public.zz_rls_inner(); end $f$; create function public.zz_rls_inner() returns void language plpgsql as $f$ begin null; end $f$;");
    await c.query("create event trigger zz_indirect on ddl_command_end execute function public.zz_rls_helper()");
    const one = await run();
    check('event triggers: one trigger (an indirect helper) is listed by name with no heuristic verdict', one.eventTriggers.total === 1 && one.eventTriggers.listed[0]!.name === 'zz_indirect' && one.eventTriggers.listed[0]!.function === 'zz_rls_helper' && !('enables_rls' in one.eventTriggers.listed[0]!));
    const oneOut: string[] = [];
    const lg = console.log;
    console.log = (...x: unknown[]) => { oneOut.push(String(x[0])); };
    try { reportEnvironmentPreflight(one); } finally { console.log = lg; }
    check('event triggers: a real catalogue trigger that is not on the reviewed list prints as "unlisted" with its position, never its name or function', oneOut.some((x) => /"msg":"staging-sql.environment_event_trigger","position":1,"name":"unlisted","event":"ddl_command_end","enabled":"O","function":"unlisted"/.test(x)) && oneOut.every((x) => !/zz_indirect|zz_rls_helper/.test(x)));
    for (let i = 0; i < LIST_LIMIT + 2; i += 1) await c.query(`create event trigger zz_t${String(i).padStart(3, '0')} on ddl_command_end execute function public.zz_rls_helper()`);
    const many = await run();
    const out2: string[] = [];
    console.log = (...a: unknown[]) => { out2.push(String(a[0])); };
    try { reportEnvironmentPreflight(many); } finally { console.log = l; }
    check('event triggers: more than the list limit reports the full count and truncated=true', many.eventTriggers.total === LIST_LIMIT + 3 && many.eventTriggers.listed.length === LIST_LIMIT && out2.some((x) => new RegExp(`"msg":"staging-sql.environment_event_triggers","count":${LIST_LIMIT + 3},"listed":${LIST_LIMIT},"truncated":true`).test(x)));
    await dropTriggers();
    check('event triggers: the report is read-only (a read-only transaction can run it)', await (async () => { await c.query('begin read only'); try { await run(); return true; } finally { await c.query('rollback'); } })());
  } finally {
    await dropTriggers().catch(() => undefined);
    await c.query('drop function if exists public.zz_rls_helper(); drop function if exists public.zz_rls_inner();').catch(() => undefined);
    await c.query('alter role authenticator reset all').catch(() => undefined);
    await c.query(`alter role authenticator in database ${db} reset all`).catch(() => undefined);
    for (const kv of priorConfig ?? []) { const [k, ...v] = kv.split('='); await c.query(`alter role authenticator set ${k} = ${pg.escapeLiteral(v.join('='))}`).catch(() => undefined); }
    await c.query('drop schema if exists zz_env_other cascade').catch(() => undefined);
    await c.query(wipe).catch(() => undefined);
    for (const r of created) await c.query(`drop owned by ${r}; drop role if exists ${r}`).catch(() => undefined);
    await c.end();
  }
  console.log(`PASS ${n} environment-preflight catalogue checks`);
}

main().catch((err) => { console.error(err); process.exit(1); });
