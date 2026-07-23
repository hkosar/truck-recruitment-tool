-- Fix set_do_not_contact on PostgreSQL 17: the CASE expression feeding the
-- activity_type enum must be typed explicitly. Without the cast, an authorized
-- editor reaches the final activity insert and the transaction aborts with
-- "column activity_type is of type activity_type but expression is text".

create or replace function public.set_do_not_contact(
  p_dot bigint,
  p_on boolean,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public, internal, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if not coalesce(internal.can_edit(), false) then
    raise exception 'insufficient privilege to change do-not-contact';
  end if;
  if not exists (select 1 from public.carriers where dot_number = p_dot) then
    raise exception 'carrier % not found', p_dot;
  end if;

  update public.carriers
     set do_not_contact = p_on,
         dnc_reason = case when p_on then p_reason else null end,
         dnc_set_by = case when p_on then v_uid else null end,
         dnc_set_at = case when p_on then now() else null end
   where dot_number = p_dot;

  if p_on then
    insert into public.contact_suppressions (dot_number, channel, reason, source, created_by)
    values (p_dot, 'all', p_reason, 'manual', v_uid)
    on conflict (dot_number, channel) where value is null
    do update set reason = excluded.reason, created_by = excluded.created_by,
                  created_at = now(), expires_at = null;
  else
    update public.contact_suppressions
       set expires_at = now()
     where dot_number = p_dot and channel = 'all' and value is null
       and (expires_at is null or expires_at > now());
  end if;

  insert into public.batch_activity (batch_id, actor_id, activity_type, payload)
  select bc.batch_id, v_uid,
         (case when p_on then 'dnc_set' else 'dnc_cleared' end)::activity_type,
         jsonb_build_object('dot_number', p_dot, 'reason', p_reason)
  from public.batch_carriers bc
  where bc.dot_number = p_dot;
end
$$;

revoke execute on function public.set_do_not_contact(bigint, boolean, text) from public, anon;
grant execute on function public.set_do_not_contact(bigint, boolean, text) to authenticated, service_role;
