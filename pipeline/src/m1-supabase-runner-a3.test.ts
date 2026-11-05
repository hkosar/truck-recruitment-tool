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
// (68/68, catalogue unchanged afterwards, membership still ADMIN-only) and postgis-placement. Like hosted Supabase (assumed, not
// verified), the login is made a member of anon, authenticated and service_role by the superuser.
//   5. PostGIS in public, plus the dangerous starting state of Codex review thr_fhw66f89ay B1 (TRUCKRECRU-143): the runner login
//      has default privileges in schema internal (and public) that grant new tables and sequences to anon and authenticated (and in
//      internal to PUBLIC) (runs on a copy of the pristine public database, made at the start like case 4's). The "grant ... on all
//      tables/sequences in schema internal" lines of that review find no relation there before M1 (the migrations create none). After
//      M1 the runner's default privileges for schema internal hand nothing to those roles (M1 revokes them before its first table).
// Since TRUCKRECRU-143 round 4 M1 never changes privileges on a relation it did not create (the earlier "sweep" over existing
// internal relations is gone). Cases 6-8 start with such relations: M1, M1b and M1c must apply without error, change nothing on
// them (full table and column ACLs, owners, and the effective privileges, direct, through PUBLIC or inherited, with and without
// grant option, of service_role, every recruiter_* role, the runner and every owner, and their USAGE/CREATE on schema internal; read
// by the superuser before M1, after M1, after M1b/M1c and after the matrix), give anon/authenticated nothing on what they create,
// and the role matrix must refuse the leftover with the named probes and leave nothing behind (each on a copy of the pristine public
// database, like case 5's).
//   6. Codex review thr_phw7jjfvc9 B1 (round 2): an ordinary table in internal owned by another role (not the runner, which neither
//      owns it nor inherits its owner), on which anon holds only MAINTAIN (PostgreSQL 17) or only TRUNCATE (16: no MAINTAIN there; also
//      a table-only right); round 1's sweep raised 42501 there. The matrix refuses exactly 1 of 68 (anon's internal probe, naming it).
//   7. Codex review thr_pp3mvh6wjz B1 (round 3): relations in internal that the runner owns, on which anon (or authenticated) holds a
//      right WITH GRANT OPTION and passed it on (to service_role, or anon to authenticated): the review's table, a column grant, a
//      view, a materialized view, a partitioned table, a foreign table and a sequence (round 2's sweep raised 2BP01 "dependent
//      privileges exist" on each), plus a column-only grant, a table anon owns, and a table where service_role (with grant option)
//      granted anon a right next to the owner's own grant. The matrix refuses exactly 2 of 68 (anon's and authenticated's internal
//      probes, naming exactly those relations).
//   8. Codex review thr_v6e6ax8gt9 B1 (round 3's sweep): service_role, recruiter_review and the owner tr_m1_review_owner (whose role
//      the runner inherits) hold SELECT on internal.hunt_effective only through their membership in anon (round 3's sweep took it
//      from all three); plus a runner-owned table granted to anon, authenticated and PUBLIC (what the sweep used to clear), and
//      the runner's GLOBAL default privileges (no schema) granting new tables and sequences to anon and authenticated, which a
//      schema-level revoke cannot remove: M1's and M1b's tables and M1's identity sequences must still end up with no anon/
//      authenticated/PUBLIC access (M1 and M1b revoke them by name). Measured, not fixed here: M1c (pinned, unchanged) revokes only
//      its table, so the global sequence default reaches internal.batch_delete_audit_id_seq. The matrix refuses exactly 4 of 68
//      (anon's and authenticated's internal probes naming those relations, and both "new internal table" default-privilege probes).
// In every applied case but 6, 7 and 8, after M1 and again after M1b/M1c: anon and authenticated hold no effective privilege on any app table,
// view or sequence in public and internal (MAINTAIN included on PostgreSQL 17+), and an unqualified VACUUM (VERBOSE) as each of
// them, outside any transaction, processes no app table (from its "vacuuming" notices; a superuser VACUUM of one table proves the
// notices are read).
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
/** Case 6: owns one internal table; the runner is not a member of it. */
const OTHER_OWNER = 'tr_m1_other_owner';
/** Case 8: owns internal.hunt_effective; the runner inherits it. A member of anon, like REVIEW_RECRUITER. */
const REVIEW_OWNER = 'tr_m1_review_owner';
/** Case 8: a recruiter_* role that is not one of M1's, a member of anon. */
const REVIEW_RECRUITER = 'recruiter_review';
const M1_ROLES = ['recruiter_api', 'recruiter_app', 'recruiter_maintenance'];
/** Roles a case may create (all dropped by dropCase). */
const CASE_ROLES = [...M1_ROLES, RUNNER, NO_ADMIN_RUNNER, OTHER_OWNER, REVIEW_OWNER, REVIEW_RECRUITER];
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

/** The app relations of public and internal (tables, views, sequences; extension members are the platform's). */
const APP_RELATIONS_SQL = `select c.oid, n.nspname || '.' || c.relname as name, c.relkind::text as kind from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('public', 'internal') and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
    and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.refclassid = 'pg_extension'::regclass and d.deptype = 'e')`;
/** Every app relation / API role pair with any effective privilege (direct, through PUBLIC or inherited). $1: the table privileges
 *  to test (MAINTAIN only on PostgreSQL 17+, where it exists). */
const API_EXPOSURE_SQL = `select coalesce(array_agg(r.name || ':' || a.role order by r.name, a.role), '{}') as exposed
  from (${APP_RELATIONS_SQL}) r cross join (values ('anon'), ('authenticated')) a(role)
 where case when r.kind = 'S' then has_sequence_privilege(a.role, r.oid, 'USAGE,SELECT,UPDATE')
            else has_table_privilege(a.role, r.oid, $1) or has_any_column_privilege(a.role, r.oid, 'SELECT,INSERT,UPDATE,REFERENCES') end`;
const API_MAINTAIN_SQL = `select coalesce(array_agg(r.name || ':' || a.role order by r.name, a.role), '{}') as exposed
  from (${APP_RELATIONS_SQL}) r cross join (values ('anon'), ('authenticated')) a(role)
 where r.kind in ('r', 'p', 'm') and has_table_privilege(a.role, r.oid, 'MAINTAIN')`;
const TABLE_PRIVILEGES_16 = 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER';

/** Codex review thr_fhw66f89ay B1: a Supabase-like runner whose default privileges hand new public and internal tables and
 *  sequences to the API roles (internal also to PUBLIC), with the existing relations granted (TRUCKRECRU-143; the migrations create
 *  no relation in internal, so the two "on all ... in schema internal" lines grant nothing before M1). */
const DANGEROUS_DEFAULT_ACL_SQL = [
  'grant all on all tables in schema public to anon, authenticated, service_role',
  `alter default privileges for role ${RUNNER} in schema public grant all on tables to anon, authenticated, service_role`,
  'grant usage on schema internal to anon, authenticated',
  'grant all on all tables in schema internal to anon, authenticated, public',
  'grant all on all sequences in schema internal to anon, authenticated, public',
  `alter default privileges for role ${RUNNER} in schema internal grant all on tables to anon, authenticated, public`,
  `alter default privileges for role ${RUNNER} in schema internal grant all on sequences to anon, authenticated, public`,
];

/** Case 7 (Codex review thr_pp3mvh6wjz B1, TRUCKRECRU-143 round 3): run by the superuser admin, after the handover. Grants made
 *  by the admin are recorded with the owner as grantor; the ones made after "set role" carry that role as grantor. */
const DEPENDENT_GRANT_SQL = [
  'grant usage on schema internal to anon, authenticated',
  'create foreign data wrapper tr_review_fdw',
  'create server tr_review_srv foreign data wrapper tr_review_fdw',
  'create table internal.review_dependent (id int)',
  'create table internal.review_dep_column (id int)',
  'create table internal.review_dep_column_only (id int)',
  'create table internal.review_dep_chain (id int)',
  'create sequence internal.review_dep_seq',
  'create view internal.review_dep_view as select 1 as id',
  'create materialized view internal.review_dep_matview as select 1 as id',
  'create table internal.review_dep_parted (id int) partition by range (id)',
  'create table internal.review_dep_parted_1 partition of internal.review_dep_parted for values from (0) to (10)',
  'create foreign table internal.review_dep_foreign (id int) server tr_review_srv',
  'create table internal.review_anon_owned (id int)',
  'create table internal.review_other_grantor (id int)',
  ...['review_dependent', 'review_dep_column', 'review_dep_column_only', 'review_dep_chain', 'review_dep_view', 'review_dep_matview', 'review_dep_parted',
    'review_dep_parted_1', 'review_dep_foreign', 'review_other_grantor'].map((t) => `alter table internal.${t} owner to ${RUNNER}`),
  `alter sequence internal.review_dep_seq owner to ${RUNNER}`,
  'alter table internal.review_anon_owned owner to anon',
  // The review's exact chain, then the same on the other relation kinds.
  'grant select on internal.review_dependent to anon with grant option',
  'grant insert on internal.review_dep_column to anon',
  'grant select (id) on internal.review_dep_column to anon with grant option',
  'grant select (id) on internal.review_dep_column_only to anon with grant option',
  'grant select on internal.review_dep_chain to anon with grant option',
  'grant usage on sequence internal.review_dep_seq to anon with grant option',
  'grant select on internal.review_dep_view to anon with grant option',
  'grant select on internal.review_dep_matview to anon with grant option',
  'grant select on internal.review_dep_parted to anon with grant option',
  'grant select on internal.review_dep_foreign to anon with grant option',
  'grant select on internal.review_other_grantor to service_role with grant option',
  'grant insert on internal.review_other_grantor to anon',
  'set role anon',
  'grant select on internal.review_dependent to service_role',
  'grant select (id) on internal.review_dep_column to service_role',
  'grant select (id) on internal.review_dep_column_only to service_role',
  'grant select on internal.review_dep_chain to authenticated',
  'grant usage on sequence internal.review_dep_seq to service_role',
  'grant select on internal.review_dep_view to service_role',
  'grant select on internal.review_dep_matview to service_role',
  'grant select on internal.review_dep_parted to service_role',
  'grant select on internal.review_dep_foreign to service_role',
  'grant select on internal.review_anon_owned to service_role',
  'reset role',
  // service_role needs USAGE on internal only to name the table; it is taken back at once (the schema ACL stays as before).
  'grant usage on schema internal to service_role',
  'set role service_role',
  'grant select on internal.review_other_grantor to anon',
  'reset role',
  'revoke usage on schema internal from service_role',
];
/** The relations case 7 adds, and which API role keeps a privilege on each after M1 (the role matrix must name exactly these). */
const DEPENDENT_GRANT_LEFT: Record<string, string[]> = {
  review_anon_owned: ['anon'], review_dep_chain: ['anon', 'authenticated'], review_dep_column: ['anon'], review_dep_column_only: ['anon'],
  review_dep_foreign: ['anon'], review_dep_matview: ['anon'], review_dep_parted: ['anon'], review_dep_seq: ['anon'], review_dep_view: ['anon'],
  review_dependent: ['anon'], review_other_grantor: ['anon'],
};
/** Every table and column ACL entry of case 7's relations (the partition included), as text, read by the superuser admin. */
const DEPENDENT_GRANT_ACL_SQL = `select coalesce(array_agg(x order by x), '{}') as acl from (
  select c.relname || ':' || a.grantee::regrole::text || '=' || a.privilege_type || ':' || a.is_grantable::text || '/' || a.grantor::regrole::text as x
    from pg_class c, aclexplode(c.relacl) a where c.relnamespace = 'internal'::regnamespace and c.relname like 'review\\_%'
  union all
  select c.relname || '.' || t.attname || ':' || a.grantee::regrole::text || '=' || a.privilege_type || ':' || a.is_grantable::text || '/' || a.grantor::regrole::text
    from pg_class c join pg_attribute t on t.attrelid = c.oid, aclexplode(t.attacl) a where c.relnamespace = 'internal'::regnamespace and c.relname like 'review\\_%'
) s`;

/** Case 8 (Codex review thr_v6e6ax8gt9 B1, TRUCKRECRU-143 round 4): run by the superuser admin, after the handover. service_role is
 *  made a member of anon here (cluster-wide), and that membership is revoked again when the case ends. */
const INHERITED_RIGHTS_SQL = [
  `create role ${REVIEW_OWNER}`,
  `create role ${REVIEW_RECRUITER}`,
  // The review's fixture: three protected roles get SELECT only through anon.
  'create table internal.hunt_effective (id int)',
  `alter table internal.hunt_effective owner to ${REVIEW_OWNER}`,
  `revoke select on internal.hunt_effective from ${REVIEW_OWNER}`,
  'grant select on internal.hunt_effective to anon',
  `grant anon to service_role, ${REVIEW_RECRUITER}, ${REVIEW_OWNER}`,
  `grant ${REVIEW_OWNER} to ${RUNNER} with inherit true, set true, admin false`,
  `grant usage on schema internal to service_role, ${REVIEW_RECRUITER}, ${REVIEW_OWNER}`,
  // What earlier rounds' sweep cleared: a runner-owned table granted to anon, authenticated and PUBLIC.
  'create table internal.hunt_leftover (id int)',
  `alter table internal.hunt_leftover owner to ${RUNNER}`,
  `grant select on internal.hunt_leftover to anon, authenticated, public, ${REVIEW_RECRUITER}`,
  // The runner's global default privileges (no schema): a schema-level revoke cannot remove them.
  `alter default privileges for role ${RUNNER} grant select on tables to anon, authenticated`,
  `alter default privileges for role ${RUNNER} grant usage on sequences to anon, authenticated`,
];
/** Case 8: the API-role privileges left on app relations after M1 (the pre-existing ones), and after M1c (its identity sequence). */
const INHERITED_LEFT_M1 = ['internal.hunt_effective:anon', 'internal.hunt_leftover:anon', 'internal.hunt_leftover:authenticated'];
const INHERITED_LEFT_M1C = ['internal.batch_delete_audit_id_seq:anon', 'internal.batch_delete_audit_id_seq:authenticated'];

/** The relations in schema internal before M1 (non-extension tables, views, sequences): the ones M1/M1b/M1c must not touch. */
const PREEXISTING_INTERNAL_SQL = `select coalesce(array_agg(c.oid::text order by c.oid), '{}') as oids from pg_class c
  where c.relnamespace = 'internal'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
    and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.refclassid = 'pg_extension'::regclass and d.deptype = 'e')`;
/** The protected roles: service_role, every recruiter_* role, the runner and every owner of those relations (never anon or
 *  authenticated, whose access is what M1 removes from its own objects). */
const PROTECTED_ROLES_SQL = `select array_agg(distinct r order by r) as roles from (
  select rolname::text as r from pg_roles where rolname = 'service_role' or rolname like 'recruiter\\_%' or rolname = $2
  union all select pg_get_userbyid(c.relowner)::text from pg_class c where c.oid = any($1::oid[])
) s where r not in ('anon', 'authenticated')`;
/** For those relations and roles: every effective privilege (with and without grant option; table, column, sequence, and USAGE/
 *  CREATE on schema internal), plus each relation's owner and full table and column ACLs. $3: the table privileges to test. */
const PROTECTED_PRIVILEGES_SQL = `select coalesce(array_agg(x order by x), '{}') as p from (
  select 'eff:' || c.oid::regclass::text || ':' || r || ':' || p || '=' ||
         case when c.relkind = 'S' then has_sequence_privilege(r::name, c.oid, p)::text || '/' || has_sequence_privilege(r::name, c.oid, p || ' WITH GRANT OPTION')::text
              else has_table_privilege(r::name, c.oid, p)::text || '/' || has_table_privilege(r::name, c.oid, p || ' WITH GRANT OPTION')::text end as x
    from pg_class c, unnest($2::text[]) r, unnest(case when c.relkind = 'S' then array['USAGE', 'SELECT', 'UPDATE'] else $3::text[] end) p
   where c.oid = any($1::oid[])
  union all
  select 'col:' || c.oid::regclass::text || '.' || a.attname || ':' || r || ':' || p || '=' ||
         has_column_privilege(r::name, c.oid, a.attnum, p)::text || '/' || has_column_privilege(r::name, c.oid, a.attnum, p || ' WITH GRANT OPTION')::text
    from pg_class c join pg_attribute a on a.attrelid = c.oid, unnest($2::text[]) r, unnest(array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) p
   where c.oid = any($1::oid[]) and c.relkind <> 'S' and a.attnum > 0 and not a.attisdropped
  union all
  select 'nsp:internal:' || r || '=' || has_schema_privilege(r::name, 'internal', 'USAGE')::text || '/' || has_schema_privilege(r::name, 'internal', 'CREATE')::text
    from unnest($2::text[]) r
  union all
  select 'acl:' || c.oid::regclass::text || ':' || pg_get_userbyid(c.relowner) || ':' || coalesce(c.relacl::text, '') from pg_class c where c.oid = any($1::oid[])
  union all
  select 'attacl:' || c.oid::regclass::text || '.' || a.attname || ':' || a.attacl::text
    from pg_class c join pg_attribute a on a.attrelid = c.oid where c.oid = any($1::oid[]) and a.attacl is not null
) s`;

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
  // Case 5's database: a copy of the pristine public database (taken before case 2 touches it).
  const daclCopyUrl = (() => { const u = new URL(URLS.public as string); u.pathname = `${u.pathname}_dacl`; return u.toString(); })();
  // Case 6's database: a copy of the pristine public database (taken before case 2 touches it).
  const unownedCopyUrl = (() => { const u = new URL(URLS.public as string); u.pathname = `${u.pathname}_unowned`; return u.toString(); })();
  // Case 7's database: a copy of the pristine public database (taken before case 2 touches it).
  const depgrantCopyUrl = (() => { const u = new URL(URLS.public as string); u.pathname = `${u.pathname}_depgrant`; return u.toString(); })();
  // Case 8's database: a copy of the pristine public database (taken before case 2 touches it).
  const inheritedCopyUrl = (() => { const u = new URL(URLS.public as string); u.pathname = `${u.pathname}_inherit`; return u.toString(); })();
  /** Case 8 makes service_role a member of anon (cluster-wide); the final cleanup revokes it if the case did not get to. */
  let serviceAnonGranted = false;
  const existingM1Roles = () => onCluster(async (c) => (await c.query("select rolname from pg_roles where rolname = any($1) order by rolname", [CASE_ROLES])).rows.map((r) => r.rolname as string));

  /** Drops the case's database (only if it carries a task ownership comment) and every role the case made. */
  const dropCase = async (dbUrl: string) => {
    const db = new URL(dbUrl).pathname.slice(1);
    await onCluster(async (c) => {
      const comment = (await c.query("select shobj_description(oid, 'pg_database') as c from pg_database where datname = $1", [db])).rows[0]?.c as string | undefined;
      if (comment !== undefined) {
        assert.match(comment ?? '', /^a3-task-owned:/, `refusing: ${db} is not task-owned`);
        await c.query(`drop database ${db}`);
      }
      for (const r of CASE_ROLES) await c.query(`drop role if exists ${r}`);
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
    // Every query result the executor got back (read-only copy for the test; the executor itself prints only fixed counts).
    const results: unknown[] = [];
    const query = client.query.bind(client) as (...a: unknown[]) => Promise<unknown>;
    (client as unknown as { query: (...a: unknown[]) => Promise<unknown> }).query = async (...a: unknown[]) => { const r = await query(...a); results.push(r); return r; };
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
    return { error, events, plan, results };
  };
  /** The role matrix's own list of failed probes (its final role_matrix row), from the results runAsRunner kept. */
  const matrixFailures = (results: unknown[]) => {
    for (const r of [...results].reverse()) {
      for (const one of [...(Array.isArray(r) ? r : [r])].reverse()) {
        const m = (one as { rows?: Array<{ role_matrix?: { failed?: unknown } }> }).rows?.[0]?.role_matrix;
        if (m) return m.failed as Array<{ actor: string; test: string; expected: string; observed: string }>;
      }
    }
    return undefined;
  };
  const describe = (e: (Error & { code?: string; id?: string }) | undefined) => `error=${e?.id ?? ''} ${e?.code ?? ''} ${e?.message ?? ''}`;

  /** TRUCKRECRU-143: what anon and authenticated can still reach, read by the superuser admin (effective privileges). */
  const apiExposure = async (admin: pg.Client) => {
    const pg17 = (await admin.query(`select current_setting('server_version_num')::int >= 170000 as v`)).rows[0].v as boolean;
    const rels = (await admin.query(APP_RELATIONS_SQL)).rows as Array<{ name: string; kind: string }>;
    const exposed = (await admin.query(API_EXPOSURE_SQL, [TABLE_PRIVILEGES_16 + (pg17 ? ',MAINTAIN' : '')])).rows[0].exposed as string[];
    const maintain = pg17 ? (await admin.query(API_MAINTAIN_SQL)).rows[0].exposed as string[] : [];
    return { pg17, relations: rels.length, internal: rels.filter((r) => r.name.startsWith('internal.')).length, exposed, maintain };
  };
  /** TRUCKRECRU-143 round 4: the pre-existing internal relations and the protected roles, fixed before M1, and their privileges. */
  type Protected = { oids: string[]; roles: string[]; privs: string; snapshot: string[] };
  const protectedSnapshot = async (admin: pg.Client, p: Omit<Protected, 'snapshot'>) => (await admin.query(PROTECTED_PRIVILEGES_SQL, [p.oids, p.roles, p.privs.split(',')])).rows[0].p as string[];
  const protectedBefore = async (label: string, admin: pg.Client, minRelations: number): Promise<Protected> => {
    const pg17 = (await admin.query(`select current_setting('server_version_num')::int >= 170000 as v`)).rows[0].v as boolean;
    const oids = (await admin.query(PREEXISTING_INTERNAL_SQL)).rows[0].oids as string[];
    const roles = (await admin.query(PROTECTED_ROLES_SQL, [oids, RUNNER])).rows[0].roles as string[];
    const p = { oids, roles, privs: TABLE_PRIVILEGES_16 + (pg17 ? ',MAINTAIN' : '') };
    const snapshot = await protectedSnapshot(admin, p);
    check(`${label}: before M1 ${oids.length} relation(s) already exist in internal; protected roles ${roles.join(', ')}; ${snapshot.length} privilege/ACL facts recorded`,
      oids.length >= minRelations && roles.includes('service_role') && roles.includes(RUNNER) && snapshot.some((s) => s.endsWith('=true/false') || s.endsWith('=true/true')), `oids=${oids.length} roles=${roles.join(',')}`);
    return { ...p, snapshot };
  };
  const checkProtectedUnchanged = async (label: string, stage: string, admin: pg.Client, p: Protected) => {
    const now = await protectedSnapshot(admin, p);
    check(`${label}: after ${stage} no protected role's privilege on the pre-existing internal relations changed (${p.snapshot.length} facts: effective table/column/sequence/schema privileges incl. inherited and grant options, owners, full ACLs)`,
      JSON.stringify(now) === JSON.stringify(p.snapshot), `gone=${p.snapshot.filter((x) => !now.includes(x)).join(' | ')} new=${now.filter((x) => !p.snapshot.includes(x)).join(' | ')}`);
  };
  /** The API-role exposure on relations that did not exist before M1 (so M1, M1b or M1c created them). */
  const newRelationExposure = async (admin: pg.Client, p: Protected) => {
    const x = await apiExposure(admin);
    const old = new Set(((await admin.query(`select n.nspname || '.' || c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.oid = any($1::oid[])`, [p.oids])).rows as Array<{ name: string }>).map((r) => r.name));
    const isNew = (e: string) => !old.has(e.slice(0, e.lastIndexOf(':')));
    return { exposed: x.exposed.filter(isNew), maintain: x.maintain.filter(isNew) };
  };
  const checkNoApiExposure = async (label: string, stage: string, admin: pg.Client, minInternal: number) => {
    const x = await apiExposure(admin);
    check(`${label}: after ${stage} anon and authenticated hold no privilege on any of the ${x.relations} app tables/views/sequences in public and internal (${x.internal} in internal; MAINTAIN ${x.pg17 ? 'included, PostgreSQL 17+' : 'does not exist on PostgreSQL 16'})`,
      x.exposed.length === 0 && x.maintain.length === 0 && x.internal >= minInternal, `internal=${x.internal} exposed=${x.exposed.join(',')} maintain=${x.maintain.join(',')}`);
  };
  /** The app tables (public, internal) an unqualified VACUUM processed, from its INFO "vacuuming "db.schema.table"" notices. */
  const vacuumedAppTables = async (admin: pg.Client, run: () => Promise<unknown>) => {
    const notices: string[] = [];
    const onNotice = (m: { message?: string }) => { notices.push(String(m.message ?? '')); };
    admin.on('notice', onNotice);
    try { await run(); } finally { admin.removeListener('notice', onNotice); }
    const db = (await admin.query('select current_database() as d')).rows[0].d as string;
    const tables = new Set(((await admin.query(APP_RELATIONS_SQL)).rows as Array<{ name: string; kind: string }>).filter((r) => r.kind !== 'S' && r.kind !== 'v').map((r) => `${db}.${r.name}`));
    const vacuumed = notices.map((m) => /^vacuuming "(.+)"$/.exec(m)?.[1]).filter((t): t is string => t !== undefined);
    return { all: vacuumed.length, app: vacuumed.filter((t) => tables.has(t)).map((t) => t.slice(db.length + 1)) };
  };
  const checkVacuumAsApiRoles = async (label: string, admin: pg.Client) => {
    const control = await vacuumedAppTables(admin, () => admin.query('vacuum (verbose) internal.app_sessions'));
    check(`${label}: control: the superuser's VACUUM (VERBOSE) internal.app_sessions is seen in its notices`, JSON.stringify(control.app) === '["internal.app_sessions"]', JSON.stringify(control));
    for (const role of ['anon', 'authenticated']) {
      let actor = '';
      const seen = await vacuumedAppTables(admin, async () => {
        await admin.query(`set role ${role}`);
        try {
          actor = (await admin.query('select current_user as u')).rows[0].u as string;
          await admin.query('vacuum (verbose)');
        } finally {
          await admin.query('reset role');
        }
      });
      check(`${label}: an unqualified VACUUM (VERBOSE) as ${role}, outside any transaction, processes no app table (${seen.all} relation(s) processed in all)`,
        actor === role && seen.app.length === 0, `actor=${actor} app tables vacuumed=${seen.app.join(',')}`);
    }
  };

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
      await checkNoApiExposure(label, 'M1', o.admin, 12);
      {
        const left = (await o.admin.query(`select count(*)::int as n from pg_default_acl d, aclexplode(d.defaclacl) x
            where d.defaclrole = $1::regrole and d.defaclnamespace = 'internal'::regnamespace and d.defaclobjtype in ('r', 'S')
              and x.grantee in (0, 'anon'::regrole, 'authenticated'::regrole)`, [RUNNER])).rows[0].n as number;
        check(`${label}: after M1 the runner's default privileges in schema internal give tables and sequences to none of anon, authenticated, PUBLIC`, left === 0, String(left));
      }
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
      await checkNoApiExposure(label, 'M1b and M1c', o.admin, 14);
      await checkVacuumAsApiRoles(label, o.admin);
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
        check(`${label}: role-matrix-m1 as the runner passes 68/68`, s.error === undefined && JSON.stringify(ev) === '{"msg":"staging-sql.role_matrix","ok":true,"total":68,"passed":68,"failed":0}'
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
    for (const [srcUrl, copyUrl] of [[URLS.neg, negCopyUrl], [URLS.public, daclCopyUrl], [URLS.public, unownedCopyUrl], [URLS.public, depgrantCopyUrl], [URLS.public, inheritedCopyUrl]] as const) {
      const src = new URL(srcUrl as string).pathname.slice(1);
      const copy = new URL(copyUrl).pathname.slice(1);
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
    // 5. PostGIS in public, with the runner's dangerous default privileges and grants (Codex review thr_fhw66f89ay B1, TRUCKRECRU-143).
    await assertApplied('internal default ACL', daclCopyUrl, 'public', async (a) => {
      await a.query(PUBLIC_EXECUTE_SQL);
      for (const sql of DANGEROUS_DEFAULT_ACL_SQL) await a.query(sql);
      const defaults = (await a.query(`select count(*)::int as n from pg_default_acl d, aclexplode(d.defaclacl) x
          where d.defaclrole = $1::regrole and d.defaclnamespace = 'internal'::regnamespace and d.defaclobjtype in ('r', 'S')
            and x.grantee in (0, 'anon'::regrole, 'authenticated'::regrole)`, [RUNNER])).rows[0].n as number;
      check('internal default ACL: before M1 the runner\'s default privileges in schema internal hand new tables and sequences to anon, authenticated and PUBLIC', defaults > 0, String(defaults));
    });
    // 6. PostGIS in public, plus a table in internal owned by another role with only a table-level right for anon (Codex review
    //    thr_phw7jjfvc9 B1, TRUCKRECRU-143 round 2). M1 applies and leaves it; the role matrix refuses it.
    {
      const label = 'unowned internal table';
      let right = '';
      let prot = undefined as unknown as Protected;
      const o = await applyAsRunner(unownedCopyUrl, async (a) => {
        await a.query(PUBLIC_EXECUTE_SQL);
        right = (await a.query(`select current_setting('server_version_num')::int >= 170000 as v`)).rows[0].v ? 'MAINTAIN' : 'TRUNCATE';
        await a.query(`create role ${OTHER_OWNER}`);
        await a.query(`create table internal.review_unowned (id int)`);
        await a.query(`alter table internal.review_unowned owner to ${OTHER_OWNER}`);
        await a.query(`grant ${right} on internal.review_unowned to anon`);
        const f = (await a.query(`select pg_has_role($1, $2, 'MEMBER') as member, has_table_privilege('anon', 'internal.review_unowned', $3) as granted,
            (select relacl::text from pg_class where oid = 'internal.review_unowned'::regclass) as acl`, [RUNNER, OTHER_OWNER, right])).rows[0];
        check(`${label}: before M1 internal.review_unowned is owned by ${OTHER_OWNER} (the runner is not a member) and anon holds only ${right} on it`,
          f.member === false && f.granted === true && f.acl === `{${OTHER_OWNER}=arwdDxt${right === 'MAINTAIN' ? 'm' : ''}/${OTHER_OWNER},anon=${right === 'MAINTAIN' ? 'm' : 'D'}/${OTHER_OWNER}}`, JSON.stringify(f));
        prot = await protectedBefore(label, a, 1);
      });
      try {
        const acl = async () => (await o.admin.query(`select relacl::text as a from pg_class where oid = 'internal.review_unowned'::regclass`)).rows[0].a as string;
        const aclBefore = await acl();
        check(`${label}: M1 applies as the Supabase-like runner (it touches no relation it did not create)`,
          o.error === undefined && o.events.some((e) => e.msg === 'staging-sql.step_done'), describe(o.error));
        await checkProtectedUnchanged(label, 'M1', o.admin, prot);
        const exposedAfter = async (stage: string) => {
          const x = await apiExposure(o.admin);
          const want = ['internal.review_unowned:anon'];
          check(`${label}: after ${stage} the only API-role privilege left on the ${x.relations} app relations is anon's ${right} on internal.review_unowned (ACL unchanged)`,
            JSON.stringify(x.exposed) === JSON.stringify(want) && JSON.stringify(x.maintain) === JSON.stringify(x.pg17 ? want : []) && (await acl()) === aclBefore,
            `exposed=${x.exposed.join(',')} maintain=${x.maintain.join(',')} acl=${await acl()}`);
        };
        await exposedAfter('M1');
        for (const action of ['apply-m1b', 'apply-m1c']) {
          const s = await runAsRunner(unownedCopyUrl, action);
          check(`${label}: ${action} applies as the Supabase-like runner`, s.error === undefined && s.events.some((e) => e.msg === 'staging-sql.step_done'), describe(s.error));
        }
        await exposedAfter('M1b and M1c');
        await checkProtectedUnchanged(label, 'M1b and M1c', o.admin, prot);
        const before = await stateOf(o.admin);
        const s = await runAsRunner(unownedCopyUrl, 'role-matrix-m1');
        const ev = s.events.find((e) => e.msg === 'staging-sql.role_matrix');
        const failed = matrixFailures(s.results);
        check(`${label}: role-matrix-m1 refuses (role_matrix_failed, 1 of 68 failed, step_failed not step_done)`,
          s.error?.id === 'role_matrix_failed' && JSON.stringify(ev) === '{"msg":"staging-sql.role_matrix","ok":false,"total":68,"passed":67,"failed":1}'
          && !s.events.some((e) => e.msg === 'staging-sql.step_done'), `${describe(s.error)} ${JSON.stringify(ev)}`);
        check(`${label}: the failing probe is anon's no-privilege probe for schema internal, held on review_unowned only`,
          failed?.length === 1 && failed[0]!.actor === 'anon' && failed[0]!.test === 'no privilege on any app table/sequence in internal (incl. MAINTAIN on 17+)'
          && / relations, held on: review_unowned$/.test(failed[0]!.observed), JSON.stringify(failed));
        const cmp = compareStates(before, await stateOf(o.admin), MATRIX_FULL_RUN_SEQUENCES);
        check(`${label}: the refused role matrix left nothing behind (catalogue, table rows, sequences only ${MATRIX_FULL_RUN_SEQUENCES.join(', ')} moved forward; review_unowned's ACL unchanged)`,
          cmp.problems.length === 0 && JSON.stringify(cmp.advanced) === JSON.stringify(MATRIX_FULL_RUN_SEQUENCES) && (await acl()) === aclBefore, `${cmp.problems.join('; ')} advanced=${cmp.advanced.join(',')}`);
        await checkProtectedUnchanged(label, 'the role matrix', o.admin, prot);
      } finally {
        await o.admin.end();
      }
      await dropCase(unownedCopyUrl);
      check(`${label}: case cleaned up (its database and roles dropped)`, (await existingM1Roles()).length === 0);
    }
    // 7. PostGIS in public, plus runner-owned internal relations on which anon or authenticated passed on a right they hold WITH
    //    GRANT OPTION (Codex review thr_pp3mvh6wjz B1, TRUCKRECRU-143 round 3). M1 applies and leaves them; the role matrix refuses them.
    {
      const label = 'dependent grants in internal';
      const aclOf = async (admin: pg.Client) => (await admin.query(DEPENDENT_GRANT_ACL_SQL)).rows[0].acl as string[];
      let aclBefore: string[] = [];
      let prot = undefined as unknown as Protected;
      const ownerGrant = `review_other_grantor:anon=INSERT:false/${RUNNER}`;
      const o = await applyAsRunner(depgrantCopyUrl, async (a) => {
        await a.query(PUBLIC_EXECUTE_SQL);
        for (const sql of DEPENDENT_GRANT_SQL) await a.query(sql);
        aclBefore = await aclOf(a);
        const want = [
          'review_dependent:service_role=SELECT:false/anon', 'review_dep_column.id:service_role=SELECT:false/anon', 'review_dep_column_only.id:service_role=SELECT:false/anon',
          'review_dep_chain:authenticated=SELECT:false/anon', 'review_dep_seq:service_role=USAGE:false/anon', 'review_dep_view:service_role=SELECT:false/anon',
          'review_dep_matview:service_role=SELECT:false/anon', 'review_dep_parted:service_role=SELECT:false/anon', 'review_dep_foreign:service_role=SELECT:false/anon',
          'review_anon_owned:service_role=SELECT:false/anon', 'review_other_grantor:anon=SELECT:false/service_role', 'review_other_grantor:service_role=SELECT:true/' + RUNNER, ownerGrant,
          'review_dependent:anon=SELECT:true/' + RUNNER, 'review_dep_seq:anon=USAGE:true/' + RUNNER, 'review_dep_column.id:anon=SELECT:true/' + RUNNER];
        const owners = (await a.query(`select string_agg(c.relname || '=' || pg_get_userbyid(c.relowner), ',' order by c.relname) as o from pg_class c
            where c.relnamespace = 'internal'::regnamespace and c.relname like 'review\\_%'`)).rows[0].o as string;
        check(`${label}: before M1 anon (and once authenticated) passed on rights held WITH GRANT OPTION from the runner, on runner-owned relations of every kind`,
          want.every((w) => aclBefore.includes(w)) && owners === Object.keys({ ...DEPENDENT_GRANT_LEFT, review_dep_parted_1: [] }).sort()
            .map((r) => `${r}=${r === 'review_anon_owned' ? 'anon' : RUNNER}`).join(','), `missing=${want.filter((w) => !aclBefore.includes(w)).join(',')} owners=${owners}`);
        prot = await protectedBefore(label, a, Object.keys(DEPENDENT_GRANT_LEFT).length + 1);
      });
      try {
        // M1 touches none of them: every ACL entry stays, the owner's own INSERT grant to anon on review_other_grantor included.
        const aclSame = async (stage: string) => {
          const now = await aclOf(o.admin);
          check(`${label}: after ${stage} every ACL entry on those relations and their columns is unchanged (service_role's and the owner's grant to anon included)`,
            JSON.stringify(now) === JSON.stringify(aclBefore) && aclBefore.includes(ownerGrant),
            `gone=${aclBefore.filter((x) => !now.includes(x)).join(',')} new=${now.filter((x) => !aclBefore.includes(x)).join(',')}`);
        };
        check(`${label}: M1 applies as the Supabase-like runner (it touches no relation it did not create, so no 2BP01)`,
          o.error === undefined && o.events.some((e) => e.msg === 'staging-sql.step_done'), describe(o.error));
        await aclSame('M1');
        await checkProtectedUnchanged(label, 'M1', o.admin, prot);
        const wantExposed = Object.entries(DEPENDENT_GRANT_LEFT).flatMap(([r, roles]) => roles.map((role) => `internal.${r}:${role}`)).sort();
        const exposedAfter = async (stage: string) => {
          const x = await apiExposure(o.admin);
          const wantMaintain = x.pg17 ? ['internal.review_anon_owned:anon'] : [];
          check(`${label}: after ${stage} the only API-role privileges left on the ${x.relations} app relations are on those relations (${wantExposed.length} relation/role pairs)`,
            JSON.stringify([...x.exposed].sort()) === JSON.stringify(wantExposed) && JSON.stringify([...x.maintain].sort()) === JSON.stringify(wantMaintain),
            `exposed=${x.exposed.join(',')} maintain=${x.maintain.join(',')}`);
        };
        await exposedAfter('M1');
        for (const action of ['apply-m1b', 'apply-m1c']) {
          const s = await runAsRunner(depgrantCopyUrl, action);
          check(`${label}: ${action} applies as the Supabase-like runner`, s.error === undefined && s.events.some((e) => e.msg === 'staging-sql.step_done'), describe(s.error));
        }
        await exposedAfter('M1b and M1c');
        await aclSame('M1b and M1c');
        await checkProtectedUnchanged(label, 'M1b and M1c', o.admin, prot);
        const before = await stateOf(o.admin);
        const s = await runAsRunner(depgrantCopyUrl, 'role-matrix-m1');
        const ev = s.events.find((e) => e.msg === 'staging-sql.role_matrix');
        const failed = matrixFailures(s.results);
        check(`${label}: role-matrix-m1 refuses (role_matrix_failed, 2 of 68 failed, step_failed not step_done)`,
          s.error?.id === 'role_matrix_failed' && JSON.stringify(ev) === '{"msg":"staging-sql.role_matrix","ok":false,"total":68,"passed":66,"failed":2}'
          && !s.events.some((e) => e.msg === 'staging-sql.step_done'), `${describe(s.error)} ${JSON.stringify(ev)}`);
        const heldBy = (role: string) => Object.keys(DEPENDENT_GRANT_LEFT).filter((r) => DEPENDENT_GRANT_LEFT[r]!.includes(role)).sort().join(',');
        const probe = (role: string) => failed?.find((f) => f.actor === role && f.test === 'no privilege on any app table/sequence in internal (incl. MAINTAIN on 17+)');
        check(`${label}: the failing probes are anon's and authenticated's no-privilege probes for schema internal, naming exactly the relations left`,
          failed?.length === 2 && probe('anon')?.observed.endsWith(` relations, held on: ${heldBy('anon')}`) === true
          && probe('authenticated')?.observed.endsWith(` relations, held on: ${heldBy('authenticated')}`) === true, JSON.stringify(failed));
        const cmp = compareStates(before, await stateOf(o.admin), MATRIX_FULL_RUN_SEQUENCES);
        check(`${label}: the refused role matrix left nothing behind (catalogue, table rows, sequences only ${MATRIX_FULL_RUN_SEQUENCES.join(', ')} moved forward)`,
          cmp.problems.length === 0 && JSON.stringify(cmp.advanced) === JSON.stringify(MATRIX_FULL_RUN_SEQUENCES), `${cmp.problems.join('; ')} advanced=${cmp.advanced.join(',')}`);
        await aclSame('the role matrix');
        await checkProtectedUnchanged(label, 'the role matrix', o.admin, prot);
      } finally {
        await o.admin.end();
      }
      await dropCase(depgrantCopyUrl);
      check(`${label}: case cleaned up (its database and roles dropped)`, (await existingM1Roles()).length === 0);
    }
    // 8. PostGIS in public, plus protected roles whose right on an internal table comes only through anon, a runner-owned table
    //    granted to anon/authenticated/PUBLIC, and the runner's global default privileges (Codex review thr_v6e6ax8gt9 B1,
    //    TRUCKRECRU-143 round 4). M1 applies, changes no protected privilege; the role matrix refuses the leftovers.
    {
      const label = 'inherited rights in internal';
      let prot = undefined as unknown as Protected;
      const serviceInAnon = () => onCluster(async (c) => (await c.query(`select exists (select 1 from pg_auth_members where roleid = 'anon'::regrole and member = 'service_role'::regrole) as m`)).rows[0].m as boolean);
      assert.equal(await serviceInAnon(), false, 'service_role must not be a member of anon before case 8 (the case grants and revokes that membership)');
      serviceAnonGranted = true;
      const o = await applyAsRunner(inheritedCopyUrl, async (a) => {
        await a.query(PUBLIC_EXECUTE_SQL);
        for (const sql of INHERITED_RIGHTS_SQL) await a.query(sql);
        const f = (await a.query(`select
            (select relacl::text from pg_class where oid = 'internal.hunt_effective'::regclass) as acl,
            array(select r || '=' || has_table_privilege(r, 'internal.hunt_effective', 'SELECT')::text || '/' || pg_has_role(r, 'anon', 'USAGE')::text
                    from unnest(array['service_role', $2, $3]) r order by r) as eff,
            pg_has_role($1, $3, 'USAGE') as runner_inherits_owner`, [RUNNER, REVIEW_RECRUITER, REVIEW_OWNER])).rows[0];
        check(`${label}: before M1 service_role, ${REVIEW_RECRUITER} and the owner ${REVIEW_OWNER} hold SELECT on internal.hunt_effective only through anon (the runner inherits the owner)`,
          new RegExp(`^\\{${REVIEW_OWNER}=awdDxtm?/${REVIEW_OWNER},anon=r/${REVIEW_OWNER}\\}$`).test(String(f.acl)) && JSON.stringify(f.eff) === JSON.stringify([`${REVIEW_RECRUITER}=true/true`, 'service_role=true/true', `${REVIEW_OWNER}=true/true`].sort())
            && f.runner_inherits_owner === true, JSON.stringify(f));
        prot = await protectedBefore(label, a, 2);
        check(`${label}: the protected roles include service_role, ${REVIEW_RECRUITER}, ${REVIEW_OWNER} and the runner`,
          [REVIEW_RECRUITER, REVIEW_OWNER, RUNNER, 'service_role'].every((r) => prot.roles.includes(r)), prot.roles.join(','));
        const globals = (await a.query(`select string_agg(d.defaclobjtype::text, ',' order by d.defaclobjtype) as t from pg_default_acl d
            where d.defaclrole = $1::regrole and d.defaclnamespace = 0`, [RUNNER])).rows[0].t as string;
        check(`${label}: before M1 the runner has global default privileges for tables and sequences`, globals === 'S,r', globals);
      });
      try {
        check(`${label}: M1 applies as the Supabase-like runner (it touches no relation it did not create)`,
          o.error === undefined && o.events.some((e) => e.msg === 'staging-sql.step_done'), describe(o.error));
        await checkProtectedUnchanged(label, 'M1', o.admin, prot);
        const exposedAfter = async (stage: string, want: string[]) => {
          const x = await apiExposure(o.admin);
          const fresh = await newRelationExposure(o.admin, prot);
          check(`${label}: after ${stage} the API-role privileges left on the ${x.relations} app relations are exactly ${want.join(', ')} (no MAINTAIN)`,
            JSON.stringify([...x.exposed].sort()) === JSON.stringify([...want].sort()) && x.maintain.length === 0, `exposed=${x.exposed.join(',')} maintain=${x.maintain.join(',')}`);
          return fresh;
        };
        {
          const fresh = await exposedAfter('M1', INHERITED_LEFT_M1);
          check(`${label}: after M1 nothing M1 created (despite the runner's global default privileges) is reachable by anon or authenticated`, fresh.exposed.length === 0 && fresh.maintain.length === 0, fresh.exposed.join(','));
          const publicHeld = (await o.admin.query(`select coalesce(string_agg(c.relname, ',' order by c.relname), '') as r from pg_class c, aclexplode(c.relacl) a
              where c.relnamespace = 'internal'::regnamespace and not (c.oid = any($1::oid[])) and a.grantee in (0, 'anon'::regrole, 'authenticated'::regrole)`, [prot.oids])).rows[0].r as string;
          check(`${label}: after M1 no ACL of a relation M1 created names anon, authenticated or PUBLIC`, publicHeld === '', publicHeld);
        }
        for (const action of ['apply-m1b', 'apply-m1c']) {
          const s = await runAsRunner(inheritedCopyUrl, action);
          check(`${label}: ${action} applies as the Supabase-like runner`, s.error === undefined && s.events.some((e) => e.msg === 'staging-sql.step_done'), describe(s.error));
        }
        {
          const fresh = await exposedAfter('M1b and M1c', [...INHERITED_LEFT_M1, ...INHERITED_LEFT_M1C]);
          check(`${label}: after M1b and M1c the only new relation anon/authenticated reach is M1c's identity sequence (the runner's global sequence default; M1c revokes only its table)`,
            JSON.stringify([...fresh.exposed].sort()) === JSON.stringify(INHERITED_LEFT_M1C), fresh.exposed.join(','));
          const m1b = (await o.admin.query(`select coalesce(relacl::text, '') as a from pg_class where oid = 'internal.staff_mobile_unverified'::regclass`)).rows[0].a as string;
          check(`${label}: M1b's table names none of anon, authenticated, PUBLIC in its ACL`, !/(^|[{,])(anon|authenticated|)=/.test(m1b), m1b);
        }
        await checkProtectedUnchanged(label, 'M1b and M1c', o.admin, prot);
        const before = await stateOf(o.admin);
        const s = await runAsRunner(inheritedCopyUrl, 'role-matrix-m1');
        const ev = s.events.find((e) => e.msg === 'staging-sql.role_matrix');
        const failed = matrixFailures(s.results);
        check(`${label}: role-matrix-m1 refuses (role_matrix_failed, 4 of 68 failed, step_failed not step_done)`,
          s.error?.id === 'role_matrix_failed' && JSON.stringify(ev) === '{"msg":"staging-sql.role_matrix","ok":false,"total":68,"passed":64,"failed":4}'
          && !s.events.some((e) => e.msg === 'staging-sql.step_done'), `${describe(s.error)} ${JSON.stringify(ev)}`);
        const probe = (role: string, test: string) => failed?.find((f) => f.actor === role && f.test === test);
        const internalProbe = 'no privilege on any app table/sequence in internal (incl. MAINTAIN on 17+)';
        const newTableProbe = 'a new internal table gets no privilege (default privileges)';
        check(`${label}: the failing probes are anon's and authenticated's internal probes (naming exactly the relations left) and both new-table default-privilege probes`,
          failed?.length === 4 && probe('anon', internalProbe)?.observed.endsWith(' relations, held on: batch_delete_audit_id_seq,hunt_effective,hunt_leftover') === true
          && probe('authenticated', internalProbe)?.observed.endsWith(' relations, held on: batch_delete_audit_id_seq,hunt_leftover') === true
          && probe('anon', newTableProbe) !== undefined && probe('authenticated', newTableProbe) !== undefined, JSON.stringify(failed));
        const cmp = compareStates(before, await stateOf(o.admin), MATRIX_FULL_RUN_SEQUENCES);
        check(`${label}: the refused role matrix left nothing behind (catalogue, table rows, sequences only ${MATRIX_FULL_RUN_SEQUENCES.join(', ')} moved forward)`,
          cmp.problems.length === 0 && JSON.stringify(cmp.advanced) === JSON.stringify(MATRIX_FULL_RUN_SEQUENCES), `${cmp.problems.join('; ')} advanced=${cmp.advanced.join(',')}`);
        await checkProtectedUnchanged(label, 'the role matrix', o.admin, prot);
        // Actual reads, not only catalogue answers: each protected role still selects from hunt_effective.
        for (const r of ['service_role', REVIEW_RECRUITER, REVIEW_OWNER]) {
          await o.admin.query('begin');
          try {
            await o.admin.query(`set local role ${r}`);
            const n = (await o.admin.query('select count(*)::int as n from internal.hunt_effective')).rows[0].n as number;
            check(`${label}: ${r} can still SELECT from internal.hunt_effective after M1, M1b, M1c and the matrix`, n === 0);
          } finally {
            await o.admin.query('rollback');
          }
        }
      } finally {
        await o.admin.end();
      }
      await dropCase(inheritedCopyUrl);
      await onCluster(async (c) => { await c.query('revoke anon from service_role'); });
      serviceAnonGranted = false;
      check(`${label}: case cleaned up (its database and roles dropped, service_role no longer a member of anon)`, (await existingM1Roles()).length === 0 && !(await serviceInAnon()));
    }
  } finally {
    // Leaves the cluster without the case roles even after a failed check (later cases and reruns need them absent).
    for (const v of [...Object.values(URLS), negCopyUrl, daclCopyUrl, unownedCopyUrl, depgrantCopyUrl, inheritedCopyUrl]) await dropCase(v as string).catch(() => undefined);
    if (serviceAnonGranted) await onCluster(async (c) => { await c.query('revoke anon from service_role'); }).catch(() => undefined);
  }
  console.log(`PASS m1-supabase-runner: ${n} checks passed`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
