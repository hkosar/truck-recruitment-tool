-- ============================================================================
-- M1c_batch_delete_audit.sql -- a permanent record of every batch delete (Hunter, 2026-10-23:
-- "yes" to a permanent record of batch deletes). PENDING: applied only AFTER
-- supabase/pending/M1_same_origin_signin.sql and M1b_add_person.sql, as one transaction. NOT
-- EXECUTED on any hosted database (local A3 test cluster only).
-- Backout: supabase/backout/M1c-backout.sql (keeps the records).
--
--   1. internal.batch_delete_audit: batch id, name, actor, time, member count. It has NO foreign
--      key, so nothing cascades into it: the row outlives the batch (and the person). Append-only:
--      a trigger refuses UPDATE, DELETE and TRUNCATE. The app role has no access to the table.
--   2. public.batch_delete: the manager-only delete. The audit row is written in the SAME
--      transaction as the delete (same function), after the batch row is locked; if anything
--      fails, both roll back together. Lock order (doc 15 §17.2): the actor's own session (I3),
--      then the batch (B1); the cascade then takes its zones, members and feed (B2, B3, B6).
-- ============================================================================
begin;

-- ---- 1. The record.
create table internal.batch_delete_audit (
  id           bigint generated always as identity primary key,
  batch_id     uuid not null,
  batch_name   text not null,
  actor_id     uuid not null,
  deleted_at   timestamptz not null default now(),
  member_count int not null check (member_count >= 0)
);
comment on table internal.batch_delete_audit is
  'Permanent record of batch deletes (Hunter, 2026-10-23). No foreign keys, so it survives the '
  'batch and the person. Append-only (trigger). Written only by public.batch_delete.';

create function internal.batch_delete_audit_append_only()
returns trigger
language plpgsql
set search_path = internal, pg_temp
as $$
begin
  raise exception 'internal.batch_delete_audit is append-only' using errcode = 'insufficient_privilege';
end
$$;
create trigger batch_delete_audit_no_update_delete
  before update or delete on internal.batch_delete_audit
  for each row execute function internal.batch_delete_audit_append_only();
create trigger batch_delete_audit_no_truncate
  before truncate on internal.batch_delete_audit
  for each statement execute function internal.batch_delete_audit_append_only();

revoke all on table internal.batch_delete_audit from public, anon, authenticated, recruiter_api;
revoke execute on function internal.batch_delete_audit_append_only() from public, anon, authenticated, recruiter_api;

-- ---- 2. The delete (managers only).
create function public.batch_delete(p_batch_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, internal, pg_temp
as $$
declare
  -- I3: the actor's own session; manager, link session only.
  v_actor   uuid := internal.lock_and_validate(array['manager']::user_role[], array['link']);
  v_name    text;
  v_members int;
begin
  -- The batches delete policy's own check, kept although this function bypasses RLS.
  if not internal.actor_can_write(array['manager']::user_role[]) then
    raise exception 'not permitted' using errcode = 'insufficient_privilege';
  end if;
  -- B1: lock the batch; an unknown batch writes nothing.
  select b.name into v_name from public.batches b where b.id = p_batch_id for update;
  if not found then
    return false;
  end if;
  perform internal.recheck_session();
  select count(*)::int into v_members from public.batch_carriers bc where bc.batch_id = p_batch_id;
  insert into internal.batch_delete_audit (batch_id, batch_name, actor_id, member_count)
  values (p_batch_id, v_name, v_actor, v_members);
  delete from public.batches where id = p_batch_id;
  return true;
end
$$;

revoke all on function public.batch_delete(uuid) from public, anon, authenticated;
grant execute on function public.batch_delete(uuid) to recruiter_api;

commit;
