-- PROPOSAL ONLY — DO NOT APPLY WITHOUT A FRESH TIER-3 OWNER DECISION.
--
-- Purpose: adopt the fifteen already-present pre-ledger migrations into the
-- Supabase migration ledger without replaying their DDL on production.
--
-- IMPORTANT: repository migrations added after the live geocode row are not
-- part of this metadata adoption. As of 2026-07-23 those are:
--   20260722223300_security_hardening
--   20260723004500_profile_service_bootstrap
--   20260723010400_dnc_activity_enum_cast
-- They remain ordinary unapplied migrations and require their own reviewed,
-- staging-proven production application after this ledger repair.
--
-- Preconditions (must be freshly proved immediately before use):
--   1. current_database() belongs to project ejrfobddnojbijzrjbii;
--   2. production schema/object/policy/grant inventory still reconciles to the
--      first fifteen repository migrations;
--   3. the only existing ledger row is
--      20260722042539_geocode_attempt_queue;
--   4. a current backup is visible and the recovery path is accepted;
--   5. repository checksums match docs/build-plan/migration-checksums.sha256;
--   6. the three post-geocode migrations listed above are absent from the live
--      ledger and their effects are absent from production;
--   7. the latest Pro daily backup is visible and a restore-to-new-project
--      rehearsal has passed under 11-recovery-rehearsal-runbook.md.
--
-- This script changes migration metadata only. It must affect exactly 15 rows.
-- A timeout is an unknown state: reread before retrying.

begin;

lock table supabase_migrations.schema_migrations in share row exclusive mode;

do $$
declare
  existing_count integer;
  expected_live boolean;
begin
  select count(*) into existing_count
  from supabase_migrations.schema_migrations;

  select exists (
    select 1
    from supabase_migrations.schema_migrations
    where version = '20260722042539'
      and name = 'geocode_attempt_queue'
  ) into expected_live;

  if existing_count <> 1 or not expected_live then
    raise exception
      'Migration ledger precondition failed: expected only 20260722042539_geocode_attempt_queue';
  end if;

  if exists (
    select 1
    from supabase_migrations.schema_migrations
    where version in ('20260722223300', '20260723004500', '20260723010400')
  ) then
    raise exception 'Post-geocode migration precondition failed: a later migration is already registered';
  end if;

  -- Coarse production identity guard. This does not replace the required
  -- external project-ref verification, but it prevents accidental use on an
  -- empty/small database or another application with a coincidentally similar
  -- ledger.
  if to_regclass('public.carriers') is null
     or to_regclass('public.profiles') is null
     or to_regclass('public.batch_carriers') is null
     or (select count(*) from public.carriers) < 190000 then
    raise exception 'Production schema/count identity precondition failed';
  end if;
end $$;

insert into supabase_migrations.schema_migrations (version, name, statements)
values
  ('20260720000100', 'extensions', array[]::text[]),
  ('20260720000200', 'enums', array[]::text[]),
  ('20260720000300', 'profiles', array[]::text[]),
  ('20260720000400', 'carriers', array[]::text[]),
  ('20260720000500', 'cargo_other_values', array[]::text[]),
  ('20260720000600', 'batches', array[]::text[]),
  ('20260720000700', 'contact', array[]::text[]),
  ('20260720000800', 'activity', array[]::text[]),
  ('20260720000900', 'warnings', array[]::text[]),
  ('20260720001000', 'internal_matcher', array[]::text[]),
  ('20260720001100', 'rpc', array[]::text[]),
  ('20260720001200', 'rls', array[]::text[]),
  ('20260720001300', 'realtime', array[]::text[]),
  ('20260720001400', 'pipeline_tables', array[]::text[]),
  ('20260720001500', 'service_role_pipeline_grants', array[]::text[])
returning version, name;

do $$
declare
  final_count integer;
  adopted_count integer;
begin
  select count(*) into final_count
  from supabase_migrations.schema_migrations;

  select count(*) into adopted_count
  from supabase_migrations.schema_migrations
  where version between '20260720000100' and '20260720001500';

  if final_count <> 16 or adopted_count <> 15 then
    raise exception 'Migration ledger postcondition failed: expected 16 total and 15 adopted rows';
  end if;
end $$;

-- The caller must independently reread all 16 ordered version/name pairs after
-- COMMIT and verify that the three later repository versions remain absent.
-- Until execution is specifically authorized, keep this script as a reviewed
-- proposal only. Do not chain the later migrations into the same approval.

commit;
