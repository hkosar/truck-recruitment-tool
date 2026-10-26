// Read-only report of three project-level switches that the new staging project's creation screen pre-selects
// (doc 16 section 1.3 step 4a), run BEFORE the 20-file replay. It only reports; each line is a manager decision gate,
// the tool does not pass or fail them:
//   1. event triggers: any database event trigger and whether its function enables row level security (an
//      "automatic RLS" trigger). The reviewed migrations enable RLS and write policies explicitly, so none is
//      expected from the migrations; a Supabase-built-in trigger (for example the PostgREST schema-cache watcher)
//      is normal and is listed by name only. An RLS-enabling trigger is a STOP for a manager decision.
//   2. default privileges: for objects created by THIS login in schema public, whether anon / authenticated /
//      service_role receive tables, sequences and functions by default. Derived from the migrations: service_role
//      gets all three (20260720001500), and EXECUTE on functions is revoked from PUBLIC (20260722223300). The
//      migrations never grant table access to anon/authenticated themselves ("RLS alone gates tables", they rely
//      on the platform default), so the legacy rehearsal frontend (approval 5) needs authenticated to receive
//      tables and sequences by default; the manager compares.
//   3. Data API exposure: whether the PostgREST schema list set on the `authenticator` role names `public`. If the
//      list is not visible from SQL the value is null and the owner checks the dashboard.
// It reads only catalogue facts, prints only fixed keys and identifier names (never a connection detail), and
// changes nothing.

import type { RebuiltSqlClient } from './staging-rebuilt.js';

export const ENV_ROLES = ['anon', 'authenticated', 'service_role'] as const;

export const EVENT_TRIGGERS_SQL = `select e.evtname::text as name, e.evtevent::text as event, e.evtenabled::text as enabled,
       (p.proname)::text as function,
       (p.prosrc ~* 'row\\s+level\\s+security') as enables_rls
  from pg_event_trigger e join pg_proc p on p.oid = e.evtfoid
 order by e.evtname limit 50`;

export const DEFAULT_PRIVILEGES_SQL = `with me as (select oid from pg_roles where rolname = current_user),
acl as (select d.defaclobjtype, d.defaclnamespace, x.grantee
          from pg_default_acl d, aclexplode(d.defaclacl) x
         where d.defaclrole = (select oid from me))
select r.rolname::text as role,
  exists (select 1 from acl where grantee = r.oid and defaclobjtype = 'r' and defaclnamespace = 'public'::regnamespace) as tables_public,
  exists (select 1 from acl where grantee = r.oid and defaclobjtype = 'S' and defaclnamespace = 'public'::regnamespace) as sequences_public,
  exists (select 1 from acl where grantee = r.oid and defaclobjtype = 'f' and defaclnamespace = 'public'::regnamespace) as functions_public,
  exists (select 1 from acl where grantee = r.oid and defaclobjtype = 'r' and defaclnamespace = 0) as tables_global,
  exists (select 1 from acl where grantee = r.oid and defaclobjtype = 'S' and defaclnamespace = 0) as sequences_global,
  exists (select 1 from acl where grantee = r.oid and defaclobjtype = 'f' and defaclnamespace = 0) as functions_global
  from pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role') order by r.rolname`;

export const DATA_API_SQL = `select
  exists (select 1 from pg_roles where rolname = 'authenticator') as authenticator_exists,
  (select count(*)::int from pg_roles r, unnest(coalesce(r.rolconfig, '{}'::text[])) c where r.rolname = 'authenticator' and c like 'pgrst.db_schemas=%') as schema_list_entries,
  (select bool_or(regexp_replace(substr(c, length('pgrst.db_schemas=') + 1), '\\s', '', 'g') ~ '(^|,)public(,|$)') from pg_roles r, unnest(coalesce(r.rolconfig, '{}'::text[])) c where r.rolname = 'authenticator' and c like 'pgrst.db_schemas=%') as public_listed,
  (select count(*)::int from pg_roles where rolname in ('anon', 'authenticated', 'service_role')) as api_roles_present`;

export interface EnvironmentReport {
  eventTriggers: Array<{ name: string; event: string; enabled: string; function: string; enables_rls: boolean }>;
  defaults: Array<Record<string, string | boolean>>;
  dataApi: { authenticator_exists: boolean; schema_list_entries: number; public_listed: boolean | null; api_roles_present: number };
}

export async function runEnvironmentPreflight(client: RebuiltSqlClient): Promise<EnvironmentReport> {
  const eventTriggers = (await client.query(EVENT_TRIGGERS_SQL)).rows as EnvironmentReport['eventTriggers'];
  const defaults = (await client.query(DEFAULT_PRIVILEGES_SQL)).rows as EnvironmentReport['defaults'];
  const dataApi = (await client.query(DATA_API_SQL)).rows[0] as EnvironmentReport['dataApi'];
  return { eventTriggers, defaults, dataApi };
}

const ident = (v: unknown): string => (typeof v === 'string' && /^[A-Za-z0-9_]{1,63}$/.test(v) ? v : 'other');

/** Prints identifiers (checked), booleans and counts only; the manager reads these lines. */
export function reportEnvironmentPreflight(r: EnvironmentReport): void {
  const line = (o: Record<string, unknown>) => console.log(JSON.stringify(o));
  line({ msg: 'staging-sql.environment_event_triggers', count: r.eventTriggers.length, enables_rls: r.eventTriggers.filter((e) => e.enables_rls === true).length });
  for (const e of r.eventTriggers) line({ msg: 'staging-sql.environment_event_trigger', name: ident(e.name), event: ident(e.event), enabled: ident(e.enabled), function: ident(e.function), enables_rls: e.enables_rls === true });
  for (const d of r.defaults) {
    line({
      msg: 'staging-sql.environment_default_privileges',
      role: ident(d.role),
      tables_public: d.tables_public === true, sequences_public: d.sequences_public === true, functions_public: d.functions_public === true,
      tables_global: d.tables_global === true, sequences_global: d.sequences_global === true, functions_global: d.functions_global === true,
    });
  }
  line({
    msg: 'staging-sql.environment_data_api',
    authenticator_exists: r.dataApi.authenticator_exists === true,
    schema_list_entries: Number(r.dataApi.schema_list_entries),
    public_listed: r.dataApi.public_listed === null || r.dataApi.public_listed === undefined ? 'unknown' : r.dataApi.public_listed === true,
    api_roles_present: Number(r.dataApi.api_roles_present),
  });
  line({ msg: 'staging-sql.environment_preflight', note: 'report only; each line is a manager decision gate' });
}
