-- ============================================================================
-- M1b_add_person.sql -- managers add staff directly (D8, APPROVED by Hunter 2026-10-22:
-- "yes, remove the old account link so managers can add people"). PENDING: applied only AFTER
-- supabase/pending/M1_same_origin_signin.sql, as one transaction. NOT EXECUTED on any hosted
-- database (local A3 test cluster only). Backout: supabase/backout/M1b-backout.sql.
--
--   1. public.profiles no longer requires an auth.users row (the old sign-in account). Existing
--      ids and rows are untouched; new ids default to gen_random_uuid().
--   2. An optional mobile number is kept in internal.staff_mobile_unverified, outside every
--      staff-readable surface. It is UNVERIFIED and never used for sign-in, recovery or any
--      confirmation (SMS is not built; doc 15 §27).
--   3. public.team_add_person: MANAGER, link session only, roster lock held exclusively (I1, as
--      every team operation), email normalized, any existing roster email refused, audit row,
--      no email sent (the person requests a sign-in link themselves).
-- D10: the backout-window freeze on new-user adds is SUPERSEDED for adds by this approval; the
-- email-edit freeze (internal.backout_window, M1) stays as reviewed.
-- ============================================================================
begin;

-- ---- 1. D8: drop the profiles -> auth.users link (and its cascade-delete hazard).
alter table public.profiles drop constraint if exists profiles_id_fkey;
alter table public.profiles alter column id set default gen_random_uuid();

-- ---- 2. Optional mobile, UNVERIFIED, internal only (recruiter_api has no access to internal tables).
create table internal.staff_mobile_unverified (
  user_id    uuid primary key references public.profiles(id),
  mobile     text not null check (mobile ~ '^\+[1-9][0-9]{7,14}$'),
  entered_by uuid not null references public.profiles(id),
  entered_at timestamptz not null default now()
);
comment on table internal.staff_mobile_unverified is
  'Optional mobile entered by a manager when adding a person. UNVERIFIED: never used for sign-in, '
  'recovery or any confirmation (SMS is not built). Not readable by the app role.';

-- ---- 3. Add a person.
create function public.team_add_person(p_full_name text, p_email text, p_role user_role, p_mobile text)
returns uuid
language plpgsql
volatile
security definer
set search_path = public, internal, pg_temp
as $$
declare
  -- I1 roster FOR UPDATE (p_roster = true), then the actor's own rows; manager, link session only.
  v_actor  uuid := internal.lock_and_validate(array['manager']::user_role[], array['link'], '{}', true);
  v_name   text := btrim(p_full_name);
  v_email  text := lower(btrim(p_email));
  v_mobile text := nullif(btrim(p_mobile), '');
  v_id     uuid;
begin
  if v_name is null or v_name = '' or length(v_name) > 200 then
    raise exception 'invalid name' using errcode = 'check_violation';
  end if;
  if v_email is null or length(v_email) > 320 or v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
    raise exception 'invalid email' using errcode = 'check_violation';
  end if;
  if p_role is null or p_role not in ('manager', 'edit', 'view') then
    raise exception 'invalid role' using errcode = 'check_violation';
  end if;
  if v_mobile is not null and v_mobile !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'invalid mobile' using errcode = 'check_violation';
  end if;
  -- Any roster row with this address (any status, legacy rows included) refuses the add: a
  -- disabled person is reactivated, never duplicated. Serialized by the exclusive roster lock,
  -- which every team operation (including email edits) takes first.
  if exists (select 1 from public.profiles o where lower(o.email) = v_email) then
    raise exception 'email already belongs to a person on the roster' using errcode = 'unique_violation';
  end if;
  insert into public.profiles (email, full_name, role, status, approved_by, approved_at)
  values (v_email, v_name, p_role, 'approved', v_actor, now())
  returning id into v_id;
  if v_mobile is not null then
    insert into internal.staff_mobile_unverified (user_id, mobile, entered_by) values (v_id, v_mobile, v_actor);
  end if;
  insert into internal.auth_events (user_id, kind, detail)
  values (v_id, 'team_add_person', jsonb_build_object('by', v_actor, 'role', p_role, 'mobile_entered', v_mobile is not null));
  return v_id;
end
$$;

revoke all on function public.team_add_person(text, text, user_role, text) from public, anon, authenticated;
grant execute on function public.team_add_person(text, text, user_role, text) to recruiter_api;

commit;
