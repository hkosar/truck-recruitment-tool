-- Session A (start within 2 s of B, as recruiter_app): its session is valid at the start, then
-- waits on B's batch lock past expiry. recheck_session() must refuse after the wait.
\set ON_ERROR_STOP 0
begin;
select set_config('app.session_hash', 'a3-session-hash', true);
select public.bulk_set_status('a3000000-0000-4000-8000-0000000000b1', array[3000001]::bigint[], 'contacted');
-- expected above: ERROR "session expired while waiting" (SQLSTATE 42501)
rollback;
\set ON_ERROR_STOP 1
do $assert$
begin
  if (select status from public.batch_carriers
      where batch_id = 'a3000000-0000-4000-8000-0000000000b1' and dot_number = 3000001) <> 'new' then
    raise exception 'FAIL: status changed although the session expired during the lock wait';
  end if;
  raise notice 'PASS: expired-during-wait write refused; status unchanged';
end
$assert$;
