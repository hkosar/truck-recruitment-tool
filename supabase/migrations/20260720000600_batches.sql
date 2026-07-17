-- ============================================================================
-- 20260720000600_batches.sql -- batches, batch_zones, batch_carriers
-- Spec: docs/build-plan/01-architecture.md Part A §2.6, §2.9 (batch-domain
-- indexes); amended per #18 (batch_zones.label is user-editable "material /
-- lane label", defaulting to generated geographic text -- no DDL change, the
-- column already supports arbitrary text; comment updated to make the app
-- contract explicit).
-- ============================================================================

create table public.batches (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,                 -- F20: first field in creation flow
  customer          text,                          -- F20/G9
  job               text,                          -- F20/G9
  description       text,
  created_by        uuid not null references public.profiles(id),
  created_at        timestamptz not null default now(),
  snapshot_taken_at timestamptz,                   -- when membership was frozen
  last_refreshed_at timestamptz,
  refresh_count     int not null default 0,
  search_definition jsonb not null,                -- filters ONLY; zones live in batch_zones (D3, contract §5.1)
  archived_at       timestamptz                    -- null = active (drives the F4 dashboard)
);

create table public.batch_zones (                  -- F21 MULTI-LANE
  id             uuid primary key default gen_random_uuid(),
  batch_id       uuid not null references public.batches(id) on delete cascade,
  zone_type      zone_type not null,
  label          text not null,                    -- user-editable "Material / lane label" (amendment #18); defaults to
                                                     -- generated geographic text e.g. 'Austin · 55 mi' / 'Austin → San Antonio · 40 mi',
                                                     -- owner may overwrite with e.g. 'Limestone from Austin' (map legend, lane chips, F22)
  params         jsonb not null,                   -- full UI-reconstructable spec (shape contract §5.1)
  geom           geography not null,               -- Point (radius anchor) or LineString (corridor route)
  distance_miles numeric(6,2) not null check (distance_miles > 0 and distance_miles <= 300),
  sort_order     int not null default 0,
  created_at     timestamptz not null default now(),
  constraint zone_geom_shape check (
    (zone_type = 'radius'   and geometrytype(geom::geometry) = 'POINT') or
    (zone_type = 'corridor' and geometrytype(geom::geometry) = 'LINESTRING')
  )
);
-- Coverage = UNION over a batch's zones (OR of per-zone ST_DWithin) -- the F21 'amorphous blob'.
-- Buffered polygons are NOT stored: the client draws circles/route-buffers from params (G1),
-- and the query path is index-accelerated ST_DWithin against carriers.geom either way.

create table public.batch_carriers (               -- the M:N snapshot membership
  batch_id          uuid  not null references public.batches(id) on delete cascade,
  dot_number        bigint not null references public.carriers(dot_number) on delete restrict,
  status            batch_carrier_status not null default 'new',   -- per-batch (locked rule)
  status_changed_by uuid references public.profiles(id),
  status_changed_at timestamptz,
  added_at          timestamptz not null default now(),
  added_via_refresh boolean not null default false, -- distinguishes refresh adds (F: never auto-remove)
  promoted_at       timestamptz,                    -- F23 'Mark as Promoted' (replaces Send-to-Onboarding)
  promoted_by       uuid references public.profiles(id),
  primary key (batch_id, dot_number)                -- the required UNIQUE, as the PK
);

comment on table public.batch_carriers is
  'batch_carriers -> carriers is ON DELETE RESTRICT deliberately: membership history must make '
  'carrier deletion impossible (carriers are never deleted anyway). Batch deletion cascades '
  'zones/members/activity, but NOT contact history (contact_logs.batch_id is ON DELETE SET NULL).';

-- ----------------------------------------------------------------------------
-- Indexes (§2.9) -- batch domain
-- ----------------------------------------------------------------------------
create index idx_zones_batch    on public.batch_zones (batch_id, sort_order);
create index idx_zones_geom     on public.batch_zones using gist (geom);
create index idx_bc_dot         on public.batch_carriers (dot_number);               -- 'which batches am I in'
create index idx_bc_batch_status on public.batch_carriers (batch_id, status);        -- F5 status-filtered lists
