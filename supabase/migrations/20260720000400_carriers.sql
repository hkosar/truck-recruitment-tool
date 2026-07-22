-- ============================================================================
-- 20260720000400_carriers.sql  --  carriers + insurance + safety + inspections
--                                   + qc snapshots + sync_runs
-- Spec: docs/build-plan/01-architecture.md Part A §2.4, §2.9 (carrier indexes);
-- amended per the "Adversarial-review amendments" #7 (sync-bookkeeping + every
-- Part B §2.3 mapped column absent from Part A, insurance/authority two-layer
-- storage incl. carrier_insurance_filings, carrier_safety PK+snapshot_month,
-- carrier_qc_snapshots) and reconciliation §1 item 6 (lat/lng float mirrors).
--
-- Column-name contract (Part A): every sync-owned column is named identically
-- to its Socrata field in az4n-8mr2 so the Render ingest job is a straight
-- field-list copy. Worker must verify the 30 crgo_* names + L&I thousands-
-- scaling against live dataset metadata on ingest day one (open risk, §9).
-- ============================================================================

create table public.carriers (
  -- ============ identity (D1) ============
  dot_number        bigint primary key,

  -- ============ SYNC-OWNED (census az4n-8mr2; overwritten nightly) ============
  legal_name        text not null,
  dba_name          text,
  phy_street        text, phy_city text, phy_state text, phy_zip text,
  phone             text, cell_phone text, email_address citext, fax text,   -- G4 contactability raw; citext per amendment #7
  company_officer_1 text, company_officer_2 text,                          -- F9/F17 contact-name source (canonical; 01 reconciliation #1)
  power_units       int,
  total_drivers     int,
  classdef          text,            -- 'Authorized For Hire' | 'Private (Property)' | ...
  carrier_operation text,            -- Interstate / Intrastate
  status_code       text,            -- 'A' = active
  mcs150_date       date,
  entity_type       text,
  -- 30 cargo flags, 1:1 with census (F14 plain checkboxes; Tier-2 backstop = drybulk/construct/bldgmat)
  crgo_genfreight boolean not null default false, crgo_household  boolean not null default false,
  crgo_metalsheet boolean not null default false, crgo_motoveh    boolean not null default false,
  crgo_drivetow   boolean not null default false, crgo_logpole    boolean not null default false,
  crgo_bldgmat    boolean not null default false, crgo_mobilehome boolean not null default false,
  crgo_machlrg    boolean not null default false, crgo_produce    boolean not null default false,
  crgo_liqgas     boolean not null default false, crgo_intermodal boolean not null default false,
  crgo_passengers boolean not null default false, crgo_oilfield   boolean not null default false,
  crgo_livestock  boolean not null default false, crgo_grainfeed  boolean not null default false,
  crgo_coalcoke   boolean not null default false, crgo_meat       boolean not null default false,
  crgo_garbage    boolean not null default false, crgo_usmail     boolean not null default false,
  crgo_chem       boolean not null default false, crgo_drybulk    boolean not null default false,
  crgo_coldfood   boolean not null default false, crgo_beverages  boolean not null default false,
  crgo_paperprod  boolean not null default false, crgo_utility    boolean not null default false,
  crgo_farmsupp   boolean not null default false, crgo_construct  boolean not null default false,
  crgo_waterwell  boolean not null default false, crgo_cargoothr  boolean not null default false,
  crgo_cargoothr_desc text,                       -- THE core signal (brief §4 Tier 1); Part B's "cargo_other_raw" alias means this column
  census_raw        jsonb,                        -- full 142-field record for the F7 rich profile (D2)
  census_updated_at timestamptz,                  -- when the source row last changed
  last_synced_at    timestamptz,
  first_seen_at     timestamptz not null default now(),
  address_hash      text,                         -- md5(phy_street|city|state|zip); ingest maintains

  -- ============ SYNC-OWNED — amendment #7: sync bookkeeping (Part A <-> Part B drift fix) ============
  row_hash              text,                     -- md5 of all mapped source columns; drives the changed-rows-only upsert (Part B §2.2)
  last_changed_at        timestamptz,              -- last time row_hash actually differed (not just re-synced)
  source_missing_since   date,                     -- set when a TX carrier drops out of today's census slice (warning code 9, never deleted)

  -- ============ SYNC-OWNED — amendment #7: every Part B §2.3 mapped column absent from Part A ============
  fmcsa_add_date          date,                    -- census 'add_date': how long registered
  duns_number             text,                    -- census 'dun_bradstreet_no'; F18 enrichment cross-ref
  hm_ind                  boolean,                 -- hazmat indicator
  prior_revoke_flag       boolean,                 -- chameleon-carrier warning input
  prior_revoke_dot_number bigint,
  recordable_crash_rate   numeric,                 -- profile display
  docket_display          text,                    -- concat of docket1prefix+docket1; display-only (MC deprecated)
  mail_street             text, mail_city text, mail_state text, mail_zip text,  -- carrier_mailing_* set
  owned_trucks            int, owned_tractors int, owned_trailers int,
  leased_trucks           int, leased_tractors int, leased_trailers int,        -- owntruck/owntract/owntrail (+leased); F7 profile header
  mcs150_mileage          bigint,
  mcs150_mileage_year     int,
  phy_zip5                text,                    -- left(phy_zip,5); geocoding anchor
  phy_county               text,                    -- census 'phy_cnty'; county anchor (F12)
  fleetsize                text,
  truck_units              int,
  bus_units                int,
  total_cdl                int,

  -- ============ SYNC-OWNED — reconciliation §1 item 6: cheap-read float mirrors ============
  lat  double precision,                          -- mirrors ST_Y(geom); Part B writes both directly
  lng  double precision,                           -- mirrors ST_X(geom)

  -- ============ DERIVED (generated, therefore also sync-consistent) ============
  cargo_other_norm  text generated always as (
    nullif(btrim(regexp_replace(lower(coalesce(crgo_cargoothr_desc,'')),
                                '[^a-z0-9&/ ]+',' ','g')), '')
  ) stored,                                       -- normalization backbone of F14 faceting
  contact_name      text generated always as (
    coalesce(contact_name_override, company_officer_1)
  ) stored,                                       -- F9/F17/G4: one canonical display name

  -- ============ APP-OWNED (never touched by sync; D9) ============
  contact_name_override  text,                    -- F18 MVP: manual research fills these
  contact_phone_override text,
  contact_email_override text,
  do_not_contact  boolean not null default false, -- GLOBAL DNC (locked rule; overrides everything)
  dnc_reason      text,
  dnc_set_by      uuid references public.profiles(id),
  dnc_set_at      timestamptz,
  -- geocode pipeline output (brief §3 caveat 3; written only by the geocode worker)
  geom              geography(Point,4326),
  geocode_precision geocode_precision not null default 'none',
  geocode_source    text,                         -- 'google' | 'census_zip' | ...
  geocode_addr_hash text,                         -- address_hash at geocode time; re-geocode when <> address_hash
  geocoded_at       timestamptz
);
comment on column public.carriers.census_raw is
  'Full Socrata record. TOASTed; ~1-3KB/row. Renders the profile long-tail (F7).';
comment on column public.carriers.row_hash is
  'md5 of the concatenated mapped source columns (Part B §2.2). Upsert SET clause is gated '
  'WHERE carriers.row_hash IS DISTINCT FROM EXCLUDED.row_hash so unchanged rows never write.';
comment on column public.carriers.source_missing_since is
  'Set to today the first time a previously-seen TX dot_number is absent from the daily slice; '
  'cleared (set null) if it reappears. Feeds warning code missing_from_source (amendment #8). '
  'Carriers are NEVER deleted (G10 honesty; batch membership must survive).';

-- Carriers are never deleted. A carrier that drops out of the census keeps its row;
-- status_code flips and last_synced_at goes stale -- history, timelines and batch
-- membership survive (G10 honesty: UI shows "last seen in FMCSA data on ...").

-- ----------------------------------------------------------------------------
-- 1:1 / 1:N satellites (all sync-owned, service_role-written)
-- ----------------------------------------------------------------------------

create table public.carrier_insurance (           -- L&I jeyh-5nsj family (brief §3); amended per #7
  dot_number        bigint primary key references public.carriers(dot_number) on delete cascade,
  common_status     authority_status not null default 'unknown',
  contract_status   authority_status not null default 'unknown',
  broker_status     authority_status not null default 'unknown',
  authority_raw     jsonb,                        -- untouched L&I authority fields (Part B's carrier_authority merges HERE, no separate table)
  authority_active  boolean generated always as
    (common_status = 'active' or contract_status = 'active') stored,
  bipd_required     bigint,                       -- DOLLARS. L&I publishes THOUSANDS -> ingest x1000 (critical!)
  bipd_on_file      bigint,                       -- DOLLARS (null = nothing on file)
  bipd_cancel_date  date,                          -- amendment #7: next pending cancellation of the in-force BIPD policy; feeds insurance_expiring_30d (amendment #8 / F24)
  cargo_on_file     bigint,
  bond_on_file      bigint,
  insurer_name      text,
  insurance_effective_date date,                   -- amendment #7 (renamed from policy_effective_date for clarity alongside bipd_cancel_date)
  last_synced_at    timestamptz not null default now()
);
comment on column public.carrier_insurance.bipd_cancel_date is
  'min(cancl_effective_date) among filings still in the future, from the nightly rollup over '
  'carrier_insurance_filings (Part B §2.4). Null = no pending cancellation on file.';

-- amendment #7: append-only raw L&I filings feeding the carrier_insurance rollup above.
create table public.carrier_insurance_filings (
  dot_number           bigint not null references public.carriers(dot_number) on delete cascade,
  docket_number        text not null,
  policy_no            text not null,
  effective_date       date not null,
  insurer_name         text,                       -- L&I 'name_company'
  ins_form_code        text,                        -- BMC-91/91X/34/...
  ins_class_code       text,
  ins_type_desc        text,                        -- filter ILIKE 'BIPD%' for liability filings
  max_cov_amount       bigint,                       -- DOLLARS (ingest x1000 from L&I thousands)
  min_cov_amount       bigint,
  underl_lim_amount    bigint,
  cancl_effective_date date,
  trans_date           date,
  synced_at            timestamptz not null default now(),
  primary key (dot_number, docket_number, policy_no, effective_date)
);
comment on table public.carrier_insurance_filings is
  'Append-only raw L&I ActPendInsur filings (natural key = PK). Ingest only INSERTs new rows; '
  'never updates/deletes (pipeline discipline, not DB-enforced). The nightly rollup step '
  '(Part B §2.4) reads this table and writes the single current-state row on carrier_insurance.';

create table public.carrier_safety (              -- SMS census kjg3-diqy, monthly (brief §3 caveat 4); amended per #7
  dot_number         bigint primary key references public.carriers(dot_number) on delete cascade,
  snapshot_month     date,                          -- amendment #7: which monthly SMS snapshot this row reflects
  crash_total_24mo   int,  crash_fatal_24mo int,  crash_injury_24mo int,  crash_tow_24mo int,
  inspections_24mo   int,
  driver_insp_24mo   int,  driver_oos_24mo  int,
  vehicle_insp_24mo  int,  vehicle_oos_24mo int,
  driver_oos_rate    numeric(5,2),                -- percent 0-100
  vehicle_oos_rate   numeric(5,2),
  safety_rating      text,                        -- 'Satisfactory'|'Conditional'|'Unsatisfactory'|null
  safety_rating_date date,
  last_synced_at     timestamptz not null default now()
);
comment on table public.carrier_safety is
  'PK dot_number = latest snapshot only (monthly overwrite), per amendment #7. snapshot_month '
  'records which month''s SMS pull produced the current row.';

create table public.carrier_inspections (         -- filled lazily via QCMobile on profile view + batch warm
  id             bigint generated always as identity primary key,
  dot_number     bigint not null references public.carriers(dot_number) on delete cascade,
  report_number  text unique,                     -- natural dedupe key when present
  inspection_date date not null,
  state          text,
  level          int check (level between 1 and 6),
  oos            boolean not null default false,
  violations     int not null default 0,
  raw            jsonb,
  synced_at      timestamptz not null default now()
);

-- amendment #7 / #16: QCMobile per-carrier cache. Written by the M5.8 Edge Function
-- `qc-fetch` (FMCSA WebKey stays server-side); 24h cache feeds carrier_inspections rows.
create table public.carrier_qc_snapshots (
  dot_number  bigint primary key references public.carriers(dot_number) on delete cascade,
  payload     jsonb not null,
  fetched_at  timestamptz not null default now()
);
comment on table public.carrier_qc_snapshots is
  'QCMobile per-carrier response cache (24h TTL enforced by the qc-fetch Edge Function, not '
  'the DB). M5.8; until the WebKey prerequisite is set, this table simply stays empty and the '
  'Inspections tile shows an honest "no data yet" state (amendment #16).';

create table public.sync_runs (                   -- G10: honest data freshness for the UI footer
  id            bigint generated always as identity primary key,
  source        sync_source not null,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  rows_upserted int,
  ok            boolean,
  error         text
);

comment on table public.carriers is
  'Ingest contract (Render cron, service_role): COPY into a temp staging table -> '
  'INSERT ... ON CONFLICT (dot_number) DO UPDATE SET <sync-owned columns only> WHERE '
  'carriers.row_hash IS DISTINCT FROM EXCLUDED.row_hash -- the SET list explicitly excludes '
  'every APP-OWNED column (D9). Then upsert cargo_other_values (§2.5), then enqueue geocoding '
  'for rows where geocode_addr_hash is distinct from address_hash (never attempted or address changed).';

-- ----------------------------------------------------------------------------
-- Indexes (§2.9) -- the carriers-table hot paths
-- ----------------------------------------------------------------------------
create index idx_carriers_geom        on public.carriers using gist (geom);          -- radius+corridor (F6/F21)
create index idx_carriers_other_trgm  on public.carriers using gin (cargo_other_norm gin_trgm_ops); -- F14 keyword
create index idx_carriers_other_btree on public.carriers (cargo_other_norm) where cargo_other_norm is not null; -- facet GROUP BY
create index idx_carriers_name_trgm   on public.carriers using gin ((legal_name || ' ' || coalesce(dba_name,'')) gin_trgm_ops); -- in-batch/global name search (F19)
create index idx_carriers_status      on public.carriers (status_code);
create index idx_carriers_units      on public.carriers (power_units);
create index idx_carriers_dnc        on public.carriers (dot_number) where do_not_contact;         -- fast global-DNC joins
create index idx_carriers_geocode_todo on public.carriers (dot_number)
  where geocode_addr_hash is distinct from address_hash;                             -- unattempted/current-address-changed queue

create index idx_cif_dot on public.carrier_insurance_filings (dot_number);
