-- ============================================================================
-- 20260720001000_internal_matcher.sql -- the D4 keystone
-- Spec: docs/build-plan/01-architecture.md Part A §5.0 + §4 (search_definition
-- jsonb contract + cargo matching semantics).
--
-- "One internal matcher internal.matching_carriers(definition jsonb) powers
-- search, live count, facets, snapshot, and refresh" -- guarantees "Refresh
-- adds exactly what Search would find", no drift (D4).
--
-- Part A gives the zone-UNION predicate as a literal SQL fragment plus prose
-- for the remaining AND-ed conditions ("plus, AND-ed: cargo per §4 semantics;
-- power_units between; status_code='A' if active_only; ..."). This migration
-- is the first complete, executable assembly of that prose into real SQL.
-- Implementation choices (see manifest for the full list):
--   * returns TABLE(dot_number bigint) rather than bare "setof bigint" --
--     equivalent capability, named column is easier for every caller to join on.
--   * internal.zone_geom(z)/internal.zone_radius_m(z) factor the zone->geography
--     construction out of the inline fragment so search_carriers/search_carriers_map
--     can reuse it for per-zone "matched_zones" attribution without re-typing it.
--   * The 30 crgo_* flag names are matched via an explicit CASE lookup (not
--     to_jsonb(c)->>f): a per-row full-row-to-jsonb conversion would also
--     serialize census_raw and geom on every EXISTS evaluation, which is
--     wasteful at TX scale. CASE is a closed whitelist by construction (any
--     unrecognized name falls to ELSE false) -- satisfies the "validated
--     against the 30-name whitelist" note in §4's jsonb contract comment
--     without the serialization cost.
--   * "cargo absent/empty -> no cargo filtering" (§4) is implemented as: the
--     cargo predicate is skipped entirely when BOTH flags and other.include
--     are empty/absent, regardless of what's in other.exclude. This is also
--     what makes the facet SCOPE RULE (§5.3, "counts run over p_definition
--     WITH THE ENTIRE 'cargo' KEY REMOVED") behave identically to a
--     present-but-empty cargo key, as intended.
--   * search_definition.contactability.{has_phone,has_email} and
--     .status.{active_only,for_hire_only,interstate_only,authorized_only} and
--     .insurance.{enforce,require_insured} are all simple "require" boolean
--     switches: false or absent = no filter, true = filter applied. (This
--     differs from the batch_members/batch_members_map RPC parameters of the
--     same name, which are true nullable tri-states -- see the RPC migration.)
--   * exclude_dnc defaults to true when the key is absent (per §4's own
--     example comment "default true; DNC never enters new work") but is
--     honored literally if the caller sets it to false -- the app is expected
--     to always send true; the DB does not hard-code the exclusion so a
--     future "show suppressed carriers" research view remains possible
--     without a schema change.
-- ============================================================================

-- Small reusable geometry helpers (not in Part A verbatim, but factored out of
-- its zone-UNION SQL fragment so the same logic doesn't get re-typed in every
-- RPC that needs PER-ZONE attribution, e.g. search_carriers'/search_carriers_map's
-- matched_zones -- the matcher itself only needs the UNION, not which zone hit).
create or replace function internal.zone_geom(z jsonb) returns geography
language sql immutable as $$
  select case z->>'zone_type'
    when 'radius' then
      st_setsrid(st_makepoint((z->'params'->>'lng')::float8, (z->'params'->>'lat')::float8), 4326)::geography
    when 'corridor' then
      st_setsrid(st_makeline(array(
        select st_makepoint((pt->>0)::float8, (pt->>1)::float8)
        from jsonb_array_elements(z->'params'->'route') pt
      )), 4326)::geography
  end
$$;

create or replace function internal.zone_radius_m(z jsonb) returns numeric
language sql immutable as $$
  select coalesce((z->'params'->>'radius_miles')::numeric, (z->'params'->>'buffer_miles')::numeric) * 1609.344
$$;

create or replace function internal.matching_carriers(p_def jsonb)
returns table (dot_number bigint)
language sql
stable
as $$
  select c.dot_number
  from public.carriers c
  left join public.carrier_insurance ci on ci.dot_number = c.dot_number
  where
    -- ---- zones (geo) -- UNION over lanes; absent/empty zones list = statewide ----
    (
      coalesce(jsonb_array_length(p_def->'zones'), 0) = 0
      or (
        c.geom is not null
        and exists (
          select 1
          from jsonb_array_elements(p_def->'zones') z
          where st_dwithin(c.geom, internal.zone_geom(z), internal.zone_radius_m(z))
        )
      )
    )

    -- ---- cargo (§4 decisive semantics) ----
    and (
      (
        coalesce(jsonb_array_length(p_def#>'{cargo,flags}'), 0) = 0
        and coalesce(jsonb_array_length(p_def#>'{cargo,other,include}'), 0) = 0
      )
      or (
        (
          exists (
            select 1
            from jsonb_array_elements_text(coalesce(p_def#>'{cargo,flags}', '[]'::jsonb)) f
            where coalesce(
              case f
                when 'crgo_genfreight' then c.crgo_genfreight
                when 'crgo_household'  then c.crgo_household
                when 'crgo_metalsheet' then c.crgo_metalsheet
                when 'crgo_motoveh'    then c.crgo_motoveh
                when 'crgo_drivetow'   then c.crgo_drivetow
                when 'crgo_logpole'    then c.crgo_logpole
                when 'crgo_bldgmat'    then c.crgo_bldgmat
                when 'crgo_mobilehome' then c.crgo_mobilehome
                when 'crgo_machlrg'    then c.crgo_machlrg
                when 'crgo_produce'    then c.crgo_produce
                when 'crgo_liqgas'     then c.crgo_liqgas
                when 'crgo_intermodal' then c.crgo_intermodal
                when 'crgo_passengers' then c.crgo_passengers
                when 'crgo_oilfield'   then c.crgo_oilfield
                when 'crgo_livestock'  then c.crgo_livestock
                when 'crgo_grainfeed'  then c.crgo_grainfeed
                when 'crgo_coalcoke'   then c.crgo_coalcoke
                when 'crgo_meat'       then c.crgo_meat
                when 'crgo_garbage'    then c.crgo_garbage
                when 'crgo_usmail'     then c.crgo_usmail
                when 'crgo_chem'       then c.crgo_chem
                when 'crgo_drybulk'    then c.crgo_drybulk
                when 'crgo_coldfood'   then c.crgo_coldfood
                when 'crgo_beverages'  then c.crgo_beverages
                when 'crgo_paperprod'  then c.crgo_paperprod
                when 'crgo_utility'    then c.crgo_utility
                when 'crgo_farmsupp'   then c.crgo_farmsupp
                when 'crgo_construct'  then c.crgo_construct
                when 'crgo_waterwell'  then c.crgo_waterwell
                when 'crgo_cargoothr'  then c.crgo_cargoothr
                else false
              end,
              false)
          )
          or (
            c.cargo_other_norm is not null
            and c.cargo_other_norm in (
              select jsonb_array_elements_text(coalesce(p_def#>'{cargo,other,include}', '[]'::jsonb))
            )
          )
        )
        and not (
          c.cargo_other_norm is not null
          and c.cargo_other_norm in (
            select jsonb_array_elements_text(coalesce(p_def#>'{cargo,other,exclude}', '[]'::jsonb))
          )
        )
      )
    )

    -- ---- power units range ----
    and (
      p_def->'power_units' is null
      or (
        (p_def#>>'{power_units,min}' is null or c.power_units >= (p_def#>>'{power_units,min}')::int)
        and (p_def#>>'{power_units,max}' is null or c.power_units <= (p_def#>>'{power_units,max}')::int)
      )
    )

    -- ---- status/authority/for-hire/interstate toggles ----
    and ((p_def#>>'{status,active_only}')::boolean is not true or c.status_code = 'A')
    and ((p_def#>>'{status,for_hire_only}')::boolean is not true or c.classdef = 'Authorized For Hire')
    and ((p_def#>>'{status,interstate_only}')::boolean is not true or c.carrier_operation ilike 'interstate%')
    and ((p_def#>>'{status,authorized_only}')::boolean is not true or coalesce(ci.authority_active, false))

    -- ---- insurance threshold (never silent -- enforce/require_insured are explicit opt-ins) ----
    and ((p_def#>>'{insurance,enforce}')::boolean is not true
         or coalesce(ci.bipd_on_file, 0) >= coalesce((p_def#>>'{insurance,min_bipd}')::bigint, 0))
    and ((p_def#>>'{insurance,require_insured}')::boolean is not true or coalesce(ci.bipd_on_file, 0) > 0)

    -- ---- contactability (F16/G4) ----
    and ((p_def#>>'{contactability,has_phone}')::boolean is not true
         or coalesce(c.contact_phone_override, c.phone, c.cell_phone) is not null)
    and ((p_def#>>'{contactability,has_email}')::boolean is not true
         or coalesce(c.contact_email_override, c.email_address::text) is not null)

    -- ---- global DNC (locked rule; default true when the key is absent) ----
    and (not coalesce((p_def->>'exclude_dnc')::boolean, true) or not c.do_not_contact)
$$;

comment on function internal.matching_carriers is
  'D4 keystone: dot_numbers matching a search_definition (§4). Reused (by joining back to '
  'public.carriers for row data) by search_carriers, count_carriers, facet_other_values, '
  'facet_suggested_keywords, facet_cargo_flags, search_carriers_map, create_batch and '
  'refresh_batch -- guarantees these can never disagree with each other.';
