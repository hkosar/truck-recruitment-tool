-- Session A (start within 2 s of B, as recruiter_app): its session is valid at the start, then
-- waits on B's batch lock past expiry. recheck_session() must refuse after the wait.
-- The test FAILS on unexpected success and on any other error; it never ignores the outcome.
\set ON_ERROR_STOP 1
begin;
select set_config('app.session_hash', 'a3-session-hash', true);
do $probe$
begin
  begin
    perform public.bulk_set_status('a3000000-0000-4000-8000-0000000000b1', array[3000001]::bigint[], 'contacted');
  exception when insufficient_privilege then
    if sqlerrm <> 'session expired while waiting' then
      raise exception 'FAIL: refused for the wrong reason: %', sqlerrm;
    end if;
    raise notice 'PASS: refused with SQLSTATE 42501 "session expired while waiting"';
    return;
  end;
  raise exception 'FAIL: bulk_set_status succeeded although the session expired during the lock wait';
end
$probe$;
rollback;

do $assert$
begin
  if (select status from public.batch_carriers
      where batch_id = 'a3000000-0000-4000-8000-0000000000b1' and dot_number = 3000001) <> 'new' then
    raise exception 'FAIL: status changed although the session expired during the lock wait';
  end if;
  raise notice 'PASS: status unchanged';
end
$assert$;
