-- ============================================================================
-- profile-bootstrap-backout.sql -- DRAFT, PENDING REVIEW. NOT EXECUTED ANYWHERE.
-- Serves doc 17 (sign-in cutover runbook, cited at commits 301418b and f1189dc), step A2 "Backouts": "Profile bootstrap -> restore
-- the earlier function body (20260720000300 / 20260720000800; no file prepared)" and the Route A action profile-bootstrap-backout
-- (phrase RUN TNBS PRODUCTION SQL PROFILE-BOOTSTRAP-BACKOUT). It backs out exactly ONE migration:
--   supabase/migrations/20260723004500_profile_service_bootstrap.sql   (Route A action migration-profile-service-bootstrap)
-- (The runbook text names 20260720000800; that file is the activity migration and holds no profile function. The earlier
--  function body is in 20260720000300_profiles.sql lines 40-48, which is what this file restores.)
--
-- WHAT THE MIGRATION CREATES OR CHANGES (the whole list; there is nothing else in it):
--   1. Replaces the body of internal.guard_profile_update() so that the trusted service_role (auth.role() = 'service_role') may
--      change role / status / approved_by / approved_at on public.profiles, as well as managers (internal.is_manager()).
--   2. Its trailing revoke/grant statements: revoke execute from public, anon, authenticated; grant execute to service_role.
-- WHAT THIS FILE REVERSES:
--   * (1) only: it puts back the body from 20260720000300_profiles.sql, in which only a manager (internal.current_app_role() =
--     'manager') may make that change. The function keeps the search_path pin public, internal, pg_temp that the hardening
--     migration (20260722223300) applied to it, so the catalogue returns to the state AFTER hardening and BEFORE this migration.
--   * (2) is NOT reversed, on purpose: after the hardening migration those statements are no-ops (the hardening already removed
--     PUBLIC and anon, never granted authenticated to this trigger function, and granted service_role execute on every function).
--     Re-running them backwards would take service_role's hardening grant away. CREATE OR REPLACE keeps the existing grants.
--
-- RUN ORDER (assumed, and checked below where the database can show it): the A2 migrations ran in order, hardening first. Back
-- out in the reverse order: contact-logs guard, then dnc-enum-cast-backout, then this file, and security-hardening-backout last.
-- If M1 was applied, run the M1 backouts first (doc 16 section 3.3). M1 does not redefine this function.
--
-- DATA: NO DATA IS DESTROYED. It changes one function body and nothing else: no table, no row, no grant, no trigger.
-- BEHAVIOUR YOU LOSE (read before the go): once this runs, a service_role request that changes a profile's role, status or approval
-- is refused ("only managers may change role/approval") unless a manager is the caller. Anything that provisions roles through the
-- Admin API depends on the migration's body and stops working until the migration is applied again.
--
-- SAFE TO REPEAT: yes. CREATE OR REPLACE with the same text changes nothing; the checks below run each time.
-- ONE TRANSACTION: it has its own begin ... commit, so the runner runs it as written. If a check fails, nothing is kept.
-- ============================================================================
begin;

-- Precondition: the function and its trigger on public.profiles exist (they come from 20260720000300). Otherwise stop.
do $check$
begin
  if to_regprocedure('internal.guard_profile_update()') is null then
    raise exception 'internal.guard_profile_update() does not exist; refusing';
  end if;
  if not exists (
    select 1 from pg_trigger t
    where t.tgrelid = 'public.profiles'::regclass and t.tgname = 'guard_profile_update' and not t.tgisinternal
  ) then
    raise exception 'trigger guard_profile_update on public.profiles does not exist; refusing';
  end if;
end
$check$;

-- The body of 20260720000300_profiles.sql lines 40-48, unchanged; only the search_path is the hardened value public, internal, pg_temp.
create or replace function internal.guard_profile_update() returns trigger
language plpgsql
security definer
set search_path = public, internal, pg_temp
as $$
begin
  if (new.role, new.status, new.approved_by, new.approved_at)
     is distinct from (old.role, old.status, old.approved_by, old.approved_at)
     and internal.current_app_role() <> 'manager' then
    raise exception 'only managers may change role/approval';
  end if;
  return new;
end $$;

-- Postcondition: the restored body no longer mentions service_role and does use the manager check. Otherwise nothing is kept.
do $check$
declare
  v_src text;
begin
  select p.prosrc into v_src from pg_proc p where p.oid = 'internal.guard_profile_update()'::regprocedure;
  if v_src is null or v_src like '%service_role%' or v_src not like '%internal.current_app_role()%' then
    raise exception 'the restored guard_profile_update body is not the expected one; rolling back';
  end if;
end
$check$;

commit;
