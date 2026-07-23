begin;

create temporary table _results (
  actor text not null,
  test_name text not null,
  expected text not null,
  observed text not null,
  pass boolean not null
) on commit drop;
grant select, insert, update, delete on _results to anon, authenticated;

create or replace function pg_temp.set_actor(p_id uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_id, 'role', 'authenticated')::text, true);
end $$;

create or replace function pg_temp.record_denied(p_actor text, p_test text, p_sql text) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
    insert into _results values (p_actor, p_test, 'error', 'allowed', false);
  exception when others then
    insert into _results values (p_actor, p_test, 'error', sqlstate || ':' || sqlerrm, true);
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
    insert into _results values (p_actor, p_test, '0 rows or error', sqlstate || ':' || sqlerrm, true);
  end;
end $$;

-- Supabase grants public tables broadly and relies on RLS. Anon must still see
-- no carrier rows (a permission error caused by the private helper is also a
-- valid deny), and must lack EXECUTE on application RPCs.
set local role anon;
select pg_temp.record_no_rows_or_error('anon','select carriers',
  $$select * from public.carriers limit 1$$);
select pg_temp.record_denied('anon','execute create_batch',
  $$select public.create_batch('AUTHZ PROBE',null,null,null,'{}'::jsonb)$$);

-- pending guest: own profile only; no carrier/batch data or writes.
set local role authenticated;
select pg_temp.set_actor('71000000-0000-4000-8000-000000000005');
insert into _results
select 'pending','select profiles','1 own row',count(*)::text,count(*)=1 and bool_and(id='71000000-0000-4000-8000-000000000005') from public.profiles;
insert into _results
select 'pending','select carriers','0 rows',count(*)::text,count(*)=0 from public.carriers;
select pg_temp.record_denied('pending','execute create_batch',
  $$select public.create_batch('AUTHZ PROBE',null,null,null,'{}'::jsonb)$$);

-- approved guest: still not staff.
select pg_temp.set_actor('71000000-0000-4000-8000-000000000006');
insert into _results
select 'guest','select profiles','1 own row',count(*)::text,count(*)=1 and bool_and(id='71000000-0000-4000-8000-000000000006') from public.profiles;
insert into _results
select 'guest','select batches','0 rows',count(*)::text,count(*)=0 from public.batches;

-- disabled user: own profile only, no app rows/writes.
select pg_temp.set_actor('71000000-0000-4000-8000-000000000007');
insert into _results
select 'disabled','select profiles','1 own row',count(*)::text,count(*)=1 and bool_and(id='71000000-0000-4000-8000-000000000007') from public.profiles;
insert into _results
select 'disabled','select carriers','0 rows',count(*)::text,count(*)=0 from public.carriers;
select pg_temp.record_denied('disabled','execute set_do_not_contact',
  $$select public.set_do_not_contact(1400001,true,'AUTHZ PROBE')$$);

-- viewer: reads work, every CRM mutation is denied.
select pg_temp.set_actor('71000000-0000-4000-8000-000000000004');
insert into _results
select 'viewer','select carriers','800 rows',count(*)::text,count(*)=800 from public.carriers;
select pg_temp.record_no_rows_or_error('viewer','update batch status',
  $$update public.batch_carriers set status='contacted' where batch_id=(select id from public.batches limit 1) and dot_number=(select dot_number from public.batch_carriers limit 1)$$);
select pg_temp.record_denied('viewer','insert contact log',
  $$insert into public.contact_logs(dot_number,user_id,channel,disposition) values(1400001,'71000000-0000-4000-8000-000000000004','call','connected')$$);
select pg_temp.record_denied('viewer','insert activity comment',
  $$insert into public.batch_activity(batch_id,actor_id,activity_type,comment) values((select id from public.batches limit 1),'71000000-0000-4000-8000-000000000004','comment','AUTHZ PROBE')$$);
select pg_temp.record_no_rows_or_error('viewer','update DNC',
  $$update public.carriers set do_not_contact=true where dot_number=1400001$$);
select pg_temp.record_denied('viewer','execute create_batch',
  $$select public.create_batch('AUTHZ PROBE',null,null,null,'{}'::jsonb)$$);

-- editor: intended workflow writes allowed; protected/admin/sync writes denied.
select pg_temp.set_actor('71000000-0000-4000-8000-000000000002');
select pg_temp.record_no_rows_or_error('editor','delete batch',
  $$delete from public.batches where id=(select id from public.batches limit 1)$$);
select pg_temp.record_no_rows_or_error('editor','delete batch member',
  $$delete from public.batch_carriers where batch_id=(select id from public.batches limit 1) and dot_number=(select dot_number from public.batch_carriers limit 1)$$);
select pg_temp.record_denied('editor','escalate profile role',
  $$update public.profiles set role='manager' where id='71000000-0000-4000-8000-000000000002'$$);
select pg_temp.record_denied('editor','update sync-owned legal name',
  $$update public.carriers set legal_name='AUTHZ PROBE' where dot_number=1400001$$);
select pg_temp.record_denied('editor','insert log as another user',
  $$insert into public.contact_logs(dot_number,user_id,channel,disposition) values(1400001,'71000000-0000-4000-8000-000000000004','call','connected')$$);
select pg_temp.record_denied('editor','insert non-comment activity',
  $$insert into public.batch_activity(batch_id,actor_id,activity_type,payload) values((select id from public.batches limit 1),'71000000-0000-4000-8000-000000000002','refresh','{}')$$);

savepoint editor_allowed;
do $$
declare v_before int; v_after int;
begin
  select count(*) into v_before from public.contact_logs;
  insert into public.contact_logs(dot_number,user_id,channel,disposition,notes)
  values(1400001,'71000000-0000-4000-8000-000000000002','call','connected','AUTHZ PROBE');
  select count(*) into v_after from public.contact_logs;
  insert into _results values ('editor','insert own contact log','allowed',(v_after-v_before)::text,v_after=v_before+1);
end $$;
rollback to editor_allowed;

savepoint editor_dnc;
do $$
declare v_before boolean; v_during boolean;
begin
  select do_not_contact into v_before from public.carriers where dot_number=1400001;
  perform public.set_do_not_contact(1400001,not v_before,'AUTHZ PROBE');
  select do_not_contact into v_during from public.carriers where dot_number=1400001;
  insert into _results values ('editor','execute set_do_not_contact','allowed',v_during::text,v_during=not v_before);
end $$;
rollback to editor_dnc;

-- manager: intended admin curation allowed; column boundaries still apply.
select pg_temp.set_actor('71000000-0000-4000-8000-000000000001');
savepoint manager_curate;
do $$
declare v_value text; v_before text; v_during text;
begin
  select value,match_group into v_value,v_before from public.cargo_other_values order by value limit 1;
  update public.cargo_other_values set match_group='AUTHZ_PROBE' where value=v_value;
  select match_group into v_during from public.cargo_other_values where value=v_value;
  insert into _results values ('manager','curate cargo match_group','allowed',coalesce(v_during,'NULL'),v_during='AUTHZ_PROBE');
end $$;
rollback to manager_curate;
select pg_temp.record_denied('manager','update sync-owned legal name',
  $$update public.carriers set legal_name='AUTHZ PROBE' where dot_number=1400001$$);

reset role;
select jsonb_build_object(
  'failures', (select count(*) from _results where not pass),
  'failed', coalesce((select jsonb_agg(jsonb_build_object('actor',actor,'test',test_name,'expected',expected,'observed',observed) order by actor,test_name) from _results where not pass),'[]'::jsonb),
  'passed', (select count(*) from _results where pass),
  'total', (select count(*) from _results)
) as role_matrix;
rollback;
