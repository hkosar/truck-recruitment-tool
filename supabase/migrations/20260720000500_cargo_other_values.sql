-- ============================================================================
-- 20260720000500_cargo_other_values.sql -- the F14 facet backbone (table, not matview: D5)
-- Spec: docs/build-plan/01-architecture.md Part A §2.5, §2.9 (cargo facet indexes);
-- unchanged by the amendments except that amendment #17 confirms this table +
-- facet_suggested_keywords (§5.3, in the RPC migration) are the SINGLE F14
-- suggestion mechanism -- Part B's separate cargo_other_suggestions table is
-- dropped; its seed-term + trigram mechanic becomes the ingest-side populator
-- of match_group below.
-- ============================================================================

create table public.cargo_other_values (
  value               text primary key,           -- = carriers.cargo_other_norm
  carrier_count_tx    int  not null default 0,    -- global TX count; refreshed nightly
  sample_raw          text,                       -- one original-casing example for display
  match_group         text,                       -- CURATED: 'sand'|'gravel'|'rock'|'dirt'|'aggregate'|'stone'|'base'|null
  is_sand_gravel      boolean not null default false,  -- CURATED: brief §4 Tier-1 term list
  first_seen_at       timestamptz not null default now(),
  last_seen_at        timestamptz not null default now()
);

comment on table public.cargo_other_values is
  'Sync-upserted (nightly counts/last_seen_at) WITHOUT touching match_group/is_sand_gravel '
  '(same D9 discipline as carriers app-owned columns). A seed migration statement pre-curates '
  'obvious groups by pattern; the manager refines from the UI. Powers instant suggested '
  'likely-match keyword chips with counts (F14); SCOPED counts always come from the live '
  'facet RPC (§5.3) because they depend on the user''s current geo/filters -- a matview cannot '
  'be parameterized by scope, and a matview would also lose these curation columns on refresh.';

comment on column public.cargo_other_values.match_group is
  'Nightly sync pre-curates via pattern match: value ~ ''sand|gravel|aggregate|rock|dirt|stone|base'' '
  '-> match_group, is_sand_gravel = true for sand/gravel/aggregate patterns (seeded in seed.sql '
  'for dev; the real pipeline''s cargo-facets step does the equivalent upsert in production).';

create index idx_cov_trgm  on public.cargo_other_values using gin (value gin_trgm_ops);
create index idx_cov_group on public.cargo_other_values (match_group) where match_group is not null;
