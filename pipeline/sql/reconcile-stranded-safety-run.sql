-- ============================================================================================
-- Reconcile ONE stranded sync-safety run (status still 'running' after the process died or was
-- cancelled). Audited and non-destructive: the row is marked 'failed' with the reason, the actor
-- and the time; no row is ever deleted. Run in the Supabase SQL Editor as the project owner.
--
-- Why this exists: runs.ts recovers stale 'running' rows only when the SAME step starts again,
-- and with PIPELINE_NIGHTLY_SAFETY=off it never does, so a stranded row would stay forever.
--
-- BEFORE running (all three, in order):
--   1. Render -> service `pipeline`: no run is in progress (Events / Logs show the last run ended).
--   2. Find the row:  select id, job, started_at from public.pipeline_runs
--                     where step = 'sync-safety' and status = 'running';
--   3. Edit the three EDIT lines below (run id, your name, the reason).
-- The block itself refuses (and changes nothing) unless:
--   - that id is a sync-safety row that is still 'running' and started more than 15 minutes ago;
--   - no database session labelled with the pipeline's application_name is connected;
--   - no other session holds a lock on public.carrier_safety.
-- If SUPABASE_DB_URL sets its own application_name, use that value for v_app.
-- ============================================================================================
do $reconcile$
declare
  v_run_id bigint := 0;          -- EDIT: the stranded row's id
  v_actor  text   := '';         -- EDIT: who is doing this (name)
  v_reason text   := '';         -- EDIT: why (e.g. 'run cancelled in Render during rollback')
  v_app    text   := 'tnbs-pipeline';
  v_row    public.pipeline_runs%rowtype;
  v_sessions int;
  v_lockers  int;
  v_updated  int;
begin
  if v_run_id <= 0 or btrim(v_actor) = '' or btrim(v_reason) = '' then
    raise exception 'REFUSED: set v_run_id, v_actor and v_reason first';
  end if;

  select * into v_row from public.pipeline_runs where id = v_run_id for update;
  if not found then
    raise exception 'REFUSED: pipeline_runs id % does not exist', v_run_id;
  end if;
  if v_row.step <> 'sync-safety' or v_row.status <> 'running' then
    raise exception 'REFUSED: id % is step %, status % (only a running sync-safety row qualifies)',
      v_run_id, v_row.step, v_row.status;
  end if;
  if v_row.started_at > now() - interval '15 minutes' then
    raise exception 'REFUSED: id % started at % (less than 15 minutes ago); it may still be active',
      v_run_id, v_row.started_at;
  end if;

  select count(*) into v_sessions
  from pg_stat_activity
  where application_name = v_app and pid <> pg_backend_pid();
  if v_sessions > 0 then
    raise exception 'REFUSED: % database session(s) labelled % are connected; a pipeline process is still running',
      v_sessions, v_app;
  end if;

  select count(distinct l.pid) into v_lockers
  from pg_locks l
  where l.relation = 'public.carrier_safety'::regclass and l.pid <> pg_backend_pid();
  if v_lockers > 0 then
    raise exception 'REFUSED: % other session(s) hold a lock on public.carrier_safety', v_lockers;
  end if;

  update public.pipeline_runs
  set status = 'failed',
      finished_at = now(),
      error = format('Stranded run reconciled manually (abandoned): %s. Actor: %s. At: %s.',
                     v_reason, v_actor, to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
      meta = meta || jsonb_build_object('reconciled', jsonb_build_object(
               'previous_status', 'running',
               'outcome', 'abandoned',
               'reason', v_reason,
               'actor', v_actor,
               'at', now(),
               'checked_sessions_app', v_app))
  where id = v_run_id and status = 'running';
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    raise exception 'REFUSED: expected to update exactly 1 row, updated %', v_updated;
  end if;
  raise notice 'Reconciled pipeline_runs id % as failed (abandoned) by %', v_run_id, v_actor;
end
$reconcile$;

-- AFTER: confirm (expected: status failed, meta.reconciled filled; no rows deleted)
-- select id, status, finished_at, error, meta->'reconciled' from public.pipeline_runs where step = 'sync-safety' order by id desc limit 5;
