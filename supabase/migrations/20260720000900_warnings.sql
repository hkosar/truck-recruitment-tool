-- ============================================================================
-- 20260720000900_warnings.sql -- F15/G5 warning-flag strategy (§3)
-- Spec: docs/build-plan/01-architecture.md Part A §3; amended per #8 to the
-- CLOSED NINE-code vocabulary: carrier_inactive, no_insurance,
-- insurance_below_standard, insurance_expiring_30d, authority_not_active,
-- safety_rating, high_oos, recent_crashes, missing_from_source. This is the
-- complete closed vocabulary and REPLACES Part A's original 7-code list.
--
-- Choice: STABLE SQL function + security_invoker view. Not a computed column
-- (predicate spans carriers + carrier_insurance + carrier_safety; generated
-- columns are single-table). Not stored/materialized (sources re-sync
-- daily/monthly; a stored flag is a staleness bug waiting to happen). Not
-- client-side (the flag must appear identically in list rows, profile,
-- dashboards, call-sheet exports -- G5 propagation demands one server-side
-- truth). D6 stands -- never stored; Part B computes only the *inputs*.
--
-- NOTE on IMMUTABLE -> STABLE: Part A's original 7-code function was declared
-- IMMUTABLE (safe -- no wall-clock dependency). Amendment #8's
-- insurance_expiring_30d code compares p_bipd_cancel_date to CURRENT_DATE, so
-- the function's result now legitimately depends on "when it's called" as
-- well as its arguments. Declaring that IMMUTABLE would be incorrect (Postgres
-- may cache/fold IMMUTABLE results across calls); STABLE is the correct,
-- minimal fix -- same semantics Part A intended (same result within one
-- statement/scan), safe with a CURRENT_DATE read.
-- ============================================================================

create function internal.warning_reasons(
  p_status_code text, p_bipd_on_file bigint, p_has_ins_row boolean, p_authority_active boolean,
  p_rating text, p_vehicle_oos numeric, p_driver_oos numeric, p_crashes int,
  p_bipd_cancel_date date default null, p_source_missing_since date default null
) returns text[] language sql stable as $$
  select coalesce(array_remove(array[
    case when p_status_code is distinct from 'A'                     then 'carrier_inactive'         end,
    case when not p_has_ins_row or coalesce(p_bipd_on_file,0) = 0    then 'no_insurance'              end,
    case when coalesce(p_bipd_on_file,0) between 1 and 999999        then 'insurance_below_standard'  end, -- $1MM bar; $500k stays VISIBLE (locked threshold rule)
    case when p_bipd_cancel_date is not null
              and p_bipd_cancel_date <= (current_date + 30)          then 'insurance_expiring_30d'    end, -- mirrors the owner's "Insurance Expiring Soon" counter (F24); amendment #8
    case when p_has_ins_row and not coalesce(p_authority_active,false) then 'authority_not_active'    end,
    case when p_rating in ('Conditional','Unsatisfactory')           then 'safety_rating'             end,
    case when coalesce(p_vehicle_oos,0) > 34 or coalesce(p_driver_oos,0) > 10 then 'high_oos'         end, -- ~1.5x national averages; single tuning point
    case when coalesce(p_crashes,0) >= 4                             then 'recent_crashes'            end,
    case when p_source_missing_since is not null                     then 'missing_from_source'       end  -- amendment #8: input = carriers.source_missing_since
  ], null), '{}') $$;

comment on function internal.warning_reasons is
  'Closed nine-code warning vocabulary (amendment #8; supersedes Part A''s original seven). '
  'The frontend maps codes to copy (e.g. insurance_below_standard -> "BIPD below $1MM"). This '
  'replaces the removed "exclude concerning safety" filter -- nothing is silently excluded (F15).';

create view public.carrier_warnings with (security_invoker = true) as
select c.dot_number,
       internal.warning_reasons(c.status_code, i.bipd_on_file, i.dot_number is not null,
         i.authority_active, s.safety_rating, s.vehicle_oos_rate, s.driver_oos_rate, s.crash_total_24mo,
         i.bipd_cancel_date, c.source_missing_since)
         as warning_reasons
from public.carriers c
left join public.carrier_insurance i using (dot_number)
left join public.carrier_safety    s using (dot_number);

comment on view public.carrier_warnings is
  'How rows carry reasons to the UI: every list-returning RPC in §5 ALSO includes '
  'warning_reasons text[] and has_warnings boolean per row (computed inline on the RPC''s own '
  'joins, or by LEFT JOINing this view -- no extra round trip). UI contract: '
  'warning_reasons <> ''{}'' -> pale-red row + alert chips naming each code, rendered on batch '
  'lists, search results, the profile header, and the generated call sheet (F15/G5).';
