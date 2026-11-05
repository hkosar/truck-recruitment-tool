// A3 LOCAL only (TRUCKRECRU-149): the Supabase-like runner setup shared by m1-supabase-runner-a3.test.ts and pg17-probe-apply-m1.ts
// (scripts/pg17-probe.mjs --apply-m1), moved here unchanged so both apply M1 from the same starting state.

/** A made-up rebuilt-staging ref and URL: planRebuiltSqlRun only plans with them; the executor gets an injected loopback client. */
export const REF = 'abcdefghijklmnopqrst';
export const FAKE_URL = `postgresql://postgres.${REF}:redacted-pw@aws-0-us-east-2.pooler.supabase.com:5432/postgres`;
export const RUNNER = 'tr_m1_runner';

/** Gives the runner login what Supabase's postgres has: the database, schema internal and every non-extension object of public and
 *  internal (the PostGIS routines stay with the superuser, as supabase_admin owns PostGIS), and the realtime publication. */
export const HANDOVER_SQL = `do $x$
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
export const STANDIN_EXT_SQL = `(select d0.refobjid from pg_depend d0 join pg_proc p0 on p0.oid = d0.objid where d0.classid = 'pg_proc'::regclass and d0.refclassid = 'pg_extension'::regclass and d0.deptype = 'e' and p0.proname = 'st_x')`;

/** Hosted Supabase: the migrations' "revoke ... from public" on the PostGIS routines was run by a non-owner, so PUBLIC keeps EXECUTE. */
export const PUBLIC_EXECUTE_SQL = `do $p$ declare r record; begin
  for r in select d.objid::regprocedure as fn from pg_depend d join pg_extension e on e.oid = d.refobjid
           where d.classid = 'pg_proc'::regclass and d.refclassid = 'pg_extension'::regclass and d.deptype = 'e' and e.oid = ${STANDIN_EXT_SQL} loop
    execute format('grant execute on routine %s to public', r.fn);
  end loop;
end $p$`;

/** The SQL the m1 suite runs as the superuser on a baseline database (no M1) before the runner applies M1 with PostGIS in public
 *  (its case 2): the NOSUPERUSER CREATEROLE INHERIT login, the handover, and (assumed from Supabase's role setup, not verified on
 *  staging-2) membership of anon, authenticated and service_role granted by the superuser. pwLiteral is an already quoted literal. */
export const runnerSetupStatements = (pwLiteral: string): string[] => [
  `create role ${RUNNER} login nosuperuser createrole inherit password ${pwLiteral}`,
  HANDOVER_SQL,
  `grant anon, authenticated, service_role to ${RUNNER}`,
];
