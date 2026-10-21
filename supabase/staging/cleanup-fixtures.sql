-- Staging-only cleanup for the deterministic database fixture set (fixture run stg-db-20260723-0042).
-- Removes the seven no-password fixture identities and the business rows explicitly
-- registered as fixture-owned in staging_identity.fixture_rows. It never deletes by table,
-- by number range, or by who created a row.
--
-- Run ONLY through the staging SQL runner:
--   npm --prefix pipeline run staging:sql -- --action=cleanup --confirm="CLEAN UP TNBS RECRUITER FIXTURES" --execute
-- Staging project: truck-recruitment-tool-staging, ref yhyoxhtguyturgdhwywc.
--
-- Gates, all checked before any row is deleted:
--   1. app.staging_runner_verified_ref equals the staging ref (set only by the runner after it
--      has verified the connection target and refused production).
--   2. The connected database carries the staging identity marker for that same project.
--   3. The confirmation phrase app.staging_cleanup_confirmation.
-- After the scoped deletes, the transaction is refused if anything not fixture-owned still
-- references a fixture identity.

begin;

do $$
declare
  v_marker_rows bigint;
  v_marker_ok boolean;
begin
  if current_setting('app.staging_runner_verified_ref', true) is distinct from 'yhyoxhtguyturgdhwywc' then
    raise exception 'staging cleanup refused: run through the staging SQL runner, which verifies the staging project first';
  end if;
  if to_regclass('staging_identity.marker') is null or to_regclass('staging_identity.fixture_rows') is null then
    raise exception 'staging cleanup refused: this database has no staging identity marker (install it once on staging via the runner)';
  end if;
  execute format(
    'select count(*), bool_and(environment = ''staging'' and marker_id = ''a8512f81-fe47-485d-95cd-092c46e4920b''::uuid and project_ref = %L) from staging_identity.marker',
    current_setting('app.staging_runner_verified_ref'))
    into v_marker_rows, v_marker_ok;
  if v_marker_rows <> 1 or v_marker_ok is not true then
    raise exception 'staging cleanup refused: staging identity marker is missing or names a different project';
  end if;
  if current_setting('app.staging_cleanup_confirmation', true) is distinct from 'CLEAN UP TNBS RECRUITER FIXTURES' then
    raise exception 'staging cleanup refused: confirmation phrase is missing';
  end if;
end
$$;

-- Explicit fixture ownership: registered rows and metadata-tagged fixture identities.
create temporary table tmp_cleanup_carriers on commit drop as
select row_key::bigint as dot_number from staging_identity.fixture_rows where table_name = 'carriers';
create temporary table tmp_cleanup_batches on commit drop as
select row_key::uuid as id from staging_identity.fixture_rows where table_name = 'batches';
create temporary table tmp_cleanup_users on commit drop as
select id from auth.users
where raw_user_meta_data->>'test_run_id' = 'stg-db-20260723-0042'
  and raw_user_meta_data->>'test_only' = 'true'
  and email like '%@tnbs-recruiter.example.invalid'
  and encrypted_password is null;

delete from public.contact_logs
where dot_number in (select dot_number from tmp_cleanup_carriers);
-- Members go first while their batches still exist: the member-delete audit trigger writes a
-- batch_activity row that must reference a live batch. Deleting a registered batch then
-- cascades to its zones and all its activity, including those audit rows.
delete from public.batch_carriers
where dot_number in (select dot_number from tmp_cleanup_carriers)
   or batch_id in (select id from tmp_cleanup_batches);
delete from public.batches
where id in (select id from tmp_cleanup_batches);
delete from public.cargo_other_values
where value in (select row_key from staging_identity.fixture_rows where table_name = 'cargo_other_values');
-- Insurance, filings, safety, inspections, QC snapshots, and carrier-scoped suppressions cascade.
delete from public.carriers
where dot_number in (select dot_number from tmp_cleanup_carriers);
delete from staging_identity.fixture_rows
where table_name in ('carriers', 'batches', 'cargo_other_values');

-- Approval references to fixture identities must be cleared before those identities go.
-- internal.guard_profile_update() only lets a manager or the trusted service role change
-- approval columns, so this one statement runs under the service-role claim, which is set
-- transaction-locally after every gate above has passed and cleared immediately afterwards.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
update public.profiles
set approved_by = null
where approved_by in (select id from tmp_cleanup_users);
select set_config('request.jwt.claims', '{}', true);

-- Refuse if anything that is not fixture-owned still points at a fixture identity.
do $$
declare
  v_refs bigint;
begin
  select
    (select count(*) from public.batches where created_by in (select id from tmp_cleanup_users))
  + (select count(*) from public.contact_logs where user_id in (select id from tmp_cleanup_users))
  + (select count(*) from public.batch_activity where actor_id in (select id from tmp_cleanup_users))
  + (select count(*) from public.batch_carriers where status_changed_by in (select id from tmp_cleanup_users)
                                                  or promoted_by in (select id from tmp_cleanup_users))
  + (select count(*) from public.carriers where dnc_set_by in (select id from tmp_cleanup_users))
  + (select count(*) from public.contact_suppressions where created_by in (select id from tmp_cleanup_users))
  into v_refs;
  if v_refs <> 0 then
    raise exception 'staging cleanup refused: % row(s) that are not registered fixtures still reference fixture identities', v_refs;
  end if;
end
$$;

delete from auth.users
where id in (select id from tmp_cleanup_users);

commit;
