-- ============================================================================
-- cleanup-auth-ledgers-m1.sql -- staging-only, for AFTER M1. New file next to
-- supabase/staging/cleanup-fixtures.sql (unchanged).
--
-- Removes the sign-in ledger rows of the fixture identities only (fixture run
-- stg-db-20260723-0042), so that cleanup-fixtures.sql can then delete those identities (the
-- ledgers reference public.profiles) and so that each fictional-data reset starts with clean
-- sign-in state. It never deletes by table, by number range, or by who created a row, and it
-- never touches a non-fixture person's rows.
--
-- Run ONLY through the staging SQL runner (an action must be registered for this file; that is
-- a pipeline-tooling change waiting for the staging rollout approval):
--   --confirm="CLEAN UP TNBS RECRUITER SIGN-IN FIXTURES"
-- Gates, all checked before any row is deleted (same as cleanup-fixtures.sql):
--   1. app.staging_runner_verified_ref equals the staging ref (set only by the runner after it
--      has verified the connection target and refused production).
--   2. The connected database carries the staging identity marker for that same project.
--   3. The confirmation phrase app.staging_auth_ledger_cleanup_confirmation.
-- ============================================================================

begin;

do $$
declare
  v_marker_rows bigint;
  v_marker_ok boolean;
begin
  if current_setting('app.staging_runner_verified_ref', true) is distinct from 'yhyoxhtguyturgdhwywc' then
    raise exception 'staging sign-in ledger cleanup refused: run through the staging SQL runner, which verifies the staging project first';
  end if;
  if to_regclass('staging_identity.marker') is null or to_regclass('staging_identity.fixture_rows') is null then
    raise exception 'staging sign-in ledger cleanup refused: this database has no staging identity marker';
  end if;
  execute format(
    'select count(*), bool_and(environment = ''staging'' and marker_id = ''a8512f81-fe47-485d-95cd-092c46e4920b''::uuid and project_ref = %L) from staging_identity.marker',
    current_setting('app.staging_runner_verified_ref'))
    into v_marker_rows, v_marker_ok;
  if v_marker_rows <> 1 or v_marker_ok is not true then
    raise exception 'staging sign-in ledger cleanup refused: staging identity marker is missing or names a different project';
  end if;
  if current_setting('app.staging_auth_ledger_cleanup_confirmation', true) is distinct from 'CLEAN UP TNBS RECRUITER SIGN-IN FIXTURES' then
    raise exception 'staging sign-in ledger cleanup refused: confirmation phrase is missing';
  end if;
  if to_regclass('internal.app_sessions') is null then
    raise exception 'staging sign-in ledger cleanup refused: M1 is not applied on this database';
  end if;
end
$$;

-- Explicit fixture ownership: exactly the metadata-tagged, no-password fixture identities, plus
-- (after M1b, D8) fixture profiles an earlier cleanup left without their Auth user: only the
-- seven fixed fixture ids of profile-fixtures.sql, on the fixture domain, with no Auth user. The
-- same rule as supabase/staging/cleanup-fixtures.sql.
create temporary table tmp_fixture_people on commit drop as
select u.id, lower(u.email) as email
from auth.users u
where u.raw_user_meta_data->>'test_run_id' = 'stg-db-20260723-0042'
  and u.raw_user_meta_data->>'test_only' = 'true'
  and u.email like '%@tnbs-recruiter.example.invalid'
  and u.encrypted_password is null
union
select p.id, lower(p.email)
from public.profiles p
where p.id in ('71000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000002',
               '71000000-0000-4000-8000-000000000003', '71000000-0000-4000-8000-000000000004',
               '71000000-0000-4000-8000-000000000005', '71000000-0000-4000-8000-000000000006',
               '71000000-0000-4000-8000-000000000007')
  and p.email like '%@tnbs-recruiter.example.invalid'
  and not exists (select 1 from auth.users u where u.id = p.id);

-- A1 sessions (they reference recovery codes), then A2 links (events keep their snapshot; the
-- link reference is SET NULL), then A3 recovery codes and sets, then A4 blocks, then audit.
delete from internal.app_sessions where user_id in (select id from tmp_fixture_people);
delete from internal.email_events
 where link_id in (select l.id from internal.signin_links l where l.user_id in (select id from tmp_fixture_people));
delete from internal.signin_links where user_id in (select id from tmp_fixture_people);
delete from internal.recovery_codes where user_id in (select id from tmp_fixture_people);
delete from internal.recovery_sets where user_id in (select id from tmp_fixture_people);
delete from internal.blocked_email_addresses where normalized_email in (select email from tmp_fixture_people);
delete from internal.auth_events where user_id in (select id from tmp_fixture_people);

-- Refuse if anything outside the fixture set still references a fixture identity's ledgers.
do $$
begin
  if exists (select 1 from internal.app_sessions where user_id in (select id from tmp_fixture_people))
     or exists (select 1 from internal.signin_links where user_id in (select id from tmp_fixture_people))
     or exists (select 1 from internal.recovery_codes where user_id in (select id from tmp_fixture_people)) then
    raise exception 'staging sign-in ledger cleanup refused: fixture ledger rows remain';
  end if;
end
$$;

commit;
