-- ============================================================================
-- 20260720001100_rpc.sql -- public RPC surface + dashboard view
-- Spec: docs/build-plan/01-architecture.md Part A §5 (all subsections) + the
-- "Contract reconciliation" section item 3 (facet_cargo_flags,
-- batch_members/_map filter-parity args) + amendments #8 (nine-code warnings
-- flow through every list RPC), #10 (batch_members_map parity + row_num),
-- #11 (batch_status_counts, dashboard_totals, batch_dashboard.warnings_count
-- /with_phone, count_carriers.tier1_count), #19 (log_export).
--
-- Language/security choices (own engineering judgment, not literal spec text
-- -- see manifest): `language sql` for every pure single-query RPC (matches
-- Part A's OWN worked examples elsewhere, e.g. internal.warning_reasons,
-- internal.current_app_role -- both `language sql`); `language plpgsql` only
-- where real procedural logic is needed (create_batch, refresh_batch,
-- bulk_set_status, set_do_not_contact, log_export). Those five are also
-- SECURITY DEFINER: §6 states outright that "auto rows come from SECURITY
-- DEFINER triggers/RPCs" for batch_activity's non-comment activity_types,
-- which the plain `act_comment` RLS policy (insert restricted to
-- activity_type='comment') would otherwise block -- each such function
-- therefore re-implements its own authorization check via
-- internal.can_edit(), written NULL-safe (coalesce(...,false)) since a bare
-- `if not internal.can_edit() then raise` would silently ALLOW an anon/
-- unapproved caller (current_app_role() returns NULL for them, and
-- `if NULL then` never raises in PL/pgSQL). Every other RPC stays the
-- documented default, SECURITY INVOKER, so RLS on the underlying tables does
-- the access control (non-staff simply get empty results, matching the RLS
-- negative matrix's "0 rows / denied" expectation for reads).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Shared helper: the exact same filtered+sorted+row-numbered member list is
-- used by BOTH batch_members and batch_members_map so "list # = pin #" holds
-- under every sort/filter by construction (amendment #10 / M5.3 AC) -- same
-- DRY principle as internal.matching_carriers for search/count/facets (D4).
-- ----------------------------------------------------------------------------
create or replace function internal.batch_members_ordered(
  p_batch_id       uuid,
  p_status         batch_carrier_status[],
  p_q              text,
  p_warnings_only  boolean,
  p_min_insurance  bigint,
  p_size_min       int,
  p_size_max       int,
  p_has_phone      boolean,
  p_has_email      boolean,
  p_sort           text,
  p_dir            text
)
returns table (dot_number bigint, row_num int)
language sql
stable
as $$
  with base as (
    select
      bc.dot_number, bc.status, bc.added_at,
      c.legal_name, c.phy_city, c.power_units,
      ci.bipd_on_file,
      coalesce(cw.warning_reasons,'{}') as warning_reasons,
      lc.last_contact_at
    from public.batch_carriers bc
    join public.carriers c on c.dot_number = bc.dot_number
    left join public.carrier_insurance ci on ci.dot_number = bc.dot_number
    left join public.carrier_warnings cw on cw.dot_number = bc.dot_number
    left join lateral (
      select max(cl.contacted_at) as last_contact_at
      from public.contact_logs cl where cl.dot_number = bc.dot_number
    ) lc on true
    where bc.batch_id = p_batch_id
      and (p_status is null or bc.status = any(p_status))
      and (p_warnings_only is not true or coalesce(cw.warning_reasons,'{}') <> '{}')
      and (p_min_insurance is null or coalesce(ci.bipd_on_file,0) >= p_min_insurance)
      and (p_size_min is null or c.power_units >= p_size_min)
      and (p_size_max is null or c.power_units <= p_size_max)
      and (p_has_phone is null or (coalesce(c.contact_phone_override, c.phone, c.cell_phone) is not null) = p_has_phone)
      and (p_has_email is null or (coalesce(c.contact_email_override, c.email_address::text) is not null) = p_has_email)
      and (
        p_q is null or btrim(p_q) = ''
        or (c.legal_name || ' ' || coalesce(c.dba_name,'')) ilike '%' || p_q || '%'
        or c.dot_number::text like p_q || '%'
      )
  )
  select
    b.dot_number,
    (row_number() over (order by
      -- enum group (status -- pipeline-declared order, not alphabetical)
      case when p_dir is distinct from 'desc' then case p_sort when 'status' then b.status end end asc nulls last,
      case when p_dir = 'desc' then case p_sort when 'status' then b.status end end desc nulls last,
      -- text group
      case when p_dir is distinct from 'desc' then case p_sort when 'legal_name' then b.legal_name when 'phy_city' then b.phy_city end end asc nulls last,
      case when p_dir = 'desc' then case p_sort when 'legal_name' then b.legal_name when 'phy_city' then b.phy_city end end desc nulls last,
      -- numeric group
      case when p_dir is distinct from 'desc' then case p_sort when 'power_units' then b.power_units end end asc nulls last,
      case when p_dir = 'desc' then case p_sort when 'power_units' then b.power_units end end desc nulls last,
      -- timestamp group
      case when p_dir is distinct from 'desc' then case p_sort when 'last_contact_at' then b.last_contact_at when 'added_at' then b.added_at end end asc nulls last,
      case when p_dir = 'desc' then case p_sort when 'last_contact_at' then b.last_contact_at when 'added_at' then b.added_at end end desc nulls last,
      -- deterministic tiebreaker (stable pagination)
      b.dot_number asc
    ))::int as row_num
  from base b
$$;

-- ----------------------------------------------------------------------------
-- §5.1 search_carriers -- paged results (search builder + pre-batch review)
-- sort whitelist: legal_name | power_units | phy_city | dot_number | bipd_on_file
-- ----------------------------------------------------------------------------
create or replace function public.search_carriers(
  p_definition jsonb,
  p_page       int  default 1,
  p_page_size  int  default 50,
  p_sort       text default 'legal_name',
  p_dir        text default 'asc'
)
returns table (
  dot_number bigint, legal_name text, dba_name text,
  contact_name text, phone text, cell_phone text, email text,
  phy_city text, phy_state text, phy_zip text,
  power_units int, total_drivers int, classdef text, carrier_operation text,
  cargo_other_desc text, cargo_flags text[],
  bipd_on_file bigint, authority_active boolean,
  lng float8, lat float8, geocode_precision geocode_precision,
  do_not_contact boolean,
  matched_zones text[],
  warning_reasons text[], has_warnings boolean,
  in_batches int,
  total_count bigint
)
language sql
stable
security invoker
as $$
  with matched as (
    select c.*, ci.bipd_on_file as ins_bipd_on_file, ci.authority_active as ins_authority_active
    from public.carriers c
    join internal.matching_carriers(p_definition) mc on mc.dot_number = c.dot_number
    left join public.carrier_insurance ci on ci.dot_number = c.dot_number
  ),
  zones_arr as (
    select coalesce(p_definition->'zones', '[]'::jsonb) as zones
  )
  select
    m.dot_number, m.legal_name, m.dba_name,
    m.contact_name,
    m.phone, m.cell_phone,
    coalesce(m.contact_email_override, m.email_address::text) as email,
    m.phy_city, m.phy_state, m.phy_zip,
    m.power_units, m.total_drivers, m.classdef, m.carrier_operation,
    m.crgo_cargoothr_desc as cargo_other_desc,
    (select array_agg(t.flag order by t.flag) from (values
       ('crgo_genfreight', m.crgo_genfreight), ('crgo_household', m.crgo_household),
       ('crgo_metalsheet', m.crgo_metalsheet), ('crgo_motoveh', m.crgo_motoveh),
       ('crgo_drivetow', m.crgo_drivetow), ('crgo_logpole', m.crgo_logpole),
       ('crgo_bldgmat', m.crgo_bldgmat), ('crgo_mobilehome', m.crgo_mobilehome),
       ('crgo_machlrg', m.crgo_machlrg), ('crgo_produce', m.crgo_produce),
       ('crgo_liqgas', m.crgo_liqgas), ('crgo_intermodal', m.crgo_intermodal),
       ('crgo_passengers', m.crgo_passengers), ('crgo_oilfield', m.crgo_oilfield),
       ('crgo_livestock', m.crgo_livestock), ('crgo_grainfeed', m.crgo_grainfeed),
       ('crgo_coalcoke', m.crgo_coalcoke), ('crgo_meat', m.crgo_meat),
       ('crgo_garbage', m.crgo_garbage), ('crgo_usmail', m.crgo_usmail),
       ('crgo_chem', m.crgo_chem), ('crgo_drybulk', m.crgo_drybulk),
       ('crgo_coldfood', m.crgo_coldfood), ('crgo_beverages', m.crgo_beverages),
       ('crgo_paperprod', m.crgo_paperprod), ('crgo_utility', m.crgo_utility),
       ('crgo_farmsupp', m.crgo_farmsupp), ('crgo_construct', m.crgo_construct),
       ('crgo_waterwell', m.crgo_waterwell), ('crgo_cargoothr', m.crgo_cargoothr)
     ) as t(flag, is_set) where t.is_set) as cargo_flags,
    m.ins_bipd_on_file as bipd_on_file,
    coalesce(m.ins_authority_active, false) as authority_active,
    st_x(m.geom::geometry) as lng, st_y(m.geom::geometry) as lat, m.geocode_precision,
    m.do_not_contact,
    (
      select array_remove(array_agg(distinct coalesce(z->>'label', 'Zone ' || ord::text)
                                     order by coalesce(z->>'label', 'Zone ' || ord::text)), null)
      from jsonb_array_elements(za.zones) with ordinality as t(z, ord)
      where m.geom is not null and st_dwithin(m.geom, internal.zone_geom(z), internal.zone_radius_m(z))
    ) as matched_zones,
    coalesce(cw.warning_reasons, '{}') as warning_reasons,
    coalesce(cw.warning_reasons, '{}') <> '{}' as has_warnings,
    (select count(*)::int from public.batch_carriers bc where bc.dot_number = m.dot_number) as in_batches,
    count(*) over ()::bigint as total_count
  from matched m
  cross join zones_arr za
  left join public.carrier_warnings cw on cw.dot_number = m.dot_number
  order by
    case when p_dir is distinct from 'desc' then
      case p_sort when 'legal_name' then m.legal_name when 'phy_city' then m.phy_city end
    end asc nulls last,
    case when p_dir = 'desc' then
      case p_sort when 'legal_name' then m.legal_name when 'phy_city' then m.phy_city end
    end desc nulls last,
    case when p_dir is distinct from 'desc' then
      case p_sort when 'power_units' then m.power_units::bigint when 'dot_number' then m.dot_number when 'bipd_on_file' then m.ins_bipd_on_file end
    end asc nulls last,
    case when p_dir = 'desc' then
      case p_sort when 'power_units' then m.power_units::bigint when 'dot_number' then m.dot_number when 'bipd_on_file' then m.ins_bipd_on_file end
    end desc nulls last,
    m.dot_number asc
  limit greatest(p_page_size, 0)
  offset greatest((p_page - 1), 0) * greatest(p_page_size, 0)
$$;

-- ----------------------------------------------------------------------------
-- §5.2 count_carriers -- the live match counter; tier1_count added per
-- amendment #11 ("carriers whose cargo_other_norm matches a curated
-- is_sand_gravel value").
-- ----------------------------------------------------------------------------
create or replace function public.count_carriers(p_definition jsonb)
returns table (
  match_count bigint, with_phone bigint, with_email bigint,
  with_warnings bigint, dnc_excluded bigint, geocoded_pct numeric,
  tier1_count bigint
)
language sql
stable
security invoker
as $$
  with matched as (
    select c.*
    from public.carriers c
    join internal.matching_carriers(p_definition) mc on mc.dot_number = c.dot_number
  ),
  matched_incl_dnc as (
    select mc.dot_number
    from internal.matching_carriers(
      jsonb_set(coalesce(p_definition,'{}'::jsonb), '{exclude_dnc}', 'false'::jsonb, true)
    ) mc
  )
  select
    count(*) as match_count,
    count(*) filter (where coalesce(m.contact_phone_override, m.phone, m.cell_phone) is not null) as with_phone,
    count(*) filter (where coalesce(m.contact_email_override, m.email_address::text) is not null) as with_email,
    count(*) filter (where coalesce(cw.warning_reasons,'{}') <> '{}') as with_warnings,
    greatest((select count(*) from matched_incl_dnc) - count(*), 0) as dnc_excluded,
    round(100.0 * count(*) filter (where m.geom is not null) / nullif(count(*),0), 1) as geocoded_pct,
    count(*) filter (where coalesce(cov.is_sand_gravel,false)) as tier1_count
  from matched m
  left join public.carrier_warnings cw on cw.dot_number = m.dot_number
  left join public.cargo_other_values cov on cov.value = m.cargo_other_norm
$$;

-- ----------------------------------------------------------------------------
-- §5.3 facet_other_values + facet_suggested_keywords -- F14/G8
-- SCOPE RULE: counts run over p_definition WITH THE ENTIRE 'cargo' KEY
-- REMOVED (the jsonb `-` operator drops a top-level key).
-- ----------------------------------------------------------------------------
create or replace function public.facet_other_values(
  p_definition jsonb,
  p_keyword    text default null,
  p_limit      int  default 100,
  p_offset     int  default 0
)
returns table (
  value text, sample_raw text, carrier_count bigint,
  match_group text, is_sand_gravel boolean, total_values bigint
)
language sql
stable
security invoker
as $$
  with scope as (
    select c.cargo_other_norm
    from public.carriers c
    join internal.matching_carriers(p_definition - 'cargo') mc on mc.dot_number = c.dot_number
    where c.cargo_other_norm is not null
      and (p_keyword is null or btrim(p_keyword) = '' or c.cargo_other_norm ilike '%' || p_keyword || '%')
  ),
  grouped as (
    select cargo_other_norm as value, count(*) as carrier_count
    from scope
    group by cargo_other_norm
  )
  select
    g.value, cov.sample_raw, g.carrier_count,
    cov.match_group, coalesce(cov.is_sand_gravel, false) as is_sand_gravel,
    count(*) over ()::bigint as total_values
  from grouped g
  left join public.cargo_other_values cov on cov.value = g.value
  order by g.carrier_count desc, g.value asc
  limit greatest(p_limit, 0) offset greatest(p_offset, 0)
$$;

create or replace function public.facet_suggested_keywords(p_definition jsonb)
returns table (match_group text, value_count int, carrier_count bigint)
language sql
stable
security invoker
as $$
  with scope as (
    select c.cargo_other_norm
    from public.carriers c
    join internal.matching_carriers(p_definition - 'cargo') mc on mc.dot_number = c.dot_number
    where c.cargo_other_norm is not null
  )
  select cov.match_group, count(distinct s.cargo_other_norm)::int as value_count, count(*)::bigint as carrier_count
  from scope s
  join public.cargo_other_values cov on cov.value = s.cargo_other_norm
  where cov.match_group is not null
  group by cov.match_group
  order by carrier_count desc, match_group asc
$$;

-- ----------------------------------------------------------------------------
-- facet_cargo_flags -- approved contract ADDITION (reconciliation item 3):
-- the 30 checkbox live counts, same SCOPE RULE as facet_other_values.
-- ----------------------------------------------------------------------------
create or replace function public.facet_cargo_flags(p_definition jsonb)
returns table (flag text, carrier_count bigint)
language sql
stable
security invoker
as $$
  with scope as (
    select c.*
    from public.carriers c
    join internal.matching_carriers(p_definition - 'cargo') mc on mc.dot_number = c.dot_number
  ),
  counts as (
    select
      count(*) filter (where crgo_genfreight) as crgo_genfreight,
      count(*) filter (where crgo_household)  as crgo_household,
      count(*) filter (where crgo_metalsheet) as crgo_metalsheet,
      count(*) filter (where crgo_motoveh)    as crgo_motoveh,
      count(*) filter (where crgo_drivetow)   as crgo_drivetow,
      count(*) filter (where crgo_logpole)    as crgo_logpole,
      count(*) filter (where crgo_bldgmat)    as crgo_bldgmat,
      count(*) filter (where crgo_mobilehome) as crgo_mobilehome,
      count(*) filter (where crgo_machlrg)    as crgo_machlrg,
      count(*) filter (where crgo_produce)    as crgo_produce,
      count(*) filter (where crgo_liqgas)     as crgo_liqgas,
      count(*) filter (where crgo_intermodal) as crgo_intermodal,
      count(*) filter (where crgo_passengers) as crgo_passengers,
      count(*) filter (where crgo_oilfield)   as crgo_oilfield,
      count(*) filter (where crgo_livestock)  as crgo_livestock,
      count(*) filter (where crgo_grainfeed)  as crgo_grainfeed,
      count(*) filter (where crgo_coalcoke)   as crgo_coalcoke,
      count(*) filter (where crgo_meat)       as crgo_meat,
      count(*) filter (where crgo_garbage)    as crgo_garbage,
      count(*) filter (where crgo_usmail)     as crgo_usmail,
      count(*) filter (where crgo_chem)       as crgo_chem,
      count(*) filter (where crgo_drybulk)    as crgo_drybulk,
      count(*) filter (where crgo_coldfood)   as crgo_coldfood,
      count(*) filter (where crgo_beverages)  as crgo_beverages,
      count(*) filter (where crgo_paperprod)  as crgo_paperprod,
      count(*) filter (where crgo_utility)    as crgo_utility,
      count(*) filter (where crgo_farmsupp)   as crgo_farmsupp,
      count(*) filter (where crgo_construct)  as crgo_construct,
      count(*) filter (where crgo_waterwell)  as crgo_waterwell,
      count(*) filter (where crgo_cargoothr)  as crgo_cargoothr
    from scope
  )
  select v.flag, v.carrier_count
  from counts x
  cross join lateral (values
    ('crgo_genfreight', x.crgo_genfreight), ('crgo_household', x.crgo_household),
    ('crgo_metalsheet', x.crgo_metalsheet), ('crgo_motoveh', x.crgo_motoveh),
    ('crgo_drivetow', x.crgo_drivetow), ('crgo_logpole', x.crgo_logpole),
    ('crgo_bldgmat', x.crgo_bldgmat), ('crgo_mobilehome', x.crgo_mobilehome),
    ('crgo_machlrg', x.crgo_machlrg), ('crgo_produce', x.crgo_produce),
    ('crgo_liqgas', x.crgo_liqgas), ('crgo_intermodal', x.crgo_intermodal),
    ('crgo_passengers', x.crgo_passengers), ('crgo_oilfield', x.crgo_oilfield),
    ('crgo_livestock', x.crgo_livestock), ('crgo_grainfeed', x.crgo_grainfeed),
    ('crgo_coalcoke', x.crgo_coalcoke), ('crgo_meat', x.crgo_meat),
    ('crgo_garbage', x.crgo_garbage), ('crgo_usmail', x.crgo_usmail),
    ('crgo_chem', x.crgo_chem), ('crgo_drybulk', x.crgo_drybulk),
    ('crgo_coldfood', x.crgo_coldfood), ('crgo_beverages', x.crgo_beverages),
    ('crgo_paperprod', x.crgo_paperprod), ('crgo_utility', x.crgo_utility),
    ('crgo_farmsupp', x.crgo_farmsupp), ('crgo_construct', x.crgo_construct),
    ('crgo_waterwell', x.crgo_waterwell), ('crgo_cargoothr', x.crgo_cargoothr)
  ) as v(flag, carrier_count)
$$;

-- ----------------------------------------------------------------------------
-- §5.4 Batch operations (VOLATILE, SECURITY DEFINER -- see file header)
-- ----------------------------------------------------------------------------
create or replace function public.create_batch(
  p_name        text,
  p_customer    text,
  p_job         text,
  p_description text,
  p_definition  jsonb
)
returns table (batch_id uuid, member_count int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch_id uuid;
  v_zone     jsonb;
  v_ord      bigint;
  v_count    int;
begin
  if not coalesce(internal.can_edit(), false) then
    raise exception 'insufficient privilege to create a batch';
  end if;
  if p_name is null or btrim(p_name) = '' then
    raise exception 'batch name is required';
  end if;

  insert into public.batches (name, customer, job, description, created_by, search_definition, snapshot_taken_at)
  values (p_name, p_customer, p_job, p_description, auth.uid(), coalesce(p_definition,'{}'::jsonb) - 'zones', now())
  returning id into v_batch_id;

  for v_zone, v_ord in
    select z, ord from jsonb_array_elements(coalesce(p_definition->'zones','[]'::jsonb)) with ordinality as t(z, ord)
  loop
    insert into public.batch_zones (batch_id, zone_type, label, params, geom, distance_miles, sort_order)
    values (
      v_batch_id,
      (v_zone->>'zone_type')::zone_type,
      coalesce(v_zone->>'label', 'Lane ' || v_ord::text),
      coalesce(v_zone->'params', '{}'::jsonb),
      internal.zone_geom(v_zone),
      coalesce((v_zone->'params'->>'radius_miles')::numeric, (v_zone->'params'->>'buffer_miles')::numeric),
      coalesce((v_zone->>'sort_order')::int, (v_ord - 1)::int)
    );
  end loop;

  insert into public.batch_carriers (batch_id, dot_number, status, added_via_refresh)
  select v_batch_id, mc.dot_number, 'new', false
  from internal.matching_carriers(p_definition) mc;
  get diagnostics v_count = row_count;

  insert into public.batch_activity (batch_id, actor_id, activity_type, payload)
  values (v_batch_id, auth.uid(), 'batch_created', jsonb_build_object('name', p_name));
  insert into public.batch_activity (batch_id, actor_id, activity_type, payload)
  values (v_batch_id, auth.uid(), 'members_added', jsonb_build_object('count', v_count));

  return query select v_batch_id, v_count;
end;
$$;

create or replace function public.refresh_batch(p_batch_id uuid)
returns table (added_count int, added_dots bigint[])
language plpgsql
security definer
set search_path = public
as $$
declare
  v_def         jsonb;
  v_zones       jsonb;
  v_added_dots  bigint[];
  v_added_count int;
begin
  if not coalesce(internal.can_edit(), false) then
    raise exception 'insufficient privilege to refresh a batch';
  end if;

  select b.search_definition into v_def from public.batches b where b.id = p_batch_id;
  if not found then
    raise exception 'batch % not found', p_batch_id;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'zone_type', z.zone_type, 'label', z.label, 'params', z.params
         ) order by z.sort_order), '[]'::jsonb)
    into v_zones
  from public.batch_zones z
  where z.batch_id = p_batch_id;

  v_def := v_def || jsonb_build_object('zones', v_zones);

  -- one 'refresh' activity row instead of N (D7); no per-row status_change rows
  -- get written either way since these are plain INSERTs (trg_bc_change only
  -- fires on UPDATE), the flag is set anyway per Part A's explicit instruction.
  perform set_config('app.suppress_row_activity', 'on', true);

  with ins as (
    insert into public.batch_carriers (batch_id, dot_number, status, added_via_refresh)
    select p_batch_id, mc.dot_number, 'new', true
    from internal.matching_carriers(v_def) mc
    on conflict (batch_id, dot_number) do nothing
    returning dot_number
  )
  select coalesce(array_agg(dot_number), '{}'), count(*)::int
    into v_added_dots, v_added_count
  from ins;

  perform set_config('app.suppress_row_activity', 'off', true);

  update public.batches
     set last_refreshed_at = now(), refresh_count = refresh_count + 1
   where id = p_batch_id;

  insert into public.batch_activity (batch_id, actor_id, activity_type, payload)
  values (p_batch_id, auth.uid(), 'refresh', jsonb_build_object('added_count', v_added_count));

  return query select v_added_count, v_added_dots;
end;
$$;

create or replace function public.bulk_set_status(
  p_batch_id uuid,
  p_dots     bigint[],
  p_status   batch_carrier_status
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  if not coalesce(internal.can_edit(), false) then
    raise exception 'insufficient privilege to change carrier status';
  end if;

  perform set_config('app.suppress_row_activity', 'on', true);

  update public.batch_carriers bc
     set status = p_status,
         status_changed_by = auth.uid(),   -- trigger won't set these while suppressed
         status_changed_at = now()
   where bc.batch_id = p_batch_id
     and bc.dot_number = any(p_dots)
     and bc.status is distinct from p_status;
  get diagnostics v_count = row_count;

  perform set_config('app.suppress_row_activity', 'off', true);

  insert into public.batch_activity (batch_id, actor_id, activity_type, payload)
  values (p_batch_id, auth.uid(), 'bulk_status_change',
          jsonb_build_object('to', p_status, 'count', v_count,
                              'dots', (select coalesce(jsonb_agg(d), '[]'::jsonb) from unnest(p_dots[1:50]) d)));

  return v_count;
end;
$$;

create or replace function public.set_do_not_contact(
  p_dot    bigint,
  p_on     boolean,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if not coalesce(internal.can_edit(), false) then
    raise exception 'insufficient privilege to change do-not-contact';
  end if;
  if not exists (select 1 from public.carriers where dot_number = p_dot) then
    raise exception 'carrier % not found', p_dot;
  end if;

  update public.carriers
     set do_not_contact = p_on,
         dnc_reason = case when p_on then p_reason else null end,
         dnc_set_by = case when p_on then v_uid else null end,
         dnc_set_at = case when p_on then now() else null end
   where dot_number = p_dot;

  if p_on then
    insert into public.contact_suppressions (dot_number, channel, reason, source, created_by)
    values (p_dot, 'all', p_reason, 'manual', v_uid)
    on conflict (dot_number, channel) where value is null
    do update set reason = excluded.reason, created_by = excluded.created_by,
                   created_at = now(), expires_at = null;
  else
    update public.contact_suppressions
       set expires_at = now()
     where dot_number = p_dot and channel = 'all' and value is null
       and (expires_at is null or expires_at > now());
  end if;

  -- logs into EVERY batch currently containing the carrier (locked rule, F11/G7)
  insert into public.batch_activity (batch_id, actor_id, activity_type, payload)
  select bc.batch_id, v_uid, case when p_on then 'dnc_set' else 'dnc_cleared' end,
         jsonb_build_object('dot_number', p_dot, 'reason', p_reason)
  from public.batch_carriers bc
  where bc.dot_number = p_dot;
end;
$$;

-- amendment #19: sheet/CSV exports write activity so F11's feed records them.
create or replace function public.log_export(
  p_batch_id  uuid,
  p_kind      text,
  p_row_count int
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not coalesce(internal.can_edit(), false) then
    raise exception 'insufficient privilege to log an export';
  end if;
  if p_kind not in ('call_sheet','csv') then
    raise exception 'invalid export kind: % (expected call_sheet or csv)', p_kind;
  end if;

  insert into public.batch_activity (batch_id, actor_id, activity_type, payload)
  values (p_batch_id, auth.uid(), 'export', jsonb_build_object('kind', p_kind, 'row_count', p_row_count));
end;
$$;

-- ----------------------------------------------------------------------------
-- §5.5 Batch working page & dashboard reads
-- batch_members sort whitelist: status | legal_name | phy_city | power_units
--   | last_contact_at | added_at. Extended per reconciliation item 3 with
--   p_min_insurance/p_size_min/p_size_max/p_has_phone/p_has_email.
-- ----------------------------------------------------------------------------
create or replace function public.batch_members(
  p_batch_id      uuid,
  p_status        batch_carrier_status[] default null,
  p_q             text default null,
  p_warnings_only boolean default false,
  p_page          int default 1,
  p_page_size     int default 50,
  p_sort          text default 'status',
  p_dir           text default 'asc',
  p_min_insurance bigint default null,
  p_size_min      int default null,
  p_size_max      int default null,
  p_has_phone     boolean default null,
  p_has_email     boolean default null
)
returns table (
  dot_number bigint, legal_name text, dba_name text,
  contact_name text, phone text, email text,
  phy_city text, power_units int,
  status batch_carrier_status, status_changed_at timestamptz, status_changed_by_name text,
  added_via_refresh boolean, promoted_at timestamptz,
  do_not_contact boolean, warning_reasons text[], has_warnings boolean,
  last_contact_at timestamptz, last_contact_channel contact_channel, contact_count int,
  lng float8, lat float8,
  total_count bigint
)
language sql
stable
security invoker
as $$
  with ordered as (
    select * from internal.batch_members_ordered(
      p_batch_id, p_status, p_q, p_warnings_only, p_min_insurance,
      p_size_min, p_size_max, p_has_phone, p_has_email, p_sort, p_dir
    )
  )
  select
    c.dot_number, c.legal_name, c.dba_name, c.contact_name,
    coalesce(c.contact_phone_override, c.phone, c.cell_phone) as phone,
    coalesce(c.contact_email_override, c.email_address::text) as email,
    c.phy_city, c.power_units,
    bc.status, bc.status_changed_at, p.full_name as status_changed_by_name,
    bc.added_via_refresh, bc.promoted_at,
    c.do_not_contact,
    coalesce(cw.warning_reasons,'{}') as warning_reasons,
    coalesce(cw.warning_reasons,'{}') <> '{}' as has_warnings,
    lc.last_contact_at, lc.last_contact_channel, lc.contact_count,
    st_x(c.geom::geometry) as lng, st_y(c.geom::geometry) as lat,
    count(*) over ()::bigint as total_count
  from ordered o
  join public.batch_carriers bc on bc.batch_id = p_batch_id and bc.dot_number = o.dot_number
  join public.carriers c on c.dot_number = o.dot_number
  left join public.profiles p on p.id = bc.status_changed_by
  left join public.carrier_warnings cw on cw.dot_number = o.dot_number
  left join lateral (
    select max(cl.contacted_at) as last_contact_at,
           (array_agg(cl.channel order by cl.contacted_at desc))[1] as last_contact_channel,
           count(*)::int as contact_count
    from public.contact_logs cl where cl.dot_number = o.dot_number
  ) lc on true
  order by o.row_num
  limit least(greatest(p_page_size, 0), 200)                                   -- §4 perf plan: page_size cap
  offset greatest((p_page - 1), 0) * least(greatest(p_page_size, 0), 200)
$$;

-- amendment #10: full filter+sort parity with batch_members, plus row_num --
-- this is what makes "list # = pin #" true under every sort/filter (M5.3 AC).
create or replace function public.batch_members_map(
  p_batch_id      uuid,
  p_status        batch_carrier_status[] default null,
  p_q             text default null,
  p_warnings_only boolean default false,
  p_min_insurance bigint default null,
  p_size_min      int default null,
  p_size_max      int default null,
  p_has_phone     boolean default null,
  p_has_email     boolean default null,
  p_sort          text default 'status',
  p_dir           text default 'asc'
)
returns table (
  dot_number bigint, lng float8, lat float8,
  status batch_carrier_status, do_not_contact boolean, has_warnings boolean,
  row_num int
)
language sql
stable
security invoker
as $$
  select
    c.dot_number, st_x(c.geom::geometry) as lng, st_y(c.geom::geometry) as lat,
    bc.status, c.do_not_contact,
    coalesce(cw.warning_reasons,'{}') <> '{}' as has_warnings,
    o.row_num
  from internal.batch_members_ordered(
    p_batch_id, p_status, p_q, p_warnings_only, p_min_insurance,
    p_size_min, p_size_max, p_has_phone, p_has_email, p_sort, p_dir
  ) o
  join public.batch_carriers bc on bc.batch_id = p_batch_id and bc.dot_number = o.dot_number
  join public.carriers c on c.dot_number = o.dot_number
  left join public.carrier_warnings cw on cw.dot_number = o.dot_number
  order by o.row_num
$$;

create or replace function public.search_carriers_map(
  p_definition jsonb,
  p_limit      int default 5000
)
returns table (dot_number bigint, lng float8, lat float8, has_warnings boolean, matched_zones text[])
language sql
stable
security invoker
as $$
  with matched as (
    select c.dot_number, c.geom
    from public.carriers c
    join internal.matching_carriers(p_definition) mc on mc.dot_number = c.dot_number
    order by c.dot_number
    limit greatest(p_limit, 0)
  )
  select
    m.dot_number, st_x(m.geom::geometry) as lng, st_y(m.geom::geometry) as lat,
    coalesce(cw.warning_reasons,'{}') <> '{}' as has_warnings,
    (
      select array_remove(array_agg(distinct coalesce(z->>'label', 'Zone ' || ord::text)
                                     order by coalesce(z->>'label', 'Zone ' || ord::text)), null)
      from jsonb_array_elements(coalesce(p_definition->'zones','[]'::jsonb)) with ordinality as t(z, ord)
      where m.geom is not null and st_dwithin(m.geom, internal.zone_geom(z), internal.zone_radius_m(z))
    ) as matched_zones
  from matched m
  left join public.carrier_warnings cw on cw.dot_number = m.dot_number
$$;

create or replace function public.generate_contact_sheet(
  p_batch_id uuid,
  p_dots     bigint[] default null
)
returns table (
  dot_number bigint, legal_name text, dba_name text,
  contact_name text, email text,
  phone text, cell_phone text, phy_city text, phy_state text,
  status batch_carrier_status, warning_reasons text[],
  last_contact_at timestamptz, next_steps text
)
language sql
stable
security invoker
as $$
  select
    c.dot_number, c.legal_name, c.dba_name, c.contact_name,
    coalesce(c.contact_email_override, c.email_address::text) as email,
    coalesce(c.contact_phone_override, c.phone) as phone, c.cell_phone,
    c.phy_city, c.phy_state,
    bc.status,
    coalesce(cw.warning_reasons,'{}') as warning_reasons,
    lc.last_contact_at, lc.next_steps
  from public.batch_carriers bc
  join public.carriers c on c.dot_number = bc.dot_number
  left join public.carrier_warnings cw on cw.dot_number = bc.dot_number
  left join lateral (
    select cl.contacted_at as last_contact_at, cl.next_steps
    from public.contact_logs cl
    where cl.dot_number = bc.dot_number
    order by cl.contacted_at desc
    limit 1
  ) lc on true
  where bc.batch_id = p_batch_id
    and (p_dots is null or bc.dot_number = any(p_dots))
    -- HARD-EXCLUDES do_not_contact + call/all suppressions (locked DNC rule, §2.7)
    and not c.do_not_contact
    and not exists (
      select 1 from public.contact_suppressions cs
      where cs.dot_number = c.dot_number
        and cs.channel in ('call','all')
        and (cs.expires_at is null or cs.expires_at > now())
    )
  order by c.legal_name
$$;

-- Dashboard (F3/F4/G2) -- a view, directly PostgREST-selectable. Extended per
-- amendment #11 with warnings_count and with_phone.
create or replace view public.batch_dashboard with (security_invoker = true) as
select b.id, b.name, b.customer, b.job, b.created_by, p.full_name as created_by_name,
       b.created_at, b.snapshot_taken_at, b.last_refreshed_at, b.archived_at,
       (select count(*) from public.batch_carriers bc where bc.batch_id = b.id)            as member_count,
       (select coalesce(jsonb_object_agg(s.status, s.n), '{}'::jsonb) from
          (select status, count(*) n from public.batch_carriers where batch_id = b.id group by 1) s)
                                                                                            as status_counts,
       (select count(*) from public.batch_carriers bc where bc.batch_id = b.id and bc.promoted_at is not null)
                                                                                            as promoted_count,
       (select count(*) from public.batch_carriers bc
          join public.carrier_warnings cw on cw.dot_number = bc.dot_number
          where bc.batch_id = b.id and cw.warning_reasons <> '{}')                         as warnings_count,
       (select count(*) from public.batch_carriers bc
          join public.carriers c on c.dot_number = bc.dot_number
          where bc.batch_id = b.id
            and coalesce(c.contact_phone_override, c.phone, c.cell_phone) is not null)     as with_phone,
       (select max(a.created_at) from public.batch_activity a where a.batch_id = b.id)     as last_activity_at,
       (select coalesce(jsonb_agg(jsonb_build_object(
               'id', z.id, 'zone_type', z.zone_type, 'label', z.label,
               'params', z.params, 'distance_miles', z.distance_miles)
               order by z.sort_order), '[]'::jsonb)
          from public.batch_zones z where z.batch_id = b.id)                               as zones
from public.batches b join public.profiles p on p.id = b.created_by;

comment on view public.batch_dashboard is
  'Frontend: WHERE archived_at IS NULL -> the F4 all-active-batches map (drawn from zones '
  'jsonb) above the batch table; row click -> batch page. Also feeds the stat-counter strip '
  '(F24/G10). warnings_count/with_phone added per amendment #11.';

-- amendment #11: per-status counts + dnc_count + warnings_count + with_phone/with_email
-- for a single batch's status chips (one grouped query, never scanning loaded pages -- §4).
create or replace function public.batch_status_counts(p_batch_id uuid)
returns table (
  new_count int, attempted_count int, contacted_count int,
  interested_count int, not_a_fit_count int,
  dnc_count int, warnings_count int,
  with_phone int, with_email int
)
language sql
stable
security invoker
as $$
  select
    count(*) filter (where bc.status = 'new')::int,
    count(*) filter (where bc.status = 'attempted')::int,
    count(*) filter (where bc.status = 'contacted')::int,
    count(*) filter (where bc.status = 'interested')::int,
    count(*) filter (where bc.status = 'not_a_fit')::int,
    count(*) filter (where c.do_not_contact)::int,
    count(*) filter (where coalesce(cw.warning_reasons,'{}') <> '{}')::int,
    count(*) filter (where coalesce(c.contact_phone_override, c.phone, c.cell_phone) is not null)::int,
    count(*) filter (where coalesce(c.contact_email_override, c.email_address::text) is not null)::int
  from public.batch_carriers bc
  join public.carriers c on c.dot_number = bc.dot_number
  left join public.carrier_warnings cw on cw.dot_number = bc.dot_number
  where bc.batch_id = p_batch_id
$$;

-- amendment #11: dashboard StatStrip aggregate, scoped to active (non-archived) batches.
create or replace function public.dashboard_totals()
returns table (
  active_batches bigint, distinct_carriers bigint, with_phone bigint,
  interested bigint, promoted bigint
)
language sql
stable
security invoker
as $$
  select
    (select count(*) from public.batches where archived_at is null),
    (select count(distinct bc.dot_number) from public.batch_carriers bc
       join public.batches b on b.id = bc.batch_id where b.archived_at is null),
    (select count(distinct bc.dot_number) from public.batch_carriers bc
       join public.batches b on b.id = bc.batch_id
       join public.carriers c on c.dot_number = bc.dot_number
       where b.archived_at is null
         and coalesce(c.contact_phone_override, c.phone, c.cell_phone) is not null),
    (select count(*) from public.batch_carriers bc join public.batches b on b.id = bc.batch_id
       where b.archived_at is null and bc.status = 'interested'),
    (select count(*) from public.batch_carriers bc join public.batches b on b.id = bc.batch_id
       where b.archived_at is null and bc.promoted_at is not null)
$$;

-- ----------------------------------------------------------------------------
-- §5.6 Compliance helper (used by call-sheet now; email/SMS modules later -- F10)
-- ----------------------------------------------------------------------------
create or replace function internal.is_contactable(p_dot bigint, p_channel contact_channel)
returns boolean
language sql
stable
as $$
  select not exists (
    select 1 from public.carriers c where c.dot_number = p_dot and c.do_not_contact
  )
  and not exists (
    select 1 from public.contact_suppressions cs
    where cs.dot_number = p_dot
      and cs.channel in (p_channel, 'all')
      and cs.value is null
      and (cs.expires_at is null or cs.expires_at > now())
  )
  and not exists (
    select 1 from public.contact_suppressions cs, public.carriers c
    where c.dot_number = p_dot
      and cs.channel in (p_channel, 'all')
      and cs.value is not null
      and (cs.expires_at is null or cs.expires_at > now())
      and lower(cs.value) = lower(
        case p_channel
          when 'email' then coalesce(c.contact_email_override, c.email_address::text)
          else coalesce(c.contact_phone_override, c.phone, c.cell_phone)
        end
      )
  )
$$;

-- Exposed to authenticated via this public wrapper for UI badges.
create or replace function public.is_contactable(p_dot bigint, p_channel contact_channel)
returns boolean
language sql
stable
security invoker
as $$
  select internal.is_contactable(p_dot, p_channel)
$$;
