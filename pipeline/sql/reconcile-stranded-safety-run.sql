-- ============================================================================================
-- Reconcile ONE stranded sync-safety run (status still 'running' after the process died or was
-- cancelled). Audited and non-destructive: the row is marked 'failed' with the reason, the actor
-- and the time; no row is ever deleted. Run in the Supabase SQL Editor as the project owner.
--
-- Why this exists: runs.ts recovers stale 'running' rows only when the SAME step starts again,
-- and with PIPELINE_NIGHTLY_SAFETY=off it never does, so a stranded row would stay forever.
--
-- BEFORE running (all three, in order):
--   1. FIRST, in Render -> service `pipeline`: confirm no run is in progress (the last run in
--      Events / Logs has ended). The database checks below are a second line of defence only.
--   2. Find the row:  select id, job, started_at from public.pipeline_runs
--                     where step = 'sync-safety' and status = 'running';
--   3. Edit the three EDIT lines below (run id, your name, the reason). Only if SUPABASE_DB_URL
--      sets its own application_name: put that value in v_app. Only if SUPABASE_DB_URL connects as
--      a role other than postgres: put that role in v_db_user.
-- The block itself refuses (and changes nothing) unless ALL of these hold:
--   - that id is a sync-safety row that is still 'running' and started more than 15 minutes ago;
--   - no other session's application_name contains v_app. A substring match covers the exact
--     name, the "Supavisor - <name>" form the session pooler shows, and any other prefix;
--   - no other session of the pipeline's database role (v_db_user) is inside a transaction. The
--     pipeline does all of its staging work inside one transaction, so a downloading run is
--     caught here even though it holds no lock on carrier_safety yet;
--   - no other session holds a temporary or not-yet-committed new table (the pipeline stages into
--     temp tables created inside its open transaction, which other sessions cannot see in pg_class);
--   - no other session holds a lock on public.carrier_safety.
-- A refusal can be a false alarm (for example another SQL Editor tab mid-transaction); wait and
-- run it again. Never work around a refusal.
-- ============================================================================================
do $reconcile$
declare
  v_run_id  bigint := 0;          -- EDIT: the stranded row's id
  v_actor   text   := '';         -- EDIT: who is doing this (name)
  v_reason  text   := '';         -- EDIT: why (e.g. 'run cancelled in Render during rollback')
  v_app     text   := 'tnbs-pipeline';
  v_db_user text   := 'postgres';
  v_row     public.pipeline_runs%rowtype;
  v_sessions int;
  v_in_xact  int;
  v_temp     int;
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

  if btrim(v_app) = '' or btrim(v_db_user) = '' then
    raise exception 'REFUSED: v_app and v_db_user must not be empty';
  end if;

  select count(*) into v_sessions
  from pg_stat_activity
  where pid <> pg_backend_pid()
    and strpos(coalesce(application_name, ''), v_app) > 0;
  if v_sessions > 0 then
    raise exception 'REFUSED: % database session(s) whose application_name contains % are connected; a pipeline process may still be running',
      v_sessions, v_app;
  end if;

  select count(*) into v_in_xact
  from pg_stat_activity
  where pid <> pg_backend_pid()
    and usename = v_db_user
    and xact_start is not null;
  if v_in_xact > 0 then
    raise exception 'REFUSED: % other session(s) of role % are inside a transaction; a pipeline run may be staging data',
      v_in_xact, v_db_user;
  end if;

  -- Tables a session created inside its still-open transaction (the pipeline's temp staging
  -- tables) are NOT visible in pg_class to other sessions yet, so a plain join would miss them.
  -- Count locks on relations in this database that are either temporary or not visible at all.
  select count(distinct l.pid) into v_temp
  from pg_locks l
  left join pg_class c on c.oid = l.relation
  where l.locktype = 'relation'
    and l.database = (select oid from pg_database where datname = current_database())
    and l.pid <> pg_backend_pid()
    and (c.oid is null or c.relpersistence = 't');
  if v_temp > 0 then
    raise exception 'REFUSED: % other session(s) hold temporary or not-yet-committed new tables; a pipeline run may be staging data', v_temp;
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
               'checked_sessions_app', v_app,
               'checked_db_user', v_db_user))
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
