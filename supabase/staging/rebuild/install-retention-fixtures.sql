-- Staging-only (REBUILT staging project, doc 16 section 4 step 3, approval 11): the ten sign-in ledger
-- rows for the hosted retention least-privilege test, five AGED and five FRESH control rows, one pair per
-- ledger. Runs only through the staging SQL runner (--project=rebuilt, action install-retention-fixtures)
-- after M1 and the profile fixtures, as the runner login (recruiter_maintenance cannot insert). The pinned
-- ref below is the OLD staging ref on purpose: the runner re-pins it to the recorded rebuilt ref in memory
-- and refuses to send the file otherwise (pipeline/src/staging-rebuilt.ts).
--
-- Why this makes "one real run deletes only aged fixture rows" provable: the retention rules delete EVERY
-- aged row in the five ledgers, so this file refuses to run unless NO aged row exists yet (all five rule
-- counts are 0), and refuses if any fixture row already exists. After it the only aged rows are the five
-- fixtures below, each carrying the tag ret-fixture-20261101-aged in its key column (fresh controls:
-- ret-fixture-20261101-fresh). The runner action retention-run then refuses unless each rule would delete
-- exactly one row and that row is the tagged one. The tag literals here, in retention-run.ts and in
-- remove-retention-fixtures.sql must stay equal (scripts/verify-staging-rebuild-contract.mjs checks it).
-- Rows reference only the manager fixture profile of profile-fixtures.sql; addresses use the reserved
-- .example.invalid domain and cannot receive mail. Removal: remove-retention-fixtures.sql.

begin;

do $$
declare
  v_marker_rows bigint;
  v_marker_ok boolean;
begin
  if current_setting('app.staging_runner_verified_ref', true) is distinct from 'yhyoxhtguyturgdhwywc' then
    raise exception 'retention fixtures refused: run through the staging SQL runner, which verifies the staging project first';
  end if;
  if current_setting('app.staging_retention_fixtures_confirmation', true) is distinct from 'INSTALL TNBS RETENTION TEST FIXTURES' then
    raise exception 'retention fixtures refused: confirmation phrase missing';
  end if;
  if to_regclass('staging_identity.marker') is null then
    raise exception 'retention fixtures refused: this database has no staging identity marker';
  end if;
  execute format(
    'select count(*), bool_and(environment = ''staging'' and marker_id = ''a8512f81-fe47-485d-95cd-092c46e4920b''::uuid and project_ref = %L) from staging_identity.marker',
    current_setting('app.staging_runner_verified_ref'))
    into v_marker_rows, v_marker_ok;
  if v_marker_rows <> 1 or v_marker_ok is not true then
    raise exception 'retention fixtures refused: staging identity marker is missing or names a different project';
  end if;
  if to_regclass('internal.app_sessions') is null then
    raise exception 'retention fixtures refused: M1 is not applied on this database';
  end if;
  if not exists (select 1 from public.profiles where id = '71000000-0000-4000-8000-000000000001' and email like '%@tnbs-recruiter.example.invalid') then
    raise exception 'retention fixtures refused: install the profile fixtures first (the manager fixture owns the rows)';
  end if;
  -- Nothing aged may exist yet: the retention run would delete it too. These are the RETENTION_RULES predicates.
  if exists (select 1 from internal.auth_request_buckets where window_start < clock_timestamp() - interval '48 hours')
     or exists (select 1 from internal.recovery_failures where at < clock_timestamp() - interval '48 hours')
     or exists (select 1 from internal.email_events where received_at < clock_timestamp() - interval '180 days')
     or exists (select 1 from internal.signin_links where coalesce(used_at, revoked_at, expires_at) < clock_timestamp() - interval '30 days')
     or exists (select 1 from internal.app_sessions where least(coalesce(revoked_at, 'infinity'::timestamptz), expires_at) < clock_timestamp() - interval '30 days') then
    raise exception 'retention fixtures refused: aged ledger rows already exist, so the retention run would not be limited to fixtures';
  end if;
  if exists (select 1 from internal.auth_request_buckets where key_hash like 'ret-fixture-20261101-%')
     or exists (select 1 from internal.recovery_failures where email_hash like 'ret-fixture-20261101-%')
     or exists (select 1 from internal.email_events where provider_event_id like 'ret-fixture-20261101-%')
     or exists (select 1 from internal.signin_links where token_hash like 'ret-fixture-20261101-%')
     or exists (select 1 from internal.app_sessions where token_hash like 'ret-fixture-20261101-%') then
    raise exception 'retention fixtures refused: they are already installed (or partly installed; remove them first)';
  end if;
end
$$;

insert into internal.auth_request_buckets (dimension, key_hash, window_start, count) values
  ('ip', 'ret-fixture-20261101-aged', now() - interval '3 days', 1),
  ('ip', 'ret-fixture-20261101-fresh', now(), 1);

insert into internal.recovery_failures (email_hash, at) values
  ('ret-fixture-20261101-aged', now() - interval '3 days'),
  ('ret-fixture-20261101-fresh', now());

insert into internal.signin_links (user_id, token_hash, recipient_email, created_at, expires_at) values
  ('71000000-0000-4000-8000-000000000001', 'ret-fixture-20261101-aged', 'retention-fixture@tnbs-recruiter.example.invalid',
   now() - interval '40 days', now() - interval '40 days' + interval '15 minutes'),
  ('71000000-0000-4000-8000-000000000001', 'ret-fixture-20261101-fresh', 'retention-fixture@tnbs-recruiter.example.invalid',
   now(), now() + interval '15 minutes');

insert into internal.app_sessions (user_id, token_hash, kind, email_at_issue, created_at, last_seen_at, idle_window, expires_at, absolute_expires_at) values
  ('71000000-0000-4000-8000-000000000001', 'ret-fixture-20261101-aged', 'link', 'retention-fixture@tnbs-recruiter.example.invalid',
   now() - interval '200 days', now() - interval '200 days', interval '30 days', now() - interval '170 days', now() - interval '110 days'),
  ('71000000-0000-4000-8000-000000000001', 'ret-fixture-20261101-fresh', 'link', 'retention-fixture@tnbs-recruiter.example.invalid',
   now(), now(), interval '30 days', now() + interval '30 days', now() + interval '90 days');

insert into internal.email_events (provider_event_id, recipient_email, event_type, occurred_at, received_at) values
  ('ret-fixture-20261101-aged', 'retention-fixture@tnbs-recruiter.example.invalid', 'delivered', now() - interval '200 days', now() - interval '200 days'),
  ('ret-fixture-20261101-fresh', 'retention-fixture@tnbs-recruiter.example.invalid', 'delivered', now(), now());

do $$
begin
  if (select count(*) from internal.auth_request_buckets where key_hash = 'ret-fixture-20261101-aged' and window_start < clock_timestamp() - interval '48 hours') <> 1
     or (select count(*) from internal.recovery_failures where email_hash = 'ret-fixture-20261101-aged' and at < clock_timestamp() - interval '48 hours') <> 1
     or (select count(*) from internal.email_events where provider_event_id = 'ret-fixture-20261101-aged' and received_at < clock_timestamp() - interval '180 days') <> 1
     or (select count(*) from internal.signin_links where token_hash = 'ret-fixture-20261101-aged' and coalesce(used_at, revoked_at, expires_at) < clock_timestamp() - interval '30 days') <> 1
     or (select count(*) from internal.app_sessions where token_hash = 'ret-fixture-20261101-aged' and least(coalesce(revoked_at, 'infinity'::timestamptz), expires_at) < clock_timestamp() - interval '30 days') <> 1 then
    raise exception 'retention fixtures: expected exactly one aged fixture per ledger';
  end if;
  if (select count(*) from internal.auth_request_buckets where key_hash = 'ret-fixture-20261101-fresh') <> 1
     or (select count(*) from internal.recovery_failures where email_hash = 'ret-fixture-20261101-fresh') <> 1
     or (select count(*) from internal.email_events where provider_event_id = 'ret-fixture-20261101-fresh') <> 1
     or (select count(*) from internal.signin_links where token_hash = 'ret-fixture-20261101-fresh') <> 1
     or (select count(*) from internal.app_sessions where token_hash = 'ret-fixture-20261101-fresh') <> 1 then
    raise exception 'retention fixtures: expected exactly one fresh control per ledger';
  end if;
end
$$;

commit;
