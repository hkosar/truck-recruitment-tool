-- Staging-only: removes the retention test fixtures installed by install-retention-fixtures.sql (the fresh
-- controls, and the aged rows too if the real run never happened). Runs only through the staging SQL runner
-- (--project=rebuilt, action remove-retention-fixtures), as the runner login. It deletes ONLY rows whose key
-- column carries the exact tag ret-fixture-20261101-aged or ret-fixture-20261101-fresh; it never deletes by
-- table, by age, or by who created a row. The pinned ref below is the OLD staging ref on purpose (the runner
-- re-pins it in memory).

begin;

do $$
declare
  v_marker_rows bigint;
  v_marker_ok boolean;
begin
  if current_setting('app.staging_runner_verified_ref', true) is distinct from 'yhyoxhtguyturgdhwywc' then
    raise exception 'retention fixture removal refused: run through the staging SQL runner, which verifies the staging project first';
  end if;
  if current_setting('app.staging_retention_fixtures_confirmation', true) is distinct from 'REMOVE TNBS RETENTION TEST FIXTURES' then
    raise exception 'retention fixture removal refused: confirmation phrase missing';
  end if;
  if to_regclass('staging_identity.marker') is null then
    raise exception 'retention fixture removal refused: this database has no staging identity marker';
  end if;
  execute format(
    'select count(*), bool_and(environment = ''staging'' and marker_id = ''a8512f81-fe47-485d-95cd-092c46e4920b''::uuid and project_ref = %L) from staging_identity.marker',
    current_setting('app.staging_runner_verified_ref'))
    into v_marker_rows, v_marker_ok;
  if v_marker_rows <> 1 or v_marker_ok is not true then
    raise exception 'retention fixture removal refused: staging identity marker is missing or names a different project';
  end if;
  if to_regclass('internal.app_sessions') is null then
    raise exception 'retention fixture removal refused: M1 is not applied on this database';
  end if;
end
$$;

delete from internal.app_sessions where token_hash in ('ret-fixture-20261101-aged', 'ret-fixture-20261101-fresh');
delete from internal.signin_links where token_hash in ('ret-fixture-20261101-aged', 'ret-fixture-20261101-fresh');
delete from internal.email_events where provider_event_id in ('ret-fixture-20261101-aged', 'ret-fixture-20261101-fresh');
delete from internal.recovery_failures where email_hash in ('ret-fixture-20261101-aged', 'ret-fixture-20261101-fresh');
delete from internal.auth_request_buckets where key_hash in ('ret-fixture-20261101-aged', 'ret-fixture-20261101-fresh');

do $$
begin
  if exists (select 1 from internal.auth_request_buckets where key_hash like 'ret-fixture-20261101-%')
     or exists (select 1 from internal.recovery_failures where email_hash like 'ret-fixture-20261101-%')
     or exists (select 1 from internal.email_events where provider_event_id like 'ret-fixture-20261101-%')
     or exists (select 1 from internal.signin_links where token_hash like 'ret-fixture-20261101-%')
     or exists (select 1 from internal.app_sessions where token_hash like 'ret-fixture-20261101-%') then
    raise exception 'retention fixture removal: tagged rows remain';
  end if;
end
$$;

commit;
