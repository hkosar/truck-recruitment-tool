-- A3 ONLY: assertions after the successful cleanup run (see cleanup_m1b_setup.sql and README.md).
\set ON_ERROR_STOP 1
do $$
begin
  if exists (select 1 from public.profiles where id::text like '71000000-0000-4000-8000-00000000000%') then
    raise exception 'FAIL: fixture profiles remain (orphans)';
  end if;
  if exists (select 1 from auth.users where raw_user_meta_data->>'test_run_id' = 'stg-db-20260723-0042') then
    raise exception 'FAIL: fixture Auth users remain';
  end if;
  if exists (select 1 from internal.staff_mobile_unverified where user_id::text like '71000000-0000-4000-8000-00000000000%') then
    raise exception 'FAIL: a fixture mobile row remains';
  end if;
  if not exists (select 1 from public.profiles where id = '7e000000-0000-4000-8000-0000000000b1' and approved_by is null) then
    raise exception 'FAIL: the real person must be kept (approval reference to the fixture cleared)';
  end if;
  if exists (select 1 from internal.app_sessions where token_hash = 'a3-cleanup-m1b-session') then
    raise exception 'FAIL: the fixture session should have been removed by the ledger cleanup';
  end if;
  raise notice 'PASS: fixture profiles (incl. the orphan), Auth users, own mobile and ledger rows removed; the real person kept';
end
$$;
