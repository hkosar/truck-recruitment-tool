-- ============================================================================
-- reset-fictional-data.sql -- deterministic staging data reset; never run against production
-- Spec: docs/build-plan/01-architecture.md Part A §8; 05-verification.md §3.1
-- (post-migration probes); 00-master-plan.md M1.2 AC.
--
-- Strategy: setseed() makes every random() call in this SESSION reproducible
-- run-to-run (`supabase db reset` always yields the same data). ~785 carriers
-- are bulk-generated via generate_series, mirroring mockup/src/data.js's
-- distributions (tier mix, city weights, insurance/authority/safety spreads,
-- email fill rate, geocode precision tiers). A further ~15 HAND-AUTHORED
-- carriers (dot_number 1400001+, clearly out of the bulk range which tops out
-- ~1307674) then DETERMINISTICALLY guarantee every hard invariant listed in
-- 01 §8 / 05 §3.1 (cross-batch carrier, DNC carrier, one example of each of
-- the 9 warning codes, refresh-candidates, override columns exercised) --
-- probability alone from the bulk generation is not good enough for a "must
-- always hold" test fixture, so those cases are hand-placed, not hoped-for.
--
-- All batch membership snapshots below are computed by calling the REAL
-- internal.matching_carriers(...) function (the same one search/count/
-- create_batch/refresh_batch use in production) against real PostGIS
-- geometry, so the seed can never drift from what the app itself would
-- compute for the same search_definition + zones (D4).
--
-- NOTE ON DATES: every "warning-relevant" date (bipd_cancel_date,
-- source_missing_since, mcs150_date, etc.) is written relative to
-- CURRENT_DATE/now() at seed-load time, not as hardcoded literals -- so e.g.
-- insurance_expiring_30d keeps firing correctly no matter which real
-- calendar day `supabase db reset` is actually run on in the future.
-- ============================================================================

begin;

-- Invocation contract: set both transaction-local settings before running the reset body:
--   select set_config('app.staging_project_ref', 'yhyoxhtguyturgdhwywc', true);
--   select set_config('app.staging_reset_confirmation', 'RESET FICTIONAL TNBS RECRUITER DATA', true);
-- The hosted reset runner supplies these in the same transaction/session.
-- Fail closed unless the operator/session supplies the exact isolated staging ref.
do $$
begin
  if current_setting('app.staging_project_ref', true) is distinct from 'yhyoxhtguyturgdhwywc' then
    raise exception 'staging reset refused: app.staging_project_ref must equal yhyoxhtguyturgdhwywc';
  end if;
  if current_setting('app.staging_reset_confirmation', true) is distinct from 'RESET FICTIONAL TNBS RECRUITER DATA' then
    raise exception 'staging reset refused: confirmation phrase is missing';
  end if;
end
$$;

-- Preserve auth.users and profiles. Delete only application/pipeline data in FK order.
delete from public.contact_logs;
delete from public.contact_suppressions;
delete from public.batch_activity;
delete from public.batch_carriers;
delete from public.batch_zones;
delete from public.batches;
delete from public.cargo_other_values;
delete from public.carrier_qc_snapshots;
delete from public.carrier_inspections;
delete from public.carrier_safety;
delete from public.carrier_insurance_filings;
delete from public.carrier_insurance;
delete from public.data_quality_reports;
delete from public.pipeline_runs;
delete from public.zip_centroids;
delete from public.city_centroids;
delete from public.carriers;

-- Reset touched identity sequences where present; schema and migrations are unchanged.
select setval(pg_get_serial_sequence('public.batch_activity', 'id'), 1, false);
select setval(pg_get_serial_sequence('public.contact_suppressions', 'id'), 1, false);
select setval(pg_get_serial_sequence('public.carrier_inspections', 'id'), 1, false);
select setval(pg_get_serial_sequence('public.carrier_qc_snapshots', 'id'), 1, false);
select setval(pg_get_serial_sequence('public.pipeline_runs', 'id'), 1, false);

select setseed(0.42);

-- ----------------------------------------------------------------------------
-- 0. Word lists + weighted city table (session-local; dropped at COMMIT).
--    Carry forward the mockup's own lists (mockup/src/data.js, mockup/src/geo.js)
--    so the synthetic legal names / cargo-other text / city mix "look like"
--    the mockup the owner already reviewed.
-- ----------------------------------------------------------------------------
create temporary table tmp_cities (
  id int generated always as identity primary key,
  name text, lng double precision, lat double precision, weight int, area_code text
) on commit drop;
insert into tmp_cities (name, lng, lat, weight, area_code) values
  ('Houston',-95.37,29.76,22,'713'), ('Dallas',-96.80,32.78,18,'214'),
  ('Fort Worth',-97.33,32.75,10,'817'), ('San Antonio',-98.49,29.42,16,'210'),
  ('Austin',-97.74,30.27,16,'512'), ('Midland',-102.08,32.00,12,'432'),
  ('Odessa',-102.37,31.85,8,'432'), ('Corpus Christi',-97.40,27.80,8,'361'),
  ('Laredo',-99.51,27.51,7,'956'), ('Lubbock',-101.86,33.58,6,'806'),
  ('Waco',-97.15,31.55,7,'254'), ('Amarillo',-101.83,35.22,5,'806'),
  ('El Paso',-106.49,31.76,5,'915'), ('Beaumont',-94.10,30.08,5,'409');

create temporary table tmp_city_cum (
  name text, lng double precision, lat double precision, area_code text,
  cum_w numeric, total_w numeric
) on commit drop;
insert into tmp_city_cum
select name, lng, lat, area_code,
       sum(weight) over (order by id) as cum_w,
       sum(weight) over ()            as total_w
from tmp_cities;

create temporary table tmp_geo_words (id int generated always as identity primary key, w text) on commit drop;
insert into tmp_geo_words (w) values
 ('Lone Star'),('Brazos'),('Permian'),('Hill Country'),('Trinity'),('Bluebonnet'),('Caprock'),
 ('Guadalupe'),('Red River'),('Pecos'),('Comal'),('Frio'),('Balcones'),('Llano'),('Nueces'),
 ('Alamo'),('Big Bend'),('Gulf Coast'),('Panhandle'),('Rio Grande'),('San Jacinto'),
 ('Cross Timbers'),('Edwards'),('Blanco'),('Colorado River');

create temporary table tmp_sg_core (id int generated always as identity primary key, w text) on commit drop;
insert into tmp_sg_core (w) values
 ('Aggregate'),('Sand & Gravel'),('Rock'),('Materials'),('Dirt Works'),('Gravel'),('Aggregates'),
 ('Sand Co.'),('Rock & Sand'),('Stone'),('Base Material');

create temporary table tmp_t2_core (id int generated always as identity primary key, w text) on commit drop;
insert into tmp_t2_core (w) values
 ('Construction'),('Dump Truck'),('Excavation'),('Ready Mix'),('Concrete'),('Building Supply'),('Site Works');

create temporary table tmp_t0_core (id int generated always as identity primary key, w text) on commit drop;
insert into tmp_t0_core (w) values
 ('Logistics'),('Refrigerated'),('Tank Lines'),('Livestock'),('Van Lines'),('Distribution'),('Freightways');

create temporary table tmp_suffix (id int generated always as identity primary key, w text) on commit drop;
insert into tmp_suffix (w) values
 ('Trucking'),('Transport'),('Hauling'),('Logistics'),('Carriers'),('Express'),('LLC'),('Inc.');

create temporary table tmp_sg_other (id int generated always as identity primary key, w text) on commit drop;
insert into tmp_sg_other (w) values
 ('Sand and Gravel'),('Sand & Gravel'),('SAND/GRAVEL'),('Rock & Dirt'),('Aggregate Hauling'),('Gravel'),
 ('Sand, Gravel, Rock'),('Dirt & Aggregate'),('Crushed Stone'),('Fill Dirt / Sand'),('Sand and gravel hauling'),
 ('S&G Hauling'),('Rock, Sand, Base'),('aggregate / dirt');

create temporary table tmp_streets (id int generated always as identity primary key, w text) on commit drop;
insert into tmp_streets (w) values
 ('Farm to Market Rd'),('County Rd'),('Industrial Blvd'),('Quarry Rd'),('Old Bastrop Hwy'),('Pit Rd'),
 ('Commerce St'),('Aggregate Way'),('Loop'),('Business Park Dr'),('Ranch Rd'),('Highway 90');

create temporary table tmp_first_names (id int generated always as identity primary key, w text) on commit drop;
insert into tmp_first_names (w) values
  ('James'),('Robert'),('Maria'),('Linda'),('David'),('Carlos'),('Jennifer'),('Michael'),
  ('Patricia'),('Juan'),('Susan'),('Ricardo'),('Karen'),('Daniel'),('Rosa'),('Kevin'),
  ('Sandra'),('Miguel'),('Nancy'),('Tomas');

create temporary table tmp_last_names (id int generated always as identity primary key, w text) on commit drop;
insert into tmp_last_names (w) values
  ('Garcia'),('Smith'),('Martinez'),('Johnson'),('Rodriguez'),('Brown'),('Hernandez'),('Davis'),
  ('Lopez'),('Wilson'),('Gonzalez'),('Anderson'),('Perez'),('Taylor'),('Sanchez'),('Moore'),
  ('Ramirez'),('Jackson'),('Torres'),('White');

create temporary table tmp_counties (id int generated always as identity primary key, w text) on commit drop;
insert into tmp_counties (w) values
  ('Harris'),('Dallas'),('Tarrant'),('Bexar'),('Travis'),('Midland'),('Ector'),('Nueces'),
  ('Webb'),('Lubbock'),('McLennan'),('Potter'),('El Paso'),('Jefferson');

-- ----------------------------------------------------------------------------
-- 1. ~785 bulk-random synthetic TX carriers (+ ~15 hand-authored below = ~800)
-- ----------------------------------------------------------------------------
with draws as materialized (
  select
    i,
    random() as r_tier, random() as r_city,
    random() as r_geo_idx, random() as r_suffix_chance, random() as r_suffix_idx,
    random() as r_dba_chance, random() as r_dba_idx,
    random() as r_lng_jit, random() as r_lat_jit,
    random() as r_units, random() as r_drivers_extra,
    random() as r_officer1_first, random() as r_officer1_last,
    random() as r_officer2_first, random() as r_officer2_last, random() as r_has_officer2,
    random() as r_cell_chance, random() as r_email_chance, random() as r_email_style,
    random() as r_fax_chance,
    random() as r_classdef_a, random() as r_classdef_b,
    random() as r_operation, random() as r_active,
    random() as r_mcs150_days, random() as r_add_days,
    random() as r_street_num, random() as r_street_idx,
    random() as r_zip, random() as r_county_idx,
    random() as r_dnc_chance,
    random() as r_authority, random() as r_bipd,
    random() as r_crashes_chance, random() as r_crashes_count,
    random() as r_voos, random() as r_doos, random() as r_rating,
    random() as r_cargo_other_idx, random() as r_cargo_other_chance,
    random() as r_flag_construct, random() as r_flag_bldgmat,
    random() as r_flagset_t2, random() as r_flagset_t0,
    random() as r_geocode, random() as r_phone_a, random() as r_phone_b,
    random() as r_phone_c, random() as r_phone_d,
    random() as r_dot_jit, random() as r_first_seen_days, random() as r_changed_days
  from generate_series(1, 785) as i
),
city_pick as materialized (
  select d.i, cc.name as city_name, cc.lng as city_lng, cc.lat as city_lat, cc.area_code
  from draws d
  join lateral (
    select cw.name, cw.lng, cw.lat, cw.area_code
    from tmp_city_cum cw
    where d.r_city * cw.total_w < cw.cum_w
    order by cw.cum_w asc
    limit 1
  ) cc on true
),
words as materialized (
  select
    d.i,
    (select w from tmp_geo_words  order by id limit 1 offset floor(d.r_geo_idx    * 25)::int) as geo_word,
    (select w from tmp_sg_core    order by id limit 1 offset floor(d.r_geo_idx    * 11)::int) as sg_core_word,
    (select w from tmp_t2_core    order by id limit 1 offset floor(d.r_geo_idx    * 7)::int)  as t2_core_word,
    (select w from tmp_t0_core    order by id limit 1 offset floor(d.r_geo_idx    * 7)::int)  as t0_core_word,
    (select w from tmp_suffix     order by id limit 1 offset floor(d.r_suffix_idx * 8)::int)  as suffix_word,
    (select w from tmp_streets    order by id limit 1 offset floor(d.r_street_idx * 12)::int) as street_word,
    (select w from tmp_first_names order by id limit 1 offset floor(d.r_officer1_first * 20)::int) as o1_first,
    (select w from tmp_last_names  order by id limit 1 offset floor(d.r_officer1_last  * 20)::int) as o1_last,
    (select w from tmp_first_names order by id limit 1 offset floor(d.r_officer2_first * 20)::int) as o2_first,
    (select w from tmp_last_names  order by id limit 1 offset floor(d.r_officer2_last  * 20)::int) as o2_last,
    (select w from tmp_counties   order by id limit 1 offset floor(d.r_county_idx * 14)::int) as county_word,
    (select w from tmp_sg_other   order by id limit 1 offset floor(d.r_cargo_other_idx * 14)::int) as sg_other_word
  from draws d
),
final as materialized (
  select
    d.i,
    (1200000 + d.i * 137 + floor(d.r_dot_jit * 130)::int)::bigint as dot_number,
    case when d.r_tier < 0.60 then 1 when d.r_tier < 0.90 then 2 else 0 end as tier,
    case when d.r_flagset_t2 < 0.25 then 'a' when d.r_flagset_t2 < 0.50 then 'b'
         when d.r_flagset_t2 < 0.75 then 'c' else 'd' end as t2_combo,
    case when d.r_flagset_t0 < 1.0/6 then 'a' when d.r_flagset_t0 < 2.0/6 then 'b'
         when d.r_flagset_t0 < 3.0/6 then 'c' when d.r_flagset_t0 < 4.0/6 then 'd'
         when d.r_flagset_t0 < 5.0/6 then 'e' else 'f' end as t0_combo,
    cp.city_name, cp.area_code,
    (cp.city_lng + (d.r_lng_jit - 0.5) * 1.10) as jlng,
    (cp.city_lat + (d.r_lat_jit - 0.5) * 0.90) as jlat,
    w.geo_word, w.sg_core_word, w.t2_core_word, w.t0_core_word, w.suffix_word, w.street_word,
    w.o1_first, w.o1_last, w.o2_first, w.o2_last, w.county_word, w.sg_other_word,
    (1 + floor(power(d.r_units, 2.5) * 89))::int as power_units,
    lpad(floor(d.r_zip * 4998)::text, 4, '0')  -- combined with a fixed 750xx-79xxx-ish prefix below
      as zip_suffix,
    -- NOTE: exposed as plain named columns (not a whole-row `d` composite) so
    -- the INSERT...SELECT below can reference them as f.r_foo directly. A
    -- whole-row column would have required writing `(f.d).r_foo` (dotted
    -- field access into a composite-typed column needs parens in Postgres,
    -- `f.d.r_foo` alone does not parse the way you'd expect); flat columns
    -- sidestep the issue entirely.
    d.r_suffix_chance, d.r_dba_chance, d.r_dba_idx, d.r_street_num,
    d.r_phone_a, d.r_phone_b, d.r_phone_c, d.r_phone_d,
    d.r_cell_chance, d.r_email_chance, d.r_email_style, d.r_fax_chance,
    d.r_has_officer2, d.r_drivers_extra, d.r_classdef_a, d.r_classdef_b,
    d.r_operation, d.r_active, d.r_mcs150_days, d.r_add_days,
    d.r_flag_bldgmat, d.r_flag_construct, d.r_cargo_other_chance, d.r_cargo_other_idx,
    d.r_first_seen_days, d.r_changed_days, d.r_geocode, d.r_dnc_chance
  from draws d
  join city_pick cp on cp.i = d.i
  join words w      on w.i = d.i
)
insert into public.carriers (
  dot_number, legal_name, dba_name,
  phy_street, phy_city, phy_state, phy_zip, phy_zip5, phy_county,
  phone, cell_phone, email_address, fax,
  company_officer_1, company_officer_2,
  power_units, total_drivers, classdef, carrier_operation, status_code, mcs150_date, fmcsa_add_date, entity_type,
  crgo_genfreight, crgo_household, crgo_metalsheet, crgo_motoveh, crgo_drivetow, crgo_logpole,
  crgo_bldgmat, crgo_mobilehome, crgo_machlrg, crgo_produce, crgo_liqgas, crgo_intermodal,
  crgo_passengers, crgo_oilfield, crgo_livestock, crgo_grainfeed, crgo_coalcoke, crgo_meat,
  crgo_garbage, crgo_usmail, crgo_chem, crgo_drybulk, crgo_coldfood, crgo_beverages,
  crgo_paperprod, crgo_utility, crgo_farmsupp, crgo_construct, crgo_waterwell, crgo_cargoothr,
  crgo_cargoothr_desc,
  census_updated_at, last_synced_at, first_seen_at, address_hash, row_hash, last_changed_at,
  lat, lng, geom, geocode_precision, geocode_source, geocode_addr_hash, geocoded_at,
  do_not_contact
)
select
  f.dot_number,
  f.geo_word || ' ' || (case f.tier when 1 then f.sg_core_word when 2 then f.t2_core_word else f.t0_core_word end)
    || (case when f.tier = 1 and f.r_suffix_chance >= 0.45 then '' else ' ' || f.suffix_word end),
  case when f.r_dba_chance < 0.25
       then f.geo_word || ' ' || (array['S&G','Aggregates','Hauling','Materials'])[1 + floor(f.r_dba_idx*4)::int]
       else null end,
  (100 + floor(f.r_street_num * 9700)::int)::text || ' ' || f.street_word,
  f.city_name, 'TX',
  '75' || f.zip_suffix, '75' || f.zip_suffix, f.county_word,
  '(202) 555-' || lpad((100 + (f.i % 100))::text, 4, '0'),
  case when f.r_cell_chance < 0.55
       then '(202) 555-' || lpad((100 + ((f.i + 37) % 100))::text, 4, '0')
       else null end,
  case when f.r_email_chance < 0.22
       then (case when f.r_email_style < 0.5 then 'dispatch-' else 'info-' end)
            || lower(regexp_replace(f.geo_word || (case f.tier when 1 then f.sg_core_word when 2 then f.t2_core_word else f.t0_core_word end),
                                     '[^a-zA-Z0-9]', '', 'g')) || '@carrier.example.invalid'
       else null end,
  case when f.r_fax_chance < 0.15
       then '(202) 555-' || lpad((100 + ((f.i + 73) % 100))::text, 4, '0')
       else null end,
  f.o1_first || ' ' || f.o1_last,
  case when f.r_has_officer2 < 0.4 then f.o2_first || ' ' || f.o2_last else null end,
  f.power_units,
  f.power_units + floor(f.r_drivers_extra * 4)::int,
  case when f.r_classdef_a < 0.82 then 'Authorized For Hire'
       when f.r_classdef_b < 0.5  then 'Private (Property)'
       else 'Exempt For Hire' end,
  case when f.r_operation < 0.7 then 'Interstate' else 'Intrastate (Non-HM)' end,
  case when f.r_active < 0.9 then 'A' else 'I' end,
  current_date - (20 + floor(f.r_mcs150_days * 1380))::int,
  current_date - (365 + floor(f.r_add_days * 3285))::int,
  'Carrier',
  -- 30 crgo_* flags: only the categories the mockup ever sets are non-false (see file header)
  (f.tier = 0 and f.t0_combo in ('a','f')),                              -- crgo_genfreight
  false, false,                                                          -- crgo_household, crgo_metalsheet
  (f.tier = 0 and f.t0_combo = 'e'),                                     -- crgo_motoveh
  false, false,                                                          -- crgo_drivetow, crgo_logpole
  (f.tier = 1 and f.r_flag_bldgmat < 0.4) or (f.tier = 2 and f.t2_combo in ('b','c')) or (f.tier = 0 and f.t0_combo = 'f'), -- crgo_bldgmat
  false, false, false,                                                   -- crgo_mobilehome, crgo_machlrg, crgo_produce
  false, false,                                                          -- crgo_liqgas, crgo_intermodal
  false, false,                                                          -- crgo_passengers, crgo_oilfield
  (f.tier = 0 and f.t0_combo = 'd'),                                     -- crgo_livestock
  false, false, false, false, false,                                    -- crgo_grainfeed, crgo_coalcoke, crgo_meat, crgo_garbage, crgo_usmail
  false,                                                                 -- crgo_chem
  (f.tier = 1) or (f.tier = 2 and f.t2_combo in ('a','d')),              -- crgo_drybulk
  (f.tier = 0 and f.t0_combo = 'b'),                                     -- crgo_coldfood
  false, false, false, false,                                           -- crgo_beverages, crgo_paperprod, crgo_utility, crgo_farmsupp
  (f.tier = 1 and f.r_flag_construct < 0.6) or (f.tier = 2 and f.t2_combo in ('a','b')) or (f.tier = 0 and f.t0_combo = 'f'), -- crgo_construct
  false,                                                                 -- crgo_waterwell
  case when f.tier = 1 then true
       when f.tier = 2 and f.r_cargo_other_chance < 0.15 then true
       else false end,                                                  -- crgo_cargoothr
  case when f.tier = 1 then f.sg_other_word
       when f.tier = 2 and f.r_cargo_other_chance < 0.15
         then (array['Base rock','Materials','Construction debris'])[1 + floor(f.r_cargo_other_idx*3)::int]
       else null end,
  now(), now(),
  now() - ((30 + floor(f.r_first_seen_days * 400))::int || ' days')::interval,
  md5(coalesce((100 + floor(f.r_street_num * 9700)::int)::text,'') || '|' || f.city_name || '|TX|' || '75' || f.zip_suffix),
  md5(f.dot_number::text || f.geo_word || f.zip_suffix),
  now() - (floor(f.r_changed_days * 30)::int || ' days')::interval,
  case when f.r_geocode < 0.97 then f.jlat else null end,
  case when f.r_geocode < 0.97 then f.jlng else null end,
  case when f.r_geocode < 0.97
       then st_setsrid(st_makepoint(f.jlng, f.jlat), 4326)::geography else null end,
  case when f.r_geocode < 0.70 then 'rooftop'::geocode_precision
       when f.r_geocode < 0.85 then 'range_interpolated'::geocode_precision
       when f.r_geocode < 0.93 then 'zip_centroid'::geocode_precision
       when f.r_geocode < 0.97 then 'city_centroid'::geocode_precision
       else 'none'::geocode_precision end,
  case when f.r_geocode < 0.97 then 'seed' else null end,
  case when f.r_geocode < 0.97
       then md5(coalesce((100 + floor(f.r_street_num * 9700)::int)::text,'') || '|' || f.city_name || '|TX|' || '75' || f.zip_suffix)
       else null end,
  case when f.r_geocode < 0.97 then now() - (floor(f.r_geocode * 60)::int || ' days')::interval else null end,
  (f.tier <> 0 and f.r_dnc_chance < 0.02)
from final f;

-- ----------------------------------------------------------------------------
-- 2. carrier_insurance + carrier_safety for the 785 bulk carriers
-- ----------------------------------------------------------------------------
with base as materialized (
  select c.dot_number,
         random() as r_authority, random() as r_bipd, random() as r_cancel_chance, random() as r_cancel_days,
         random() as r_effective_days
  from public.carriers c
  where c.dot_number between 1200000 and 1307999   -- the bulk range only
),
picked as materialized (
  select
    dot_number,
    case when r_authority < 0.72 then 'active'::authority_status
         when r_authority < 0.90 then 'pending'::authority_status
         else 'inactive'::authority_status end as common_status,
    case
      when r_bipd < 0.10 then 0::bigint
      when r_bipd < 0.28 then 500000::bigint
      when r_bipd < 0.45 then 750000::bigint
      when r_bipd < 0.82 then 1000000::bigint
      else 2000000::bigint
    end as bipd_on_file,
    r_cancel_chance, r_cancel_days, r_effective_days
  from base
)
insert into public.carrier_insurance (
  dot_number, common_status, contract_status, broker_status,
  bipd_required, bipd_on_file, bipd_cancel_date, cargo_on_file, bond_on_file,
  insurer_name, insurance_effective_date, last_synced_at
)
select
  dot_number, common_status, 'none'::authority_status, 'none'::authority_status,
  750000, bipd_on_file,
  -- ~4% of rows get a genuinely-soon cancellation (exercises insurance_expiring_30d
  -- organically too, on top of the guaranteed hand-authored example below)
  case when r_cancel_chance < 0.04 then current_date + (3 + floor(r_cancel_days*27))::int else null end,
  case when bipd_on_file > 0 then 100000 else 0 end,
  case when bipd_on_file > 0 then 25000 else 0 end,
  'Texas Sure Insurance Co.',
  current_date - (30 + floor(r_effective_days*900))::int,
  now()
from picked;

with base as materialized (
  select c.dot_number,
         random() as r_crash_chance, random() as r_crash_n,
         random() as r_insp, random() as r_voos, random() as r_doos, random() as r_rating
  from public.carriers c
  where c.dot_number between 1200000 and 1307999
)
insert into public.carrier_safety (
  dot_number, snapshot_month,
  crash_total_24mo, crash_fatal_24mo, crash_injury_24mo, crash_tow_24mo,
  inspections_24mo, driver_insp_24mo, driver_oos_24mo, vehicle_insp_24mo, vehicle_oos_24mo,
  driver_oos_rate, vehicle_oos_rate, safety_rating, safety_rating_date, last_synced_at
)
select
  dot_number, date_trunc('month', current_date)::date,
  crash_total, case when crash_total > 0 and random() < 0.05 then 1 else 0 end,
  least(crash_total, floor(random()*2)::int),
  greatest(0, crash_total - floor(random()*2)::int),
  insp_total, floor(insp_total*0.6)::int, driver_oos, floor(insp_total*0.4)::int, vehicle_oos,
  round(doos_rate,2), round(voos_rate,2), rating,
  case when rating is not null then current_date - (60 + floor(random()*1500))::int else null end,
  now()
from (
  select
    dot_number,
    case when r_crash_chance < 0.7 then 0 else 1 + floor(r_crash_n * 6)::int end as crash_total,
    floor(r_insp * 40)::int as insp_total,
    round((r_voos * 42)::numeric, 2) as voos_rate,
    round((r_doos * 22)::numeric, 2) as doos_rate,
    floor((r_doos*22)/100 * (floor(r_insp*40)*0.6))::int as driver_oos,
    floor((r_voos*42)/100 * (floor(r_insp*40)*0.4))::int as vehicle_oos,
    case when r_rating < 0.55 then null
         when r_rating < 0.90 then 'Satisfactory'
         when r_rating < 0.97 then 'Conditional'
         else 'Unsatisfactory' end as rating
  from base
) x;

-- ============================================================================
-- 3. Hand-authored "invariant" carriers (dot_number 1400001-1400015) --
--    deterministically guarantee every hard test case from 01 §8 / 05 §3.1
--    regardless of how the bulk random draws above happened to land.
-- ============================================================================

insert into public.carriers (
  dot_number, legal_name, dba_name, phy_street, phy_city, phy_state, phy_zip, phy_zip5, phy_county,
  phone, cell_phone, email_address, company_officer_1, company_officer_2,
  power_units, total_drivers, classdef, carrier_operation, status_code, mcs150_date, entity_type,
  crgo_drybulk, crgo_construct, crgo_bldgmat, crgo_cargoothr, crgo_cargoothr_desc,
  census_updated_at, last_synced_at, first_seen_at, address_hash, row_hash, last_changed_at,
  source_missing_since,
  contact_name_override, contact_phone_override, contact_email_override,
  lat, lng, geom, geocode_precision, geocode_source, geocode_addr_hash, geocoded_at,
  do_not_contact, dnc_reason, dnc_set_at
) values
  -- 1400001: the CROSS-BATCH carrier -- dead center on Austin so it genuinely
  -- falls inside both Batch A's Austin-radius zone AND Batch B's Austin-end
  -- corridor buffer (no need to "hope" the geometry lines up).
  (1400001, 'Colorado River Sand & Gravel LLC', 'CRSG Hauling', '4400 Quarry Rd', 'Austin', 'TX', '78744', '78744', 'Travis',
   '(512) 555-0101', '(512) 555-0102', 'dispatch-crsg@carrier.example.invalid', 'Walter Odom', 'Denise Odom',
   14, 15, 'Authorized For Hire', 'Interstate', 'A', current_date - 200, 'Carrier',
   true, true, false, true, 'Sand and Gravel',
   now(), now(), now() - interval '260 days', md5('4400 Quarry Rd|Austin|TX|78744'), md5('1400001'), now() - interval '5 days',
   null, null, null, null,
   30.267, -97.743, st_setsrid(st_makepoint(-97.743, 30.267), 4326)::geography, 'rooftop', 'seed', md5('4400 Quarry Rd|Austin|TX|78744'), now() - interval '5 days',
   false, null, null),

  -- 1400002: the DNC carrier -- otherwise a clean Tier-1 match for Batch A so
  -- it can be seeded as an EXISTING member that later got marked DNC (the
  -- realistic path: DNC never blocks pre-existing membership, only new
  -- matches). do_not_contact set well after added_at (see batch_carriers below).
  (1400002, 'Bluebonnet Aggregate Transport Inc.', null, '900 Pit Rd', 'Austin', 'TX', '78725', '78725', 'Travis',
   '(512) 555-0103', null, null, 'Nora Castillo', null,
   9, 10, 'Authorized For Hire', 'Interstate', 'A', current_date - 90, 'Carrier',
   true, false, true, true, 'Aggregate Hauling',
   now(), now(), now() - interval '180 days', md5('900 Pit Rd|Austin|TX|78725'), md5('1400002'), now() - interval '2 days',
   null, null, null, null,
   30.29, -97.70, st_setsrid(st_makepoint(-97.70, 30.29), 4326)::geography, 'rooftop', 'seed', md5('900 Pit Rd|Austin|TX|78725'), now() - interval '2 days',
   true, 'Asked not to be contacted', now() - interval '10 days'),

  -- 1400003 / 1400004: REFRESH-CANDIDATE carriers -- genuinely match Batch A's
  -- and Batch B's definition+zones respectively, but deliberately excluded
  -- from the initial snapshot insert below (05 §3.1 refresh-candidate invariant).
  (1400003, 'Balcones Rock & Sand Co.', null, '210 Ranch Rd', 'Austin', 'TX', '78737', '78737', 'Travis',
   '(512) 555-0104', '(512) 555-0105', 'info-balcones@carrier.example.invalid', 'Herbert Lyons', null,
   6, 7, 'Authorized For Hire', 'Interstate', 'A', current_date - 150, 'Carrier',
   true, true, false, true, 'Rock & Dirt',
   now(), now(), now() - interval '90 days', md5('210 Ranch Rd|Austin|TX|78737'), md5('1400003'), now() - interval '1 days',
   null, null, null, null,
   30.15, -97.85, st_setsrid(st_makepoint(-97.85, 30.15), 4326)::geography, 'range_interpolated', 'seed', md5('210 Ranch Rd|Austin|TX|78737'), now() - interval '1 days',
   false, null, null),
  (1400004, 'Guadalupe Gravel Express', null, '77 Loop', 'San Antonio', 'TX', '78201', '78201', 'Bexar',
   '(210) 555-0106', null, 'dispatch-guadalupe@carrier.example.invalid', 'Ester Vance', 'Omar Vance',
   11, 12, 'Authorized For Hire', 'Interstate', 'A', current_date - 60, 'Carrier',
   true, false, false, true, 'Gravel',
   now(), now(), now() - interval '40 days', md5('77 Loop|San Antonio|TX|78201'), md5('1400004'), now(),
   null, null, null, null,
   29.44, -98.47, st_setsrid(st_makepoint(-98.47, 29.44), 4326)::geography, 'rooftop', 'seed', md5('77 Loop|San Antonio|TX|78201'), now(),
   false, null, null),

  -- 1400005: carrier_inactive (status_code <> 'A')
  (1400005, 'Panhandle Freightways LLC', null, '12 Highway 90', 'Amarillo', 'TX', '79101', '79101', 'Potter',
   '(806) 555-0107', null, null, 'Glenn Ashby', null,
   4, 4, 'Authorized For Hire', 'Interstate', 'I', current_date - 500, 'Carrier',
   false, false, false, false, null,
   now(), now(), now() - interval '700 days', md5('12 Highway 90|Amarillo|TX|79101'), md5('1400005'), now() - interval '400 days',
   null, null, null, null,
   35.20, -101.80, st_setsrid(st_makepoint(-101.80, 35.20), 4326)::geography, 'city_centroid', 'seed', md5('12 Highway 90|Amarillo|TX|79101'), now() - interval '400 days',
   false, null, null),

  -- 1400006: no_insurance (no carrier_insurance row at all -- inserted below WITHOUT one)
  (1400006, 'Caprock Base Material Co.', null, '55 Commerce St', 'Lubbock', 'TX', '79401', '79401', 'Lubbock',
   '(806) 555-0108', '(806) 555-0109', null, 'Ida Wren', null,
   7, 8, 'Authorized For Hire', 'Interstate', 'A', current_date - 120, 'Carrier',
   true, false, false, true, 'Base Material',
   now(), now(), now() - interval '200 days', md5('55 Commerce St|Lubbock|TX|79401'), md5('1400006'), now() - interval '3 days',
   null, null, null, null,
   33.58, -101.85, st_setsrid(st_makepoint(-101.85, 33.58), 4326)::geography, 'rooftop', 'seed', md5('55 Commerce St|Lubbock|TX|79401'), now() - interval '3 days',
   false, null, null),

  -- 1400007: insurance_below_standard ($500k on file, via carrier_insurance below)
  (1400007, 'Frio Stone Carriers', null, '340 Industrial Blvd', 'Laredo', 'TX', '78040', '78040', 'Webb',
   '(956) 555-0110', null, 'ops-frio@carrier.example.invalid', 'Ana Beltran', 'Luis Beltran',
   10, 11, 'Authorized For Hire', 'Interstate', 'A', current_date - 80, 'Carrier',
   true, true, false, true, 'Crushed Stone',
   now(), now(), now() - interval '300 days', md5('340 Industrial Blvd|Laredo|TX|78040'), md5('1400007'), now() - interval '2 days',
   null, null, null, null,
   27.53, -99.49, st_setsrid(st_makepoint(-99.49, 27.53), 4326)::geography, 'rooftop', 'seed', md5('340 Industrial Blvd|Laredo|TX|78040'), now() - interval '2 days',
   false, null, null),

  -- 1400008: insurance_expiring_30d (bipd_cancel_date = current_date+15 below)
  (1400008, 'Edwards Plateau Hauling', null, '19 County Rd', 'San Antonio', 'TX', '78245', '78245', 'Bexar',
   '(210) 555-0111', '(210) 555-0112', 'dispatch-edwards@carrier.example.invalid', 'Wanda Klein', null,
   13, 14, 'Authorized For Hire', 'Interstate', 'A', current_date - 40, 'Carrier',
   true, false, true, true, 'Dirt & Aggregate',
   now(), now(), now() - interval '500 days', md5('19 County Rd|San Antonio|TX|78245'), md5('1400008'), now() - interval '1 days',
   null, null, null, null,
   29.50, -98.65, st_setsrid(st_makepoint(-98.65, 29.50), 4326)::geography, 'rooftop', 'seed', md5('19 County Rd|San Antonio|TX|78245'), now() - interval '1 days',
   false, null, null),

  -- 1400009: authority_not_active (has an insurance row, but authority inactive)
  (1400009, 'Nueces Dirt Works', null, '81 Aggregate Way', 'Corpus Christi', 'TX', '78401', '78401', 'Nueces',
   '(361) 555-0113', null, null, 'Bruce Camacho', null,
   5, 6, 'Authorized For Hire', 'Interstate', 'A', current_date - 220, 'Carrier',
   true, false, false, true, 'Sand, Gravel, Rock',
   now(), now(), now() - interval '350 days', md5('81 Aggregate Way|Corpus Christi|TX|78401'), md5('1400009'), now() - interval '6 days',
   null, null, null, null,
   27.78, -97.42, st_setsrid(st_makepoint(-97.42, 27.78), 4326)::geography, 'range_interpolated', 'seed', md5('81 Aggregate Way|Corpus Christi|TX|78401'), now() - interval '6 days',
   false, null, null),

  -- 1400010: safety_rating (Conditional)
  (1400010, 'Pecos Trail Aggregates', null, '1200 Business Park Dr', 'Odessa', 'TX', '79761', '79761', 'Ector',
   '(432) 555-0114', '(432) 555-0115', 'info-pecos@carrier.example.invalid', 'Faye Nolan', 'Curtis Nolan',
   16, 17, 'Authorized For Hire', 'Interstate', 'A', current_date - 30, 'Carrier',
   true, true, true, true, 'Fill Dirt / Sand',
   now(), now(), now() - interval '600 days', md5('1200 Business Park Dr|Odessa|TX|79761'), md5('1400010'), now(),
   null, null, null, null,
   31.85, -102.37, st_setsrid(st_makepoint(-102.37, 31.85), 4326)::geography, 'rooftop', 'seed', md5('1200 Business Park Dr|Odessa|TX|79761'), now(),
   false, null, null),

  -- 1400011: high_oos (vehicle_oos_rate/driver_oos_rate set high below)
  (1400011, 'Llano Uplift Trucking', null, '65 Quarry Rd', 'Fort Worth', 'TX', '76102', '76102', 'Tarrant',
   '(817) 555-0116', null, 'dispatch-llano@carrier.example.invalid', 'Grant Pope', null,
   8, 9, 'Authorized For Hire', 'Interstate', 'A', current_date - 100, 'Carrier',
   true, false, true, true, 'S&G Hauling',
   now(), now(), now() - interval '450 days', md5('65 Quarry Rd|Fort Worth|TX|76102'), md5('1400011'), now() - interval '4 days',
   null, null, null, null,
   32.75, -97.33, st_setsrid(st_makepoint(-97.33, 32.75), 4326)::geography, 'rooftop', 'seed', md5('65 Quarry Rd|Fort Worth|TX|76102'), now() - interval '4 days',
   false, null, null),

  -- 1400012: recent_crashes (crash_total_24mo >= 4 below)
  (1400012, 'Trinity Bend Materials', null, '48 Old Bastrop Hwy', 'Dallas', 'TX', '75201', '75201', 'Dallas',
   '(214) 555-0117', '(214) 555-0118', null, 'Iris Marsh', 'Todd Marsh',
   20, 21, 'Authorized For Hire', 'Interstate', 'A', current_date - 70, 'Carrier',
   true, true, false, true, 'aggregate / dirt',
   now(), now(), now() - interval '800 days', md5('48 Old Bastrop Hwy|Dallas|TX|75201'), md5('1400012'), now() - interval '7 days',
   null, null, null, null,
   32.78, -96.80, st_setsrid(st_makepoint(-96.80, 32.78), 4326)::geography, 'rooftop', 'seed', md5('48 Old Bastrop Hwy|Dallas|TX|75201'), now() - interval '7 days',
   false, null, null),

  -- 1400013: missing_from_source (source_missing_since = current_date - 5)
  (1400013, 'Comal Springs Hauling', null, '9 Farm to Market Rd', 'San Antonio', 'TX', '78223', '78223', 'Bexar',
   '(210) 555-0119', null, 'ops-comal@carrier.example.invalid', 'Dale Osorio', null,
   3, 3, 'Authorized For Hire', 'Interstate', 'A', current_date - 900, 'Carrier',
   true, false, false, false, null,
   now(), now() - interval '5 days', now() - interval '900 days', md5('9 Farm to Market Rd|San Antonio|TX|78223'), md5('1400013'), now() - interval '5 days',
   current_date - 5, null, null, null,
   29.35, -98.40, st_setsrid(st_makepoint(-98.40, 29.35), 4326)::geography, 'zip_centroid', 'seed', md5('9 Farm to Market Rd|San Antonio|TX|78223'), now() - interval '900 days',
   false, null, null),

  -- 1400014: MULTI-WARNING carrier (insurance_below_standard + high_oos +
  -- recent_crashes all at once) -- exercises the WarningChips multi-badge case.
  (1400014, 'Red River Chameleon Hauling', null, '3 Pit Rd', 'Dallas', 'TX', '75217', '75217', 'Dallas',
   '(214) 555-0120', null, null, 'Otis Prather', null,
   6, 6, 'Authorized For Hire', 'Interstate', 'A', current_date - 1000, 'Carrier',
   true, false, false, true, 'Rock, Sand, Base',
   now(), now(), now() - interval '1000 days', md5('3 Pit Rd|Dallas|TX|75217'), md5('1400014'), now() - interval '10 days',
   null, null, null, null,
   32.70, -96.75, st_setsrid(st_makepoint(-96.75, 32.70), 4326)::geography, 'approximate', 'seed', md5('3 Pit Rd|Dallas|TX|75217'), now() - interval '10 days',
   false, null, null),

  -- 1400015: contact-override demonstration carrier (F18 MVP: manual research
  -- fills the app-owned override columns; contact_name/coalesce logic exercised).
  (1400015, 'Hill Country Overrides Trucking', null, '501 Ranch Rd', 'Austin', 'TX', '78652', '78652', 'Travis',
   '(512) 555-0121', null, null, 'J. Original Officer', null,
   12, 13, 'Authorized For Hire', 'Interstate', 'A', current_date - 45, 'Carrier',
   true, true, false, true, 'Sand and gravel hauling',
   now(), now(), now() - interval '75 days', md5('501 Ranch Rd|Austin|TX|78652'), md5('1400015'), now() - interval '1 days',
   null, 'Patricia Overridden-Contact', '(512) 555-0199', 'corrected-contact@carrier.example.invalid',
   30.10, -97.95, st_setsrid(st_makepoint(-97.95, 30.10), 4326)::geography, 'rooftop', 'seed', md5('501 Ranch Rd|Austin|TX|78652'), now() - interval '1 days',
   false, null, null);

-- Insurance rows for the invariant carriers (1400006 deliberately has NONE --
-- exercises the "no carrier_insurance row at all" branch of no_insurance).
insert into public.carrier_insurance (dot_number, common_status, contract_status, broker_status, bipd_required, bipd_on_file, bipd_cancel_date, cargo_on_file, bond_on_file, insurer_name, insurance_effective_date, last_synced_at) values
  (1400001, 'active', 'none', 'none', 750000, 1000000, null, 100000, 25000, 'Texas Sure Insurance Co.', current_date - 200, now()),
  (1400002, 'active', 'none', 'none', 750000, 1000000, null, 100000, 25000, 'Texas Sure Insurance Co.', current_date - 300, now()),
  (1400003, 'active', 'none', 'none', 750000, 750000,  null, 100000, 25000, 'Texas Sure Insurance Co.', current_date - 150, now()),
  (1400004, 'active', 'none', 'none', 750000, 1000000, null, 100000, 25000, 'Texas Sure Insurance Co.', current_date - 90,  now()),
  (1400005, 'inactive','none', 'none', 750000, 0,        null, 0, 0,        'Texas Sure Insurance Co.', current_date - 900, now()),
  -- 1400006 intentionally has NO row.
  (1400007, 'active', 'none', 'none', 750000, 500000,  null, 100000, 25000, 'Texas Sure Insurance Co.', current_date - 400, now()),
  (1400008, 'active', 'none', 'none', 750000, 1000000, current_date + 15, 100000, 25000, 'Texas Sure Insurance Co.', current_date - 500, now()),
  (1400009, 'pending','none', 'none', 750000, 1000000, null, 100000, 25000, 'Texas Sure Insurance Co.', current_date - 350, now()),
  (1400010, 'active', 'none', 'none', 750000, 2000000, null, 100000, 25000, 'Texas Sure Insurance Co.', current_date - 600, now()),
  (1400011, 'active', 'none', 'none', 750000, 1000000, null, 100000, 25000, 'Texas Sure Insurance Co.', current_date - 450, now()),
  (1400012, 'active', 'none', 'none', 750000, 2000000, null, 100000, 25000, 'Texas Sure Insurance Co.', current_date - 800, now()),
  (1400013, 'inactive','none', 'none', 750000, 0,        null, 0, 0,        'Texas Sure Insurance Co.', current_date - 900, now()),
  (1400014, 'active', 'none', 'none', 750000, 500000,  null, 100000, 25000, 'Texas Sure Insurance Co.', current_date - 1000, now()),
  (1400015, 'active', 'none', 'none', 750000, 1000000, null, 100000, 25000, 'Texas Sure Insurance Co.', current_date - 75,  now());

-- Safety rows for the invariant carriers (ratings/crash/OOS tuned per-code).
insert into public.carrier_safety (dot_number, snapshot_month, crash_total_24mo, crash_fatal_24mo, crash_injury_24mo, crash_tow_24mo, inspections_24mo, driver_insp_24mo, driver_oos_24mo, vehicle_insp_24mo, vehicle_oos_24mo, driver_oos_rate, vehicle_oos_rate, safety_rating, safety_rating_date, last_synced_at) values
  (1400001, date_trunc('month', current_date)::date, 0, 0, 0, 0, 12, 8, 0, 4, 0, 0,    0,    'Satisfactory', current_date - 200, now()),
  (1400002, date_trunc('month', current_date)::date, 0, 0, 0, 0, 6,  4, 0, 2, 0, 0,    0,    null,           null,              now()),
  (1400003, date_trunc('month', current_date)::date, 0, 0, 0, 0, 5,  3, 0, 2, 0, 0,    0,    null,           null,              now()),
  (1400004, date_trunc('month', current_date)::date, 0, 0, 0, 0, 8,  5, 0, 3, 0, 0,    0,    'Satisfactory', current_date - 90, now()),
  (1400005, date_trunc('month', current_date)::date, 1, 0, 1, 0, 2,  1, 0, 1, 0, 0,    0,    null,           null,              now()),
  (1400006, date_trunc('month', current_date)::date, 0, 0, 0, 0, 3,  2, 0, 1, 0, 0,    0,    null,           null,              now()),
  (1400007, date_trunc('month', current_date)::date, 0, 0, 0, 0, 9,  6, 0, 3, 0, 0,    0,    'Satisfactory', current_date - 80, now()),
  (1400008, date_trunc('month', current_date)::date, 0, 0, 0, 0, 7,  4, 0, 3, 0, 0,    0,    'Satisfactory', current_date - 40, now()),
  (1400009, date_trunc('month', current_date)::date, 0, 0, 0, 0, 4,  3, 0, 1, 0, 0,    0,    null,           null,              now()),
  (1400010, date_trunc('month', current_date)::date, 2, 0, 1, 1, 15, 9, 1, 6, 1, 8.5,  12.0, 'Conditional',  current_date - 30, now()),
  (1400011, date_trunc('month', current_date)::date, 1, 0, 0, 1, 20, 12, 2, 8, 3, 12.5, 38.0, 'Satisfactory', current_date - 100, now()),
  (1400012, date_trunc('month', current_date)::date, 5, 1, 3, 1, 18, 10, 1, 8, 2, 6.0,  20.0, 'Satisfactory', current_date - 70, now()),
  (1400013, date_trunc('month', current_date)::date, 0, 0, 0, 0, 0,  0, 0, 0, 0, 0,    0,    null,           null,              now()),
  (1400014, date_trunc('month', current_date)::date, 4, 0, 2, 2, 22, 11, 3, 9, 4, 15.0, 40.0, 'Unsatisfactory', current_date - 1000, now()),
  (1400015, date_trunc('month', current_date)::date, 0, 0, 0, 0, 10, 7, 0, 4, 0, 0,    0,    'Satisfactory', current_date - 45, now());

-- ============================================================================
-- 4. cargo_other_values -- curated facet backbone, upserted from every
--    distinct cargo_other_norm now present across all ~800 carriers, with
--    the §2.5 pattern-based pre-curation applied (sand/gravel/aggregate ->
--    is_sand_gravel true; rock/dirt/stone/base captured too but not flagged
--    Tier-1 on their own, matching the "curated, manager refines" story).
-- ============================================================================
insert into public.cargo_other_values (value, carrier_count_tx, sample_raw, match_group, is_sand_gravel, first_seen_at, last_seen_at)
select
  c.cargo_other_norm,
  count(*),
  (array_agg(c.crgo_cargoothr_desc order by c.dot_number))[1],
  case
    when c.cargo_other_norm ~ 'sand'      then 'sand'
    when c.cargo_other_norm ~ 'gravel'    then 'gravel'
    when c.cargo_other_norm ~ 'aggregate' then 'aggregate'
    when c.cargo_other_norm ~ 'rock'      then 'rock'
    when c.cargo_other_norm ~ 'dirt'      then 'dirt'
    when c.cargo_other_norm ~ 'stone'     then 'stone'
    when c.cargo_other_norm ~ 'base'      then 'base'
    else null
  end,
  c.cargo_other_norm ~ 'sand|gravel|aggregate',
  now(), now()
from public.carriers c
where c.cargo_other_norm is not null
group by c.cargo_other_norm
on conflict (value) do update set
  carrier_count_tx = excluded.carrier_count_tx,
  last_seen_at = excluded.last_seen_at;
  -- (match_group/is_sand_gravel/sample_raw are NOT touched on conflict -- same
  -- D9 discipline as production: curation survives re-sync. Not load-bearing
  -- here since this is a one-shot seed, but written the same way on purpose.)

-- ============================================================================
-- 5. Two seed batches (F21): Batch A = 2-zone multi-lane RADIUS batch
--    (earliest created_at, satisfying 05 §3.1's ">= 2 zones" probe on
--    `batches order by created_at limit 1`); Batch B = 1-zone CORRIDOR batch.
-- ============================================================================
insert into public.batches (name, customer, job, description, created_by, search_definition, snapshot_taken_at, last_refreshed_at, refresh_count, created_at)
select
  'Central Texas Aggregate Recruitment', 'Vulcan Materials', 'SH-45 Belt Widening',
  'Sand & gravel and aggregate haulers around Austin and Waco for the belt job.',
  p.id,
  jsonb_build_object(
    'cargo', jsonb_build_object(
      'flags', jsonb_build_array('crgo_drybulk','crgo_construct','crgo_bldgmat'),
      'other', jsonb_build_object('enabled', true,
                 'include', jsonb_build_array('sand and gravel','sand & gravel','gravel','aggregate hauling'),
                 'exclude', jsonb_build_array())
    ),
    'contactability', jsonb_build_object(),
    'insurance', jsonb_build_object('min_bipd', 500000, 'enforce', false, 'require_insured', false),
    'power_units', jsonb_build_object('min', 1, 'max', 200),
    'status', jsonb_build_object('active_only', true, 'authorized_only', false, 'for_hire_only', true, 'interstate_only', false),
    'exclude_dnc', true
  ),
  now() - interval '9 days', now() - interval '2 days', 1,
  now() - interval '9 days'
from public.profiles p where p.email = 'manager@tnbs-recruiter.example.invalid';

-- Every downstream statement re-derives each batch's id by its (unique,
-- seed-only) name rather than threading a variable through -- simplest thing
-- that works reliably regardless of which client executes this script.
insert into public.batch_zones (batch_id, zone_type, label, params, geom, distance_miles, sort_order)
select b.id, 'radius'::zone_type, 'Austin · 55 mi',
       jsonb_build_object('anchor_kind','city','anchor_label','Austin, TX','lng',-97.743,'lat',30.267,'radius_miles',55),
       st_setsrid(st_makepoint(-97.743,30.267),4326)::geography, 55, 0
from public.batches b where b.name = 'Central Texas Aggregate Recruitment'
union all
select b.id, 'radius'::zone_type, 'Waco · 35 mi',
       jsonb_build_object('anchor_kind','city','anchor_label','Waco, TX','lng',-97.15,'lat',31.55,'radius_miles',35),
       st_setsrid(st_makepoint(-97.15,31.55),4326)::geography, 35, 1
from public.batches b where b.name = 'Central Texas Aggregate Recruitment';

insert into public.batches (name, customer, job, description, created_by, search_definition, snapshot_taken_at, last_refreshed_at, refresh_count, created_at)
select
  'I-35 Corridor: Austin -> San Antonio', 'Martin Marietta', 'I-35 Resurfacing',
  'Any authorized-for-hire, active carrier within 40 mi of the Austin-San Antonio run.',
  p.id,
  jsonb_build_object(
    'cargo', jsonb_build_object('flags', jsonb_build_array('crgo_drybulk','crgo_construct','crgo_bldgmat')),
    'status', jsonb_build_object('active_only', true, 'for_hire_only', true),
    'exclude_dnc', true
  ),
  now() - interval '5 days', now() - interval '5 days', 0,
  now() - interval '5 days'
from public.profiles p where p.email = 'editor@tnbs-recruiter.example.invalid';

insert into public.batch_zones (batch_id, zone_type, label, params, geom, distance_miles, sort_order)
select b.id, 'corridor'::zone_type, 'Austin -> San Antonio · 40 mi',
       jsonb_build_object('origin_label','Austin, TX','dest_label','San Antonio, TX','route_provider','google',
                           'route', jsonb_build_array(jsonb_build_array(-97.743,30.267), jsonb_build_array(-98.10,29.89), jsonb_build_array(-98.494,29.424)),
                           'buffer_miles',40),
       st_setsrid(st_makeline(array[st_makepoint(-97.743,30.267), st_makepoint(-98.10,29.89), st_makepoint(-98.494,29.424)]),4326)::geography,
       40, 0
from public.batches b where b.name = 'I-35 Corridor: Austin -> San Antonio';

-- ----------------------------------------------------------------------------
-- 5b. Snapshot membership -- computed via the REAL internal.matching_carriers,
--     composing search_definition + batch_zones exactly like refresh_batch
--     does (D4: never drifts from what the app would compute). The two
--     refresh-candidate carriers (1400003 for Batch A, 1400004 for Batch B)
--     are explicitly excluded so they remain real, provable refresh targets.
-- ----------------------------------------------------------------------------
insert into public.batch_carriers (batch_id, dot_number, status, added_at, added_via_refresh)
select b.id, matched.dot_number,
       (array['new','new','new','new','attempted','attempted','contacted','contacted','interested','not_a_fit'])
         -- deterministic-but-scattered status per (carrier,batch) pair via the
         -- built-in hashtext() (int4; cast to bigint before abs() to dodge the
         -- one-in-4-billion INT_MIN overflow edge case) -- avoids any doubt
         -- about hex-string-to-bit-type cast semantics.
         [1 + (abs(hashtext(matched.dot_number::text || b.id::text)::bigint) % 10)]::batch_carrier_status,
       b.created_at, false
from public.batches b
cross join lateral (
  select mc.dot_number
  from internal.matching_carriers(
    b.search_definition || jsonb_build_object('zones',
      (select coalesce(jsonb_agg(jsonb_build_object('zone_type', z.zone_type, 'label', z.label, 'params', z.params) order by z.sort_order), '[]'::jsonb)
       from public.batch_zones z where z.batch_id = b.id)
    )
  ) mc
  where mc.dot_number <> 1400003   -- Batch A's held-back refresh candidate
    and mc.dot_number <> 1400004   -- Batch B's held-back refresh candidate
) matched
where b.name in ('Central Texas Aggregate Recruitment', 'I-35 Corridor: Austin -> San Antonio');

-- Force-include the cross-batch carrier (1400001) and the DNC carrier
-- (1400002) as members of Batch A specifically, and 1400001 into Batch B too,
-- with realistic worked statuses (ON CONFLICT DO NOTHING because 1400001 may
-- already have matched Batch A naturally above).
insert into public.batch_carriers (batch_id, dot_number, status, status_changed_at, added_at, added_via_refresh)
select b.id, 1400001, 'contacted', now() - interval '30 hours', b.created_at, false
from public.batches b where b.name = 'Central Texas Aggregate Recruitment'
on conflict (batch_id, dot_number) do update set status = excluded.status, status_changed_at = excluded.status_changed_at;

insert into public.batch_carriers (batch_id, dot_number, status, status_changed_at, added_at, added_via_refresh)
select b.id, 1400001, 'contacted', now() - interval '30 hours', b.created_at, false
from public.batches b where b.name = 'I-35 Corridor: Austin -> San Antonio'
on conflict (batch_id, dot_number) do update set status = excluded.status, status_changed_at = excluded.status_changed_at;

insert into public.batch_carriers (batch_id, dot_number, status, status_changed_at, added_at, added_via_refresh)
select b.id, 1400002, 'attempted', now() - interval '11 days', b.created_at, false
from public.batches b where b.name = 'Central Texas Aggregate Recruitment'
on conflict (batch_id, dot_number) do update set status = excluded.status, status_changed_at = excluded.status_changed_at;

-- promote a handful of 'interested' members in Batch A so F23 has data to show.
update public.batch_carriers bc
   set promoted_at = bc.status_changed_at + interval '2 hours',
       promoted_by = b.created_by
  from public.batches b
 where bc.batch_id = b.id
   and b.name = 'Central Texas Aggregate Recruitment'
   and bc.status = 'interested'
   and bc.dot_number in (
     select dot_number from public.batch_carriers bc2
     where bc2.batch_id = b.id and bc2.status = 'interested'
     order by dot_number limit 3
   );

-- ============================================================================
-- 6. batch_activity: batch_created/members_added for both batches (mirroring
--    what create_batch would have written), plus a couple of manual comments.
-- ============================================================================
insert into public.batch_activity (batch_id, actor_id, activity_type, payload, created_at)
select b.id, b.created_by, 'batch_created', jsonb_build_object('name', b.name), b.created_at
from public.batches b;

insert into public.batch_activity (batch_id, actor_id, activity_type, payload, created_at)
select b.id, b.created_by, 'members_added',
       jsonb_build_object('count', (select count(*) from public.batch_carriers bc where bc.batch_id = b.id)),
       b.created_at + interval '1 second'
from public.batches b;

insert into public.batch_activity (batch_id, actor_id, activity_type, payload, created_at)
select b.id, b.created_by, 'refresh', jsonb_build_object('added_count', 0), b.last_refreshed_at
from public.batches b where b.name = 'Central Texas Aggregate Recruitment' and b.last_refreshed_at is not null;

insert into public.batch_activity (batch_id, actor_id, activity_type, comment, created_at)
select b.id, p.id, 'comment', 'Belt job PM wants a status update by Friday -- prioritize the Austin-metro carriers first.',
       b.created_at + interval '6 hours'
from public.batches b, public.profiles p
where b.name = 'Central Texas Aggregate Recruitment' and p.email = 'editor-two@tnbs-recruiter.example.invalid';

insert into public.batch_activity (batch_id, actor_id, activity_type, comment, created_at)
select b.id, p.id, 'comment', 'Corridor buffer feels a little wide -- most hits cluster right along I-35 anyway.',
       b.created_at + interval '3 hours'
from public.batches b, public.profiles p
where b.name = 'I-35 Corridor: Austin -> San Antonio' and p.email = 'editor@tnbs-recruiter.example.invalid';

-- ============================================================================
-- 7. contact_logs (F8/G6) -- across channels; the cross-batch carrier
--    (1400001) gets logs from BOTH batch contexts to demonstrate the unified
--    per-carrier timeline (mockup's demo invariant).
-- ============================================================================
insert into public.contact_logs (dot_number, batch_id, user_id, channel, disposition, notes, next_steps, callback_at, contacted_at)
select 1400001, b.id, p.id, 'call'::contact_channel, 'connected'::contact_disposition,
       'Reached dispatcher, walked through the belt job rates.', 'Send rate sheet.', null, now() - interval '30 hours'
from public.batches b, public.profiles p
where b.name = 'Central Texas Aggregate Recruitment' and p.email = 'manager@tnbs-recruiter.example.invalid';

insert into public.contact_logs (dot_number, batch_id, user_id, channel, disposition, notes, next_steps, callback_at, contacted_at)
select 1400001, b.id, p.id, 'text'::contact_channel, 'replied'::contact_disposition,
       'Also a fit for the I-35 run -- same owner, different job.', 'Coordinate both jobs.', null, now() - interval '30 hours'
from public.batches b, public.profiles p
where b.name = 'I-35 Corridor: Austin -> San Antonio' and p.email = 'editor@tnbs-recruiter.example.invalid';

insert into public.contact_logs (dot_number, batch_id, user_id, channel, disposition, notes, next_steps, callback_at, contacted_at)
select 1400002, b.id, p.id, 'call'::contact_channel, 'no_answer'::contact_disposition,
       'No answer, no VM set up.', 'Retry tomorrow AM.', null, now() - interval '11 days'
from public.batches b, public.profiles p
where b.name = 'Central Texas Aggregate Recruitment' and p.email = 'manager@tnbs-recruiter.example.invalid';

insert into public.contact_logs (dot_number, batch_id, user_id, channel, disposition, notes, next_steps, callback_at, contacted_at)
select 1400015, b.id, p.id, 'email'::contact_channel, 'sent'::contact_disposition,
       'Sent the rate sheet to the corrected contact email on file.', 'Follow up in 3 days.', null, now() - interval '1 days'
from public.batches b, public.profiles p
where b.name = 'Central Texas Aggregate Recruitment' and p.email = 'editor-two@tnbs-recruiter.example.invalid'
  and exists (select 1 from public.batch_carriers bc where bc.batch_id = b.id and bc.dot_number = 1400015);

-- A spread of logs across a handful of Batch A's naturally-matched, worked
-- members so the members table / activity feed isn't empty for anything but
-- the hand-authored rows.
insert into public.contact_logs (dot_number, batch_id, user_id, channel, disposition, notes, next_steps, callback_at, contacted_at)
select bc.dot_number, bc.batch_id, b.created_by,
       'call'::contact_channel,
       (case bc.status
          when 'attempted'  then 'voicemail'
          when 'contacted'  then 'connected'
          when 'interested' then 'interested'
          when 'not_a_fit'  then 'not_interested'
          else 'no_answer' end)::contact_disposition,
       'Seed-generated call log for demo purposes.',
       'Follow up per pipeline stage.',
       case when bc.status = 'contacted' then now() + interval '2 days' else null end,
       coalesce(bc.status_changed_at, bc.added_at)
from public.batch_carriers bc
join public.batches b on b.id = bc.batch_id
where bc.status <> 'new'
  and bc.dot_number not in (1400001, 1400002, 1400015)
  and bc.dot_number between 1200000 and 1307999
order by bc.batch_id, bc.dot_number
limit 40;

-- Fail the entire transaction if the reset did not reproduce the fictional contract.
do $$
declare
  v_carriers bigint;
  v_batches bigint;
  v_password_users bigint;
  v_owner_profile bigint;
  v_fixture_profiles bigint;
  v_cross_batch bigint;
  v_dnc bigint;
  v_warning_codes bigint;
begin
  select count(*) into v_carriers from public.carriers;
  select count(*) into v_batches from public.batches;
  select count(*) into v_password_users from auth.users where encrypted_password is not null;
  select count(*) into v_owner_profile from public.profiles where email = 'hunter@twistednail.com' and role = 'manager' and status = 'approved';
  select count(*) into v_fixture_profiles from public.profiles where email like '%@tnbs-recruiter.example.invalid';
  select count(*) into v_cross_batch from public.batch_carriers where dot_number = 1400001;
  select count(*) into v_dnc from public.carriers where do_not_contact;
  select count(distinct code) into v_warning_codes
  from public.carrier_warnings cw cross join lateral unnest(cw.warning_reasons) as code;
  if v_carriers <> 800 or v_batches <> 2 or v_password_users <> 1 or v_owner_profile <> 1
     or v_fixture_profiles <> 7 or v_cross_batch < 2 or v_dnc < 1 or v_warning_codes <> 9 then
    raise exception 'staging reset verification failed: carriers %, batches %, password users %, owner %, fixture profiles %, cross-batch %, dnc %, warning codes %',
      v_carriers, v_batches, v_password_users, v_owner_profile, v_fixture_profiles, v_cross_batch, v_dnc, v_warning_codes;
  end if;
end
$$;

commit;

-- ============================================================================
-- End of seed. Expected shape after `supabase db reset` (see 05 §3.1):
--   exactly 800 carriers, 2 batches (earliest has 2 zones), >=1 cross-batch carrier
--   (1400001), >=1 DNC carrier (>=1400002), non-empty carrier_warnings for
--   every one of the 9 codes, and >=1 matching-but-not-a-member carrier per
--   batch (1400003, 1400004) for the refresh-candidate invariant.
-- ============================================================================
