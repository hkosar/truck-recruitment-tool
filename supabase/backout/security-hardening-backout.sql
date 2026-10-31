-- ============================================================================
-- security-hardening-backout.sql -- undoes the REVOKES of
-- supabase/migrations/20260722223300_security_hardening.sql (lines 36-37 and 74-75).
-- NOT EXECUTED ANYWHERE. Verified offline only, by scripts/verify-hardening-backout-contract.mjs.
-- Release-path plan step 9a ("re-grant EXECUTE to PUBLIC").
--
-- WHEN TO RUN: only if the hardening migration itself must be reversed, with the owner's "go".
--   * If M1 (supabase/pending/M1_same_origin_signin.sql) was applied, run M1c-backout, M1b-backout
--     and M1-backout FIRST (doc 16 section 3.3). M1-backout restores the permission surface as it
--     was AFTER the hardening; this file goes one step further back, to BEFORE it.
--   * Run as the same role that applied the hardening migration (the revokes there ran as that
--     role, so the re-grants must too).
--   * One transaction. Changes no data, no function body and no table.
--
-- WHAT IT RE-GRANTS (the exact mirror of the migration's revokes):
--   migration line 36: revoke execute on all functions in schema public   from public, anon
--   migration line 37: revoke execute on all functions in schema internal from public, anon
--   migration line 74: alter default privileges in schema public   revoke execute on functions from public
--   migration line 75: alter default privileges in schema internal revoke execute on functions from public
--
-- WHAT IT DOES NOT UNDO, ON PURPOSE:
--   * The per-function search_path pins (migration lines 11-32). The previous values were not
--     recorded, many functions already had a pinned path, and a pinned path is not a security
--     regression; resetting them would remove protection.
--   * The grants TO authenticated and service_role (lines 43-72). They are additive. Whether
--     any of them existed before the hardening is not recorded in the repo, so removing them
--     could break the pipeline (service_role). Compare against the pre-hardening role matrix or
--     the pre-cutover snapshot (supabase/backout/pre-cutover-snapshot.sql) before touching them.
--
-- NOTE: "all functions in schema" also reaches functions that belong to extensions installed in
-- that schema, exactly as the migration's revoke did. The re-grant mirrors the revoke.
-- NOTE: the two default-privilege lines mirror lines 74-75. In PostgreSQL the global default
-- already lets PUBLIC execute new functions, so the migration's schema-specific revoke had little
-- visible effect; granting it back here is harmless and keeps the backout a literal mirror.
-- ============================================================================
begin;

grant execute on all functions in schema public to public, anon;
grant execute on all functions in schema internal to public, anon;

alter default privileges in schema public grant execute on functions to public;
alter default privileges in schema internal grant execute on functions to public;

commit;

-- Check afterwards (read-only; expect true for both; function names as in the migration):
--   select has_function_privilege('anon', 'public.dashboard_totals()', 'execute') as anon_can_execute_public_fn,
--          has_function_privilege('anon', 'internal.is_staff()', 'execute')       as anon_can_execute_internal_fn;
