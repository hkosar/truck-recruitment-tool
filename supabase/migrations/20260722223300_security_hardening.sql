-- ============================================================================
-- 20260722223300_security_hardening.sql
-- Fix-forward after the first clean hosted staging replay exposed grant- and
-- search_path-level advisor findings. This migration is intentionally additive
-- and safe to apply to an empty or populated environment.
-- ============================================================================

-- Every application function receives an explicit search_path. Public RPCs and
-- internal helpers deliberately use both schemas; trigger functions already had
-- a pinned path and are included here for complete auditability.
do $hardening$
declare
  fn regprocedure;
begin
  for fn in
    select p.oid::regprocedure
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'internal')
      and p.prokind = 'f'
      and pg_get_userbyid(p.proowner) = current_user
      and not exists (
        select 1 from pg_depend d
        where d.classid = 'pg_proc'::regclass
          and d.objid = p.oid
          and d.deptype = 'e'
      )
  loop
    execute format('alter function %s set search_path = public, internal, pg_temp', fn);
  end loop;
end
$hardening$;

-- PostgreSQL grants EXECUTE on new functions to PUBLIC by default. Revoke that
-- implicit privilege and grant only the supported application surface.
revoke execute on all functions in schema public from public, anon;
revoke execute on all functions in schema internal from public, anon;

-- Authenticated application users may call the explicit public API. RLS guards
-- all invoker reads; the five definer writes also perform fail-closed role checks.
grant execute on function
  public.search_carriers(jsonb, int, int, text, text),
  public.count_carriers(jsonb),
  public.facet_other_values(jsonb, text, int, int),
  public.facet_suggested_keywords(jsonb),
  public.facet_cargo_flags(jsonb),
  public.create_batch(text, text, text, text, jsonb),
  public.refresh_batch(uuid),
  public.bulk_set_status(uuid, bigint[], batch_carrier_status),
  public.set_do_not_contact(bigint, boolean, text),
  public.log_export(uuid, text, int),
  public.batch_members(uuid, batch_carrier_status[], text, boolean, int, int, text, text, bigint, int, int, boolean, boolean),
  public.batch_members_map(uuid, batch_carrier_status[], text, boolean, bigint, int, int, boolean, boolean, text, text),
  public.search_carriers_map(jsonb, int),
  public.generate_contact_sheet(uuid, bigint[]),
  public.batch_status_counts(uuid),
  public.dashboard_totals(),
  public.is_contactable(bigint, contact_channel)
  to authenticated;

-- Internal helpers are not PostgREST endpoints but invoker RPCs need to call
-- them. Trigger functions remain ungranted.
grant usage on schema internal to authenticated;
grant execute on function
  internal.current_app_role(),
  internal.is_staff(),
  internal.can_edit(),
  internal.is_manager(),
  internal.matching_carriers(jsonb),
  internal.zone_geom(jsonb),
  internal.zone_radius_m(jsonb),
  internal.warning_reasons(text, bigint, boolean, boolean, text, numeric, numeric, int, date, date),
  internal.batch_members_ordered(uuid, batch_carrier_status[], text, boolean, bigint, int, int, boolean, boolean, text, text),
  internal.is_contactable(bigint, contact_channel)
  to authenticated;

-- Service role is the trusted backend path for ingestion and maintenance.
grant execute on all functions in schema public to service_role;
grant execute on all functions in schema internal to service_role;

-- Ensure future functions do not silently become public/anon callable. New
-- application RPCs must receive an explicit grant in their migration.
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema internal revoke execute on functions from public;
