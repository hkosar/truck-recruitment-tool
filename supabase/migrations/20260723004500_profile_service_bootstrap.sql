-- ============================================================================
-- 20260723004500_profile_service_bootstrap.sql
-- Permit the trusted service_role to provision profile roles/statuses after an
-- Admin API user create. Manager authorization remains required for browser
-- and ordinary authenticated requests. The auth.role() check is derived from
-- the verified JWT; it does not rely on current_user inside this SECURITY
-- DEFINER trigger, which would resolve to the function owner.
-- ============================================================================

create or replace function internal.guard_profile_update() returns trigger
language plpgsql
security definer
set search_path = public, internal, pg_temp
as $$
begin
  if (new.role, new.status, new.approved_by, new.approved_at)
     is distinct from (old.role, old.status, old.approved_by, old.approved_at)
     and coalesce(auth.role(), '') <> 'service_role'
     and not coalesce(internal.is_manager(), false) then
    raise exception 'only managers or the trusted service role may change role/approval';
  end if;
  return new;
end
$$;

revoke execute on function internal.guard_profile_update() from public, anon, authenticated;
grant execute on function internal.guard_profile_update() to service_role;
