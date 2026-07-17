-- ============================================================================
-- 20260720000300_profiles.sql
-- Spec: docs/build-plan/01-architecture.md Part A §2.3.
-- NOTE: internal.current_app_role() is referenced by the guard trigger below
-- but not DEFINED until 20260720001200_rls.sql (§6). This is safe: PL/pgSQL
-- function bodies are only checked for syntax at CREATE time, not for the
-- existence of objects they reference — those are resolved at first EXECUTE,
-- by which time every migration (incl. rls.sql) has already run. Documented
-- in Part A verbatim ("internal.current_app_role() is defined in §6 with RLS").
-- ============================================================================

create table public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  email        text not null,
  full_name    text not null default '',
  role         user_role  not null default 'guest',      -- F1; guest until approved (brief §7)
  status       user_status not null default 'pending',
  avatar_color text not null default '#64748b',           -- mockup users[].color carry-forward
  approved_by  uuid references public.profiles(id),
  approved_at  timestamptz,
  created_at   timestamptz not null default now()
);

comment on table public.profiles is
  'Extends auth.users 1:1. role/status gate everything via RLS (internal.current_app_role()); '
  'guest+pending is the default until a manager approves (brief §7).';

-- Standard Supabase pattern: auto-provision a pending-guest profile on signup.
create function internal.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name',''));
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function internal.handle_new_user();

-- Privilege-escalation guard: only managers may change role/status/approval columns.
create function internal.guard_profile_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (new.role, new.status, new.approved_by, new.approved_at)
     is distinct from (old.role, old.status, old.approved_by, old.approved_at)
     and internal.current_app_role() <> 'manager' then
    raise exception 'only managers may change role/approval';
  end if;
  return new;
end $$;
create trigger guard_profile_update before update on public.profiles
  for each row execute function internal.guard_profile_update();

-- (internal.current_app_role() is defined in 20260720001200_rls.sql / §6.)
