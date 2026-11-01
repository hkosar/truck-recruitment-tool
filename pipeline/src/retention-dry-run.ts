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
 * Catalogue-wide boundary proof (counts and yes/no only): the table list comes from the catalogue, so a table added later
 * or a grant widened by mistake is caught. System schemas are excluded (they are readable by PUBLIC by design); the
 * select/function checks cover only this application's own schemas, where nothing is granted to PUBLIC.
 */
export const BOUNDARY_SQL = `
  with rels as (
    select c.oid, n.nspname || '.' || c.relname as name, n.nspname as schema
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.relkind in ('r', 'p', 'v', 'm', 'f') and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname !~ '^pg_'
  )
  select
    (select count(*)::int from rels where has_table_privilege(current_user, oid, 'DELETE') and name <> all ($1::text[])) as delete_outside,
    (select count(*)::int from rels where name = any ($1::text[]) and has_table_privilege(current_user, oid, 'DELETE')) as delete_inside,
    (select count(*)::int from rels where has_any_column_privilege(current_user, oid, 'INSERT') or has_any_column_privilege(current_user, oid, 'UPDATE')
        or has_table_privilege(current_user, oid, 'TRUNCATE') or has_table_privilege(current_user, oid, 'REFERENCES') or has_table_privilege(current_user, oid, 'TRIGGER')) as write_anywhere,
    (select count(*)::int from rels where schema in ('public', 'internal', 'auth', 'staging_identity', 'supabase_migrations')
        and has_any_column_privilege(current_user, oid, 'SELECT') and name <> all ($1::text[])) as select_outside,
    (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'internal' and has_function_privilege(current_user, p.oid, 'EXECUTE')) as internal_functions,
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
    check('no execute privilege on any internal-schema function', boundary.internal_functions === 0);
    check('no superuser, create-role, create-db, bypass-rls or replication attribute', boundary.powerful_attributes === 0);
    check('member of no other role', boundary.memberships === 0);
  } finally {
    await client.query('rollback');
  }

  report.ok = report.checks.every((c) => c.ok);
  return report;
}
