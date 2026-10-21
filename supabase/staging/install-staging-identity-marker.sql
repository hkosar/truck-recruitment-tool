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
-- Provenance: the installer registers existing rows ONLY if every carrier, batch, cargo
-- value, contact log, suppression, batch member, and batch activity row is provably part
-- of the deterministic fictional baseline that reset-fictional-data.sql generates (exact
-- fixture fingerprint: derived DOT numbers and row hashes, reserved 555-01xx phones,
-- example.invalid emails, the two baseline batch names and their fixture creators, the
-- reset's fixed contact notes). Otherwise it refuses and reports how many rows of each
-- kind were not recognised. Nothing is adopted on trust.
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

-- ----------------------------------------------------------------------------
-- Provenance: every existing business row must be provably part of the deterministic
-- fictional baseline that reset-fictional-data.sql generates. Nothing is adopted on trust.
-- ----------------------------------------------------------------------------
create temporary table tmp_fixture_users on commit drop as
select id, email from auth.users
where raw_user_meta_data->>'test_only' = 'true'
  and raw_user_meta_data->>'test_run_id' = 'stg-db-20260723-0042'
  and encrypted_password is null
  and email like '%@tnbs-recruiter.example.invalid';

-- Carriers. Bulk rows (i = 1..785): dot = 1200000 + 137*i + jitter(0..129); phone, cell, and
-- fax are derived from i in the reserved (202) 555-01xx block; email is absent or
-- @carrier.example.invalid; row_hash = md5(dot || geo word || zip suffix) where the legal
-- name starts with one of the 25 fixture geo words. Hand-authored rows: dot 1400001-1400015,
-- row_hash = md5(dot), reserved 555-01xx phones, example.invalid email.
create temporary table tmp_baseline_carriers on commit drop as
select c.dot_number
from public.carriers c
where c.phy_state = 'TX'
  and (c.email_address is null or c.email_address like '%@carrier.example.invalid')
  and (
    (
      c.dot_number between 1200137 and 1307674
      and (c.dot_number - 1200000) % 137 < 130
      and c.phone = '(202) 555-' || lpad((100 + (((c.dot_number - 1200000) / 137) % 100))::text, 4, '0')
      and (c.cell_phone is null
           or c.cell_phone = '(202) 555-' || lpad((100 + ((((c.dot_number - 1200000) / 137) + 37) % 100))::text, 4, '0'))
      and (c.fax is null
           or c.fax = '(202) 555-' || lpad((100 + ((((c.dot_number - 1200000) / 137) + 73) % 100))::text, 4, '0'))
      and exists (
        select 1
        from unnest(array[
          'Lone Star','Brazos','Permian','Hill Country','Trinity','Bluebonnet','Caprock',
          'Guadalupe','Red River','Pecos','Comal','Frio','Balcones','Llano','Nueces',
          'Alamo','Big Bend','Gulf Coast','Panhandle','Rio Grande','San Jacinto',
          'Cross Timbers','Edwards','Blanco','Colorado River'
        ]) as w(word)
        where c.legal_name like w.word || ' %'
          and c.row_hash = md5(c.dot_number::text || w.word || substr(c.phy_zip, 3))
      )
    )
    or (
      c.dot_number between 1400001 and 1400015
      and c.row_hash = md5(c.dot_number::text)
      and (c.phone is null or c.phone ~ '^\(\d{3}\) 555-01\d{2}$')
      and (c.cell_phone is null or c.cell_phone ~ '^\(\d{3}\) 555-01\d{2}$')
      and (c.fax is null or c.fax ~ '^\(\d{3}\) 555-01\d{2}$')
    )
  );

-- Batches: the two named baseline batches, each created by its fixture identity.
create temporary table tmp_baseline_batches on commit drop as
select b.id
from public.batches b
join tmp_fixture_users u on u.id = b.created_by
where (b.name = 'Central Texas Aggregate Recruitment' and u.email = 'manager@tnbs-recruiter.example.invalid')
   or (b.name = 'I-35 Corridor: Austin -> San Antonio' and u.email = 'editor@tnbs-recruiter.example.invalid');

-- Cargo values: exactly the facet rows the reset derives from baseline carriers.
create temporary table tmp_baseline_cargo on commit drop as
select v.value
from public.cargo_other_values v
where v.carrier_count_tx > 0
  and v.carrier_count_tx = (
    select count(*) from public.carriers c
    where c.cargo_other_norm = v.value
      and c.dot_number in (select dot_number from tmp_baseline_carriers)
  );

-- Every refusal predicate below is written as "(recognised) is not true" rather than
-- "not (recognised)": a NULL anywhere in the recognition test (for example a NULL note)
-- must count the row as unrecognised, not silently drop it from the count.
do $$
declare
  v_carriers bigint;
  v_batches bigint;
  v_cargo bigint;
  v_contact_logs bigint;
  v_suppressions bigint;
  v_members bigint;
  v_activity bigint;
  v_dnc_changes bigint;
begin
  select count(*) into v_carriers from public.carriers
  where (dot_number in (select dot_number from tmp_baseline_carriers)) is not true;
  select count(*) into v_batches from public.batches
  where (id in (select id from tmp_baseline_batches)) is not true;
  select count(*) into v_cargo from public.cargo_other_values
  where (value in (select value from tmp_baseline_cargo)) is not true;
  -- Baseline contact logs: one of the reset's fixed notes, by a fixture identity, on a
  -- baseline carrier, in a baseline batch (or none).
  select count(*) into v_contact_logs from public.contact_logs l
  where (
    l.notes in (
      'Reached dispatcher, walked through the belt job rates.',
      'Also a fit for the I-35 run -- same owner, different job.',
      'No answer, no VM set up.',
      'Sent the rate sheet to the corrected contact email on file.',
      'Seed-generated call log for demo purposes.'
    )
    and l.user_id in (select id from tmp_fixture_users)
    and l.dot_number in (select dot_number from tmp_baseline_carriers)
    and (l.batch_id is null or l.batch_id in (select id from tmp_baseline_batches))
  ) is not true;
  -- The baseline has no suppressions at all.
  select count(*) into v_suppressions from public.contact_suppressions;
  select count(*) into v_members from public.batch_carriers bc
  where (
    bc.batch_id in (select id from tmp_baseline_batches)
    and bc.dot_number in (select dot_number from tmp_baseline_carriers)
    and (bc.status_changed_by is null or bc.status_changed_by in (select id from tmp_fixture_users))
    and (bc.promoted_by is null or bc.promoted_by in (select id from tmp_fixture_users))
  ) is not true;
  select count(*) into v_activity from public.batch_activity a
  where (
    a.batch_id in (select id from tmp_baseline_batches)
    and (a.actor_id is null or a.actor_id in (select id from tmp_fixture_users))
  ) is not true;
  select count(*) into v_dnc_changes from public.carriers
  where dnc_set_by is not null and (dnc_set_by in (select id from tmp_fixture_users)) is not true;

  if v_carriers + v_batches + v_cargo + v_contact_logs + v_suppressions + v_members + v_activity + v_dnc_changes <> 0 then
    raise exception 'staging marker install refused: rows not recognised as the deterministic fictional baseline: carriers %, batches %, cargo values %, contact logs %, contact suppressions %, batch members %, batch activity %, carrier DNC changes by non-fixture users %',
      v_carriers, v_batches, v_cargo, v_contact_logs, v_suppressions, v_members, v_activity, v_dnc_changes;
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

-- Register the fingerprinted baseline rows (the check above guarantees there are no others).
insert into staging_identity.fixture_rows (table_name, row_key, registered_by)
select 'carriers', dot_number::text, 'install-baseline-fingerprint' from tmp_baseline_carriers;
insert into staging_identity.fixture_rows (table_name, row_key, registered_by)
select 'batches', id::text, 'install-baseline-fingerprint' from tmp_baseline_batches;
insert into staging_identity.fixture_rows (table_name, row_key, registered_by)
select 'cargo_other_values', value, 'install-baseline-fingerprint' from tmp_baseline_cargo;

commit;
