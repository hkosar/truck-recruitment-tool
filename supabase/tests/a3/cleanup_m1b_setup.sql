-- A3 ONLY (throwaway test cluster): the staging fixture cleanup after M1b (D8). Run as the
-- migration role on a database built by scripts/a3-build-test-db.mjs (M1 and M1b applied).
-- Sets up what cleanup-auth-ledgers-m1.sql and cleanup-fixtures.sql meet on staging after M1b:
-- the staging marker and fixture registry (as install-staging-identity-marker.sql creates them),
-- every business row registered as fixture-owned, and the post-M1b cases:
--   * a person added by the fixture manager (no Auth user; approved_by = fixture manager), whose
--     mobile the fixture manager entered  -> the cleanup must refuse until that is resolved;
--   * the fixture manager's own unverified mobile -> removed with the fixture;
--   * the guest fixture already orphaned (its Auth user deleted, profile left: no cascade);
--   * a live sign-in session of the editor fixture -> cleanup-fixtures.sql refuses until
--     cleanup-auth-ledgers-m1.sql has run.
\set ON_ERROR_STOP 1
begin;
create schema staging_identity;
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
insert into staging_identity.marker (environment, marker_id, project_ref, project_name)
values ('staging', 'a8512f81-fe47-485d-95cd-092c46e4920b', 'yhyoxhtguyturgdhwywc', 'A3 throwaway (test only)');
-- In this throwaway database every business row is a fixture.
insert into staging_identity.fixture_rows (table_name, row_key, registered_by)
select 'carriers', dot_number::text, 'a3' from public.carriers
union all select 'batches', id::text, 'a3' from public.batches
union all select 'cargo_other_values', value, 'a3' from public.cargo_other_values;

-- A real (non-fixture) person added by the fixture manager after M1b, with a mobile the manager entered.
insert into public.profiles (id, email, full_name, role, status, approved_by, approved_at)
values ('7e000000-0000-4000-8000-0000000000b1', 'real.person@company.example', 'Real Person', 'edit', 'approved',
        '71000000-0000-4000-8000-000000000001', now());
insert into internal.staff_mobile_unverified (user_id, mobile, entered_by)
values ('7e000000-0000-4000-8000-0000000000b1', '+15550002222', '71000000-0000-4000-8000-000000000001');
-- The fixture manager's own mobile.
insert into internal.staff_mobile_unverified (user_id, mobile, entered_by)
values ('71000000-0000-4000-8000-000000000001', '+15550003333', '71000000-0000-4000-8000-000000000001');
-- The guest fixture orphaned by an earlier cleanup that relied on the cascade.
delete from auth.users where id = '71000000-0000-4000-8000-000000000006';
-- A live sign-in session of the editor fixture.
insert into internal.app_sessions (user_id, token_hash, kind, email_at_issue, created_at, last_seen_at, idle_window, expires_at, absolute_expires_at)
select id, 'a3-cleanup-m1b-session', 'link', email, now(), now(), interval '30 days', now() + interval '30 days', now() + interval '90 days'
from public.profiles where id = '71000000-0000-4000-8000-000000000002';
commit;

do $$
begin
  if (select count(*) from public.profiles where id::text like '71000000-0000-4000-8000-00000000000%') <> 7 then
    raise exception 'setup: expected the seven fixture profiles';
  end if;
  if exists (select 1 from auth.users where id = '71000000-0000-4000-8000-000000000006') then
    raise exception 'setup: the guest fixture should be orphaned';
  end if;
  raise notice 'SETUP OK: 7 fixture profiles (guest orphaned), 1 real person, 2 mobile rows, 1 fixture session';
end
$$;
