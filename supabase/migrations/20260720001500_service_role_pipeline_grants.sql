-- ============================================================================
-- 20260720001500_service_role_pipeline_grants.sql
-- Fix-forward: explicit PostgREST grants for the ingestion service role.
--
-- Supabase RLS bypass does not replace PostgreSQL relation privileges. The
-- original migrations enabled RLS and described service_role as the sole
-- pipeline writer, but never granted service_role DML on application tables or
-- USAGE on the pipeline_runs identity sequence. The first production run
-- therefore failed before sync-census with "permission denied for table
-- pipeline_runs".
--
-- Keep this deliberately broad across the public application schema: the
-- service_role is already the trusted backend role and the pipeline uses direct
-- Postgres for bulk merges plus PostgREST for operational run/DQ rows. Future
-- public tables should inherit the same access via altered default privileges.
-- ============================================================================

grant usage on schema public to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;

alter default privileges in schema public
  grant select, insert, update, delete on tables to service_role;
alter default privileges in schema public
  grant usage, select on sequences to service_role;
alter default privileges in schema public
  grant execute on functions to service_role;
