-- ============================================================================
-- verify-role-matrix-m1.sql -- the role matrix for AFTER M1 (supabase/pending/M1_same_origin_signin.sql).
-- New file next to supabase/staging/verify-role-matrix.sql (which stays valid until M1 is applied).
-- Rollback-only: every fixture session and every probe write is undone by the final rollback.
-- Run only on staging (through the staging SQL runner once an action is registered for it) or in
-- the local A3 test cluster. Fixture identities: supabase/staging/profile-fixtures.sql
-- (71000000-...-0001 manager, -0002 editor, -0003 editor two, -0004 viewer, -0005 pending,
-- -0006 guest, -0007 disabled).
-- ============================================================================
begin;

do $gate$
begin
  if current_setting('app.staging_runner_verified_ref', true) is distinct from 'yhyoxhtguyturgdhwywc' then
    raise exception 'role matrix refused: run through the staging SQL runner (or the A3 harness), which verifies the target first';
  end if;
end
$gate$;

create temporary table _results (
  actor text not null,
  test_name text not null,
  expected text not null,
  observed text not null,
  pass boolean not null
) on commit drop;
grant select, insert on _results to anon, authenticated, recruiter_api;

-- Fixture sessions (as the migration role, before switching roles). Hashes are fixed probe
-- values, not credentials; they exist only inside this rolled-back transaction.
insert into internal.app_sessions (user_id, token_hash, kind, email_at_issue, created_at, last_seen_at, idle_window, expires_at, absolute_expires_at)
select p.id, 'probe-' || s.label, 'link', p.email, now(), now(), interval '30 days', now() + interval '30 days', now() + interval '90 days'
from (values
  ('71000000-0000-4000-8000-000000000001'::uuid, 'manager'),
  ('71000000-0000-4000-8000-000000000002'::uuid, 'editor'),
  ('71000000-0000-4000-8000-000000000004'::uuid, 'viewer'),
  ('71000000-0000-4000-8000-000000000005'::uuid, 'pending'),
  ('71000000-0000-4000-8000-000000000006'::uuid, 'guest'),
  ('71000000-0000-4000-8000-000000000007'::uuid, 'disabled')
) as s(id, label)
join public.profiles p on p.id = s.id;

-- Editor sessions that must NOT work: revoked, expired, email changed since issue.
insert into internal.app_sessions (user_id, token_hash, kind, email_at_issue, created_at, last_seen_at, idle_window, expires_at, absolute_expires_at, revoked_at, revoked_reason)
select p.id, 'probe-editor-revoked', 'link', p.email, now(), now(), interval '30 days', now() + interval '30 days', now() + interval '90 days', now(), 'signed_out'
from public.profiles p where p.id = '71000000-0000-4000-8000-000000000002';
insert into internal.app_sessions (user_id, token_hash, kind, email_at_issue, created_at, last_seen_at, idle_window, expires_at, absolute_expires_at)
select p.id, 'probe-editor-expired', 'link', p.email, now(), now(), interval '30 days', now() - interval '1 second', now() + interval '90 days'
from public.profiles p where p.id = '71000000-0000-4000-8000-000000000002';
insert into internal.app_sessions (user_id, token_hash, kind, email_at_issue, created_at, last_seen_at, idle_window, expires_at, absolute_expires_at)
select p.id, 'probe-editor-old-email', 'link', 'old-' || p.email, now(), now(), interval '30 days', now() + interval '30 days', now() + interval '90 days'
from public.profiles p where p.id = '71000000-0000-4000-8000-000000000002';

-- Recovery sessions (editor and viewer). Recovery stays DISABLED in M1; it is switched on only
-- inside this rolled-back transaction to prove the restrictions hold if it is ever enabled.
update internal.recovery_policy set enabled = true;
with sets as (
  insert into internal.recovery_sets (user_id)
  values ('71000000-0000-4000-8000-000000000002'), ('71000000-0000-4000-8000-000000000004')
  returning id, user_id
), codes as (
  insert into internal.recovery_codes (set_id, user_id, code_hash, expires_at, used_at)
  select id, user_id, 'probe-code-' || user_id, now() + interval '180 days', now() from sets
  returning id, user_id
)
insert into internal.app_sessions (user_id, token_hash, kind, email_at_issue, created_at, last_seen_at, idle_window, expires_at, absolute_expires_at, recovery_code_id)
select c.user_id,
       case when c.user_id = '71000000-0000-4000-8000-000000000002' then 'probe-editor-recovery' else 'probe-viewer-recovery' end,
       'recovery', p.email, now(), now(), interval '1 hour', now() + interval '1 hour', now() + interval '12 hours', c.id
from codes c join public.profiles p on p.id = c.user_id;

create or replace function pg_temp.as_session(p_hash text) returns void
language plpgsql as $$
begin
  perform set_config('app.session_hash', coalesce(p_hash, ''), true);
  perform set_config('app.actor_locked', '', true);
end $$;


-- ---- Probe targets (Gate 2 review finding 9). Created here, as the migration role, inside this
-- rolled-back transaction, so every probe has a known, non-null target that exists whatever data
-- the database holds; subqueries run under a session would otherwise see RLS-filtered (null)
-- targets and pass vacuously.
create temporary table _t (
  batch_id uuid, dot_a bigint, dot_b bigint, log_id uuid, activity_id bigint, suppression_id bigint, cargo_value text
) on commit drop;
grant select on _t to anon, authenticated, recruiter_api;
do $targets$
declare
  v_batch uuid;
  v_dots bigint[];
  v_log uuid;
  v_act bigint;
  v_sup bigint;
  v_cargo text;
begin
  select array_agg(c.dot_number order by c.dot_number) into v_dots
  from (select c.dot_number from public.carriers c
        where not c.do_not_contact
          and not exists (select 1 from public.contact_suppressions s where s.dot_number = c.dot_number
                          and s.channel::text = 'all' and s.value is null and (s.expires_at is null or s.expires_at > now()))
        order by c.dot_number limit 2) c;
  if coalesce(cardinality(v_dots), 0) < 2 then
    raise exception 'role matrix needs two contactable carriers';
  end if;
  select value into v_cargo from public.cargo_other_values order by value limit 1;
  if v_cargo is null then
    raise exception 'role matrix needs one cargo_other_values row';
  end if;
  insert into public.batches (name, created_by, search_definition)
  values ('AUTHZ PROBE BATCH', '71000000-0000-4000-8000-000000000001', '{}') returning id into v_batch;
  insert into public.batch_carriers (batch_id, dot_number) values (v_batch, v_dots[1]), (v_batch, v_dots[2]);
  insert into public.contact_logs (dot_number, batch_id, user_id, channel, disposition, notes)
  values (v_dots[1], v_batch, '71000000-0000-4000-8000-000000000002', 'call', 'connected', 'AUTHZ PROBE') returning id into v_log;
  insert into public.batch_activity (batch_id, actor_id, activity_type, comment)
  values (v_batch, '71000000-0000-4000-8000-000000000002', 'comment', 'AUTHZ PROBE') returning id into v_act;
  insert into public.contact_suppressions (dot_number, channel, value, created_by)
  values (v_dots[2], 'email', 'authz-probe@example.invalid', '71000000-0000-4000-8000-000000000001') returning id into v_sup;
  insert into _t values (v_batch, v_dots[1], v_dots[2], v_log, v_act, v_sup, v_cargo);
end
$targets$;

-- ---- Recording helpers. Each probe runs inside its own inner block that is always rolled back
-- (raise P0099 after the checks), so a probe's writes never leak into the next probe, while its
-- result row (inserted after the inner block) survives. Effects are checked as the migration
-- role (RESET ROLE inside the inner block; undone by the same rollback), never through the
-- session's own RLS view.

-- Denied: must raise one of the expected SQLSTATEs (default 42501); "allowed" or any other error fails.
create or replace function pg_temp.record_denied(p_actor text, p_test text, p_sql text, p_states text[] default array['42501']) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
    raise exception using errcode = 'P0099', message = 'allowed';
  exception
    when sqlstate 'P0099' then
      insert into _results values (p_actor, p_test, 'error ' || array_to_string(p_states, '/'), 'allowed', false);
      return;
    when others then
      insert into _results values (p_actor, p_test, 'error ' || array_to_string(p_states, '/'), sqlstate, sqlstate = any (p_states));
      return;
  end;
end $$;

-- Refused without an error (RLS filters the target): no row affected AND the target is unchanged,
-- checked as the migration role; or a 42501 error. Any other error fails.
create or replace function pg_temp.record_unchanged(p_actor text, p_test text, p_sql text, p_check text) returns void
language plpgsql as $$
declare
  v_rows bigint;
  v_ok boolean;
begin
  begin
    execute p_sql;
    get diagnostics v_rows = row_count;
    reset role;
    execute p_check into v_ok;
    raise exception using errcode = 'P0099', message = v_rows::text || '|' || coalesce(v_ok::text, 'null');
  exception
    when sqlstate 'P0099' then
      insert into _results values (p_actor, p_test, '0 rows, target unchanged', sqlerrm,
                                   split_part(sqlerrm, '|', 1) = '0' and split_part(sqlerrm, '|', 2) = 'true');
      return;
    when others then
      insert into _results values (p_actor, p_test, '0 rows, target unchanged', sqlstate, sqlstate = '42501');
      return;
  end;
end $$;

-- Allowed: must succeed AND the check (as the migration role) must be true afterwards.
create or replace function pg_temp.record_allowed(p_actor text, p_test text, p_sql text, p_check text) returns void
language plpgsql as $$
declare
  v_ok boolean;
begin
  begin
    execute p_sql;
    reset role;
    execute p_check into v_ok;
    raise exception using errcode = 'P0099', message = coalesce(v_ok::text, 'null');
  exception
    when sqlstate 'P0099' then
      insert into _results values (p_actor, p_test, 'allowed, effect checked', 'allowed, effect ' || sqlerrm, sqlerrm = 'true');
      return;
    when others then
      insert into _results values (p_actor, p_test, 'allowed, effect checked', sqlstate || ':' || sqlerrm, false);
      return;
  end;
end $$;

-- Row counts: a positive expectation needs > 0 rows; a zero expectation needs 0 rows or a 42501.
create or replace function pg_temp.record_count(p_actor text, p_test text, p_sql text, p_expect_positive boolean) returns void
language plpgsql as $$
declare
  v_n bigint;
begin
  begin
    execute p_sql into v_n;
    insert into _results values (p_actor, p_test, case when p_expect_positive then '> 0 rows' else '0 rows' end, v_n::text,
                                 case when p_expect_positive then v_n > 0 else v_n = 0 end);
  exception when others then
    insert into _results values (p_actor, p_test, case when p_expect_positive then '> 0 rows' else '0 rows' end, sqlstate,
                                 not p_expect_positive and sqlstate = '42501');
  end;
end $$;

-- ---- The public key and Supabase user tokens reach nothing (grants revoked).
set local role anon;
select pg_temp.record_denied('anon', 'select carriers', $$select 1 from public.carriers limit 1$$);
select pg_temp.record_denied('anon', 'select profiles', $$select 1 from public.profiles limit 1$$);
select pg_temp.record_denied('anon', 'execute create_batch', $$select public.create_batch('AUTHZ PROBE',null,null,null,'{}'::jsonb)$$);
reset role;
set local role authenticated;
select pg_temp.record_denied('authenticated', 'select carriers', $$select 1 from public.carriers limit 1$$);
select pg_temp.record_denied('authenticated', 'execute search_carriers', $$select * from public.search_carriers('{}'::jsonb, 1, 0, null, null)$$);
select pg_temp.record_denied('authenticated', 'update profiles', $$update public.profiles set full_name = full_name$$);
reset role;

-- ---- The app role without a session sees nothing.
set local role recruiter_api;
select pg_temp.as_session(null);
select pg_temp.record_count('no-session', 'select carriers', $$select count(*) from public.carriers$$, false);
select pg_temp.record_count('no-session', 'select profiles', $$select count(*) from public.profiles$$, false);
select pg_temp.record_denied('no-session', 'execute create_batch', $$select public.create_batch('AUTHZ PROBE',null,null,null,'{}'::jsonb)$$);

-- ---- Not-staff and invalid sessions see nothing and write nothing.
select pg_temp.as_session('probe-pending');
select pg_temp.record_count('pending', 'select carriers', $$select count(*) from public.carriers$$, false);
select pg_temp.record_count('pending', 'select own profile', $$select count(*) from public.profiles$$, false);
select pg_temp.as_session('probe-guest');
select pg_temp.record_count('guest', 'select batches', $$select count(*) from public.batches$$, false);
select pg_temp.as_session('probe-disabled');
select pg_temp.record_count('disabled', 'select carriers', $$select count(*) from public.carriers$$, false);
select pg_temp.record_denied('disabled', 'execute set_do_not_contact', $$select public.set_do_not_contact((select dot_a from _t),true,'AUTHZ PROBE')$$);
select pg_temp.as_session('probe-editor-revoked');
select pg_temp.record_count('editor-revoked', 'select carriers', $$select count(*) from public.carriers$$, false);
select pg_temp.as_session('probe-editor-expired');
select pg_temp.record_count('editor-expired', 'select carriers', $$select count(*) from public.carriers$$, false);
select pg_temp.as_session('probe-editor-old-email');
select pg_temp.record_count('editor-old-email', 'select carriers', $$select count(*) from public.carriers$$, false);

-- ---- Viewer: reads; every write refused.
select pg_temp.as_session('probe-viewer');
select pg_temp.record_count('viewer', 'select carriers', $$select count(*) from public.carriers$$, true);
select pg_temp.record_count('viewer', 'select profiles (staff list)', $$select count(*) from public.profiles$$, true);
select pg_temp.record_count('viewer', 'sees the probe member (control)', $$select count(*) from public.batch_carriers where batch_id = (select batch_id from _t) and dot_number = (select dot_a from _t)$$, true);
select pg_temp.record_unchanged('viewer', 'update member status',
  $$update public.batch_carriers set status = 'contacted' where batch_id = (select batch_id from _t) and dot_number = (select dot_a from _t)$$,
  $$select status = 'new' from public.batch_carriers where batch_id = (select batch_id from _t) and dot_number = (select dot_a from _t)$$);
select pg_temp.record_denied('viewer', 'insert own contact log',
  $$insert into public.contact_logs(dot_number,user_id,channel,disposition) values((select dot_a from _t),'71000000-0000-4000-8000-000000000004','call','connected')$$);
select pg_temp.record_denied('viewer', 'insert comment',
  $$insert into public.batch_activity(batch_id,actor_id,activity_type,comment) values((select batch_id from _t),'71000000-0000-4000-8000-000000000004','comment','AUTHZ PROBE')$$);
select pg_temp.record_denied('viewer', 'insert batch directly',
  $$insert into public.batches(name,created_by,search_definition) values('AUTHZ PROBE','71000000-0000-4000-8000-000000000004','{}')$$);
select pg_temp.record_denied('viewer', 'execute set_do_not_contact', $$select public.set_do_not_contact((select dot_a from _t),true,'AUTHZ PROBE')$$);
select pg_temp.record_denied('viewer', 'execute create_batch', $$select public.create_batch('AUTHZ PROBE',null,null,null,'{}'::jsonb)$$);
select pg_temp.record_denied('viewer', 'execute team_list', $$select * from public.team_list()$$);

-- ---- Editor: workflow writes allowed (effects checked); manager-only and attribution writes refused.
select pg_temp.as_session('probe-editor');
select pg_temp.record_allowed('editor', 'insert own contact log',
  $$insert into public.contact_logs(dot_number,batch_id,user_id,channel,disposition,notes) values((select dot_a from _t),(select batch_id from _t),'71000000-0000-4000-8000-000000000002','call','connected','AUTHZ PROBE ALLOWED')$$,
  $$select count(*) = 1 from public.contact_logs where notes = 'AUTHZ PROBE ALLOWED' and user_id = '71000000-0000-4000-8000-000000000002'$$);
select pg_temp.as_session('probe-editor');
select pg_temp.record_allowed('editor', 'execute create_batch',
  $$select * from public.create_batch('AUTHZ PROBE CREATE',null,null,null,'{}'::jsonb)$$,
  $$select count(*) = 1 from public.batches where name = 'AUTHZ PROBE CREATE' and created_by = '71000000-0000-4000-8000-000000000002'$$);
select pg_temp.as_session('probe-editor');
select pg_temp.record_allowed('editor', 'execute bulk_set_status',
  $$select public.bulk_set_status((select batch_id from _t), array[(select dot_a from _t)], 'contacted')$$,
  $$select status = 'contacted' and status_changed_by = '71000000-0000-4000-8000-000000000002' from public.batch_carriers where batch_id = (select batch_id from _t) and dot_number = (select dot_a from _t)$$);
select pg_temp.as_session('probe-editor');
select pg_temp.record_allowed('editor', 'execute log_export',
  $$select public.log_export((select batch_id from _t),'csv',1)$$,
  $$select count(*) = 1 from public.batch_activity where batch_id = (select batch_id from _t) and actor_id = '71000000-0000-4000-8000-000000000002' and activity_type::text <> 'comment'$$);
select pg_temp.as_session('probe-editor');
select pg_temp.record_count('editor', 'sees the probe rows (control)',
  $$select (select count(*) from public.batches where id = (select batch_id from _t)) + (select count(*) from public.contact_logs where id = (select log_id from _t))
         + (select count(*) from public.batch_activity where id = (select activity_id from _t)) + (select count(*) from public.contact_suppressions where id = (select suppression_id from _t))$$, true);
select pg_temp.record_unchanged('editor', 'delete batch (manager only)',
  $$delete from public.batches where id = (select batch_id from _t)$$,
  $$select count(*) = 1 from public.batches where id = (select batch_id from _t)$$);
select pg_temp.record_unchanged('editor', 'delete member (manager only)',
  $$delete from public.batch_carriers where batch_id = (select batch_id from _t) and dot_number = (select dot_b from _t)$$,
  $$select count(*) = 1 from public.batch_carriers where batch_id = (select batch_id from _t) and dot_number = (select dot_b from _t)$$);
select pg_temp.record_unchanged('editor', 'delete contact log (manager only)',
  $$delete from public.contact_logs where id = (select log_id from _t)$$,
  $$select count(*) = 1 from public.contact_logs where id = (select log_id from _t)$$);
select pg_temp.record_unchanged('editor', 'delete activity (manager only)',
  $$delete from public.batch_activity where id = (select activity_id from _t)$$,
  $$select count(*) = 1 from public.batch_activity where id = (select activity_id from _t)$$);
select pg_temp.record_unchanged('editor', 'delete suppression (manager only)',
  $$delete from public.contact_suppressions where id = (select suppression_id from _t)$$,
  $$select count(*) = 1 from public.contact_suppressions where id = (select suppression_id from _t)$$);
select pg_temp.record_unchanged('editor', 'curate cargo values (manager only)',
  $$update public.cargo_other_values set match_group = 'AUTHZ_PROBE' where value = (select cargo_value from _t)$$,
  $$select match_group is distinct from 'AUTHZ_PROBE' from public.cargo_other_values where value = (select cargo_value from _t)$$);
select pg_temp.record_denied('editor', 'team_update (manager only)', $$select public.team_update('71000000-0000-4000-8000-000000000004', 'X', null, null)$$);
select pg_temp.record_denied('editor', 'team_sign_everyone_out (manager only)', $$select public.team_sign_everyone_out()$$);
select pg_temp.record_denied('editor', 'update profiles directly', $$update public.profiles set role = 'manager' where id = '71000000-0000-4000-8000-000000000002'$$);
select pg_temp.record_denied('editor', 'change batches.created_by', $$update public.batches set created_by = '71000000-0000-4000-8000-000000000001' where id = (select batch_id from _t)$$);
select pg_temp.record_denied('editor', 'set carriers.dnc_set_by directly', $$update public.carriers set dnc_set_by = '71000000-0000-4000-8000-000000000001' where dot_number = (select dot_a from _t)$$);
select pg_temp.record_denied('editor', 'set do_not_contact directly', $$update public.carriers set do_not_contact = true where dot_number = (select dot_a from _t)$$);
select pg_temp.record_denied('editor', 'insert member with status_changed_by',
  $$insert into public.batch_carriers(batch_id, dot_number, status_changed_by) values((select batch_id from _t), (select dot_number from public.carriers where dot_number not in ((select dot_a from _t), (select dot_b from _t)) order by dot_number limit 1), '71000000-0000-4000-8000-000000000001')$$);
select pg_temp.record_denied('editor', 'insert member with promoted_by',
  $$insert into public.batch_carriers(batch_id, dot_number, promoted_by) values((select batch_id from _t), (select dot_number from public.carriers where dot_number not in ((select dot_a from _t), (select dot_b from _t)) order by dot_number limit 1), '71000000-0000-4000-8000-000000000001')$$);
select pg_temp.record_denied('editor', 'insert suppression as someone else',
  $$insert into public.contact_suppressions(dot_number, channel, created_by) values((select dot_a from _t), 'email', '71000000-0000-4000-8000-000000000001')$$);
select pg_temp.record_denied('editor', 'insert contact log as someone else',
  $$insert into public.contact_logs(dot_number,user_id,channel,disposition) values((select dot_a from _t),'71000000-0000-4000-8000-000000000004','call','connected')$$);
select pg_temp.record_denied('editor', 'update sync-owned legal name', $$update public.carriers set legal_name = 'AUTHZ PROBE' where dot_number = (select dot_a from _t)$$);

-- ---- Recovery sessions: no staff role anywhere; only the matrix functions, intersected with the ordinary role.
select pg_temp.as_session('probe-editor-recovery');
select pg_temp.record_count('editor-recovery', 'select carriers', $$select count(*) from public.carriers$$, false);
select pg_temp.record_count('editor-recovery', 'select own profile', $$select count(*) from public.profiles$$, false);
select pg_temp.record_denied('editor-recovery', 'execute create_batch', $$select public.create_batch('AUTHZ PROBE',null,null,null,'{}'::jsonb)$$);
select pg_temp.record_denied('editor-recovery', 'insert contact log', $$insert into public.contact_logs(dot_number,user_id,channel,disposition) values((select dot_a from _t),'71000000-0000-4000-8000-000000000002','call','connected')$$);
-- generate_contact_sheet is an invoker read under RLS: for a recovery session the denial is 0 rows
-- for a target that the editor's link session does see (control below).
select pg_temp.record_count('editor-recovery', 'execute generate_contact_sheet (0 rows)', $$select count(*) from public.generate_contact_sheet((select batch_id from _t), null)$$, false);
select pg_temp.as_session('probe-editor');
select pg_temp.record_count('editor', 'generate_contact_sheet sees the probe batch (control)', $$select count(*) from public.generate_contact_sheet((select batch_id from _t), null)$$, true);
select pg_temp.as_session('probe-editor-recovery');
select pg_temp.record_allowed('editor-recovery', 'recovery_set_status',
  $$select public.recovery_set_status((select batch_id from _t), (select dot_a from _t), 'attempted')$$,
  $$select status = 'attempted' and status_changed_by = '71000000-0000-4000-8000-000000000002' from public.batch_carriers where batch_id = (select batch_id from _t) and dot_number = (select dot_a from _t)$$);
select pg_temp.as_session('probe-viewer-recovery');
select pg_temp.record_denied('viewer-recovery', 'recovery_set_status (viewer has no writes)',
  $$select public.recovery_set_status((select batch_id from _t), (select dot_a from _t), 'attempted')$$);
select pg_temp.as_session('probe-viewer');
select pg_temp.record_denied('viewer-link', 'recovery_batches with a link session', $$select * from public.recovery_batches()$$);

-- ---- Manager: administration allowed (effects checked, then rolled back).
select pg_temp.as_session('probe-manager');
select pg_temp.record_allowed('manager', 'curate cargo values',
  $$update public.cargo_other_values set match_group = 'AUTHZ_PROBE' where value = (select cargo_value from _t)$$,
  $$select match_group = 'AUTHZ_PROBE' from public.cargo_other_values where value = (select cargo_value from _t)$$);
select pg_temp.as_session('probe-manager');
select pg_temp.record_allowed('manager', 'team_update viewer name',
  $$select public.team_update('71000000-0000-4000-8000-000000000004', 'AUTHZ PROBE NAME', null, null)$$,
  $$select full_name = 'AUTHZ PROBE NAME' from public.profiles where id = '71000000-0000-4000-8000-000000000004'$$);
select pg_temp.as_session('probe-manager');
select pg_temp.record_denied('manager', 'team_update own role', $$select public.team_update('71000000-0000-4000-8000-000000000001', null, 'edit', null)$$);
-- Emergency sign-out: every STAFF session (the manager's own, the editor's link and recovery
-- sessions) revoked; non-staff (pending, guest) sessions untouched (Gate 2 review N3).
select pg_temp.as_session('probe-manager');
select pg_temp.record_allowed('manager', 'sign everyone out: staff sessions incl. own revoked, non-staff kept',
  $$select public.team_sign_everyone_out()$$,
  $$select (select bool_and(revoked_at is not null) from internal.app_sessions
            where token_hash in ('probe-manager', 'probe-editor', 'probe-viewer', 'probe-editor-recovery', 'probe-viewer-recovery'))
       and (select bool_and(revoked_at is null) from internal.app_sessions where token_hash in ('probe-pending', 'probe-guest'))$$);

reset role;
select jsonb_build_object(
  'failures', (select count(*) from _results where not pass),
  'failed', coalesce((select jsonb_agg(jsonb_build_object('actor',actor,'test',test_name,'expected',expected,'observed',observed) order by actor,test_name) from _results where not pass),'[]'::jsonb),
  'passed', (select count(*) from _results where pass),
  'total', (select count(*) from _results)
) as role_matrix;
rollback;
