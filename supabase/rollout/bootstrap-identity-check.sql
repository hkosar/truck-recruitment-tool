-- ============================================================================
-- bootstrap-identity-check.sql -- DRAFT, PENDING REVIEW. NOT EXECUTED ANYWHERE.
-- Serves doc 17 (the sign-in cutover runbook, cited at commits 301418b and f1189dc), step BO3 "Identity alignment check (read-only)":
-- "every approved profile matches, except the first manager row, which is named as a known exception". The independent review of 2026-10-30 UTC
-- showed that read-only-inventory.sql cannot establish that exception: its approved_profiles_without_auth_user is a total and cannot say WHICH
-- profile is missing its Auth user. This file ties the exception to the actual first-manager bootstrap identity.
-- Route A action: bootstrap-identity-check (phrase RUN TNBS PRODUCTION SQL BOOTSTRAP-IDENTITY-CHECK; read-only flag set).
--
-- WHEN TO RUN IT (ORDER MATTERS): BEFORE the M1 backouts (backout-m1c, backout-m1b, backout-m1). It reads internal.auth_events, a table M1
-- creates and M1-backout.sql drops. After the M1 backouts the table is gone and this select fails (read-only, nothing changes). So BO3 order is:
--   1. bootstrap-identity-check   (this file; needs internal.auth_events)
--   2. read-only-inventory        (aggregate counts; needs only public.profiles and auth.users)
--   3. then the M1 backouts.
--
-- WHAT IT TOUCHES: reads internal.auth_events (user_id, kind), public.profiles (id, status) and auth.users (id), nothing else.
-- It is ONE select that returns ONE row of whole-number counts. It returns no id, no email, no name and no row data: the bootstrap identity is used
-- inside the query and never leaves it. The runner runs it in "begin read only" and ends with a rollback; there is no commit.
--
-- WHAT EACH COUNT IS (a "boolean" is reported as a count that is 0 or 1; every value is a whole number):
--   bootstrap_events ............................. rows of internal.auth_events with kind = 'first_manager_bootstrap' (the first-manager tool
--                                                  writes exactly one; expected 1).
--   bootstrap_profiles_present ................... distinct profiles whose id is the user_id of such an event (expected 1; 0 means the
--                                                  bootstrap profile is gone or the event has no user).
--   bootstrap_profiles_with_auth_user ............ of those, how many HAVE an auth.users row. Either 0 or 1 is acceptable: 0 is the named
--                                                  exception, and 1 means the bootstrap profile has since acquired an Auth user.
--   other_approved_profiles_without_auth_user .... approved profiles that are NOT the bootstrap profile and have no auth.users row. Expected 0.
--                                                  Anything above 0 is NOT the first-manager exception (for example a person added by M1b
--                                                  who has no Auth user yet); the manager must resolve that person's old-login or backout
--                                                  treatment before the backout. Do not treat it as the exception.
-- Reading: the exception is established only when bootstrap_events = 1, bootstrap_profiles_present = 1 and
-- other_approved_profiles_without_auth_user = 0. (proposed, not from a reviewed doc: all four counts)
-- ============================================================================
select
  e.bootstrap_events,
  b.bootstrap_profiles_present,
  b.bootstrap_profiles_with_auth_user,
  o.other_approved_profiles_without_auth_user
from (
  select count(*) as bootstrap_events
  from internal.auth_events
  where kind = 'first_manager_bootstrap'
) e
cross join (
  select
    count(*) as bootstrap_profiles_present,
    count(*) filter (where u.id is not null) as bootstrap_profiles_with_auth_user
  from public.profiles pr
  left join auth.users u on u.id = pr.id
  where pr.id in (select user_id from internal.auth_events where kind = 'first_manager_bootstrap' and user_id is not null)
) b
cross join (
  select count(*) as other_approved_profiles_without_auth_user
  from public.profiles pr
  left join auth.users u on u.id = pr.id
  where pr.status::text = 'approved'
    and u.id is null
    and pr.id not in (select user_id from internal.auth_events where kind = 'first_manager_bootstrap' and user_id is not null)
) o;
