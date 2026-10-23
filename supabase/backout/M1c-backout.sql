-- ============================================================================
-- M1c-backout.sql -- undoes supabase/pending/M1c_batch_delete_audit.sql. NOT EXECUTED anywhere.
-- Order: after retire-app-credentials.sql and BEFORE M1b-backout.sql and M1-backout.sql. One
-- transaction. Deletes no data: internal.batch_delete_audit and its append-only triggers STAY
-- (the record is permanent; Hunter, 2026-10-23), unreachable by any app role. Only the delete
-- function goes, and recruiter_api gets back the direct DELETE on public.batches that M1 granted;
-- the old app deletes batches through its own path, which writes no record.
-- ============================================================================
begin;

drop function if exists public.batch_delete(uuid);
grant delete on public.batches to recruiter_api;   -- as M1 section 11 granted it

commit;
