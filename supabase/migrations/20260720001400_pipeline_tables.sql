-- ============================================================================
-- 20260720001400_pipeline_tables.sql
-- M2 reconciliation (task #20): the tables the ingestion pipeline (Part B,
-- pipeline/src/*) depends on but Part A's DDL never defined. Fix-forward only —
-- shipped migrations are never edited.
--
-- Resolves the Part A ↔ Part B drift the pipeline flagged in-code
-- (pipeline/src/runs.ts, geocode.ts, dq-report.ts, facets.ts) and records it as
-- reconciliation amendment #21 in docs/build-plan/01-architecture.md:
--
--   pipeline_runs        operational run log  (runs.ts startRun/finishRun/checkStaleness)
--   pipeline_config      tunable seeds + thresholds (facets §3.2.2, safety R6)
--   zip_centroids        Census ZCTA Gazetteer centroids (geocode tier 2)
--   city_centroids       Census Places Gazetteer centroids (geocode tier 3)
--   data_quality_reports nightly fill-rate / coverage snapshot (dq-report §5, G10)
--
-- Decision on the sync_runs ↔ pipeline_runs question runs.ts left open (option a
-- vs b): pipeline_runs is added as the richer operational table every M2.x
-- acceptance criterion targets, and public.sync_runs — which was shipped in
-- 0400 but has NO reader or writer anywhere in the codebase — is redefined here
-- as a security_invoker VIEW derived from pipeline_runs, preserving the G10
-- "last synced per source" UI-footer contract with a single source of truth
-- (the pipeline writes pipeline_runs only; the UI reads sync_runs). No
-- double-writing, no dead duplicate table.
-- ============================================================================

-- --- enums (match pipeline/src/runs.ts PipelineJob / PipelineStep / RunStatus) -----
create type pipeline_job  as enum ('nightly','monthly','backfill');
create type pipeline_step as enum
  ('sync-census','sync-authority','sync-insurance','sync-safety',
   'cargo-facets','geocode','dq-report');
create type run_status    as enum ('running','success','failed');

-- --- pipeline_runs: one row per step invocation (startRun → finishRun) -------------
create table public.pipeline_runs (
  id            bigint generated always as identity primary key,
  job           pipeline_job  not null,
  step          pipeline_step not null,
  status        run_status    not null default 'running',
  started_at    timestamptz   not null default now(),
  finished_at   timestamptz,
  rows_read     int,
  rows_upserted int,
  rows_changed  int,
  error         text,
  meta          jsonb         not null default '{}'::jsonb
);
-- checkStaleness() reads latest success per step; startRun/finishRun by id.
create index pipeline_runs_step_started_idx
  on public.pipeline_runs (step, started_at desc);
create index pipeline_runs_step_success_idx
  on public.pipeline_runs (step, finished_at desc) where status = 'success';

comment on table public.pipeline_runs is
  'Operational log of every ingestion step (Part B §2.5). service_role writes; staff read. sync_runs is the per-source UI view over this.';

-- --- pipeline_config: tunable seeds + thresholds (key/value jsonb) -----------------
create table public.pipeline_config (
  key         text primary key,
  value       jsonb       not null,
  description text,
  updated_at  timestamptz not null default now()
);

-- Cargo Tier-1 seed terms (brief §4 / architecture §3.2.2) — kept in sync with the
-- pipeline's hardcoded fallback in pipeline/src/facets.ts until the code reads live.
insert into public.pipeline_config (key, value, description) values
  ('cargo_seed_terms',
   '["sand","gravel","aggregate","rock","dirt","stone","dump","base","fill",
     "topsoil","limestone","caliche","asphalt","concrete","select fill","haul off"]'::jsonb,
   'F14 suggested-match seed terms for the cargo_other facet browser'),
  ('oos_thresholds',
   '{"national_driver_oos_rate":0.05,"national_vehicle_oos_rate":0.21,"multiplier":1.5}'::jsonb,
   'Safety warning inputs (R6): flag when a carrier OOS rate exceeds multiplier × national average. Retune after first SMS snapshot.');

comment on table public.pipeline_config is
  'Operator-tunable pipeline seeds/thresholds (architecture §3.2.2, R6). Manager-editable later; service_role reads at run time.';

-- --- geocoding reference tables (one-time-loaded from Census Gazetteer, tiers 2/3) -
-- Loaded once by a backfill script (NOT the nightly job) — see pipeline/src/geocode.ts.
create table public.zip_centroids (
  zcta text primary key,
  lat  double precision not null,
  lng  double precision not null
);
create table public.city_centroids (
  state text not null,
  city  text not null,
  lat   double precision not null,
  lng   double precision not null,
  primary key (state, city)
);
comment on table public.zip_centroids  is 'Census ZCTA Gazetteer centroids; geocode fallback tier 2 (geocode_precision zip_centroid).';
comment on table public.city_centroids is 'Census Places Gazetteer centroids (TX); geocode fallback tier 3 (geocode_precision city_centroid).';

-- --- data_quality_reports: nightly coverage snapshot (dq-report.ts writeDqReport) --
create table public.data_quality_reports (
  run_date   date primary key,
  metrics    jsonb       not null,
  created_at timestamptz not null default now()
);
comment on table public.data_quality_reports is
  'Nightly fill-rate + warning-distribution + freshness snapshot (Part B §5, G10). Upserted by dq-report on run_date.';

-- ============================================================================
-- RLS — staff read only; service_role (the pipeline) bypasses RLS and is the
-- sole writer (D9). Mirrors the carrier/sync_runs pattern in 001200_rls.sql.
-- ============================================================================
alter table public.pipeline_runs        enable row level security;
alter table public.pipeline_config       enable row level security;
alter table public.zip_centroids         enable row level security;
alter table public.city_centroids        enable row level security;
alter table public.data_quality_reports  enable row level security;

create policy pipeline_runs_select       on public.pipeline_runs       for select using (internal.is_staff());
create policy pipeline_config_select     on public.pipeline_config      for select using (internal.is_staff());
create policy zip_centroids_select       on public.zip_centroids        for select using (internal.is_staff());
create policy city_centroids_select      on public.city_centroids       for select using (internal.is_staff());
create policy data_quality_reports_select on public.data_quality_reports for select using (internal.is_staff());

-- ============================================================================
-- sync_runs: redefine the dead shipped table (0400) as a derived view. The
-- prior table's RLS policy (001200) drops with it via CASCADE; access on the
-- view is staff-gated through pipeline_runs' own RLS (security_invoker).
-- ============================================================================
drop table public.sync_runs cascade;

create view public.sync_runs with (security_invoker = true) as
select distinct on (m.source)
  pr.id,
  m.source,
  pr.started_at,
  pr.finished_at,
  pr.rows_upserted,
  (pr.status = 'success') as ok,
  pr.error
from public.pipeline_runs pr
cross join lateral (
  select (case pr.step
            when 'sync-census'    then 'census'
            when 'sync-authority' then 'li'
            when 'sync-insurance' then 'li'         -- L&I authority + insurance share one upstream
            when 'sync-safety'    then 'sms_safety'
            when 'geocode'        then 'geocode'
            else null
          end)::sync_source as source
) m
where m.source is not null
order by m.source, pr.started_at desc;   -- latest run per source → the G10 footer

comment on view public.sync_runs is
  'G10 UI-footer freshness: latest pipeline_runs row per sync_source, derived (security_invoker). Reader-only; the pipeline writes pipeline_runs.';

grant select on public.sync_runs to authenticated;
