-- Staging-only (REBUILT staging project, doc 16 §1.3 step 5): the 12 eligible fixture identities
-- reserved for the hosted T-SHUTDOWN test (doc 16 §1.5 row 10): two sets of 6 (set A = 01-06,
-- set B = 07-12). Runs only through the staging SQL runner (--project=rebuilt, action
-- install-shutdown-fixtures) after the marker, profile-fixtures, M1, M1b and M1c. The pinned ref
-- below is the OLD staging ref on purpose: the runner re-pins it to the recorded rebuilt ref in
-- memory and refuses to send the file otherwise (pipeline/src/staging-rebuilt.ts).
-- The auth metadata uses the same test_run_id as profile-fixtures.sql so the marker installer and
-- the fictional-data reset keep recognising these identities as fixtures. Same shape as
-- profile-fixtures.sql: database-level auth.users rows with explicit test metadata (no password,
-- no identity, no session), whose profiles are then made approved editors. Their addresses are
-- at the reserved .example.invalid domain and cannot receive mail.
-- Removal: remove-shutdown-fixtures.sql.

begin;

do $$
begin
  if current_setting('app.staging_runner_verified_ref', true) is distinct from 'yhyoxhtguyturgdhwywc' then
    raise exception 'shutdown fixtures refused: run through the staging SQL runner, which verifies the staging project first';
  end if;
  if current_setting('app.staging_shutdown_fixtures_confirmation', true) is distinct from 'INSTALL TNBS SHUTDOWN TEST FIXTURES' then
    raise exception 'shutdown fixtures refused: confirmation phrase missing';
  end if;
  if to_regclass('staging_identity.marker') is null then
    raise exception 'shutdown fixtures refused: this database has no staging identity marker';
  end if;
  if to_regprocedure('public.team_add_person(text, text, user_role, text)') is null
     or to_regprocedure('public.batch_delete(uuid)') is null then
    raise exception 'shutdown fixtures refused: apply M1, M1b and M1c first';
  end if;
  if not exists (select 1 from public.profiles where id = '71000000-0000-4000-8000-000000000001' and role = 'manager' and status = 'approved') then
    raise exception 'shutdown fixtures refused: install the profile fixtures first (the manager fixture approves these)';
  end if;
  if exists (select 1 from public.profiles where id::text like '71000000-0000-4000-8000-0000000002%')
     or exists (select 1 from auth.users where id::text like '71000000-0000-4000-8000-0000000002%') then
    raise exception 'shutdown fixtures refused: they are already installed (or partly installed; remove them first)';
  end if;
end
$$;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at, is_sso_user, is_anonymous
)
select '00000000-0000-0000-0000-000000000000',
       ('71000000-0000-4000-8000-0000000002' || lpad(n::text, 2, '0'))::uuid,
       'authenticated', 'authenticated',
       'shutdown-' || lpad(n::text, 2, '0') || '@tnbs-recruiter.example.invalid', null,
       '{"provider":"database-fixture","providers":[]}',
       jsonb_build_object('test_only', true, 'test_run_id', 'stg-db-20260723-0042', 'label', 'shutdown-' || lpad(n::text, 2, '0'), 'set', case when n <= 6 then 'A' else 'B' end),
       now(), now(), false, false
from generate_series(1, 12) n;

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- The profile rows (created by the auth.users trigger, or inserted here if the trigger did not).
insert into public.profiles (id, email, full_name, role, status, approved_by, approved_at)
select ('71000000-0000-4000-8000-0000000002' || lpad(n::text, 2, '0'))::uuid,
       'shutdown-' || lpad(n::text, 2, '0') || '@tnbs-recruiter.example.invalid',
       'Fictional Shutdown Test ' || lpad(n::text, 2, '0'), 'edit', 'approved',
       '71000000-0000-4000-8000-000000000001', now()
from generate_series(1, 12) n
on conflict (id) do update
  set email = excluded.email, full_name = excluded.full_name, role = 'edit', status = 'approved',
      approved_by = excluded.approved_by, approved_at = excluded.approved_at;

do $$
begin
  if (select count(*) from public.profiles
       where id::text like '71000000-0000-4000-8000-0000000002%' and role = 'edit' and status = 'approved') <> 12 then
    raise exception 'shutdown fixtures: expected 12 approved editor fixtures';
  end if;
end
$$;

commit;
