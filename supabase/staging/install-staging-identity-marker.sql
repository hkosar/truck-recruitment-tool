-- ============================================================================
-- install-staging-identity-marker.sql -- ONE-TIME, STAGING-ONLY operator step.
--
-- Creates a database-resident identity marker that the destructive staging
-- scripts (reset-fictional-data.sql, cleanup-fixtures.sql) require before they
-- delete anything. The marker lives in its own schema, is defined only in
-- supabase/staging/ (never in supabase/migrations/), and is therefore absent
-- from production unless someone deliberately runs this file there. This file
-- refuses to run on a database that does not already look like the fictional
-- staging fixture set, so it cannot be installed on a database holding real
-- users or real carriers.
--
-- Run exactly once, as the database owner (postgres), in the Supabase SQL
-- editor of the project named truck-recruitment-tool-staging, after confirming
-- that project name in the dashboard. Set the confirmation in the same run:
--   select set_config('app.staging_marker_install_confirmation', 'INSTALL TNBS STAGING IDENTITY MARKER', true);
-- ============================================================================

begin;

do $$
declare
  v_fixture_profiles bigint;
  v_other_profiles bigint;
  v_real_range_carriers bigint;
begin
  if current_setting('app.staging_marker_install_confirmation', true)
       is distinct from 'INSTALL TNBS STAGING IDENTITY MARKER' then
    raise exception 'staging marker install refused: confirmation phrase is missing';
  end if;
  if to_regnamespace('staging_identity') is not null then
    raise exception 'staging marker install refused: schema staging_identity already exists';
  end if;

  -- The database must already be the fictional staging fixture set.
  select count(*) into v_fixture_profiles
  from public.profiles
  where id::text like '71000000-0000-4000-8000-00000000000%'
    and email like '%@tnbs-recruiter.example.invalid';
  select count(*) into v_other_profiles
  from public.profiles
  where not (id::text like '71000000-0000-4000-8000-00000000000%' and email like '%@tnbs-recruiter.example.invalid')
    and email is distinct from 'hunter@twistednail.com';
  select count(*) into v_real_range_carriers
  from public.carriers
  where not (dot_number between 1200000 and 1307999 or dot_number between 1400001 and 1400099);
  if v_fixture_profiles <> 7 or v_other_profiles <> 0 or v_real_range_carriers <> 0 then
    raise exception 'staging marker install refused: database does not match the fictional staging fixture set (fixture profiles %, other profiles %, carriers outside fictional DOT ranges %)',
      v_fixture_profiles, v_other_profiles, v_real_range_carriers;
  end if;
end
$$;

create schema staging_identity;
revoke all on schema staging_identity from public;

create table staging_identity.marker (
  singleton    boolean primary key default true check (singleton),
  environment  text not null check (environment = 'staging'),
  marker_id    uuid not null,
  project_name text not null,
  installed_at timestamptz not null default now(),
  installed_by text not null default current_user
);
revoke all on table staging_identity.marker from public;

do $$
declare
  v_role text;
begin
  -- Supabase API roles must never read or change the marker.
  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = v_role) then
      execute format('revoke all on schema staging_identity from %I', v_role);
      execute format('revoke all on table staging_identity.marker from %I', v_role);
    end if;
  end loop;
end
$$;

insert into staging_identity.marker (environment, marker_id, project_name)
values ('staging', 'a8512f81-fe47-485d-95cd-092c46e4920b', 'truck-recruitment-tool-staging');

commit;
