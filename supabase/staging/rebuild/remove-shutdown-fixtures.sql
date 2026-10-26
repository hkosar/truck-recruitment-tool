-- Staging-only: removes the 12 T-SHUTDOWN fixture identities (install-shutdown-fixtures.sql) and
-- their sign-in ledger rows. Runs only through the staging SQL runner (action
-- remove-shutdown-fixtures). Refuses, changing nothing, if any business row references them.
-- Delivery evidence is kept: their email events stay (event rows carry their own recipient
-- snapshot; the link reference is set to null by the foreign key).

begin;

-- The twelve exact identities: each id must carry its own expected label, address and test metadata.
-- Nothing else in the reserved id range is selected (a stray row there makes the final check refuse).
create temporary table tmp_shutdown_fixtures on commit drop as
select u.id
  from generate_series(1, 12) n
  join auth.users u
    on u.id = ('71000000-0000-4000-8000-0000000002' || lpad(n::text, 2, '0'))::uuid
   and u.raw_user_meta_data->>'label' = 'shutdown-' || lpad(n::text, 2, '0')
   and u.email = 'shutdown-' || lpad(n::text, 2, '0') || '@tnbs-recruiter.example.invalid'
   and u.raw_user_meta_data->>'test_only' = 'true'
   and u.raw_user_meta_data->>'test_run_id' = 'stg-db-20260723-0042';

do $$
begin
  if current_setting('app.staging_runner_verified_ref', true) is distinct from 'yhyoxhtguyturgdhwywc' then
    raise exception 'shutdown fixture removal refused: run through the staging SQL runner, which verifies the staging project first';
  end if;
  if current_setting('app.staging_shutdown_fixtures_confirmation', true) is distinct from 'REMOVE TNBS SHUTDOWN TEST FIXTURES' then
    raise exception 'shutdown fixture removal refused: confirmation phrase missing';
  end if;
  if to_regclass('staging_identity.marker') is null then
    raise exception 'shutdown fixture removal refused: this database has no staging identity marker';
  end if;
  if (select count(*) from tmp_shutdown_fixtures) <> 12 then
    raise exception 'shutdown fixture removal refused: expected exactly 12 matching fixture identities, found %', (select count(*) from tmp_shutdown_fixtures);
  end if;
  if exists (select 1 from public.contact_logs where user_id in (select id from tmp_shutdown_fixtures))
     or exists (select 1 from public.batch_activity where actor_id in (select id from tmp_shutdown_fixtures))
     or exists (select 1 from public.batches where created_by in (select id from tmp_shutdown_fixtures))
     or exists (select 1 from public.batch_carriers where status_changed_by in (select id from tmp_shutdown_fixtures) or promoted_by in (select id from tmp_shutdown_fixtures))
     or exists (select 1 from public.contact_suppressions where created_by in (select id from tmp_shutdown_fixtures))
     or exists (select 1 from public.carriers where dnc_set_by in (select id from tmp_shutdown_fixtures))
     or exists (select 1 from internal.blocked_email_addresses where cleared_by in (select id from tmp_shutdown_fixtures))
     or exists (select 1 from internal.staff_mobile_unverified where entered_by in (select id from tmp_shutdown_fixtures) and user_id not in (select id from tmp_shutdown_fixtures))
     or exists (select 1 from public.profiles where approved_by in (select id from tmp_shutdown_fixtures)) then
    raise exception 'shutdown fixture removal refused: business rows reference these fixtures';
  end if;
end
$$;

delete from internal.app_sessions where user_id in (select id from tmp_shutdown_fixtures);
delete from internal.recovery_codes where user_id in (select id from tmp_shutdown_fixtures);
delete from internal.recovery_sets where user_id in (select id from tmp_shutdown_fixtures);
delete from internal.signin_links where user_id in (select id from tmp_shutdown_fixtures);
delete from internal.auth_events where user_id in (select id from tmp_shutdown_fixtures);
delete from internal.staff_mobile_unverified where user_id in (select id from tmp_shutdown_fixtures);
delete from public.profiles where id in (select id from tmp_shutdown_fixtures);
delete from auth.users where id in (select id from tmp_shutdown_fixtures);

do $$
begin
  if exists (select 1 from public.profiles where id::text like '71000000-0000-4000-8000-0000000002%')
     or exists (select 1 from auth.users where id::text like '71000000-0000-4000-8000-0000000002%') then
    raise exception 'shutdown fixture removal: rows remain';
  end if;
end
$$;

commit;
