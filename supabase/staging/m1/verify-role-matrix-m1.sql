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

create or replace function pg_temp.record_denied(p_actor text, p_test text, p_sql text) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
    insert into _results values (p_actor, p_test, 'error', 'allowed', false);
  exception when others then
    insert into _results values (p_actor, p_test, 'error', sqlstate, true);
  end;
end $$;

create or replace function pg_temp.record_no_rows_or_error(p_actor text, p_test text, p_sql text) returns void
language plpgsql as $$
declare
  v_rows bigint;
begin
  begin
    execute p_sql;
    get diagnostics v_rows = row_count;
    insert into _results values (p_actor, p_test, '0 rows or error', v_rows::text, v_rows = 0);
  exception when others then
    insert into _results values (p_actor, p_test, '0 rows or error', sqlstate, true);
  end;
end $$;

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
    insert into _results values (p_actor, p_test, case when p_expect_positive then '> 0 rows' else '0 rows' end, sqlstate, not p_expect_positive);
  end;
end $$;

create or replace function pg_temp.record_allowed(p_actor text, p_test text, p_sql text) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
    insert into _results values (p_actor, p_test, 'allowed', 'allowed', true);
  exception when others then
    insert into _results values (p_actor, p_test, 'allowed', sqlstate || ':' || sqlerrm, false);
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
select pg_temp.record_denied('disabled', 'execute set_do_not_contact', $$select public.set_do_not_contact(1400001,true,'AUTHZ PROBE')$$);
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
select pg_temp.record_no_rows_or_error('viewer', 'update member status',
  $$update public.batch_carriers set status = 'contacted' where (batch_id, dot_number) in (select batch_id, dot_number from public.batch_carriers limit 1)$$);
select pg_temp.record_denied('viewer', 'insert own contact log',
  $$insert into public.contact_logs(dot_number,user_id,channel,disposition) values(1400001,'71000000-0000-4000-8000-000000000004','call','connected')$$);
select pg_temp.record_denied('viewer', 'insert comment',
  $$insert into public.batch_activity(batch_id,actor_id,activity_type,comment) values((select id from public.batches limit 1),'71000000-0000-4000-8000-000000000004','comment','AUTHZ PROBE')$$);
select pg_temp.record_denied('viewer', 'insert batch directly',
  $$insert into public.batches(name,created_by,search_definition) values('AUTHZ PROBE','71000000-0000-4000-8000-000000000004','{}')$$);
select pg_temp.record_denied('viewer', 'execute set_do_not_contact', $$select public.set_do_not_contact(1400001,true,'AUTHZ PROBE')$$);
select pg_temp.record_denied('viewer', 'execute create_batch', $$select public.create_batch('AUTHZ PROBE',null,null,null,'{}'::jsonb)$$);
select pg_temp.record_denied('viewer', 'execute team_list', $$select * from public.team_list()$$);

-- ---- Editor: workflow writes allowed; manager-only and attribution writes refused.
select pg_temp.as_session('probe-editor');
savepoint e1;
select pg_temp.record_allowed('editor', 'insert own contact log',
  $$insert into public.contact_logs(dot_number,user_id,channel,disposition,notes) values((select c.dot_number from public.carriers c where not c.do_not_contact and not exists (select 1 from public.contact_suppressions s where s.dot_number = c.dot_number and s.channel::text = 'all' and s.value is null and (s.expires_at is null or s.expires_at > now())) order by c.dot_number limit 1),'71000000-0000-4000-8000-000000000002','call','connected','AUTHZ PROBE')$$);
rollback to e1;
select pg_temp.as_session('probe-editor');
savepoint e2;
select pg_temp.record_allowed('editor', 'execute create_batch', $$select * from public.create_batch('AUTHZ PROBE CREATE',null,null,null,'{}'::jsonb)$$);
rollback to e2;
select pg_temp.as_session('probe-editor');
savepoint e3;
select pg_temp.record_allowed('editor', 'execute bulk_set_status',
  $$select public.bulk_set_status((select batch_id from public.batch_carriers order by batch_id, dot_number limit 1), array[(select dot_number from public.batch_carriers order by batch_id, dot_number limit 1)], 'contacted')$$);
rollback to e3;
select pg_temp.as_session('probe-editor');
savepoint e4;
select pg_temp.record_allowed('editor', 'execute log_export', $$select public.log_export((select id from public.batches order by created_at limit 1),'csv',1)$$);
rollback to e4;
select pg_temp.as_session('probe-editor');
select pg_temp.record_no_rows_or_error('editor', 'delete batch (manager only)', $$delete from public.batches where id = (select id from public.batches limit 1)$$);
select pg_temp.record_no_rows_or_error('editor', 'delete member (manager only)',
  $$delete from public.batch_carriers where (batch_id, dot_number) in (select batch_id, dot_number from public.batch_carriers limit 1)$$);
select pg_temp.record_no_rows_or_error('editor', 'delete contact log (manager only)', $$delete from public.contact_logs where id in (select id from public.contact_logs limit 1)$$);
select pg_temp.record_no_rows_or_error('editor', 'delete activity (manager only)', $$delete from public.batch_activity where id in (select id from public.batch_activity limit 1)$$);
select pg_temp.record_no_rows_or_error('editor', 'delete suppression (manager only)', $$delete from public.contact_suppressions where id in (select id from public.contact_suppressions limit 1)$$);
select pg_temp.record_no_rows_or_error('editor', 'curate cargo values (manager only)', $$update public.cargo_other_values set match_group = 'AUTHZ_PROBE' where value = (select value from public.cargo_other_values limit 1)$$);
select pg_temp.record_denied('editor', 'team_update (manager only)', $$select public.team_update('71000000-0000-4000-8000-000000000004', 'X', null, null)$$);
select pg_temp.record_denied('editor', 'team_sign_everyone_out (manager only)', $$select public.team_sign_everyone_out()$$);
select pg_temp.record_denied('editor', 'update profiles directly', $$update public.profiles set role = 'manager' where id = '71000000-0000-4000-8000-000000000002'$$);
select pg_temp.record_denied('editor', 'change batches.created_by', $$update public.batches set created_by = '71000000-0000-4000-8000-000000000001' where id = (select id from public.batches limit 1)$$);
select pg_temp.record_denied('editor', 'set carriers.dnc_set_by directly', $$update public.carriers set dnc_set_by = '71000000-0000-4000-8000-000000000001' where dot_number = 1400001$$);
select pg_temp.record_denied('editor', 'set do_not_contact directly', $$update public.carriers set do_not_contact = true where dot_number = 1400001$$);
select pg_temp.record_denied('editor', 'insert member with status_changed_by',
  $$insert into public.batch_carriers(batch_id, dot_number, status_changed_by) values((select id from public.batches limit 1), 1400002, '71000000-0000-4000-8000-000000000001')$$);
select pg_temp.record_denied('editor', 'insert member with promoted_by',
  $$insert into public.batch_carriers(batch_id, dot_number, promoted_by) values((select id from public.batches limit 1), 1400002, '71000000-0000-4000-8000-000000000001')$$);
select pg_temp.record_denied('editor', 'insert suppression as someone else',
  $$insert into public.contact_suppressions(dot_number, channel, created_by) values(1400001, 'all', '71000000-0000-4000-8000-000000000001')$$);
select pg_temp.record_denied('editor', 'insert contact log as someone else',
  $$insert into public.contact_logs(dot_number,user_id,channel,disposition) values(1400001,'71000000-0000-4000-8000-000000000004','call','connected')$$);
select pg_temp.record_denied('editor', 'update sync-owned legal name', $$update public.carriers set legal_name = 'AUTHZ PROBE' where dot_number = 1400001$$);

-- ---- Recovery sessions: no staff role anywhere; only the matrix functions, intersected with the ordinary role.
select pg_temp.as_session('probe-editor-recovery');
select pg_temp.record_count('editor-recovery', 'select carriers', $$select count(*) from public.carriers$$, false);
select pg_temp.record_count('editor-recovery', 'select own profile', $$select count(*) from public.profiles$$, false);
select pg_temp.record_denied('editor-recovery', 'execute create_batch', $$select public.create_batch('AUTHZ PROBE',null,null,null,'{}'::jsonb)$$);
select pg_temp.record_denied('editor-recovery', 'insert contact log', $$insert into public.contact_logs(dot_number,user_id,channel,disposition) values(1400001,'71000000-0000-4000-8000-000000000002','call','connected')$$);
select pg_temp.record_denied('editor-recovery', 'execute generate_contact_sheet', $$select * from public.generate_contact_sheet((select id from public.batches limit 1), null)$$);
select pg_temp.as_session('probe-editor-recovery');
savepoint r1;
select pg_temp.record_allowed('editor-recovery', 'recovery_set_status',
  $$select public.recovery_set_status((select bc.batch_id from public.batch_carriers bc join public.carriers c on c.dot_number = bc.dot_number where not c.do_not_contact order by bc.batch_id, bc.dot_number limit 1), (select bc.dot_number from public.batch_carriers bc join public.carriers c on c.dot_number = bc.dot_number where not c.do_not_contact order by bc.batch_id, bc.dot_number limit 1), 'attempted')$$);
rollback to r1;
select pg_temp.as_session('probe-viewer-recovery');
select pg_temp.record_denied('viewer-recovery', 'recovery_set_status (viewer has no writes)',
  $$select public.recovery_set_status((select batch_id from public.batch_carriers limit 1), (select dot_number from public.batch_carriers limit 1), 'attempted')$$);
select pg_temp.as_session('probe-viewer');
select pg_temp.record_denied('viewer-link', 'recovery_batches with a link session', $$select * from public.recovery_batches()$$);

-- ---- Manager: administration allowed (all rolled back).
select pg_temp.as_session('probe-manager');
savepoint m1;
select pg_temp.record_allowed('manager', 'curate cargo values', $$update public.cargo_other_values set match_group = 'AUTHZ_PROBE' where value = (select value from public.cargo_other_values order by value limit 1)$$);
rollback to m1;
select pg_temp.as_session('probe-manager');
savepoint m2;
select pg_temp.record_allowed('manager', 'team_update viewer name', $$select public.team_update('71000000-0000-4000-8000-000000000004', 'AUTHZ PROBE NAME', null, null)$$);
rollback to m2;
select pg_temp.as_session('probe-manager');
select pg_temp.record_denied('manager', 'team_update own role', $$select public.team_update('71000000-0000-4000-8000-000000000001', null, 'edit', null)$$);
select pg_temp.as_session('probe-manager');
savepoint m3;
do $eso$
declare
  v_live_before int;
  v_live_after int;
begin
  select count(*) into v_live_before from internal.current_session();   -- 1: the manager's own
  perform public.team_sign_everyone_out();
  insert into _results values ('manager', 'sign everyone out revokes own session too', '0 rows',
    (select count(*) from internal.current_session())::text, (select count(*) from internal.current_session()) = 0);
end
$eso$;
rollback to m3;

reset role;
select jsonb_build_object(
  'failures', (select count(*) from _results where not pass),
  'failed', coalesce((select jsonb_agg(jsonb_build_object('actor',actor,'test',test_name,'expected',expected,'observed',observed) order by actor,test_name) from _results where not pass),'[]'::jsonb),
  'passed', (select count(*) from _results where pass),
  'total', (select count(*) from _results)
) as role_matrix;
rollback;
