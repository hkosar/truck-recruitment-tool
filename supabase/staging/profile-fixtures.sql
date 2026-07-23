-- Staging-only, database-level identities for transaction-scoped RLS/RPC tests.
-- These rows intentionally have no email, password, identity, refresh token, or
-- usable Auth session. They are NOT substitutes for hosted Auth/JWT E2E.
-- Apply only after independently verifying project ref yhyoxhtguyturgdhwywc.

begin;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at, is_sso_user, is_anonymous
)
values
  ('00000000-0000-0000-0000-000000000000', '71000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'manager@tnbs-recruiter.example.invalid', null,
   '{"provider":"database-fixture","providers":[]}', '{"test_only":true,"test_run_id":"stg-db-20260723-0042","label":"manager"}', now(), now(), false, false),
  ('00000000-0000-0000-0000-000000000000', '71000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'editor@tnbs-recruiter.example.invalid', null,
   '{"provider":"database-fixture","providers":[]}', '{"test_only":true,"test_run_id":"stg-db-20260723-0042","label":"editor"}', now(), now(), false, false),
  ('00000000-0000-0000-0000-000000000000', '71000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'editor-two@tnbs-recruiter.example.invalid', null,
   '{"provider":"database-fixture","providers":[]}', '{"test_only":true,"test_run_id":"stg-db-20260723-0042","label":"editor-two"}', now(), now(), false, false),
  ('00000000-0000-0000-0000-000000000000', '71000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'viewer@tnbs-recruiter.example.invalid', null,
   '{"provider":"database-fixture","providers":[]}', '{"test_only":true,"test_run_id":"stg-db-20260723-0042","label":"viewer"}', now(), now(), false, false),
  ('00000000-0000-0000-0000-000000000000', '71000000-0000-4000-8000-000000000005', 'authenticated', 'authenticated', 'pending@tnbs-recruiter.example.invalid', null,
   '{"provider":"database-fixture","providers":[]}', '{"test_only":true,"test_run_id":"stg-db-20260723-0042","label":"pending"}', now(), now(), false, false),
  ('00000000-0000-0000-0000-000000000000', '71000000-0000-4000-8000-000000000006', 'authenticated', 'authenticated', 'guest@tnbs-recruiter.example.invalid', null,
   '{"provider":"database-fixture","providers":[]}', '{"test_only":true,"test_run_id":"stg-db-20260723-0042","label":"guest"}', now(), now(), false, false),
  ('00000000-0000-0000-0000-000000000000', '71000000-0000-4000-8000-000000000007', 'authenticated', 'authenticated', 'disabled@tnbs-recruiter.example.invalid', null,
   '{"provider":"database-fixture","providers":[]}', '{"test_only":true,"test_run_id":"stg-db-20260723-0042","label":"disabled"}', now(), now(), false, false);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

update public.profiles
set email = case id
      when '71000000-0000-4000-8000-000000000001' then 'manager@tnbs-recruiter.example.invalid'
      when '71000000-0000-4000-8000-000000000002' then 'editor@tnbs-recruiter.example.invalid'
      when '71000000-0000-4000-8000-000000000003' then 'editor-two@tnbs-recruiter.example.invalid'
      when '71000000-0000-4000-8000-000000000004' then 'viewer@tnbs-recruiter.example.invalid'
      when '71000000-0000-4000-8000-000000000005' then 'pending@tnbs-recruiter.example.invalid'
      when '71000000-0000-4000-8000-000000000006' then 'guest@tnbs-recruiter.example.invalid'
      when '71000000-0000-4000-8000-000000000007' then 'disabled@tnbs-recruiter.example.invalid'
    end,
    full_name = case id
      when '71000000-0000-4000-8000-000000000001' then 'Fictional Manager'
      when '71000000-0000-4000-8000-000000000002' then 'Fictional Editor'
      when '71000000-0000-4000-8000-000000000003' then 'Fictional Second Editor'
      when '71000000-0000-4000-8000-000000000004' then 'Fictional Viewer'
      when '71000000-0000-4000-8000-000000000005' then 'Fictional Pending User'
      when '71000000-0000-4000-8000-000000000006' then 'Fictional Approved Guest'
      when '71000000-0000-4000-8000-000000000007' then 'Fictional Disabled User'
    end,
    role = case id
      when '71000000-0000-4000-8000-000000000001' then 'manager'::user_role
      when '71000000-0000-4000-8000-000000000002' then 'edit'::user_role
      when '71000000-0000-4000-8000-000000000003' then 'edit'::user_role
      when '71000000-0000-4000-8000-000000000004' then 'view'::user_role
      when '71000000-0000-4000-8000-000000000005' then 'guest'::user_role
      when '71000000-0000-4000-8000-000000000006' then 'guest'::user_role
      when '71000000-0000-4000-8000-000000000007' then 'view'::user_role
    end,
    status = case id
      when '71000000-0000-4000-8000-000000000005' then 'pending'::user_status
      when '71000000-0000-4000-8000-000000000007' then 'disabled'::user_status
      else 'approved'::user_status
    end,
    avatar_color = case id
      when '71000000-0000-4000-8000-000000000001' then '#1e3a6e'
      when '71000000-0000-4000-8000-000000000002' then '#35547e'
      when '71000000-0000-4000-8000-000000000003' then '#45648f'
      when '71000000-0000-4000-8000-000000000004' then '#6b7482'
      when '71000000-0000-4000-8000-000000000005' then '#8a5a2b'
      when '71000000-0000-4000-8000-000000000006' then '#64748b'
      when '71000000-0000-4000-8000-000000000007' then '#7f1d1d'
    end
where id::text like '71000000-0000-4000-8000-00000000000%';

commit;
