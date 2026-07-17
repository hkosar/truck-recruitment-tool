-- ============================================================================
-- 20260720000800_activity.sql -- F11/G7: batch_activity + auto-log triggers
-- Spec: docs/build-plan/01-architecture.md Part A §2.8, §2.9 (activity index).
-- ============================================================================

create table public.batch_activity (
  id            bigint generated always as identity primary key,  -- monotonic feed order
  batch_id      uuid not null references public.batches(id) on delete cascade,
  actor_id      uuid references public.profiles(id),              -- null = system
  activity_type activity_type not null,
  payload       jsonb not null default '{}'::jsonb,
  comment       text,                                             -- only for activity_type='comment'
  created_at    timestamptz not null default now(),
  constraint comment_shape check ((activity_type = 'comment') = (comment is not null))
);

-- Auto-logging (D7): trigger functions are SECURITY DEFINER (they must insert
-- regardless of the caller's activity-INSERT policy), actor from auth.uid():

create function internal.log_bc_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if current_setting('app.suppress_row_activity', true) = 'on' then return new; end if;  -- bulk ops log once
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    new.status_changed_by := auth.uid();  new.status_changed_at := now();
    insert into public.batch_activity (batch_id, actor_id, activity_type, payload)
    values (new.batch_id, auth.uid(), 'status_change',
            jsonb_build_object('dot_number', new.dot_number, 'from', old.status, 'to', new.status));
  end if;
  if tg_op = 'UPDATE' and new.promoted_at is not null and old.promoted_at is null then
    new.promoted_by := auth.uid();
    insert into public.batch_activity (batch_id, actor_id, activity_type, payload)
    values (new.batch_id, auth.uid(), 'promoted', jsonb_build_object('dot_number', new.dot_number));  -- F23
  end if;
  return new;
end $$;
create trigger trg_bc_change before update on public.batch_carriers
  for each row execute function internal.log_bc_change();

create function internal.log_bc_delete() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.batch_activity (batch_id, actor_id, activity_type, payload)
  values (old.batch_id, auth.uid(), 'carrier_removed', jsonb_build_object('dot_number', old.dot_number));
  return old;
end $$;
create trigger trg_bc_delete before delete on public.batch_carriers
  for each row execute function internal.log_bc_delete();

comment on table public.batch_activity is
  'Batch-level events (batch_created, members_added, refresh, bulk_status_change, export, '
  'dnc_set/cleared) are written by their RPCs (§5, SECURITY DEFINER). Manual comments are '
  'direct inserts gated by RLS (activity_type=''comment'' and actor_id = auth.uid()).';

-- ----------------------------------------------------------------------------
-- Indexes (§2.9) -- activity
-- ----------------------------------------------------------------------------
create index idx_activity_feed on public.batch_activity (batch_id, id desc);       -- F11 chronological feed
