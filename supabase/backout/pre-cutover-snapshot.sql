-- ============================================================================
-- pre-cutover-snapshot.sql -- READ-ONLY. Run before M1 and again after a backout; the two
-- outputs must be identical (T-BACKOUT). Lists grants, policies and the definitions of every
-- function M1 touches. Contains no data rows and no credentials.
-- ============================================================================

-- Table/column/sequence grants for the roles M1 changes.
select table_schema, table_name, grantee, privilege_type
from information_schema.role_table_grants
where grantee in ('anon', 'authenticated', 'service_role', 'recruiter_api')
  and table_schema in ('public', 'internal')
order by 1, 2, 3, 4;

select table_schema, table_name, column_name, grantee, privilege_type
from information_schema.column_privileges
where grantee in ('anon', 'authenticated', 'recruiter_api')
  and table_schema = 'public'
order by 1, 2, 3, 4, 5;

select n.nspname, c.relname, c.relkind, c.relacl::text
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname in ('public', 'internal') and c.relkind = 'S'
order by 1, 2;

-- Function execute grants and definitions.
select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) as args, p.proacl::text,
       p.prosecdef, p.proconfig::text, md5(pg_get_functiondef(p.oid)) as definition_md5
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname in ('public', 'internal') and p.prokind = 'f'
order by 1, 2, 3;

-- Policies.
select schemaname, tablename, policyname, cmd, roles::text, qual, with_check
from pg_policies
where schemaname = 'public'
order by 1, 2, 3;

-- Triggers on the tables M1 touches.
select event_object_table, trigger_name, action_timing, event_manipulation, action_statement
from information_schema.triggers
where event_object_schema = 'public'
  and event_object_table in ('profiles', 'batches', 'batch_carriers', 'contact_logs')
order by 1, 2, 4;

-- Realtime publication members.
select schemaname, tablename from pg_publication_tables
where pubname = 'supabase_realtime'
order by 1, 2;

-- Default privileges.
select pg_get_userbyid(defaclrole) as owner, defaclnamespace::regnamespace::text as schema, defaclobjtype, defaclacl::text
from pg_default_acl
order by 1, 2, 3;
