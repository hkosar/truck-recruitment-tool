# Architecture — Database, API & Ingestion Pipeline

Two specs in one file: **Part A** (Supabase schema v2: DDL, RPCs, RLS, realtime, seed)
and **Part B** (FMCSA→Supabase ingestion pipeline on Render). Written independently and
reconciled below — **this reconciliation section is authoritative wherever documents
differ** (00-master-plan §0.3).

## Contract reconciliation (read first)

1. **Contact/officer columns (canonical):** `carriers.company_officer_1`,
   `carriers.company_officer_2` (sync-owned, straight from census) + app-owned overrides
   `contact_name_override`, `contact_phone_override`, `contact_email_override`.
   Display rule everywhere: `contact_name = coalesce(contact_name_override, company_officer_1)`
   (same coalesce pattern for phone/email; RPC return shapes already do this).
   Part B's mapping-table aliases `contact_name_1/2` mean these canonical columns.
2. **RPC surface (canonical names = Part A §5).** Part 02's frontend table uses working
   aliases; the mapping is:
   `search_count` → **`count_carriers`** · `search_preview` → **`search_carriers`** (page 1)
   · `batch_geojson` → read `batch_dashboard.zones` (+ `batch_members_map` / `search_carriers_map` for pins)
   · `dashboard_batches` → select **`batch_dashboard`** view
   · `batch_status_counts` → read `status_counts` from the batch's `batch_dashboard` row
   · `set_batch_status` → **`bulk_set_status`** (bulk) / plain `PATCH batch_carriers` (single, D7)
   · `log_contact` → plain `INSERT contact_logs` · `add_comment` → plain `INSERT batch_activity`
   · `set_dnc` → **`set_do_not_contact`** · `mark_promoted` → plain `PATCH batch_carriers.promoted_at`.
3. **Two approved contract ADDITIONS to Part A §5** (frontend needs them; implement in the
   RPC migration): **`facet_cargo_flags(p_definition jsonb)`** → `(flag text, carrier_count bigint)`
   for the 30 checkbox live counts (same SCOPE RULE as `facet_other_values`: counts computed
   with the `cargo` key removed from the definition); and extended **`batch_members`**
   filter args: `p_min_insurance bigint default null`, `p_size_min int default null`,
   `p_size_max int default null`, `p_has_phone boolean default null`,
   `p_has_email boolean default null` (working-list toolbar parity — F16/F17).
4. **No Places Autocomplete anywhere** (cost rule, 04 §1): Address / pickup / dropoff
   inputs **geocode on Enter** via the Geocoding API (TX-biased `region=us`,
   `components=administrative_area:TX`). 02's mentions of "Places Autocomplete" read as
   this geocode-on-enter control. Pin-drop and City/ZIP/County anchors need no Google call
   at all (local combobox/centroid tables).
5. **Vocabulary:** UI "**lane**" = DB "**zone**" (`batch_zones` rows). One concept.
6. **Geometry column:** `carriers.geom` is `geography(Point,4326)` (Part A's matcher
   casts accordingly); `lat`/`lng` float mirrors exist for cheap reads (Part B writes both).

---

# Part A — Supabase Schema v2 (database & API)

# Twisted Nail Carrier Recruiter — Database & API Architecture (Supabase Schema v2)

**Status:** build-ready spec. Upgrades the v1 mock model (`mockup/README.md` mapping table, `mockup/src/data.js` shapes) with every Feedback-Round-1 delta. All SQL targets Postgres 15+ on Supabase. Carrier scale assumption: TX slice of census `az4n-8mr2` ≈ 150–220k rows; working views 250–5,000 rows (brief §5, §13).

**Headline decisions (justified inline below):**

| # | Decision | Why |
|---|---|---|
| D1 | `dot_number bigint` is the PK of `carriers` and the FK everywhere — no surrogate | Locked identifier decision; matches onboarding-tool handoff (brief §3, §11) |
| D2 | Hot census fields = real columns (incl. all 30 `crgo_*` booleans, 1:1 Socrata names); the full 142-field record kept in `carriers.census_raw jsonb` | Zero-transform daily ingest; the F7 rich profile renders the long tail without 142 columns |
| D3 | Zones are **rows** (`batch_zones`), not jsonb inside the batch — geometry typed, per-zone label/params | F21 multi-lane is first-class; refresh and map both read the same rows |
| D4 | One internal matcher `internal.matching_carriers(definition jsonb)` powers search, live count, facets, snapshot, and refresh | Guarantees "Refresh adds exactly what Search would find" — no drift |
| D5 | `cargo_other_values` is a **table** (sync-upserted), not a materialized view | It carries hand-curated columns (`match_group`, `is_sand_gravel`) that a matview refresh would destroy; scoped facet counts are computed live by RPC anyway (F14/G8) |
| D6 | Warning flags = STABLE SQL **function + view**, never stored | Predicate spans 3 tables (generated columns can't); source tables re-sync daily (stored flags go stale); at ≤5k-row result sets the join cost is nil (F15/G5) |
| D7 | Single-row status changes are plain `UPDATE`s via PostgREST; **triggers** auto-log activity; RPCs exist only where multi-row/multi-table atomicity is required (create/refresh/bulk/DNC) | Fewest moving parts; Realtime broadcasts the table change natively (F11/G7) |
| D8 | `carriers` is **not** in the Realtime publication (daily sync would flood it); DNC changes propagate via `batch_activity` rows | Keeps live channels quiet and meaningful |
| D9 | Sync-owned vs app-owned columns are formally separated; nightly upsert's `SET` list never touches app-owned columns (`do_not_contact`, `contact_*_override`, geocode fields) | Owner edits and DNC can never be clobbered by the cron |
| D10 | Email-blast module (F10) ships as its own later migration set (`campaigns`, `campaign_recipients`, `esp_events`); v2 schema pre-anticipates it via `contact_logs.channel` and `contact_suppressions` | Owner deferred timing; separable milestone as instructed |

---

## 1. Migration layout & versioning

```
supabase/
  config.toml
  migrations/
    20260720000100_extensions.sql
    20260720000200_enums.sql
    20260720000300_profiles.sql          -- + auth.users trigger (needs enums)
    20260720000400_carriers.sql          -- carriers + insurance + safety + inspections + sync_runs
    20260720000500_cargo_other_values.sql
    20260720000600_batches.sql           -- batches, batch_zones, batch_carriers
    20260720000700_contact.sql           -- contact_logs, contact_suppressions
    20260720000800_activity.sql          -- batch_activity + auto-log triggers
    20260720000900_warnings.sql          -- warning fn + carrier_warnings view
    20260720001000_internal_matcher.sql  -- internal schema + matching_carriers
    20260720001100_rpc.sql              -- public RPC surface + dashboard view
    20260720001200_rls.sql              -- enable RLS + all policies + grants
    20260720001300_realtime.sql         -- publication membership
  seed.sql                               -- dev-only deterministic data (see §8)
scripts/
  seed-auth-users.ts                     -- dev auth users via admin API (see §8)
```

Rules: one concern per file; **never edit a shipped migration** — fix forward with a new file. Local dev: `supabase start` + `supabase db reset` (runs migrations then `seed.sql`). Deploy: `supabase db push` from CI (Render deploy hook or GitHub Action) against the linked project. Schema drift check in CI: `supabase db diff --linked` must be empty. The Render cron/worker connects with the **service_role** key (bypasses RLS; it is the only writer of sync-owned columns per D9).

Postgres schemas: `public` (PostgREST-exposed tables + RPCs) and `internal` (helpers, matcher, trigger functions — **not** in PostgREST's exposed schemas; `REVOKE ALL ON SCHEMA internal FROM anon, authenticated` except where noted).

---

## 2. DDL — migration-ordered

### 2.1 `..._extensions.sql`

```sql
create extension if not exists postgis;        -- geo: ST_DWithin radius + corridor (F6/F13/F21, G1)
create extension if not exists pg_trgm;        -- fuzzy match on cargo other-desc + carrier names (F14, brief §4)
-- gen_random_uuid() is built-in (pgcrypto not required on PG15).
create schema if not exists internal;
```

### 2.2 `..._enums.sql`

```sql
create type user_role  as enum ('manager','edit','view','guest');            -- brief §7
create type user_status as enum ('pending','approved','disabled');           -- approval workflow

create type batch_carrier_status as enum
  ('new','attempted','contacted','interested','not_a_fit');                  -- locked pipeline (§16 addendum)

create type contact_channel as enum ('call','text','email','mail');          -- F8 (mail reserved for Phase 3)

create type contact_disposition as enum
  ('no_answer','voicemail','connected','callback','interested',
   'not_interested','wrong_number',              -- call-ish (mockup carry-forward names)
   'sent','replied','bounced');                  -- text/email manual logging (F8)
-- channel↔disposition compatibility is a UI concern; DB stays permissive.

create type zone_type as enum ('radius','corridor');                         -- F21 (extensible: ALTER TYPE ADD VALUE 'polygon' later)

create type anchor_kind as enum ('pin','address','city','zip','county');     -- F12, exactly this order in UI

create type geocode_precision as enum
  ('rooftop','range_interpolated','geometric_center','approximate',          -- Google location_type values
   'zip_centroid','city_centroid','none');                                   -- our fallback tiers (brief §5)

create type authority_status as enum ('active','pending','inactive','none','unknown');

create type activity_type as enum
  ('batch_created','members_added','refresh','status_change','bulk_status_change',
   'carrier_removed','promoted','dnc_set','dnc_cleared','comment','export'); -- F11

create type suppression_channel as enum ('call','text','email','mail','all');
create type suppression_source  as enum
  ('manual','carrier_request','dnc_registry','esp_unsubscribe','esp_bounce','sms_stop');
create type sync_source as enum ('census','li','sms_safety','inspections','geocode');
```

### 2.3 `..._profiles.sql`

```sql
create table public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  email        text not null,
  full_name    text not null default '',
  role         user_role  not null default 'guest',      -- F1; guest until approved (brief §7)
  status       user_status not null default 'pending',
  avatar_color text not null default '#64748b',           -- mockup users[].color carry-forward
  approved_by  uuid references public.profiles(id),
  approved_at  timestamptz,
  created_at   timestamptz not null default now()
);

-- Standard Supabase pattern: auto-provision a pending-guest profile on signup.
create function internal.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name',''));
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function internal.handle_new_user();

-- Privilege-escalation guard: only managers may change role/status/approval columns.
create function internal.guard_profile_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (new.role, new.status, new.approved_by, new.approved_at)
     is distinct from (old.role, old.status, old.approved_by, old.approved_at)
     and internal.current_app_role() <> 'manager' then
    raise exception 'only managers may change role/approval';
  end if;
  return new;
end $$;
create trigger guard_profile_update before update on public.profiles
  for each row execute function internal.guard_profile_update();
```

(`internal.current_app_role()` is defined in §6 with RLS.)

### 2.4 `..._carriers.sql`

**Column-name contract:** every sync-owned column is named **identically to its Socrata field** in `az4n-8mr2` so the Render ingest job is a straight field-list copy (no mapping layer). Worker must verify the 30 `crgo_*` names against dataset metadata on first run; the list below is the standard MCMIS cargo-classification set.

```sql
create table public.carriers (
  -- ============ identity (D1) ============
  dot_number        bigint primary key,

  -- ============ SYNC-OWNED (census az4n-8mr2; overwritten nightly) ============
  legal_name        text not null,
  dba_name          text,
  phy_street        text, phy_city text, phy_state text, phy_zip text,
  phone             text, cell_phone text, email_address text, fax text,   -- G4 contactability raw
  company_officer_1 text, company_officer_2 text,                          -- F9/F17 contact-name source
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
  crgo_cargoothr_desc text,                       -- THE core signal (brief §4 Tier 1)
  census_raw        jsonb,                        -- full 142-field record for the F7 rich profile (D2)
  census_updated_at timestamptz,                  -- when the source row last changed
  last_synced_at    timestamptz,
  first_seen_at     timestamptz not null default now(),
  address_hash      text,                         -- md5(phy_street|city|state|zip); ingest maintains

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
```

**Carriers are never deleted.** A carrier that drops out of the census keeps its row; `status_code` flips and `last_synced_at` goes stale — history, timelines and batch membership survive (G10 honesty: UI shows "last seen in FMCSA data on …").

**1:1 / 1:N satellites (all sync-owned, service_role-written):**

```sql
create table public.carrier_insurance (           -- L&I jeyh-5nsj family (brief §3)
  dot_number        bigint primary key references public.carriers(dot_number) on delete cascade,
  common_status     authority_status not null default 'unknown',
  contract_status   authority_status not null default 'unknown',
  broker_status     authority_status not null default 'unknown',
  authority_raw     jsonb,                        -- untouched L&I authority fields
  authority_active  boolean generated always as
    (common_status = 'active' or contract_status = 'active') stored,
  bipd_required     bigint,                       -- DOLLARS. L&I publishes THOUSANDS → ingest ×1000 (critical!)
  bipd_on_file      bigint,                       -- DOLLARS (null = nothing on file)
  cargo_on_file     bigint,
  bond_on_file      bigint,
  insurer_name      text,
  policy_effective_date date,
  last_synced_at    timestamptz not null default now()
);

create table public.carrier_safety (              -- SMS census kjg3-diqy, monthly (brief §3 caveat 4)
  dot_number         bigint primary key references public.carriers(dot_number) on delete cascade,
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

create table public.sync_runs (                   -- G10: honest data freshness for the UI footer
  id            bigint generated always as identity primary key,
  source        sync_source not null,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  rows_upserted int,
  ok            boolean,
  error         text
);
```

**Ingest contract (Render cron, service_role):** `COPY` into a temp staging table → `INSERT ... ON CONFLICT (dot_number) DO UPDATE SET <sync-owned columns only>` — the SET list explicitly excludes every APP-OWNED column (D9). Then upsert `cargo_other_values` (§2.5), then enqueue geocoding for rows where `geom is null or geocode_addr_hash is distinct from address_hash`.

### 2.5 `..._cargo_other_values.sql` — the F14 facet backbone (table, not matview: D5)

```sql
create table public.cargo_other_values (
  value               text primary key,           -- = carriers.cargo_other_norm
  carrier_count_tx    int  not null default 0,    -- global TX count; refreshed nightly
  sample_raw          text,                       -- one original-casing example for display
  match_group         text,                       -- CURATED: 'sand'|'gravel'|'rock'|'dirt'|'aggregate'|'stone'|'base'|null
  is_sand_gravel      boolean not null default false,  -- CURATED: brief §4 Tier-1 term list
  first_seen_at       timestamptz not null default now(),
  last_seen_at        timestamptz not null default now()
);
```

Nightly sync upserts counts/`last_seen_at` **without touching** `match_group`/`is_sand_gravel` (same D9 discipline). A seed migration statement pre-curates the obvious groups by pattern (`value ~ 'sand|gravel|aggregate|rock|dirt|stone|base'` → `match_group`, `is_sand_gravel = true` for sand/gravel/aggregate patterns); the manager refines from the UI. This table powers the **suggested likely-match keyword chips with counts** (F14) instantly; **scoped** counts always come from the live facet RPC (§5.3) because they depend on the user's current geo/filters — a matview cannot be parameterized by scope, and a matview would also lose the curation columns on refresh. That is the justification asked for.

### 2.6 `..._batches.sql`

```sql
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
  label          text not null,                    -- 'Austin · 55 mi' / 'Austin → San Antonio · 40 mi' (map legend, F22)
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
-- Coverage = UNION over a batch's zones (OR of per-zone ST_DWithin) — the F21 'amorphous blob'.
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
```

`batch_carriers → carriers` is `ON DELETE RESTRICT` deliberately: membership history must make carrier deletion impossible (carriers are never deleted anyway). Batch deletion cascades zones/members/activity, but **not** contact history (§2.7).

### 2.7 `..._contact.sql`

```sql
create table public.contact_logs (                 -- F8/G6: unified multi-channel timeline
  id           uuid primary key default gen_random_uuid(),
  dot_number   bigint not null references public.carriers(dot_number) on delete restrict,
  batch_id     uuid references public.batches(id) on delete set null,  -- timeline SURVIVES batch deletion
  user_id      uuid not null references public.profiles(id),
  channel      contact_channel not null,           -- call | text | email (mail reserved)
  disposition  contact_disposition not null,
  notes        text,
  next_steps   text,
  callback_at  timestamptz,                        -- drives 'callbacks due' surfacing
  contacted_at timestamptz not null default now(), -- backdatable ('logged a call from this morning')
  created_at   timestamptz not null default now()
);
-- Immutable ledger: no UPDATE policy for anyone; DELETE manager-only (§6).

create table public.contact_suppressions (         -- brief §9 + F10 legitimate-email groundwork
  id          bigint generated always as identity primary key,
  dot_number  bigint references public.carriers(dot_number) on delete cascade,  -- null = value-only suppression
  channel     suppression_channel not null,
  value       text,                                -- specific phone/email suppressed; null = whole carrier+channel
  reason      text,
  source      suppression_source not null default 'manual',
  created_by  uuid references public.profiles(id), -- null when machine-written (ESP webhook, DNC scrub)
  created_at  timestamptz not null default now(),
  expires_at  timestamptz,                         -- DNC-registry scrubs age out
  constraint target_present check (dot_number is not null or value is not null)
);
create unique index uq_suppress_value   on public.contact_suppressions(channel, lower(value)) where value is not null;
create unique index uq_suppress_carrier on public.contact_suppressions(dot_number, channel)   where value is null;
```

Division of labor: `carriers.do_not_contact` is the **global, UI-critical flag** (red badge everywhere, locked rule); `contact_suppressions` is the **channel/value compliance ledger** (email unsubscribe, SMS STOP, DNC-registry hits) that future senders must consult. `internal.is_contactable(dot, channel)` (§5.6) evaluates both.

### 2.8 `..._activity.sql` — F11/G7

```sql
create table public.batch_activity (
  id            bigint generated always as identity primary key,  -- monotonic feed order
  batch_id      uuid not null references public.batches(id) on delete cascade,
  actor_id      uuid references public.profiles(id),              -- null = system
  activity_type activity_type not null,
  payload       jsonb not null default '{}'::jsonb,
  comment       text,                                             -- only for activity_type='comment'
  created_at    timestamptz not null default now(),
  constraint comment_shape check ((activity_type = 'comment') = (comment is not null))
);
```

**Auto-logging (D7):** trigger functions are `SECURITY DEFINER` (they must insert regardless of the caller's activity-INSERT policy), actor from `auth.uid()`:

```sql
create function internal.log_bc_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if current_setting('app.suppress_row_activity', true) = 'on' then return new; end if;  -- bulk ops log once
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    new.status_changed_by := auth.uid();  new.status_changed_at := now();
    insert into public.batch_activity (batch_id, actor_id, activity_type, payload)
    values (new.batch_id, auth.uid(), 'status_change',
            jsonb_build_object('dot_number', new.dot_number, 'from', old.status, 'to', new.status));
  end if;
  if tg_op = 'UPDATE' and new.promoted_at is not null and old.promoted_at is null then
    new.promoted_by := auth.uid();
    insert into public.batch_activity (batch_id, actor_id, activity_type, payload)
    values (new.batch_id, auth.uid(), 'promoted', jsonb_build_object('dot_number', new.dot_number));  -- F23
  end if;
  return new;
end $$;
create trigger trg_bc_change before update on public.batch_carriers
  for each row execute function internal.log_bc_change();

create function internal.log_bc_delete() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.batch_activity (batch_id, actor_id, activity_type, payload)
  values (old.batch_id, auth.uid(), 'carrier_removed', jsonb_build_object('dot_number', old.dot_number));
  return old;
end $$;
create trigger trg_bc_delete before delete on public.batch_carriers
  for each row execute function internal.log_bc_delete();
```

Batch-level events (`batch_created`, `members_added`, `refresh`, `bulk_status_change`, `export`, `dnc_set/cleared`) are written by their RPCs (§5). Manual comments are direct inserts gated by RLS (`activity_type='comment' and actor_id = auth.uid()`).

### 2.9 Indexes (in each table's migration file)

```sql
-- carriers: the hot paths
create index idx_carriers_geom        on public.carriers using gist (geom);          -- radius+corridor (F6/F21)
create index idx_carriers_other_trgm  on public.carriers using gin (cargo_other_norm gin_trgm_ops); -- F14 keyword
create index idx_carriers_other_btree on public.carriers (cargo_other_norm) where cargo_other_norm is not null; -- facet GROUP BY
create index idx_carriers_name_trgm   on public.carriers using gin ((legal_name || ' ' || coalesce(dba_name,'')) gin_trgm_ops); -- in-batch/global name search (F19)
create index idx_carriers_status      on public.carriers (status_code);
create index idx_carriers_units      on public.carriers (power_units);
create index idx_carriers_dnc        on public.carriers (dot_number) where do_not_contact;         -- fast global-DNC joins
create index idx_carriers_geocode_todo on public.carriers (dot_number)
  where geom is null or geocode_addr_hash is distinct from address_hash;             -- geocode worker queue

-- batch domain
create index idx_zones_batch    on public.batch_zones (batch_id, sort_order);
create index idx_zones_geom     on public.batch_zones using gist (geom);
create index idx_bc_dot         on public.batch_carriers (dot_number);               -- 'which batches am I in'
create index idx_bc_batch_status on public.batch_carriers (batch_id, status);        -- F5 status-filtered lists

-- contact + activity
create index idx_logs_dot_time   on public.contact_logs (dot_number, contacted_at desc);  -- unified timeline (G6)
create index idx_logs_batch_time on public.contact_logs (batch_id, contacted_at desc);
create index idx_logs_callbacks  on public.contact_logs (callback_at) where callback_at is not null;
create index idx_logs_user       on public.contact_logs (user_id);
create index idx_activity_feed   on public.batch_activity (batch_id, id desc);       -- F11 chronological feed

-- cargo facet table
create index idx_cov_trgm  on public.cargo_other_values using gin (value gin_trgm_ops);
create index idx_cov_group on public.cargo_other_values (match_group) where match_group is not null;
```

---

## 3. Warning-flag strategy (F15/G5) — the chosen design

**Choice: STABLE SQL function + `security_invoker` view. Not a computed column** (predicate spans `carriers` + `carrier_insurance` + `carrier_safety`; generated columns are single-table). **Not stored/materialized** (sources re-sync daily/monthly; a stored flag is a staleness bug waiting to happen). **Not client-side** (the flag must appear identically in list rows, profile, dashboards, call-sheet **exports** — G5 propagation demands one server-side truth).

```sql
create function internal.warning_reasons(
  p_status_code text, p_bipd_on_file bigint, p_has_ins_row boolean, p_authority_active boolean,
  p_rating text, p_vehicle_oos numeric, p_driver_oos numeric, p_crashes int
) returns text[] language sql immutable as $$
  select coalesce(array_remove(array[
    case when p_status_code is distinct from 'A'                    then 'carrier_inactive'          end,
    case when not p_has_ins_row or coalesce(p_bipd_on_file,0) = 0   then 'no_insurance'              end,
    case when coalesce(p_bipd_on_file,0) between 1 and 999999       then 'insurance_below_standard'  end, -- $1MM bar; $500k stays VISIBLE (locked threshold rule)
    case when p_has_ins_row and not coalesce(p_authority_active,false) then 'authority_not_active'   end,
    case when p_rating in ('Conditional','Unsatisfactory')          then 'safety_rating'             end,
    case when coalesce(p_vehicle_oos,0) > 34 or coalesce(p_driver_oos,0) > 10 then 'high_oos'        end, -- ≈1.5× national averages; single tuning point
    case when coalesce(p_crashes,0) >= 4                            then 'recent_crashes'            end
  ], null), '{}') $$;

create view public.carrier_warnings with (security_invoker = true) as
select c.dot_number,
       internal.warning_reasons(c.status_code, i.bipd_on_file, i.dot_number is not null,
         i.authority_active, s.safety_rating, s.vehicle_oos_rate, s.driver_oos_rate, s.crash_total_24mo)
         as warning_reasons
from public.carriers c
left join public.carrier_insurance i using (dot_number)
left join public.carrier_safety    s using (dot_number);
```

**How rows carry reasons to the UI:** every list-returning RPC in §5 includes `warning_reasons text[]` and `has_warnings boolean` per row (the RPCs call `internal.warning_reasons` inline on their own joins — no extra round trip). UI contract: `warning_reasons <> '{}'` → pale-red row + alert chips naming each code, rendered on batch lists, search results, the profile header, and the generated call sheet (F15/G5). The seven codes above are the **complete closed vocabulary**; the frontend maps them to copy (e.g. `insurance_below_standard` → "BIPD below $1MM"). This replaces the removed "exclude concerning safety" filter — nothing is silently excluded (F15).

---

## 4. The `search_definition` jsonb contract (single source of truth)

Carry-forward of the mockup's `search` object, upgraded. **Stored on `batches.search_definition` WITHOUT the `zones` key** (zones are materialized to `batch_zones` at creation; `refresh_batch` re-composes them — D3/D4). Passed **with** `zones` inline to search/count/facet RPCs during live building (F13 live map editing).

```jsonc
{
  "zones": [                                                   // F21: 1..N, UNION semantics
    { "zone_type": "radius",
      "params": { "anchor_kind": "city",                        // F12 enum: pin|address|city|zip|county
                  "anchor_label": "Austin, TX",
                  "lng": -97.743, "lat": 30.267, "radius_miles": 55 } },
    { "zone_type": "corridor",
      "params": { "origin_label": "Austin, TX", "dest_label": "San Antonio, TX",   // F13: custom each time
                  "route_provider": "google",                   // fallback: 'osrm' (pending maps decision)
                  "route": [[-97.743,30.267],[-98.10,29.89],[-98.494,29.424]],     // decoded+simplified polyline [lng,lat]
                  "buffer_miles": 40 } }
  ],
  "cargo": {                                                   // F14 reinvention
    "flags": ["crgo_drybulk","crgo_construct","crgo_bldgmat"], // plain checkboxes; validated against the 30-name whitelist
    "other": { "enabled": true,
               "include": ["sand & gravel","sand and gravel","rock"],  // normalized values from the facet browser
               "exclude": ["landscape rock"] }
  },
  "contactability": { "has_phone": true, "has_email": false }, // F16/G4
  "insurance": { "min_bipd": 1000000,                          // threshold, never silent exclusion
                 "enforce": false,                             // false → all visible, warnings mark below-bar
                 "require_insured": false },                   // true → bipd_on_file > 0 (owner's 'no insurance' disqualifier)
  "power_units": { "min": 1, "max": 200 },
  "status": { "active_only": true, "authorized_only": true,
              "for_hire_only": true, "interstate_only": false },
  "exclude_dnc": true                                          // default true; DNC never enters new work
}
```

**Cargo matching semantics (decisive, document in UI):** a carrier matches the cargo block iff
`(any selected flag is true OR cargo_other_norm ∈ include)` **AND** `cargo_other_norm ∉ exclude`. Exclude is dominant — a carrier whose Other-description is excluded is dropped even if a flag also matches (an excluded value like "landscape rock" is an explicit "not my freight" verdict). If `cargo` is absent/empty → no cargo filtering. If `zones` is absent → statewide (geo optional, filters still apply).

---

## 5. RPC / API surface

Everything below lives in `public`, `LANGUAGE plpgsql STABLE` unless noted, `SECURITY INVOKER` (RLS applies) except where flagged. All list RPCs return `total_count` via `count(*) over ()` for server-side pagination (F5/G3). Sort columns are whitelisted via `CASE` mapping — never interpolated.

### 5.0 Internal keystone (D4)

```sql
-- internal.matching_carriers(p_def jsonb) returns setof bigint  -- dot_numbers matching the definition
```

Predicate assembly (the exact geo-UNION mechanics):

```sql
-- zone UNION: EXISTS over inline zones; 1609.344 m/mile; geography ⇒ geodesic + GiST-accelerated
exists (
  select 1 from jsonb_array_elements(p_def->'zones') z
  where st_dwithin(
    c.geom,
    case z->>'zone_type'
      when 'radius'   then st_setsrid(st_makepoint((z->'params'->>'lng')::float8,
                                                   (z->'params'->>'lat')::float8),4326)::geography
      when 'corridor' then st_setsrid(st_makeline(array(
                             select st_makepoint((pt->>0)::float8,(pt->>1)::float8)
                             from jsonb_array_elements(z->'params'->'route') pt)),4326)::geography
    end,
    coalesce((z->'params'->>'radius_miles')::numeric,
             (z->'params'->>'buffer_miles')::numeric) * 1609.344))
-- plus, AND-ed: cargo per §4 semantics; power_units between; status_code='A' if active_only;
-- classdef='Authorized For Hire' if for_hire_only; carrier_operation ilike 'interstate%' if interstate_only;
-- authority via LEFT JOIN carrier_insurance (authorized_only ⇒ authority_active);
-- insurance.enforce ⇒ bipd_on_file >= min_bipd; require_insured ⇒ coalesce(bipd_on_file,0) > 0;
-- contactability: has_phone ⇒ coalesce(contact_phone_override, phone, cell_phone) is not null;
--                 has_email ⇒ coalesce(contact_email_override, email_address) is not null;   -- F16/G4
-- exclude_dnc ⇒ not do_not_contact;  geom is not null whenever zones are present.
```

`refresh_batch` and `create_batch` call it with `p_def = batches.search_definition || jsonb_build_object('zones', <re-serialized from batch_zones.params>)` — search, snapshot and refresh can never disagree.

### 5.1 `search_carriers` — paged results (search builder + pre-batch review)

```sql
search_carriers(p_definition jsonb, p_page int default 1, p_page_size int default 50,
                p_sort text default 'legal_name', p_dir text default 'asc')
returns table (
  dot_number bigint, legal_name text, dba_name text,
  contact_name text, phone text, cell_phone text, email text,      -- F9/F16/F17/G4 (override-coalesced)
  phy_city text, phy_state text, phy_zip text,
  power_units int, total_drivers int, classdef text, carrier_operation text,
  cargo_other_desc text, cargo_flags text[],                       -- flags = names of true crgo_* cols
  bipd_on_file bigint, authority_active boolean,
  lng float8, lat float8, geocode_precision geocode_precision,     -- ST_X/ST_Y(geom)
  do_not_contact boolean,
  matched_zones text[],                                            -- F21/F22: which lane(s) hit (zone labels or 'Zone n')
  warning_reasons text[], has_warnings boolean,                    -- §3 (F15/G5)
  in_batches int,                                                  -- count of existing memberships (dedupe awareness)
  total_count bigint
);
-- sort whitelist: legal_name | power_units | phy_city | dot_number | bipd_on_file
```

### 5.2 `count_carriers` — the live match counter (F13 live editing, G10 honest coverage)

```sql
count_carriers(p_definition jsonb)
returns table (match_count bigint, with_phone bigint, with_email bigint,
               with_warnings bigint, dnc_excluded bigint, geocoded_pct numeric);
-- one aggregate pass over internal.matching_carriers; debounce client-side at ~300ms while sliders drag
```

### 5.3 `facet_other_values` + `facet_suggested_keywords` — F14/G8

```sql
facet_other_values(p_definition jsonb, p_keyword text default null,
                   p_limit int default 100, p_offset int default 0)
returns table (value text, sample_raw text, carrier_count bigint,   -- count WITHIN current scope
               match_group text, is_sand_gravel boolean, total_values bigint);
-- SCOPE RULE (decisive): counts run over p_definition WITH THE ENTIRE 'cargo' KEY REMOVED —
-- the browser must show the value distribution inside the current geo/status/size/contactability
-- scope, unbiased by the cargo selection being built. p_keyword filters via trgm ILIKE '%kw%'.
-- Order: carrier_count desc, value asc. Joined to cargo_other_values for curation columns.

facet_suggested_keywords(p_definition jsonb)
returns table (match_group text, value_count int, carrier_count bigint);
-- the 'suggested likely-match keywords with counts' chips: GROUP BY match_group over the same scope,
-- seeded by the curated cargo_other_values.match_group (§2.5)
```

### 5.4 Batch operations (VOLATILE)

```sql
create_batch(p_name text, p_customer text, p_job text, p_description text,
             p_definition jsonb)                                    -- WITH zones inline
returns table (batch_id uuid, member_count int);
-- Atomic: insert batch (search_definition = p_definition - 'zones'); insert batch_zones rows,
-- building geom from params (point / linestring per §5.0) — server builds geometry, client never sends WKT;
-- snapshot: insert into batch_carriers select matching dots (status 'new');
-- set snapshot_taken_at; log 'batch_created' + 'members_added' {count} activity.  (F20/F21/G9)

refresh_batch(p_batch_id uuid)
returns table (added_count int, added_dots bigint[]);
-- Recompose definition from search_definition + batch_zones; INSERT ... ON CONFLICT DO NOTHING
-- with added_via_refresh = true; NEVER deletes (locked rule); bump last_refreshed_at/refresh_count;
-- log 'refresh' {added_count}. Runs with app.suppress_row_activity='on'.

bulk_set_status(p_batch_id uuid, p_dots bigint[], p_status batch_carrier_status)
returns int;   -- rows updated
-- set_config('app.suppress_row_activity','on',true) → one 'bulk_status_change'
-- {to, count, dots(first 50)} activity row instead of N. (F5 bulk actions, F11)

set_do_not_contact(p_dot bigint, p_on boolean, p_reason text default null)
returns void;
-- Updates carriers.do_not_contact (+reason/by/at); mirrors a contact_suppressions row
-- (channel 'all', source 'carrier_request'/'manual') on set, expires it on clear;
-- logs 'dnc_set'/'dnc_cleared' into EVERY batch currently containing the carrier —
-- the feed is where the team lives, so the global flag surfaces everywhere (locked rule, F11/G7).

log_export(p_batch_id uuid, p_kind text, p_row_count int) returns void;  -- call-sheet/CSV audit (F11)
```

Single-row mutations that are **plain PostgREST updates, no RPC** (D7): status change (`PATCH batch_carriers` on `batch_id+dot_number`), promote (`promoted_at = now()`; trigger stamps `promoted_by`, logs F23 activity), comment (`INSERT batch_activity` with `activity_type='comment'`), contact log (`INSERT contact_logs`), member remove (`DELETE batch_carriers`, manager per §6).

### 5.5 Batch working page & dashboard reads

```sql
batch_members(p_batch_id uuid,
              p_status batch_carrier_status[] default null,
              p_q text default null,               -- F19 in-batch search: trgm over name/dba + dot::text prefix
              p_warnings_only boolean default false,
              p_page int default 1, p_page_size int default 50,
              p_sort text default 'status', p_dir text default 'asc')
returns table (
  dot_number bigint, legal_name text, dba_name text,
  contact_name text, phone text, email text,        -- F17 columns (override-coalesced)
  phy_city text, power_units int,
  status batch_carrier_status, status_changed_at timestamptz, status_changed_by_name text,
  added_via_refresh boolean, promoted_at timestamptz,
  do_not_contact boolean, warning_reasons text[], has_warnings boolean,
  last_contact_at timestamptz, last_contact_channel contact_channel, contact_count int,  -- G6 summary
  lng float8, lat float8,
  total_count bigint
);
-- sort whitelist: status | legal_name | phy_city | power_units | last_contact_at | added_at
-- Server-side everything: F5/G3 (hundreds→thousands of rows; page size ≤ 200).

batch_members_map(p_batch_id uuid, p_status batch_carrier_status[] default null)
returns table (dot_number bigint, lng float8, lat float8,
               status batch_carrier_status, do_not_contact boolean, has_warnings boolean);
-- All pins in one call (≤5k, brief §5) for the list⇄map toggle + colored/numbered pins + legend (F22/F6/G1).

search_carriers_map(p_definition jsonb, p_limit int default 5000)
returns table (dot_number bigint, lng float8, lat float8, has_warnings boolean, matched_zones text[]);
-- Live builder map overlay (F13).

generate_contact_sheet(p_batch_id uuid, p_dots bigint[] default null)   -- null = whole batch
returns table (dot_number bigint, legal_name text, dba_name text,
               contact_name text, email text,                            -- F9: the two ADDED columns
               phone text, cell_phone text, phy_city text, phy_state text,
               status batch_carrier_status, warning_reasons text[],      -- G5 reaches call sheets
               last_contact_at timestamptz, next_steps text);            -- latest log's next_steps
-- HARD-EXCLUDES do_not_contact carriers and call/all-channel suppressions (locked DNC rule, §2.7).
-- Frontend renders Print + CSV from this one shape. NO 'Copy USDOT list' anywhere (F9 removal);
-- USDOT promotion is per-carrier via promoted_at (F23).
```

Dashboard (F3/F4/G2) — a view, directly PostgREST-selectable:

```sql
create view public.batch_dashboard with (security_invoker = true) as
select b.id, b.name, b.customer, b.job, b.created_by, p.full_name as created_by_name,
       b.created_at, b.snapshot_taken_at, b.last_refreshed_at, b.archived_at,
       (select count(*) from batch_carriers bc where bc.batch_id = b.id)            as member_count,
       (select coalesce(jsonb_object_agg(s.status, s.n), '{}'::jsonb) from
          (select status, count(*) n from batch_carriers where batch_id = b.id group by 1) s)
                                                                                     as status_counts,
       (select count(*) from batch_carriers bc where bc.batch_id = b.id and bc.promoted_at is not null)
                                                                                     as promoted_count,
       (select max(a.created_at) from batch_activity a where a.batch_id = b.id)      as last_activity_at,
       (select coalesce(jsonb_agg(jsonb_build_object(
               'id', z.id, 'zone_type', z.zone_type, 'label', z.label,
               'params', z.params, 'distance_miles', z.distance_miles)
               order by z.sort_order), '[]'::jsonb)
          from batch_zones z where z.batch_id = b.id)                                as zones
from public.batches b join public.profiles p on p.id = b.created_by;
-- Frontend: WHERE archived_at IS NULL → the F4 all-active-batches map (drawn from zones jsonb)
-- above the batch table; row click → batch page. Also feeds the stat-counter strip (F24/G10).
```

Carrier profile (F7) needs **no RPC** — one PostgREST embed:
`GET /carriers?dot_number=eq.{dot}&select=*,carrier_insurance(*),carrier_safety(*),carrier_inspections(*),batch_carriers(batch_id,status,promoted_at,batches(name,customer,job)),contact_logs(*,profiles(full_name))` plus `carrier_warnings?dot_number=eq.{dot}` for the header alert chips. `census_raw` supplies the long-tail fields for the verification-style tiles. Contact timeline is `contact_logs` ordered by `contacted_at desc` — unified across batches (G6).

### 5.6 Compliance helper (used by call-sheet now; email/SMS modules later — F10)

```sql
internal.is_contactable(p_dot bigint, p_channel contact_channel) returns boolean;
-- false if carriers.do_not_contact
--   OR a live contact_suppressions row matches (dot_number, channel in (p_channel,'all'))
--   OR the target value (phone/email incl. overrides) matches a value-level suppression;
-- 'live' = expires_at is null or expires_at > now().
-- Exposed to authenticated via public.is_contactable wrapper for UI badges.
```

---

## 6. RLS — roles, approval gating, policies

Helper (SECURITY DEFINER breaks the profiles-RLS recursion):

```sql
create function internal.current_app_role() returns user_role
language sql stable security definer set search_path = public as
$$ select role from public.profiles where id = auth.uid() and status = 'approved' $$;
-- NULL for anon, pending guests, and disabled users → default-deny everywhere = the guest landing gate (brief §7)

create function internal.is_staff() returns boolean language sql stable as
$$ select internal.current_app_role() in ('manager','edit','view') $$;
create function internal.can_edit() returns boolean language sql stable as
$$ select internal.current_app_role() in ('manager','edit') $$;
create function internal.is_manager() returns boolean language sql stable as
$$ select internal.current_app_role() = 'manager' $$;
grant execute on function internal.current_app_role, internal.is_staff,
  internal.can_edit, internal.is_manager to authenticated;
```

`alter table ... enable row level security` on **every** public table. service_role bypasses RLS (sync writers). Policy matrix, with representative SQL:

```sql
-- profiles: own row always (pending guest sees own pending state); staff see all (names in feeds);
-- manager updates anyone (approval, F1); self-update guarded by the §2.3 trigger.
create policy profiles_select on public.profiles for select
  using (id = auth.uid() or internal.is_staff());
create policy profiles_update_self on public.profiles for update
  using (id = auth.uid()) with check (id = auth.uid());
create policy profiles_update_mgr on public.profiles for update
  using (internal.is_manager()) with check (internal.is_manager());

-- carriers + satellites + cargo_other_values + sync_runs: read for staff; guests see nothing.
create policy carriers_select on public.carriers for select using (internal.is_staff());
--   UPDATE: row policy for editors + COLUMN grants restrict to app-owned columns (D9):
create policy carriers_update on public.carriers for update
  using (internal.can_edit()) with check (internal.can_edit());
revoke update on public.carriers from authenticated;
grant  update (do_not_contact, dnc_reason, dnc_set_by, dnc_set_at,
               contact_name_override, contact_phone_override, contact_email_override)
  on public.carriers to authenticated;           -- everything else is service_role-only
--   (equivalent select-for-staff policies on carrier_insurance, carrier_safety,
--    carrier_inspections, cargo_other_values, sync_runs; cargo_other_values curation columns
--    UPDATE-grantable to manager only: grant update (match_group, is_sand_gravel) ... + manager row policy)

-- batches / batch_zones: read staff; write editors; delete manager.
create policy batches_select on public.batches for select using (internal.is_staff());
create policy batches_write  on public.batches for insert with check (internal.can_edit() and created_by = auth.uid());
create policy batches_update on public.batches for update using (internal.can_edit());
create policy batches_delete on public.batches for delete using (internal.is_manager());
-- batch_zones: same pattern keyed through internal.can_edit(); delete for can_edit (lane management).

-- batch_carriers: read staff; insert/update editors; delete manager (removal is exceptional).
create policy bc_select on public.batch_carriers for select using (internal.is_staff());
create policy bc_insert on public.batch_carriers for insert with check (internal.can_edit());
create policy bc_update on public.batch_carriers for update using (internal.can_edit());
create policy bc_delete on public.batch_carriers for delete using (internal.is_manager());

-- contact_logs: immutable ledger. Read staff; insert editors AS THEMSELVES; no update; manager delete.
create policy logs_select on public.contact_logs for select using (internal.is_staff());
create policy logs_insert on public.contact_logs for insert
  with check (internal.can_edit() and user_id = auth.uid());
create policy logs_delete on public.contact_logs for delete using (internal.is_manager());

-- batch_activity: read staff; direct INSERT is comments-only, as yourself (auto rows come from
-- SECURITY DEFINER triggers/RPCs); no update; manager delete.
create policy act_select on public.batch_activity for select using (internal.is_staff());
create policy act_comment on public.batch_activity for insert
  with check (internal.can_edit() and activity_type = 'comment' and actor_id = auth.uid());
create policy act_delete on public.batch_activity for delete using (internal.is_manager());

-- contact_suppressions: read staff; insert editors; delete manager (expiring > deleting preferred).
```

**Net role behavior:** `guest`/pending/disabled → every query empty or 403 → frontend shows the generic pending page (brief §7). `view` → all reads, zero writes (all write policies require `can_edit`). `edit` → full workflow except deletes/approval. `manager` → everything incl. Users screen (F1), curation, deletes. RPCs are `SECURITY INVOKER`, so this one matrix governs them too; the only definer code paths are the audited helpers/triggers above.

---

## 7. Realtime (live shared list + activity feed)

```sql
alter publication supabase_realtime add table
  public.batches, public.batch_zones, public.batch_carriers,
  public.batch_activity, public.contact_logs;
-- carriers deliberately EXCLUDED (D8): nightly sync churn would flood clients.
-- DNC flips reach clients as batch_activity 'dnc_set' rows (per set_do_not_contact) → refetch the carrier.
alter table public.batch_carriers replica identity full;   -- old-row values in UPDATE payloads (status transitions)
```

Client channel plan (Realtime Postgres Changes respects RLS — unauthorized users receive nothing):

- **Batch page:** one channel `batch:{id}` with three `postgres_changes` listeners filtered `batch_id=eq.{id}` on `batch_carriers` (live status/promote for all ~5 users — the locked "live shared list"), `batch_activity` (F11 feed streams in), `contact_logs` (timeline freshness).
- **Dashboard:** channel `dashboard` on `batches` (INSERT/UPDATE/DELETE) + `batch_activity` INSERTs (per-row events also bump dashboard `last_activity_at` → refetch `batch_dashboard` row, debounced).
- **Carrier profile:** listener on `contact_logs` filtered `dot_number=eq.{dot}`.

---

## 8. Seed strategy (dev)

- **`supabase/seed.sql`** (data only, deterministic — `select setseed(0.42)`): ~800 synthetic TX carriers via `generate_series`, mirroring `mockup/src/data.js` distributions (60% Tier-1 with `crgo_cargoothr_desc` drawn from the mockup's `SG_OTHER` variant list, 30% Tier-2 flag-only, 10% off-target; metro-weighted geocoded points with jitter; ~22% email fill to preserve the honest-coverage story G10; ~10% no insurance / 18% $500k / bulk $750k–$1MM+; a few Conditional ratings and ≥4-crash rows so warnings render). Then: matching `carrier_insurance`/`carrier_safety` rows, `cargo_other_values` upsert with curation pre-applied, 2 seed batches (one 2-zone multi-lane radius batch, one corridor batch — exercising F21), snapshot members with mixed statuses, contact logs across channels (F8), activity rows, one carrier shared by both batches with cross-batch timeline (the mockup's demo invariant), one DNC carrier.
- **`scripts/seed-auth-users.ts`** (service key, local only): creates the 5 mockup users via `auth.admin.createUser` (hunter/manager approved, two edit, one view, one pending guest) then updates `profiles.role/status` — auth rows cannot be reliably seeded in plain SQL across GoTrue versions.
- **Staging with real data:** run the actual Render ingest against `phy_state='TX'` into a staging Supabase project; first run doubles as the brief-§4 Tier-1 coverage measurement (report distinct `cargo_other_norm` values + fill rates from `cargo_other_values` + `count_carriers`).

---

## 9. Traceability — where each feedback item lands

| Item | Implementation |
|---|---|
| F1 | `profiles` role/status + §2.3 guard trigger + §6 manager policies |
| F2 | UI-only (reserved tabs); schema pre-provisions `contact_channel`/`suppression_channel` values |
| F3/F4/G2 | `batch_dashboard` view (map-from-`zones`-jsonb above table, counts per row) |
| F5/G3 | `batch_members` server-side filter/sort/paginate + `idx_bc_batch_status` + trgm name index |
| F6/G1 | `geography` types + GiST; zones carry map-drawable `params` |
| F7 | `census_raw` long-tail + satellite tables + `carrier_warnings` for header tiles; profile = one PostgREST embed |
| F8/G6 | `contact_logs.channel` (call/text/email, mail reserved) + disposition set + unified `(dot_number, contacted_at)` index |
| F9 | `generate_contact_sheet` adds `contact_name`+`email`; no USDOT-list endpoint exists |
| F10 | Deferred module (D10); `contact_suppressions` + `is_contactable` are its enforcement substrate |
| F11/G7 | `batch_activity` + SECURITY DEFINER auto-log triggers + comment policy + `idx_activity_feed` |
| F12 | `anchor_kind` enum in exact order pin/address/city/zip/county |
| F13 | zones passed inline to `count_carriers`/`search_carriers_map` for live editing; no preset corridors anywhere |
| F14/G8 | `cargo_other_norm` generated column + `cargo_other_values` curated table (D5) + `facet_other_values`/`facet_suggested_keywords` + include/exclude semantics (§4) |
| F15/G5 | §3 function+view, 7-code closed vocabulary, `warning_reasons` on every list RPC and the call sheet; no exclude-safety filter exists |
| F16/G4 | `contactability` block in definition; coalesced override→census contact fields in every return shape |
| F17 | `contact_name/phone/email` columns in `batch_members` |
| F18 | `contact_*_override` app-owned columns (manual research MVP); enrichment tables deferred |
| F19 | `batch_members.p_q` (post-definition, in-batch) |
| F20/G9 | `batches.name/customer/job` (name first in UI) |
| F21 | `batch_zones` rows, UNION EXISTS in matcher, `matched_zones` in results |
| F22/F24 | `batch_members_map`/`search_carriers_map` pin feeds (status/warning per pin → legend); dashboard counts → stat strip |
| F23 | `batch_carriers.promoted_at/by` + trigger-logged `promoted` activity; no onboarding integration pretended |
| G10 | `count_carriers` fill rates, `sync_runs`, `geocode_precision`, `carrier_count_tx` |
| Locked rules | Global DNC: `carriers.do_not_contact` + `exclude_dnc` + call-sheet hard exclusion + cross-batch dnc activity. Snapshot+add-only refresh: `refresh_batch` ON CONFLICT DO NOTHING, no delete path. Per-batch status: `batch_carriers.status`. Unified timeline: `contact_logs` keyed on dot, `batch_id` nullable ON DELETE SET NULL. Insurance threshold visible-not-excluded: `insurance.enforce=false` default + `insurance_below_standard` warning |

**Open risks for the build plan:** (1) verify the 30 `crgo_*` Socrata field names + L&I thousands-scaling against live dataset metadata on ingest day one; (2) corridor routing provider (Google Directions primary / OSRM fallback) decides who produces `params.route` — schema is provider-agnostic (stores decoded polyline); (3) if TX row count lands >300k or facet latency exceeds ~500ms on cold cache, add a `(phy_state, status_code)` partial covering index and consider pre-filtering facets to `crgo_cargoothr = true` rows (~10–15% of carriers) — the RPC contract does not change.

---

# Part B — Data Ingestion Pipeline (FMCSA → Supabase, Render worker)

# Data Ingestion Pipeline — FMCSA → Supabase (Render worker)

**Verification status legend:** ✅ = confirmed via web search / real-world code using these exact APIs (source cited). ⚠️R# = needs a one-time runtime probe on day 1 (this sandbox's egress proxy blocks data.transportation.gov, so live API sampling was impossible here; every ⚠️ item has an exact probe command in §7). Nothing below is guessed without being marked.

---

## 1. Source inventory — exact access

All bulk sources are Socrata (SODA v2.1) datasets on `data.transportation.gov`. One free app token (sign up at the portal, any Socrata account) is sent as header `X-App-Token`; with a token you get **1,000 requests/rolling hour** and are effectively unthrottled unless abusive; without one you're IP-throttled; throttle = HTTP 429 (✅ https://dev.socrata.com/docs/app-tokens.html). Never use `ai.fmcsa.dot.gov` downloads from the worker — its WAF blocks datacenter IPs (observed by other production pipelines); everything we need is on the Socrata portal, which serves servers fine.

### 1.1 Company Census File — `az4n-8mr2` (PRIMARY, daily)

- ✅ Dataset: "Company Census File", https://data.transportation.gov/Trucking-and-Motorcoaches/Company-Census-File/az4n-8mr2 — all active/inactive/pending FMCSA entities; full CSV ≈ 1.7 GB, ≈ 4.4M rows total (~2.2M active). Authoritative field definitions: https://www.fmcsa.dot.gov/registration/mcmis-catalog-census-file-data-element-definitions
- Endpoint: `https://data.transportation.gov/resource/az4n-8mr2.json`
- ✅ SODA field names are the lowercased CSV headers; multiple production codebases query exactly: `dot_number, legal_name, dba_name, phy_street, phy_city, phy_state, phy_zip, phone, fax, cell_phone, email_address, company_officer_1, company_officer_2, status_code, prior_revoke_flag, prior_revoke_dot_number, total_drivers, total_cdl, fleetsize, docket1, dun_bradstreet_no, crgo_cargoothr, crgo_cargoothr_desc` (GitHub evidence: axelm6/CarrierSearch `api/carriers.js`, lazizbekravshanov/fleetsight `pipeline/ingest.py`, innovativesolutiongs/GeoTrenza `reverseLookup.ts`, muneebkhan08/ColdEmailer, Wooohan/Temporary- upsert scripts). **This grounds F9/F17: contact person = `company_officer_1` / `company_officer_2`; email = `email_address`; phones = `phone` + `cell_phone`.** ✅ Cargo flags are the literal string `"X"` when checked (code check `val.strip().upper() == "X"` in Wooohan/hussfix5ba).
- ✅ Confirmed census columns also include (from the dataset's column dump): `mcs150_date, mcs150_mileage, mcs150_mileage_year, add_date, carrier_operation, classdef, hm_ind, power_units, truck_units, bus_units, phy_cnty, phy_country, carrier_mailing_street, carrier_mailing_zip, recordable_crash_rate, docket1prefix..docket3, interstate_beyond_100_miles` etc.
- **TX slice query (backfill + daily):**
  ```
  GET /resource/az4n-8mr2.json
    ?$select=<explicit ~70-column list from §2.3>
    &$where=phy_state='TX' AND dot_number > {last_key}
    &$order=dot_number
    &$limit=50000
  Header: X-App-Token: {SOCRATA_APP_TOKEN}
  ```
  Keyset pagination on `dot_number` (not `$offset` — stable and fast at depth). ✅ `$limit=50000` works on this dataset (used in the wild against both az4n-8mr2 and qh9u-swkp); v2.1 endpoints have no hard `$limit` cap (https://dev.socrata.com/docs/queries/limit.html) but 50k keeps responses ~25–50 MB.
- **Scope decision: ingest ALL TX rows regardless of `status_code`** (active + inactive). Rationale: G5/F15 — a batched carrier that goes inactive must stay visible with a warning, never vanish; and Refresh (F21) needs the full universe. Search defaults filter `status_code='A'`. Estimated volume: TX ≈ 9–10% of national → **~380–450k rows all-status, ~180–220k active** (⚠️R1 — exact counts are the first backfill's output; probe in §7).

### 1.2 Licensing & Insurance family — `jeyh-5nsj` et al. (daily)

✅ `jeyh-5nsj` is the L&I umbrella dataset ("Licensing and Insurance", BOC-3/OP-1 collections: https://data.transportation.gov/Trucking-and-Motorcoaches/Licensing-and-Insurance/jeyh-5nsj). The machine-usable members we ingest:

| Resource | Dataset (✅ titles confirmed) | What we take | Size |
|---|---|---|---|
| `6eyk-hxee` | **Carrier — All With History** | Operating-authority status (common/contract/broker), BIPD/cargo/bond insurance required-vs-on-file, business+mailing address; ~43 cols; **updated daily** | ~335 MB full CSV (~2.5–3M rows) |
| `qh9u-swkp` | **ActPendInsur — All With History** (https://data.transportation.gov/Trucking-and-Motorcoaches/ActPendInsur-All-With-History/qh9u-swkp; Foundry: https://dev.socrata.com/foundry/data.transportation.gov/qh9u-swkp) | Active/pending insurance policies: insurer, form, coverage amounts, effective + **cancel-effective** dates | ~468k rows / ~50 MB |
| `9mw4-x3tu` | AuthHist — All With History | authority grant/revocation timeline (Phase-2 nice-to-have, not ingested v1) | — |

- ✅ **ActPendInsur columns confirmed from production code:** `dot_number, docket_number, name_company` (insurer), `ins_form_code` (BMC-91/91X/34…), `ins_class_code`, `ins_type_desc` (filter `ILIKE 'BIPD%'` for liability), `policy_no, max_cov_amount, min_cov_amount, underl_lim_amount, effective_date, cancl_effective_date, trans_date`. **Two critical quirks, both confirmed in multiple codebases:** (a) coverage amounts are **in $thousands** (`max_cov_amount='1000'` = $1,000,000) — the $1MM threshold is `max_cov_amount::int >= 1000`; (b) **`dot_number` in the L&I datasets is 8-char zero-padded text** — join by casting to int (`dot_number::int`), never by string equality against census.
- `6eyk-hxee` exact machine column names: semantics confirmed (authority statuses valued `A`/`I`/`N` = active/inactive/none; BIPD required + on-file), exact SODA names ⚠️R2 (probe returns them in one call; expect `common_authority_status`-style or close variants — map by inspection on day 1, it's a ~10-line mapping).
- Insurance/authority join key everywhere: **USDOT int** (MC/docket kept as display-only text — matches the locked USDOT-primary-key decision).

### 1.3 Safety source — DECISION: monthly bulk SMS dataset primary; QCMobile per-carrier on demand only

- **Correction to the task premise:** ✅ `kjg3-diqy` is **"SMS Input — Motor Carrier Census Information"** (https://data.transportation.gov/Trucking-and-Motorcoaches/SMS-Input-Motor-Carrier-Census-Information/kjg3-diqy) — it's the monthly *census input* into SMS (identity/contact fields), **not safety results**. Don't use it for safety (and we don't need it for census either — az4n-8mr2 is fresher).
- **Pick: monthly bulk SMS results from Socrata** — primary `4y6x-dmck` "SMS AB PassProperty" (✅ SODA-tabular, queryable by `dot_number`; identified and used in production FMCSA pipelines), fallback `sjpe-nzai` "Carrier Safety Measurement System (CSMS, or SMS) — Raw Data" (https://data.transportation.gov/Trucking-and-Motorcoaches/Carrier-Safety-Measurement-System-CSMS-or-SMS-Raw-/sjpe-nzai). ⚠️R3: probe both once; keep whichever is row-queryable by `dot_number` with the standard SMS carrier columns.
- ✅ Standard SMS carrier-file columns (confirmed across several ingesting codebases): `insp_total, driver_insp_total, driver_oos_insp_total, vehicle_insp_total, vehicle_oos_insp_total, unsafe_driv_insp_w_viol, …` plus crash totals (fatal/injury/tow). We compute `driver_oos_rate = driver_oos/driver_insp`, `vehicle_oos_rate = vehicle_oos/vehicle_insp`.
- **Why not QCMobile for bulk:** it's per-carrier (`https://mobile.fmcsa.dot.gov/qc/services/carriers/{dot}?webKey=…`, free WebKey via Login.gov). 200k+ TX carriers at 1,000 req/hr ≈ 8+ days per refresh — non-viable, and against its intended per-lookup use. **Why keep it at all:** it returns the freshest per-carrier verification blob — ✅ confirmed fields `allowedToOperate, bipdInsuranceOnFile, bipdInsuranceRequired, bipdRequiredAmount, commonAuthorityStatus, contractAuthorityStatus, brokerAuthorityStatus, safetyRating, statusCode, totalDrivers, totalPowerUnits` (brandenco/qcmobile Go client + 100 other repos) — exactly what the F7 carrier-profile "verification tiles" want. **Use: on-demand fetch when a profile is opened, cached 24h in `carrier_qc_snapshots`; optional Phase-1.5.** Env: `QCMOBILE_WEBKEY`.
- Post-2025 caveat stands (discovery §3): no public BASIC percentiles; warnings (F15/G5) are built from OOS rates, crash counts, authority status, insurance amounts/cancel dates — all above.

---

## 2. Sync design

### 2.1 Jobs & flow

One Render **Cron Job** service (`pipeline`) running a sequential chain nightly (single cold start, ordered dependencies, one failure email with step context), plus a monthly chain and a manual backfill:

```
nightly  = sync-census → sync-authority → sync-insurance → cargo-facets → geocode → dq-report
monthly  = sync-safety
backfill = census(full TX) → authority → insurance → safety → geocode(all) → cargo-facets → dq-report
```

Every step is **idempotent** (pure upserts; re-run safe; `--from=<step>` resume flag).

### 2.2 Incremental strategy — full-slice re-pull + row-hash diff (not `:updated_at`)

FMCSA replaces these datasets wholesale on refresh, which makes Socrata's `:updated_at` system field useless for deltas (it churns globally; ⚠️R4 confirms, but the design doesn't depend on the answer). Instead:

1. Pull the **entire TX slice** daily (~9 pages of 50k — trivial: this is the whole reason we scope to `phy_state='TX'`).
2. `COPY` rows into `staging_census` (session-mode direct Postgres connection — see §6).
3. Compute `row_hash = md5(concat_ws('|', all mapped source columns))` per row in SQL.
4. `INSERT … ON CONFLICT (dot_number) DO UPDATE SET … , last_changed_at=now() WHERE carriers.row_hash IS DISTINCT FROM EXCLUDED.row_hash` — only changed rows write (daily churn is ~1–3%), so `last_changed_at` is meaningful and Realtime/pg triggers don't storm.
5. Set-difference pass: DOTs present in `carriers` (state TX) but absent from today's slice → `source_missing_since = today` (carrier moved out of TX or was purged). Never delete — G5: batches keep their members; missing-from-source becomes a warning input.
6. `first_seen_at` on insert — this is what batch **Refresh** (F21) uses to show "newly matching since batch creation."

### 2.3 Field mapping — census `az4n-8mr2` → `carriers` (every ingested column)

`$select` exactly this list (lowercase SODA names). Types: everything arrives as text from SODA; cast in staging.

| SODA field | carriers column | Type / transform | Notes |
|---|---|---|---|
| `dot_number` | `dot_number` | `int` PK | universal key |
| `legal_name` | `legal_name` | text | |
| `dba_name` | `dba_name` | text | |
| `status_code` | `status_code` | text ('A' active) | default filter, warning input |
| `carrier_operation` | `carrier_operation` | text | interstate/intrastate filter (⚠️R5 value domain: expect `A`/`B`/`C` codes = interstate / intrastate-HM / intrastate-non-HM) |
| `classdef` | `classdef` | text | for-hire filter ("Authorized For Hire" etc.; ⚠️R5 value domain) |
| `add_date` | `fmcsa_add_date` | date | "how long registered" |
| `mcs150_date` | `mcs150_date` | date | staleness signal |
| `mcs150_mileage`, `mcs150_mileage_year` | same | bigint / int | |
| `hm_ind` | `hm_ind` | bool ('Y') | |
| `prior_revoke_flag` | `prior_revoke_flag` | bool | chameleon-carrier warning input |
| `prior_revoke_dot_number` | `prior_revoke_dot_number` | int null | |
| `recordable_crash_rate` | `recordable_crash_rate` | numeric null | profile display |
| `dun_bradstreet_no` | `duns_number` | text | F18 enrichment cross-ref |
| `docket1prefix`+`docket1` | `docket_display` | text concat | display-only (MC deprecated) |
| `phy_street`,`phy_city`,`phy_state`,`phy_zip`,`phy_cnty`,`phy_country` | `phy_street`,`phy_city`,`phy_state`,`phy_zip5` (left(zip,5)),`phy_county`,`phy_country` | text | geocoding + county anchor (F12) |
| `carrier_mailing_street`,`carrier_mailing_city`\*,`carrier_mailing_state`\*,`carrier_mailing_zip` | `mail_*` | text | \*⚠️R5 exact names of mailing city/state cols |
| `phone` | `phone` | text (digits-normalized + raw) | G4/F16/F17 |
| `cell_phone` | `cell_phone` | text | G4 — often the better cold-call number |
| `fax` | `fax` | text | profile only |
| `email_address` | `email_address` | citext lower | G4/F16/F17/F9; ~20% fill — measured by §5 |
| `company_officer_1` | `contact_name_1` | text | **F9/F17 contact NAME** |
| `company_officer_2` | `contact_name_2` | text | F9/F17 |
| `power_units`,`truck_units`,`bus_units` | same | int | fleet-size filter |
| `total_drivers`,`total_cdl` | same | int | |
| `fleetsize` | `fleetsize` | text | |
| `owntruck`,`owntract`,`owntrail` (+ `termtruck…`,`triptruck…` ⚠️R5) | `owned_trucks/tractors/trailers` (+leased) | int | F7 profile header |
| 30× `crgo_*` (list below) | 30× `crgo_*` | bool (`='X'`) | F14 plain checkboxes |
| `crgo_cargoothr_desc` | `cargo_other_raw` | text trimmed | F14 |
| — (derived) | `cargo_other_norm` | text | §3 normalization |
| — (derived) | `row_hash`,`first_seen_at`,`last_changed_at`,`source_missing_since` | | sync bookkeeping |
| — (derived, §4) | `lat`,`lng`,`geom geography(Point,4326)`,`geocode_precision`,`geocode_status`,`geocoded_at`,`address_hash` | | geo |

✅ Cargo flag list (SODA names confirmed via ingesting codebases; the canonical MCS-150 30): `crgo_genfreight, crgo_household, crgo_metalsheet, crgo_motoveh`(⚠️R5: one repo spells `crgo_motorveh` — confirm), `crgo_drivetow, crgo_logpole, crgo_bldgmat, crgo_mobilehome, crgo_machlrg, crgo_produce, crgo_liqgas, crgo_intermodal, crgo_passengers, crgo_oilfield, crgo_livestock, crgo_grainfeed, crgo_coalcoke, crgo_meat, crgo_garbage, crgo_usmail, crgo_chem, crgo_drybulk, crgo_coldfood, crgo_beverages, crgo_paperprod, crgo_utility, crgo_farmsupp, crgo_construct, crgo_waterwell, crgo_cargoothr`. Tier-2 sand/gravel backstop flags = `crgo_drybulk`, `crgo_construct`, `crgo_bldgmat` (per discovery §4).

### 2.4 Authority + insurance sync (daily, feeds F15 warnings + insurance threshold)

- **`sync-authority` (6eyk-hxee):** paged full pull with `$select` trimmed to ~10 columns (dot, 3 authority statuses, BIPD/cargo/bond required+on-file) → filter in-worker to DOTs present in `carriers` → upsert `carrier_authority` (1:1, PK `dot_number`). ~55 pages; with `$select` the payload drops to a few hundred MB → 10–20 min.
- **`sync-insurance` (qh9u-swkp):** full pull (~10 pages) → keep `ins_type_desc ILIKE 'BIPD%'` rows for known DOTs → upsert append-style into `carrier_insurance_filings` (natural key `(dot_number, docket_number, policy_no, effective_date)`) → then one SQL rollup writes per-carrier current state: `bipd_on_file_usd = max_cov_amount::int * 1000` of the policy in effect, `bipd_cancel_date = min(cancl_effective_date > today)`. **Threshold semantics (locked):** $1MM standard / $500k visible — always a *filter*, never an exclusion; `bipd_on_file_usd < chosen threshold`, `bipd_cancel_date within 30d` ("expiring soon", mirroring the owner's existing tool counter — F24), `no BIPD row`, and `authority ≠ A` are **warning-flag inputs** (F15/G5) recomputed here nightly into `carrier_warnings` (or flags on `carriers` — schema agent's call; pipeline owns the writes).
- **`sync-safety` (monthly, day 5):** pull SMS dataset (§1.3) for known DOTs → upsert `carrier_safety` (PK `dot_number`, + `snapshot_month`): inspection totals, OOS totals, computed OOS rates, crash counts. Warning inputs: `driver_oos_rate > 1.5× national avg (~5%)`, `vehicle_oos_rate > 1.5× national avg (~21%)` — thresholds live in a `pipeline_config` table, tuned after first snapshot (⚠️R6 verify current national averages at first run).

### 2.5 Failure handling + alerting (simple, per spec)

- `pipeline_runs` table: `(id, job, step, started_at, finished_at, status running|success|failed, rows_read, rows_upserted, rows_changed, error, meta jsonb)`. Every step logs start/end.
- Per-request: retry 429/5xx/network with exponential backoff (5 tries, 2s→60s), honoring the 1,000/hr token budget.
- Per-step: throw → chain stops, run row marked `failed`, **email via Resend** (`RESEND_API_KEY`, `ALERT_EMAIL`) with job/step/error/row counts; process exits non-zero so **Render's cron failure notification** fires too (belt + suspenders).
- Staleness watchdog inside `dq-report`: if `sync-census` last success > 48h → alert even if today's run "succeeded" vacuously.
- G10 trust: the dashboard's data-health view (§5) shows last-sync timestamps per source.

### 2.6 Runtime estimate (Render Starter worker)

| Step | Est. |
|---|---|
| sync-census (TX ~430k rows, 9 pages) | 5–10 min download + 1–2 min diff/upsert |
| sync-authority (trimmed full pull) | 10–20 min |
| sync-insurance (~470k rows) | 3–5 min |
| cargo-facets + dq-report | < 2 min |
| geocode (steady-state: new/changed rows only, ~100s/day) | 2–5 min |
| **Nightly total** | **~25–45 min** |
| One-time backfill (incl. ~200k-row geocode) | census+L&I ~1h; geocoding 1–3 nights (§4) |

---

## 3. `crgo_cargoothr_desc` normalization pipeline (F14, G8)

**The core matching signal.** Free text typed by carriers ("Sand and Gravel", "SAND & GRAVEL", "sand/gravel/rock", "Dirt", "Aggregate", misspellings).

### 3.1 Normalization (at ingest, in `sync-census` staging SQL)

`cargo_other_norm = ` lowercase → replace `&` and `+` with ` and ` → strip punctuation to spaces (`[^a-z0-9 ]`) → collapse whitespace → trim. Empty → NULL. Raw preserved in `cargo_other_raw` (profile display shows the carrier's own words). This alone collapses the bulk of variants ("Sand & Gravel"/"sand and gravel."/"SAND AND GRAVEL" → `sand and gravel`).

### 3.2 Facet data & scoped counts — DECISION: on-the-fly SQL GROUP BY (recommended), plus a tiny precomputed layer

**Analysis.** Precomputed-only (a materialized `cargo_other_values` with global counts) is fast but **cannot honor F14's requirement that counts are scoped to the current geo/filters** — a Waco-radius search must show Waco-scoped counts. On-the-fly GROUP BY over the filtered set is exact and, at TX scale (~430k rows, filtered sets typically 250–5,000), runs in tens of ms with the right indexes. **Recommendation: on-the-fly RPC** (aligns with the schema agent's RPC approach):

```sql
-- RPC shape (schema agent owns signature; pipeline owns the columns/indexes it needs)
select cargo_other_norm as value,
       mode() within group (order by cargo_other_raw) as display_sample,
       count(*) as carrier_count
from carriers
where {geo union-of-zones predicate}          -- F21 multi-lane: OR of ST_DWithin per zone
  and {active/contactability/fleet filters}
  and cargo_other_norm is not null
  and (p_keyword is null or cargo_other_norm ilike '%'||p_keyword||'%'
       or similarity(cargo_other_norm, p_keyword) > 0.3)
group by 1 order by carrier_count desc
limit 200 offset p_offset;                    -- paged: the value browser can be long (F14)
```

**Pipeline-owned indexes:** `GIST (geom)`, `btree (cargo_other_norm)`, `GIN (cargo_other_norm gin_trgm_ops)` (enable `pg_trgm`), `btree (status_code)`, partial index on `(phy_state) where status_code='A'`.

**Precomputed layer (`cargo-facets` nightly step), two small tables:**
1. `cargo_other_values (norm, display_sample, tx_active_count, refreshed_at)` — the *global* distribution, for the cold "browse everything" view and G10 reporting. Cheap full rebuild nightly.
2. `cargo_other_suggestions (seed_term, matched_norm, carrier_count)` — **suggested likely-match keywords with counts** (F14): for each curated seed (`sand, gravel, aggregate, rock, dirt, stone, dump, base, fill, topsoil, limestone, caliche, asphalt, concrete, select fill, haul off, …` — maintained in `pipeline_config`), match every distinct norm value by substring OR trigram `similarity(norm, seed) > 0.35` (catches "gravle", "sand/gravl"). UI shows seeds with aggregate counts; clicking expands to per-value include/exclude. Include/exclude selections are stored in `search_definition` as lists of **norm values** (exact membership at query time — deterministic, no fuzzy at search time).

Variant clustering strategy = exact-normalized grouping (3.1) **plus** trigram-similarity grouping only in the suggestion layer (3.2.2) — fuzzy proposes, the user disposes, searches stay exact. This preserves the owner's "see the values to set up the list correctly" workflow.

---

## 4. Geocoding (bulk, $0)

No lat/lng in any FMCSA source — we geocode. **No paid geocoding for bulk** (locked).

### 4.1 Primary: Census Bureau batch geocoder

- ✅ Endpoint `POST https://geocoding.geo.census.gov/geocoder/locations/addressbatch` — CSV upload `unique_id,street,city,state,zip`; **max 10,000 records AND 5 MB per file**; no API key; `benchmark=Public_AR_Current`; returns match flag (Match/No_Match/Tie), Exact/Non_Exact, matched address, `lng,lat`. Docs: https://geocoding.geo.census.gov/geocoder/Geocoding_Services_API.html + FAQ https://www2.census.gov/geo/pdfs/maps-data/data/Census_Geocoder_FAQ.pdf + User Guide (May 2026 ed.) https://www2.census.gov/geo/pdfs/maps-data/data/Census_Geocoder_User_Guide.pdf
- `unique_id = dot_number`. Run batches **sequentially** (one in flight; each takes ~1–5 min server-side); nightly job caps at ~30 batches to be a good citizen.

### 4.2 Fallback tiers + precision recording

| Tier | Source | `geocode_precision` |
|---|---|---|
| 1 | Census batch street match (Exact or Non_Exact) | `street` |
| 2 | ZIP centroid — one-time-loaded `zip_centroids` table from the Census **ZCTA Gazetteer file** (INTPTLAT/INTPTLONG), https://www.census.gov/geographies/reference-files/time-series/geo/gazetteer-files.html | `zip` |
| 3 | City centroid — `city_centroids` from the Census **Places Gazetteer** (TX places) | `city` |
| 4 | nothing matched | `none` (excluded from geo search; surfaced in DQ report) |

- Pre-filter: `PO BOX`/`P O BOX`/`RR \d`/`HC \d` street patterns skip straight to tier 2 (they can never street-match; saves batch slots).
- `address_hash = md5(street|city|zip)`; `geocode` job selects `geom IS NULL OR address_hash <> geocoded_address_hash` → re-geocodes movers automatically.
- Radius/corridor queries treat all tiers alike (`ST_DWithin` on `geom`); UI may badge `zip`/`city` precision on the map (schema/UI agents' call; the data is there).
- **Expected rates (estimates — measured, not promised; G10 reports actuals):** street ~60–75% for TX carrier business addresses (heavy PO-box/rural-route population drags it down), ZIP-centroid rescues nearly all the rest → **≥97% geocoded at zip-or-better**, <1–2% `none`. Backfill: ~200k active first (≈20 batches/night → 1–3 nights), inactive lazily afterward.

---

## 5. Data-quality report job (G10)

Nightly `dq-report` step writes one row to `data_quality_reports (run_date PK, metrics jsonb, created_at)`:

- **Fill rates** (TX active): `phone`, `cell_phone`, `phone OR cell_phone` (the real F16 contactability number), `email_address`, `contact_name_1`, `cargo_other_raw` (Tier-1 coverage — validates the whole precision story per discovery §4/§15), `bipd on file`, safety-snapshot coverage.
- **Cargo-other**: distinct norm-value count + top 50 values with counts (from `cargo_other_values`).
- **Warning distribution**: counts of each F15 flag (below-$1MM, expiring-30d, no-insurance-on-file, authority-inactive, high-OOS, status-inactive, missing-from-source).
- **Geocode precision distribution** (street/zip/city/none).
- **Freshness**: last success per source dataset.

Surfacing: (a) the table itself (queryable, chartable later); (b) a minimal **admin "Data Health" view** in the app (manager role) rendering the latest row — fill-rate bars, top other-values table, warning counts, sync timestamps. This is the honest-coverage layer that makes the team trust the list (G10) and gates Phase-2 email (email fill rate is measured from day 1).

---

## 6. Worker implementation shape

### 6.1 Repo layout (Node 22 / TypeScript, `pipeline/` at repo root, deployed as one Render Cron Job)

```
pipeline/
  package.json            # deps: pg, tsx, zod, dotenv; dev: vitest
  tsconfig.json
  src/
    run.ts                # entry: `tsx src/run.ts <chain|step> [--from=step] [--pages=N]`
    lib/
      socrata.ts          # fetch w/ X-App-Token, keyset paging, retry/backoff, $select builders
      db.ts               # pg Pool → Supabase SESSION-mode pooler; COPY-from-stream helper
      runlog.ts           # pipeline_runs start/finish/fail
      notify.ts           # Resend alert email
      normalize.ts        # cargo_other_norm, phone digits, address_hash, row_hash
    jobs/
      sync-census.ts      sync-authority.ts   sync-insurance.ts
      sync-safety.ts      geocode.ts          cargo-facets.ts
      dq-report.ts        backfill.ts
    sql/                  # staging DDL, upsert statements, rollups (checked-in, reviewed)
```

- **DB access: direct Postgres** (`SUPABASE_DB_URL`, session pooler, port 5432) — needed for `COPY`, temp staging tables, and set-based upserts; PostgREST/service-role is the wrong tool for 400k-row merges. Migrations remain the schema agent's domain; pipeline SQL only touches its own staging/upserts.
- Geocode batch upload: native `fetch` + `FormData` file upload; stream the returned CSV.

### 6.2 Env / secrets (Render dashboard + `.env.local`)

| Var | Purpose |
|---|---|
| `SUPABASE_DB_URL` | postgres connection (session pooler) |
| `SOCRATA_APP_TOKEN` | 1,000 req/hr budget (✅ dev.socrata.com/docs/app-tokens.html) |
| `RESEND_API_KEY`, `ALERT_EMAIL` | failure + weekly DQ emails |
| `QCMOBILE_WEBKEY` | optional, on-demand profile verification (F7) |
| `PIPELINE_ENV` | `prod` / `dev` (dev caps pages, targets dev project) |

### 6.3 Render cron schedules (UTC; owner is US Central)

| Render Cron Job | Schedule | Command |
|---|---|---|
| `pipeline-nightly` | `0 9 * * *` (4am CDT, after FMCSA's overnight refresh; ⚠️R7 confirm actual refresh hour from a week of `rowsUpdatedAt`, shift if needed) | `tsx src/run.ts nightly` |
| `pipeline-monthly-safety` | `0 8 5 * *` | `tsx src/run.ts monthly` |
| `pipeline-backfill` | manual ("Run Job" button) | `tsx src/run.ts backfill` |

### 6.4 Local dev mode

`cp .env.example .env.local` → `npm run job -- nightly --from=sync-census --pages=1` pulls one 50k page against the dev Supabase project (or `supabase start` local stack); `--pages` caps every Socrata pull; geocode step honors a `--batches=1` cap. All steps print the same runlog rows they write.

---

## 7. Day-1 runtime verification probes (⚠️R1–R7)

Run once from the Render worker (or any unproxied shell); each is one `curl`:

- **R1 volumes:** `/resource/az4n-8mr2.json?$select=count(1)&$where=phy_state='TX'` and `…AND status_code='A'` and `…AND crgo_cargoothr='X'`.
- **R2 6eyk-hxee columns:** `/resource/6eyk-hxee.json?$limit=1` → record exact authority/BIPD field names into `sync-authority`'s mapping.
- **R3 SMS dataset:** `/resource/4y6x-dmck.json?$limit=1` (fallback `sjpe-nzai`) → confirm `dot_number` queryability + column set.
- **R4 `:updated_at`:** `/resource/az4n-8mr2.json?$select=:updated_at&$limit=1` two days running — informational only.
- **R5 spellings/domains:** one `$limit=1` full-row sample of az4n-8mr2 → lock `crgo_motoveh` vs `crgo_motorveh`, mailing city/state names, leased-equipment names, `classdef`/`carrier_operation` value domains.
- **R6 OOS national averages:** compute from first SMS snapshot; set warning thresholds in `pipeline_config`.
- **R7 refresh hour:** poll `https://data.transportation.gov/api/views/az4n-8mr2.json` → `rowsUpdatedAt` for a week; anchor the 9:00 UTC cron after it.

**Requirements traceability:** F9/F17 (`company_officer_1/2`, `email_address`, `phone`, `cell_phone` ingested and mapped), F14/G8 (§3 facet pipeline, scoped live counts, suggestion keywords with counts), F15/G5 (warning inputs: BIPD amount/cancel date, authority status, OOS rates, status/missing-from-source; computed nightly), F16/G4 (contactability fields first-class), F18 (DUNS + officer names retained for enrichment), F21/G1 (geocoded `geom` + GIST index powers union-of-zones), F5/G3 (indexes + server-side facets for thousands-row batches), F24 ("Insurance Expiring Soon" parity), G10 (§5 report + admin view).

Sources: [Company Census File az4n-8mr2](https://data.transportation.gov/Trucking-and-Motorcoaches/Company-Census-File/az4n-8mr2) · [MCMIS census data element definitions](https://www.fmcsa.dot.gov/registration/mcmis-catalog-census-file-data-element-definitions) · [Licensing and Insurance jeyh-5nsj](https://data.transportation.gov/Trucking-and-Motorcoaches/Licensing-and-Insurance/jeyh-5nsj) · [ActPendInsur qh9u-swkp](https://data.transportation.gov/Trucking-and-Motorcoaches/ActPendInsur-All-With-History/qh9u-swkp) · [qh9u-swkp on Socrata Foundry](https://dev.socrata.com/foundry/data.transportation.gov/qh9u-swkp) · [Carrier — All With History 6eyk-hxee](https://data.transportation.gov/w/6eyk-hxee/m7rw-edbr) · [SMS Input census kjg3-diqy](https://data.transportation.gov/Trucking-and-Motorcoaches/SMS-Input-Motor-Carrier-Census-Information/kjg3-diqy) · [CSMS/SMS Raw Data sjpe-nzai](https://data.transportation.gov/Trucking-and-Motorcoaches/Carrier-Safety-Measurement-System-CSMS-or-SMS-Raw-/sjpe-nzai) · [FMCSA Open Data Program](https://www.fmcsa.dot.gov/registration/fmcsa-data-dissemination-program) · [Socrata app tokens & limits](https://dev.socrata.com/docs/app-tokens.html) · [Socrata $limit/paging](https://dev.socrata.com/docs/queries/limit.html) · [Census Geocoder API docs](https://geocoding.geo.census.gov/geocoder/Geocoding_Services_API.html) · [Census Geocoder FAQ (10k/5MB)](https://www2.census.gov/geo/pdfs/maps-data/data/Census_Geocoder_FAQ.pdf) · [Census Geocoder User Guide May 2026](https://www2.census.gov/geo/pdfs/maps-data/data/Census_Geocoder_User_Guide.pdf) · [Census Gazetteer files (ZCTA/Places centroids)](https://www.census.gov/geographies/reference-files/time-series/geo/gazetteer-files.html) · Field-name code evidence: [axelm6/CarrierSearch](https://github.com/axelm6/CarrierSearch), [lazizbekravshanov/fleetsight](https://github.com/lazizbekravshanov/fleetsight), [innovativesolutiongs/GeoTrenza](https://github.com/innovativesolutiongs/GeoTrenza), [GoAugment/augment-carrier-audit](https://github.com/GoAugment/augment-carrier-audit), [brandenco/qcmobile](https://github.com/brandenco/qcmobile)
