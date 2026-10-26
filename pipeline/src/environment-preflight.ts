// Read-only report of catalogue FACTS about the new staging project, run BEFORE the 20-file replay (doc 16 section 1.3
// step 4a). It reports; it does not pass, fail or interpret anything, and it does NOT establish the three project
// switches the creation screen pre-selects (Data API, "Automatically expose new tables", "Enable automatic RLS"):
// those are owner dashboard checks with a STOP gate (draft approval-4 step 3). What it can prove from SQL:
//   1. event triggers: the complete count and, up to LIST_LIMIT, each trigger's position, event, enabled state and
//      name / function name (names only when reviewed; otherwise `unlisted`). Nothing is inferred from function text (a body can delegate to a helper, build its statement
//      from pieces or only mention the words in a comment). Zero is a valid result. `truncated` says when the list
//      is cut off. Every listed trigger needs an explicit human assessment; a name alone verifies nothing.
//   2. default privileges: the explicit pg_default_acl entries of THIS login, as the full set of privilege types that
//      anon, authenticated, service_role and PUBLIC would receive on new tables, sequences and functions, in schema
//      public and globally (not schema-limited), plus whether any entry is grantable and how many entries fall
//      outside those cells. Implicit defaults (for example EXECUTE on functions for PUBLIC when no entry exists) are
//      NOT visible in pg_default_acl and are not reported; effective access of an existing object is a different
//      question and is not measured here.
//   3. authenticator role settings: how many pgrst.db_schemas settings exist on the `authenticator` role (role-wide and
//      for this database) and, only when exactly one exists, whether it names `public`. That is a fact about that
//      setting. It is NOT the Data API on/off switch, the exposed-schema list the running API uses, or proof either way.
// It prints only fixed keys, enumerated words, booleans and counts: a database-derived name is shown only when it is on the reviewed
// lists above, otherwise as `unlisted` (never a connection detail, never arbitrary catalogue text). It changes nothing.

import type { RebuiltSqlClient } from './staging-rebuilt.js';

export const ENV_ROLES = ['anon', 'authenticated', 'service_role'] as const;
export const LIST_LIMIT = 50;
/**
 * Display contract for database-derived names (review r7 finding 3): an event trigger or function name is printed only when
 * it is EXACTLY one of these reviewed names; any other name prints as the fixed word `unlisted` plus its position in the
 * ordered list, and the manager stops for a separately reviewed diagnostic. Nothing the database chooses is shown except
 * what is on these lists. The names are the ones Supabase's own platform event triggers are believed to use and are NOT
 * verified against the new project: an unexpected name only causes a STOP, never a pass. Keep equal to
 * scripts/run-with-secrets.mjs (a test compares them).
 */
export const REVIEWED_EVENT_TRIGGER_NAMES = ['issue_graphql_placeholder', 'issue_pg_cron_access', 'issue_pg_graphql_access', 'issue_pg_net_access', 'pgrst_ddl_watch', 'pgrst_drop_watch', 'ensure_rls'] as const;
export const REVIEWED_EVENT_TRIGGER_FUNCTIONS = ['set_graphql_placeholder', 'grant_pg_cron_access', 'grant_pg_graphql_access', 'grant_pg_net_access', 'pgrst_ddl_watch', 'pgrst_drop_watch', 'rls_auto_enable'] as const;
export const EVENT_TRIGGER_EVENTS = ['ddl_command_start', 'ddl_command_end', 'sql_drop', 'table_rewrite'] as const;
export const EVENT_TRIGGER_ENABLED_STATES = ['O', 'D', 'R', 'A'] as const;
export const PRIVILEGE_TYPES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN', 'USAGE', 'EXECUTE', 'CREATE', 'OTHER'] as const;

export const EVENT_TRIGGERS_SQL = `select e.evtname::text as name, e.evtevent::text as event, e.evtenabled::text as enabled,
       (p.proname)::text as function
  from pg_event_trigger e join pg_proc p on p.oid = e.evtfoid
 order by e.evtname limit ${LIST_LIMIT}`;

export const EVENT_TRIGGER_COUNT_SQL = 'select count(*)::int as total from pg_event_trigger';

/** One row per explicit default-ACL entry of the connected login: who, which object kind, which scope, which privilege. */
export const DEFAULT_PRIVILEGES_SQL = `select case when x.grantee = 0 then 'PUBLIC' else (select r.rolname::text from pg_roles r where r.oid = x.grantee) end as grantee,
       d.defaclobjtype::text as objtype,
       case when d.defaclnamespace = 0 then 'global' when d.defaclnamespace = 'public'::regnamespace then 'public' else 'other' end as scope,
       x.privilege_type::text as privilege,
       x.is_grantable as grantable
  from pg_default_acl d, aclexplode(d.defaclacl) x
 where d.defaclrole = (select oid from pg_roles where rolname = current_user)
 order by 1, 2, 3, 4`;

export const ROLES_PRESENT_SQL = "select r.rolname::text as role from pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator') order by 1";

export const AUTHENTICATOR_SETTING_SQL = `with a as (select oid from pg_roles where rolname = 'authenticator'),
s as (
  select (st.setdatabase = 0) as role_wide, c
    from pg_db_role_setting st, unnest(st.setconfig) c
   where st.setrole = (select oid from a) and st.setdatabase in (0, (select oid from pg_database where datname = current_database()))
     and c like 'pgrst.db_schemas=%'
)
select exists (select 1 from a) as authenticator_exists,
       (select count(*)::int from s where role_wide) as role_wide_entries,
       (select count(*)::int from s where not role_wide) as this_database_entries,
       (select regexp_replace(substr(c, length('pgrst.db_schemas=') + 1), '\\s', '', 'g') ~ '(^|,)public(,|$)' from s limit 1) as names_public_if_single`;

type ObjKind = 'tables' | 'sequences' | 'functions';
type Scope = 'public' | 'global';
export type PrivilegeCells = Record<`${ObjKind}_${Scope}`, string[]>;
export interface DefaultAclRow { grantee: string | null; objtype: string; scope: string; privilege: string; grantable: boolean }

export interface EnvironmentReport {
  eventTriggers: { total: number; listed: Array<{ name: string; event: string; enabled: string; function: string }> };
  rolesPresent: string[];
  defaults: { rows: DefaultAclRow[] };
  authenticator: { authenticator_exists: boolean; role_wide_entries: number; this_database_entries: number; names_public_if_single: boolean | null };
}

export async function runEnvironmentPreflight(client: RebuiltSqlClient): Promise<EnvironmentReport> {
  const triggerRows = (await client.query(EVENT_TRIGGERS_SQL)).rows as Array<{ name: string; event: string; enabled: string; function: string }>;
  // Counted separately from the (capped) list so that zero is an observed zero and a cut-off list is visible.
  const total = ((await client.query(EVENT_TRIGGER_COUNT_SQL)).rows[0] as { total: number }).total;
  const rolesPresent = ((await client.query(ROLES_PRESENT_SQL)).rows as Array<{ role: string }>).map((r) => r.role);
  const rows = (await client.query(DEFAULT_PRIVILEGES_SQL)).rows as DefaultAclRow[];
  const authenticator = (await client.query(AUTHENTICATOR_SETTING_SQL)).rows[0] as EnvironmentReport['authenticator'];
  return { eventTriggers: { total, listed: triggerRows }, rolesPresent, defaults: { rows }, authenticator };
}

const listed = (v: unknown, reviewed: readonly string[], fallback: string): string => (typeof v === 'string' && reviewed.includes(v) ? v : fallback);
const priv = (v: unknown): string => (typeof v === 'string' && (PRIVILEGE_TYPES as readonly string[]).includes(v) ? v : 'OTHER');
const KIND: Record<string, ObjKind | undefined> = { r: 'tables', S: 'sequences', f: 'functions' };

/** Groups the default-ACL rows into the per-grantee cells the report prints; everything else is counted, not listed. */
export function summariseDefaults(rows: readonly DefaultAclRow[]): { byGrantee: Record<string, PrivilegeCells & { grant_option: boolean }>; entries: number; otherEntries: number } {
  const grantees = [...ENV_ROLES, 'PUBLIC'] as const;
  const blank = (): PrivilegeCells & { grant_option: boolean } => ({ tables_public: [], sequences_public: [], functions_public: [], tables_global: [], sequences_global: [], functions_global: [], grant_option: false });
  const byGrantee: Record<string, PrivilegeCells & { grant_option: boolean }> = Object.fromEntries(grantees.map((g) => [g, blank()]));
  let otherEntries = 0;
  for (const r of rows) {
    const kind = KIND[r.objtype];
    const cell = byGrantee[r.grantee ?? ''];
    if (!kind || !cell || (r.scope !== 'public' && r.scope !== 'global')) { otherEntries += 1; continue; }
    const key = `${kind}_${r.scope}` as keyof PrivilegeCells;
    cell[key].push(priv(r.privilege));
    if (r.grantable === true) cell.grant_option = true;
  }
  for (const g of grantees) for (const k of Object.keys(byGrantee[g]!) as Array<keyof PrivilegeCells>) if (Array.isArray(byGrantee[g]![k])) (byGrantee[g]![k] as string[]).sort();
  return { byGrantee, entries: rows.length, otherEntries };
}

/** Prints identifiers (checked), enumerated words, booleans and counts only; the manager reads these lines. */
export function reportEnvironmentPreflight(r: EnvironmentReport): void {
  const line = (o: Record<string, unknown>) => console.log(JSON.stringify(o));
  const total = Number.isSafeInteger(r.eventTriggers.total) ? r.eventTriggers.total : -1;
  line({ msg: 'staging-sql.environment_event_triggers', count: total, listed: r.eventTriggers.listed.length, truncated: total > r.eventTriggers.listed.length });
  r.eventTriggers.listed.forEach((e, i) => line({
    msg: 'staging-sql.environment_event_trigger', position: i + 1,
    name: listed(e.name, REVIEWED_EVENT_TRIGGER_NAMES, 'unlisted'), event: listed(e.event, EVENT_TRIGGER_EVENTS, 'other'),
    enabled: listed(e.enabled, EVENT_TRIGGER_ENABLED_STATES, 'other'), function: listed(e.function, REVIEWED_EVENT_TRIGGER_FUNCTIONS, 'unlisted'),
  }));
  const sum = summariseDefaults(r.defaults.rows);
  for (const role of ENV_ROLES) {
    const cells = sum.byGrantee[role]!;
    line({ msg: 'staging-sql.environment_default_acl', role, role_present: r.rolesPresent.includes(role), ...cells });
  }
  line({ msg: 'staging-sql.environment_default_acl', role: 'PUBLIC', role_present: true, ...sum.byGrantee.PUBLIC! });
  line({ msg: 'staging-sql.environment_default_acl_total', entries: sum.entries, outside_these_cells: sum.otherEntries, scope: 'explicit_default_acl_entries_of_this_login_only' });
  const a = r.authenticator;
  const single = a.role_wide_entries + a.this_database_entries === 1;
  line({
    msg: 'staging-sql.environment_authenticator_setting',
    authenticator_exists: a.authenticator_exists === true,
    role_wide_entries: Number(a.role_wide_entries),
    this_database_entries: Number(a.this_database_entries),
    names_public: single && typeof a.names_public_if_single === 'boolean' ? a.names_public_if_single : 'unknown',
    is_the_data_api_switch: false,
  });
  line({ msg: 'staging-sql.environment_preflight', scope: 'catalogue_facts_only_owner_checks_the_three_dashboard_switches' });
}
