// Hosted least-privilege test for the retention role (doc 16 section 4 step 3), run by the rebuilt
// staging runner action `retention-dry-run` while connected AS recruiter_maintenance.
//
// It never deletes. Part 1 counts, in a read-only transaction, the rows each retention rule WOULD
// delete. Part 2 proves the role is least-privilege: in a transaction that is always rolled back it
// must be refused (SQLSTATE 42501) when it reads public.profiles, calls a sign-in function, or
// updates a ledger, and the catalogue must show select + delete (only) on the five ledgers.
// Output carries counts, check names and pass/fail only: no row data, no connection details.

import { RETENTION_RULES } from './retention.js';

export const MAINTENANCE_LEDGER_TABLES = RETENTION_RULES.map((rule) => rule.table);

export interface DryRunClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface DryRunReport {
  currentUser: string | null;
  wouldDelete: Record<string, number>;
  checks: Array<{ name: string; ok: boolean }>;
  ok: boolean;
}

/** SQL that must be refused with insufficient_privilege (42501) for recruiter_maintenance. */
export const DENIED_STATEMENTS: ReadonlyArray<{ name: string; sql: string }> = [
  { name: 'cannot select public.profiles', sql: 'select 1 from public.profiles limit 1' },
  { name: 'cannot select public.carriers', sql: 'select 1 from public.carriers limit 1' },
  { name: 'cannot execute a sign-in function', sql: 'select internal.auth_session_info()' },
  { name: 'cannot execute a team function', sql: 'select public.team_list()' },
  { name: 'cannot update a ledger', sql: 'update internal.signin_links set token_hash = token_hash where false' },
  { name: 'cannot insert into a ledger', sql: 'insert into internal.auth_request_buckets select * from internal.auth_request_buckets where false' },
  { name: 'cannot truncate a ledger', sql: 'truncate internal.email_events' },
];

/**
 * Catalogue-wide boundary proof (counts and yes/no only): every list comes from the catalogue, so a table, schema,
 * function or sequence added later, or a grant widened by mistake, is caught. System schemas (pg_*, information_schema)
 * are excluded because PUBLIC may use them by design. "Direct" checks read the role's own ACL entries (aclexplode with
 * grantee = this role), so they are schema-agnostic and ignore PUBLIC-by-design grants (hosted vault, storage, realtime...).
 */
export const BOUNDARY_SQL = `
  with me as (select oid from pg_roles where rolname = current_user),
  schemas as (
    select n.oid, n.nspname from pg_namespace n where n.nspname <> 'information_schema' and n.nspname !~ '^pg_'
  ),
  rels as (
    select c.oid, n.nspname || '.' || c.relname as name, n.nspname as schema, c.relkind, c.relacl
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.relkind in ('r', 'p', 'v', 'm', 'f', 'S') and n.nspname <> 'information_schema' and n.nspname !~ '^pg_'
  ),
  tables as (select * from rels where relkind <> 'S'),
  funcs as (
    select p.oid, n.nspname as schema, p.proacl
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname <> 'information_schema' and n.nspname !~ '^pg_'
       and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
  )
  select
    (select count(*)::int from tables where has_table_privilege(current_user, oid, 'DELETE') and name <> all ($1::text[])) as delete_outside,
    (select count(*)::int from tables where name = any ($1::text[]) and has_table_privilege(current_user, oid, 'DELETE')) as delete_inside,
    (select count(*)::int from tables where has_any_column_privilege(current_user, oid, 'INSERT') or has_any_column_privilege(current_user, oid, 'UPDATE')
        or has_table_privilege(current_user, oid, 'TRUNCATE') or has_table_privilege(current_user, oid, 'REFERENCES') or has_table_privilege(current_user, oid, 'TRIGGER')) as write_anywhere,
    (select count(*)::int from tables where schema in ('public', 'internal', 'auth', 'staging_identity', 'supabase_migrations')
        and has_any_column_privilege(current_user, oid, 'SELECT') and name <> all ($1::text[])) as select_outside,
    (select count(*)::int from rels r, aclexplode(r.relacl) a
      where a.grantee = (select oid from me) and r.name <> all ($1::text[])) as direct_relation_grants_outside,
    (select count(*)::int from pg_attribute at join rels r on r.oid = at.attrelid, aclexplode(at.attacl) a
      where at.attacl is not null and a.grantee = (select oid from me) and r.name <> all ($1::text[])) as direct_column_grants_outside,
    (select count(*)::int from funcs where schema in ('public', 'internal') and has_function_privilege(current_user, oid, 'EXECUTE')) as exec_public_internal,
    (select count(*)::int from funcs f, aclexplode(f.proacl) a where a.grantee = (select oid from me)) as direct_function_grants,
    (select count(*)::int from schemas where has_schema_privilege(current_user, oid, 'CREATE')) as schema_create,
    (select count(*)::int from rels where relkind = 'S' and (has_sequence_privilege(current_user, oid, 'USAGE') or has_sequence_privilege(current_user, oid, 'UPDATE')
        or has_sequence_privilege(current_user, oid, 'SELECT'))) as sequence_privileges,
    (case when has_database_privilege(current_user, current_database(), 'CREATE') then 1 else 0 end) as database_create,
    (select count(*)::int from pg_roles r where r.rolname = current_user
        and (r.rolsuper or r.rolcreaterole or r.rolcreatedb or r.rolbypassrls or r.rolreplication)) as powerful_attributes,
    (select count(*)::int from pg_auth_members m join pg_roles r on r.oid = m.member where r.rolname = current_user) as memberships`;

async function refusedWith42501(client: DryRunClient, sql: string): Promise<boolean> {
  await client.query('savepoint dry_run_check');
  try {
    await client.query(sql);
    await client.query('rollback to savepoint dry_run_check');
    return false;
  } catch (error) {
    await client.query('rollback to savepoint dry_run_check');
    return (error as { code?: string }).code === '42501';
  }
}

export async function runRetentionDryRun(client: DryRunClient, expectedRole: string): Promise<DryRunReport> {
  const report: DryRunReport = { currentUser: null, wouldDelete: {}, checks: [], ok: false };
  const check = (name: string, ok: boolean) => report.checks.push({ name, ok });

  await client.query('begin read only');
  try {
    await client.query("set local statement_timeout = '30s'");
    report.currentUser = String((await client.query('select current_user as u')).rows[0]?.u ?? '');
    check(`session is ${expectedRole}`, report.currentUser === expectedRole);
    for (const rule of RETENTION_RULES) {
      const n = (await client.query(`select count(*)::int as n from ${rule.table} where ${rule.where}`)).rows[0]?.n;
      report.wouldDelete[rule.name] = typeof n === 'number' ? n : -1;
    }
    check('counted every retention rule', Object.values(report.wouldDelete).every((n) => n >= 0));
  } finally {
    await client.query('rollback');
  }

  await client.query('begin');
  try {
    await client.query("set local statement_timeout = '10s'");
    for (const denied of DENIED_STATEMENTS) check(denied.name, await refusedWith42501(client, denied.sql));
    for (const table of MAINTENANCE_LEDGER_TABLES) {
      const row = (await client.query(
        `select has_table_privilege(current_user, $1, 'SELECT') as s, has_table_privilege(current_user, $1, 'DELETE') as d,
                has_table_privilege(current_user, $1, 'INSERT') as i, has_table_privilege(current_user, $1, 'UPDATE') as u,
                has_table_privilege(current_user, $1, 'TRUNCATE') as t`,
        [table],
      )).rows[0];
      check(`${table}: select and delete only`, row?.s === true && row?.d === true && row?.i === false && row?.u === false && row?.t === false);
    }
    const boundary = (await client.query(BOUNDARY_SQL, [MAINTENANCE_LEDGER_TABLES])).rows[0] ?? {};
    check('delete is held on exactly the five ledgers', boundary.delete_inside === MAINTENANCE_LEDGER_TABLES.length && boundary.delete_outside === 0);
    check('no insert, update, truncate, references or trigger privilege on any table', boundary.write_anywhere === 0);
    check('select is held on no table outside the five ledgers (application schemas)', boundary.select_outside === 0);
    check('no direct grant of any kind on any relation, sequence or column outside the five ledgers (every schema)', boundary.direct_relation_grants_outside === 0 && boundary.direct_column_grants_outside === 0);
    check('no execute privilege on any non-extension function in public or internal', boundary.exec_public_internal === 0);
    check('no direct execute grant on any function in any schema', boundary.direct_function_grants === 0);
    check('no create privilege on any schema', boundary.schema_create === 0);
    check('no usage, select or update privilege on any sequence', boundary.sequence_privileges === 0);
    check('no create privilege on the database', boundary.database_create === 0);
    check('no superuser, create-role, create-db, bypass-rls or replication attribute', boundary.powerful_attributes === 0);
    check('member of no other role', boundary.memberships === 0);
  } finally {
    await client.query('rollback');
  }

  report.ok = report.checks.every((c) => c.ok);
  return report;
}
