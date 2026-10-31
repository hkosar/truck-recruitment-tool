-- ============================================================================
-- read-only-inventory.sql -- DRAFT, PENDING REVIEW. NOT EXECUTED ANYWHERE.
-- Serves doc 17 (the sign-in cutover runbook, cited at commits 301418b and f1189dc):
--   * A1  "Read-only production inventory (O1)": "counts of profiles by role and status, and duplicate emails ...
--          confirms nothing changed since 2026-10-22" (production had 0 Auth users and 0 profiles then; doc 15 section 32).
--   * BO3 "Identity alignment check (read-only)": "confirm profiles.email = auth.users.email for every approved profile ...
--          every approved profile matches, except the first manager row, which is named as a known exception".
-- Doc 14 section 11.4 O1 gives the same scope: "counts of profiles by role/status, duplicate emails".
-- Runbook A1 and BO3 both say "GAP: the query text is not recorded"; this file is that text, proposed for review.
-- Route A action: read-only-inventory (phrase RUN TNBS PRODUCTION SQL READ-ONLY-INVENTORY; read-only flag set).
--
-- WHAT IT TOUCHES: reads public.profiles (id, email, role, status) and auth.users (id, email), nothing else. It does not
-- reference any object M1 creates, so it runs the same way BEFORE the cutover (A1) and AFTER a backout (BO3).
-- It is ONE select that returns ONE row of whole-number counts. It returns no id, no email, no name and no row data.
-- The runner runs it in "begin read only" and ends with a rollback; there is no commit.
--
-- WHAT EACH COUNT IS, AND WHERE IT COMES FROM:
--   profiles_total ........................ A1 "nothing changed since 2026-10-22" (that day: 0).
--   auth_users_total ...................... A1, same sentence (that day: 0).
--   profiles_<role>_<status> (12 counts) .. A1 / doc 14 O1 "profiles by role and status". The role and status words are the
--                                            enum values in supabase/migrations/20260720000200_enums.sql (user_role: manager, edit,
--                                            view, guest; user_status: pending, approved, disabled). Roles and statuses are compared
--                                            as text, so a value added later cannot make this query fail.
--   profiles_other_role_status ............ rows whose role or status is NOT one of those words (expected 0).
--                                            (proposed, not from a reviewed doc: a guard so a new enum value is not missed). Role and status are
--                                            NOT NULL in the baseline, so this predicate is adequate there; a nonzero value means stop and look, and
--                                            is not itself a complete inventory.
--   duplicate_email_groups ................ A1 / doc 14 O1 "duplicate emails": how many lower-cased addresses appear on more than one profile.
--   duplicate_email_rows .................. A1 / doc 14 O1: how many profile rows are in those groups.
--                                            (both count all profiles; the unique-index question in doc 14 section 11.3 is about
--                                            active staff, so Hunter reads these as an upper bound)
--   email_mismatches ...................... BO3. The SAME expression as step 6 of retire-app-credentials.sql (action retire-email):
--                                            approved profiles joined to auth.users by id where lower(profile email) <> lower(auth email).
--   approved_profiles_without_auth_user ... BO3: approved profiles with no auth.users row (the join in email_mismatches silently skips these).
--                                            THIS IS A TOTAL ONLY. It CANNOT show that the missing one is the first manager: with two approved
--                                            managers, swapping which one has an Auth user leaves every count in this file unchanged (independent
--                                            review, 2026-10-30 UTC). Do NOT call BO3 closed on this count. The identity-specific proof is the
--                                            separate action bootstrap-identity-check (supabase/rollout/bootstrap-identity-check.sql), which runs
--                                            BEFORE the M1 backouts, while internal.auth_events still exists.
--                                            (proposed, not from a reviewed doc: a total, kept as evidence)
--   approved_auth_email_null .............. approved profiles whose auth.users row has no email. A null makes "<>" unknown, so
--                                            email_mismatches cannot see it. Expected 0; a nonzero value needs investigation (profile email
--                                            is NOT NULL in the baseline, so a null on the Auth side is the only way to get here).
--                                            (proposed, not from a reviewed doc)
-- ============================================================================
select
  p.profiles_total,
  a.auth_users_total,
  p.profiles_manager_pending, p.profiles_manager_approved, p.profiles_manager_disabled,
  p.profiles_edit_pending, p.profiles_edit_approved, p.profiles_edit_disabled,
  p.profiles_view_pending, p.profiles_view_approved, p.profiles_view_disabled,
  p.profiles_guest_pending, p.profiles_guest_approved, p.profiles_guest_disabled,
  p.profiles_other_role_status,
  d.duplicate_email_groups,
  d.duplicate_email_rows,
  i.email_mismatches,
  i.approved_profiles_without_auth_user,
  i.approved_auth_email_null
from (
  select
    count(*) as profiles_total,
    count(*) filter (where role::text = 'manager' and status::text = 'pending') as profiles_manager_pending,
    count(*) filter (where role::text = 'manager' and status::text = 'approved') as profiles_manager_approved,
    count(*) filter (where role::text = 'manager' and status::text = 'disabled') as profiles_manager_disabled,
    count(*) filter (where role::text = 'edit' and status::text = 'pending') as profiles_edit_pending,
    count(*) filter (where role::text = 'edit' and status::text = 'approved') as profiles_edit_approved,
    count(*) filter (where role::text = 'edit' and status::text = 'disabled') as profiles_edit_disabled,
    count(*) filter (where role::text = 'view' and status::text = 'pending') as profiles_view_pending,
    count(*) filter (where role::text = 'view' and status::text = 'approved') as profiles_view_approved,
    count(*) filter (where role::text = 'view' and status::text = 'disabled') as profiles_view_disabled,
    count(*) filter (where role::text = 'guest' and status::text = 'pending') as profiles_guest_pending,
    count(*) filter (where role::text = 'guest' and status::text = 'approved') as profiles_guest_approved,
    count(*) filter (where role::text = 'guest' and status::text = 'disabled') as profiles_guest_disabled,
    count(*) filter (where role::text not in ('manager', 'edit', 'view', 'guest')
                        or status::text not in ('pending', 'approved', 'disabled')) as profiles_other_role_status
  from public.profiles
) p
cross join (
  select count(*) as auth_users_total from auth.users
) a
cross join (
  select count(*) as duplicate_email_groups, coalesce(sum(n), 0)::bigint as duplicate_email_rows
  from (select count(*) as n from public.profiles group by lower(email) having count(*) > 1) g
) d
cross join (
  select
    count(*) filter (where u.id is not null and lower(pr.email) <> lower(u.email)) as email_mismatches,
    count(*) filter (where u.id is null) as approved_profiles_without_auth_user,
    count(*) filter (where u.id is not null and u.email is null) as approved_auth_email_null
  from public.profiles pr
  left join auth.users u on u.id = pr.id
  where pr.status::text = 'approved'
) i;
