-- Staging-only cleanup for the deterministic database fixture set (fixture run stg-db-20260723-0042).
-- Removes the seven no-password fixture identities and the fictional business rows that
-- reference them or the fictional carriers. It never deletes unscoped tables.
--
-- Gates, all checked before any row is deleted:
--   1. The connected database carries the staging identity marker created once by
--      supabase/staging/install-staging-identity-marker.sql (never present in production).
--      Staging project: truck-recruitment-tool-staging, ref yhyoxhtguyturgdhwywc.
--   2. The operator sets the confirmation in the same run:
--        select set_config('app.staging_cleanup_confirmation', 'CLEAN UP TNBS RECRUITER FIXTURES', true);
--   3. The database holds only fictional data: every profile is a fixture identity or the
--      staging owner, every carrier is in a fictional DOT range (1200000-1307999 bulk,
--      1400001-1400099 hand-authored), and no value-only suppression exists. Anything else
--      is treated as real business data and the whole transaction is refused.

begin;

do $$
declare
  v_marker_rows bigint;
  v_marker_ok boolean;
  v_other_profiles bigint;
  v_real_range_carriers bigint;
  v_value_suppressions bigint;
begin
  if to_regclass('staging_identity.marker') is null then
    raise exception 'staging cleanup refused: this database has no staging identity marker (run install-staging-identity-marker.sql once on staging only)';
  end if;
  execute 'select count(*), bool_and(environment = ''staging'' and marker_id = ''a8512f81-fe47-485d-95cd-092c46e4920b''::uuid) from staging_identity.marker'
    into v_marker_rows, v_marker_ok;
  if v_marker_rows <> 1 or v_marker_ok is not true then
    raise exception 'staging cleanup refused: staging identity marker is missing or does not match';
  end if;
  if current_setting('app.staging_cleanup_confirmation', true) is distinct from 'CLEAN UP TNBS RECRUITER FIXTURES' then
    raise exception 'staging cleanup refused: confirmation phrase is missing';
  end if;

  select count(*) into v_other_profiles
  from public.profiles
  where not (id::text like '71000000-0000-4000-8000-00000000000%' and email like '%@tnbs-recruiter.example.invalid')
    and email is distinct from 'hunter@twistednail.com';
  select count(*) into v_real_range_carriers
  from public.carriers
  where not (dot_number between 1200000 and 1307999 or dot_number between 1400001 and 1400099);
  select count(*) into v_value_suppressions
  from public.contact_suppressions
  where dot_number is null;
  if v_other_profiles <> 0 or v_real_range_carriers <> 0 or v_value_suppressions <> 0 then
    raise exception 'staging cleanup refused: unexpected non-fictional data (other profiles %, carriers outside fictional DOT ranges %, value-only suppressions %)',
      v_other_profiles, v_real_range_carriers, v_value_suppressions;
  end if;
end
$$;

-- Fictional business rows, in dependency order. Every delete is scoped to fictional DOT
-- ranges or to batches created by fixture identities / the staging owner.
create temporary table tmp_cleanup_users on commit drop as
select id from public.profiles
where (id::text like '71000000-0000-4000-8000-00000000000%' and email like '%@tnbs-recruiter.example.invalid')
   or email = 'hunter@twistednail.com';

delete from public.contact_logs
where dot_number between 1200000 and 1307999 or dot_number between 1400001 and 1400099;
delete from public.contact_suppressions
where dot_number between 1200000 and 1307999 or dot_number between 1400001 and 1400099;
-- Members go first while their batches still exist: the member-delete audit trigger writes a
-- batch_activity row that must reference a live batch. Deleting the batch then cascades to
-- its zones and all activity, including those audit rows.
delete from public.batch_carriers
where batch_id in (select id from public.batches where created_by in (select id from tmp_cleanup_users));
delete from public.batches
where created_by in (select id from tmp_cleanup_users);
delete from public.carriers
where dot_number between 1200000 and 1307999 or dot_number between 1400001 and 1400099;

-- Clear remaining nullable references to fixture identities so they can be removed.
update public.profiles set approved_by = null
where approved_by in (
  select id from public.profiles
  where id::text like '71000000-0000-4000-8000-00000000000%' and email like '%@tnbs-recruiter.example.invalid'
);

delete from auth.users
where raw_user_meta_data->>'test_run_id' = 'stg-db-20260723-0042'
  and raw_user_meta_data->>'test_only' = 'true'
  and email like '%@tnbs-recruiter.example.invalid'
  and encrypted_password is null;

commit;
