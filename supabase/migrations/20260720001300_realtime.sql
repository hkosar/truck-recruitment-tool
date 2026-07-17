-- ============================================================================
-- 20260720001300_realtime.sql -- publication membership
-- Spec: docs/build-plan/01-architecture.md Part A §7; amended per #15 to add
-- public.profiles (manager pending-badge; RLS-safe -- Realtime Postgres
-- Changes respects RLS, so unauthorized users receive nothing regardless of
-- publication membership).
-- ============================================================================

alter publication supabase_realtime add table
  public.batches, public.batch_zones, public.batch_carriers,
  public.batch_activity, public.contact_logs, public.profiles;
-- carriers deliberately EXCLUDED (D8): nightly sync churn would flood clients.
-- DNC flips reach clients as batch_activity 'dnc_set'/'dnc_cleared' rows (per
-- set_do_not_contact, written into EVERY batch containing the carrier) -> refetch.

alter table public.batch_carriers replica identity full;   -- old-row values in UPDATE payloads (status transitions)

-- Client channel plan (documented here for the app team; no further DDL):
--  - Batch page: channel `batch:{id}` -- postgres_changes on batch_carriers,
--    batch_activity, contact_logs, all filtered batch_id=eq.{id} (contact_logs
--    additionally filtered dot_number=eq.{dot} on the carrier profile).
--  - Dashboard: channel `dashboard` on batches (INSERT/UPDATE/DELETE) +
--    batch_activity INSERTs (bumps batch_dashboard.last_activity_at -> refetch).
--  - Users admin: channel on profiles (manager only; RLS naturally restricts
--    delivery to staff since profiles_select allows own-row-or-staff).
