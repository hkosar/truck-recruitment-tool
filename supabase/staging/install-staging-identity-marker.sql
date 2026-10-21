-- ============================================================================
-- install-staging-identity-marker.sql -- ONE-TIME, STAGING-ONLY operator step.
--
-- Run ONLY through the staging SQL runner (pipeline/src/staging-sql-runner.ts):
--   npm --prefix pipeline run staging:sql -- --action=install-marker --confirm="INSTALL TNBS STAGING IDENTITY MARKER" --execute
-- The runner parses STAGING_DB_URL with the same guard as the pipeline, refuses the
-- production project and any connection-target override, requires the exact staging
-- project, and only then opens a connection. It sets app.staging_runner_verified_ref
-- to the project it verified; this file refuses to run without it. Do not paste this
-- file into a SQL editor.
--
-- Creates, in its own schema (never in supabase/migrations, so absent from production):
--   staging_identity.marker      -- one row naming the verified staging project
--   staging_identity.fixture_rows -- explicit registry of fixture-owned business rows
-- The reset and fixture cleanup require the marker and delete only registered rows.
--
-- Adoption: on install, every carrier, batch, and cargo_other_values row currently in
-- this database is registered as fixture-owned. That is valid only because the runner
-- has verified this connection is the staging project, whose contents are fictional by
-- policy. From then on, only reset-fictional-data.sql adds registry rows.
-- ============================================================================

begin;

do $$
declare
  v_other_profiles bigint;
begin
  if current_setting('app.staging_runner_verified_ref', true) is distinct from 'yhyoxhtguyturgdhwywc' then
    raise exception 'staging marker install refused: run through the staging SQL runner, which verifies the staging project first';
  end if;
  if current_setting('app.staging_marker_install_confirmation', true)
       is distinct from 'INSTALL TNBS STAGING IDENTITY MARKER' then
    raise exception 'staging marker install refused: confirmation phrase is missing';
  end if;
  if to_regnamespace('staging_identity') is not null then
    raise exception 'staging marker install refused: schema staging_identity already exists';
  end if;

  -- Defence in depth: refuse a database with real users. Fixture identities are recognised
  -- by their explicit auth metadata; the only other allowed profile is the staging owner login.
  select count(*) into v_other_profiles
  from public.profiles p
  where not exists (
      select 1 from auth.users u
      where u.id = p.id
        and u.raw_user_meta_data->>'test_only' = 'true'
        and u.raw_user_meta_data->>'test_run_id' = 'stg-db-20260723-0042'
        and u.encrypted_password is null
    )
    and p.email is distinct from 'hunter@twistednail.com';
  if v_other_profiles <> 0 then
    raise exception 'staging marker install refused: % profile(s) are neither fixture identities nor the staging owner', v_other_profiles;
  end if;
end
$$;

create schema staging_identity;
revoke all on schema staging_identity from public;

create table staging_identity.marker (
  singleton    boolean primary key default true check (singleton),
  environment  text not null check (environment = 'staging'),
  marker_id    uuid not null,
  project_ref  text not null check (project_ref = 'yhyoxhtguyturgdhwywc'),
  project_name text not null,
  installed_at timestamptz not null default now(),
  installed_by text not null default current_user
);

create table staging_identity.fixture_rows (
  table_name    text not null check (table_name in ('carriers', 'batches', 'cargo_other_values')),
  row_key       text not null,
  registered_at timestamptz not null default now(),
  registered_by text not null,
  primary key (table_name, row_key)
);
revoke all on all tables in schema staging_identity from public;

do $$
declare
  v_role text;
begin
  -- Supabase API roles must never read or change the marker or the registry.
  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = v_role) then
      execute format('revoke all on schema staging_identity from %I', v_role);
      execute format('revoke all on all tables in schema staging_identity from %I', v_role);
    end if;
  end loop;
end
$$;

insert into staging_identity.marker (environment, marker_id, project_ref, project_name)
values ('staging', 'a8512f81-fe47-485d-95cd-092c46e4920b', current_setting('app.staging_runner_verified_ref'), 'truck-recruitment-tool-staging');

-- One-time adoption of the existing (fictional) staging contents; see header.
insert into staging_identity.fixture_rows (table_name, row_key, registered_by)
select 'carriers', dot_number::text, 'install-adoption' from public.carriers;
insert into staging_identity.fixture_rows (table_name, row_key, registered_by)
select 'batches', id::text, 'install-adoption' from public.batches;
insert into staging_identity.fixture_rows (table_name, row_key, registered_by)
select 'cargo_other_values', value, 'install-adoption' from public.cargo_other_values;

commit;
