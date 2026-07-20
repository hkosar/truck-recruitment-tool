import type { PipelineContext } from './db.js';

/**
 * cargo-facets: §3 normalization pipeline + `cargo_other_values` upsert (Part B §3, as
 * narrowed by 01-architecture.md reconciliation amendment #17).
 *
 * IMPORTANT scope correction vs the literal task brief ("facets.ts implementing §3
 * normalization"): the normalization itself -- lowercase, `&`/`+` -> "and", strip punctuation,
 * collapse whitespace (Part B §3.1) -- is NOT this file's job. Part A's DDL (§2.4) defines
 * `carriers.cargo_other_norm` as a Postgres GENERATED column derived from
 * `crgo_cargoothr_desc`, and amendment #7 keeps that generated-column design canonical. It is
 * computed automatically the instant sync-census upserts `crgo_cargoothr_desc` -- this file
 * must NEVER attempt to write `cargo_other_norm` directly (Postgres rejects INSERT/UPDATE
 * targeting a generated column outright). What THIS file actually does, and all it needs to:
 *
 *   1. Rebuild `cargo_other_values`'s global TX-active counts/sample text nightly (a GROUP BY
 *      over the already-generated `cargo_other_norm` column) -- D9 discipline: never touches
 *      the curated `match_group`/`is_sand_gravel` columns on this pass.
 *   2. Auto-populate `match_group`/`is_sand_gravel` for brand-new, still-uncurated values only
 *      (`WHERE match_group IS NULL`) using the seed-term + trigram mechanic. Amendment #17:
 *      "Part B's separate `cargo_other_suggestions` table is DROPPED; its seed-term + trigram
 *      mechanic becomes the ingest-side populator of `cargo_other_values.match_group`." This
 *      NEVER overwrites a value a manager (or a previous run) already curated -- matches Part
 *      A §2.5's "the manager refines from the UI" intent literally: once `match_group` is
 *      non-null, this file leaves it alone forever, by construction of the WHERE clause below.
 *
 * Seed term list: `pipeline_config` now exists (migration 001400, amendment #21) and is
 * seeded with these same terms under key 'cargo_seed_terms'. This file still reads its own
 * SEED_TERMS constant at run time — kept deliberately in sync with that seed row — so the
 * facet job stays deterministic and grep-able. Wiring it to read the config row live (so a
 * manager can retune without a deploy) is a small M2.x follow-up; the table + seed are ready.
 */

export interface SeedTerm {
  term: string;
  matchGroup: string;
  /** Part A §2.5's own seed migration is specific: "is_sand_gravel = true for sand/gravel/
   *  aggregate patterns" -- NOT every Tier-1-adjacent term (rock/dirt/stone/base/... get a
   *  match_group but are not themselves "sand_gravel"). Preserved here rather than loosened. */
  isSandGravel: boolean;
}

/** Part A §2.5 pattern (`sand|gravel|aggregate|rock|dirt|stone|base`) plus Part B §3.2.2's
 *  fuller example list. Single-word terms only, by design -- see buildSeedMatchGroupSql's
 *  word-boundary regex approach; multi-word phrases ("select fill", "haul off") are a
 *  plausible future enhancement, not included here to keep the regex generation simple and
 *  reviewable. The owner refines all of this from the UI (§2.5) -- this list only needs to be
 *  a reasonable starting point, not a tuned taxonomy. */
export const SEED_TERMS: SeedTerm[] = [
  { term: 'sand', matchGroup: 'sand', isSandGravel: true },
  { term: 'gravel', matchGroup: 'gravel', isSandGravel: true },
  { term: 'aggregate', matchGroup: 'aggregate', isSandGravel: true },
  { term: 'rock', matchGroup: 'rock', isSandGravel: false },
  { term: 'dirt', matchGroup: 'dirt', isSandGravel: false },
  { term: 'stone', matchGroup: 'stone', isSandGravel: false },
  { term: 'base', matchGroup: 'base', isSandGravel: false },
  { term: 'dump', matchGroup: 'dump', isSandGravel: false },
  { term: 'fill', matchGroup: 'fill', isSandGravel: false },
  { term: 'topsoil', matchGroup: 'topsoil', isSandGravel: false },
  { term: 'limestone', matchGroup: 'limestone', isSandGravel: false },
  { term: 'caliche', matchGroup: 'caliche', isSandGravel: false },
  { term: 'asphalt', matchGroup: 'asphalt', isSandGravel: false },
  { term: 'concrete', matchGroup: 'concrete', isSandGravel: false },
];

/** Trigram similarity threshold for the misspelling-catching fallback pass (Part B §3.2.2:
 *  "similarity(norm, seed) > 0.35 (catches 'gravle', 'sand/gravl')"). */
const TRIGRAM_THRESHOLD = 0.35;

function escapeRegexTerm(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Global distribution rebuild (Part B §3.2, "Cheap full rebuild nightly"). TX-active scope
 * mirrors sync-census's own ingest scope (amendment #13). `sample_raw` picks the most
 * frequent original-casing spelling for display (Part A §2.5: "one original-casing example").
 * `first_seen_at` is INSERT-only by omission from the SET clause (same pattern as
 * sources/census.ts's diff-upsert) -- ON CONFLICT never touches it, or match_group, or
 * is_sand_gravel.
 */
export function buildCountsUpsertSql(): string {
  return `
insert into public.cargo_other_values (value, carrier_count_tx, sample_raw, first_seen_at, last_seen_at)
select
  c.cargo_other_norm as value,
  count(*) as carrier_count_tx,
  mode() within group (order by c.crgo_cargoothr_desc) as sample_raw,
  now() as first_seen_at,
  now() as last_seen_at
from public.carriers c
where c.phy_state = 'TX'
  and c.status_code = 'A'
  and c.cargo_other_norm is not null
group by c.cargo_other_norm
on conflict (value) do update set
  carrier_count_tx = excluded.carrier_count_tx,
  sample_raw = excluded.sample_raw,
  last_seen_at = excluded.last_seen_at;
  `.trim();
}

/**
 * Pass 1: deterministic substring/word-boundary match against SEED_TERMS, in list order
 * (first match wins via CASE) -- mirrors Part A §2.5's own literal seed-migration SQL style
 * (`value ~ 'sand|gravel|aggregate|rock|dirt|stone|base'`) rather than inventing a different
 * mechanic. `\\y...\\y` is Postgres's regex word-boundary metacharacter (avoids "sandwich"
 * spuriously matching "sand"). Only ever touches rows where match_group IS NULL.
 */
export function buildSeedMatchGroupSql(): string {
  const whenClauses = SEED_TERMS.map(
    (s) => `    when value ~* '\\y${escapeRegexTerm(s.term)}\\y' then ${sqlStringLiteral(s.matchGroup)}`
  ).join('\n');
  const sandGravelPattern = SEED_TERMS.filter((s) => s.isSandGravel)
    .map((s) => escapeRegexTerm(s.term))
    .join('|');
  const anyTermPattern = SEED_TERMS.map((s) => escapeRegexTerm(s.term)).join('|');

  return `
update public.cargo_other_values
set match_group = case
${whenClauses}
    else null
  end,
  is_sand_gravel = (value ~* '\\y(${sandGravelPattern})\\y')
where match_group is null
  and value ~* '\\y(${anyTermPattern})\\y';
  `.trim();
}

/**
 * Pass 2: trigram-similarity fallback for values pass 1 missed entirely (misspellings like
 * "gravle") -- Part B §3.2.2. Requires `pg_trgm` (already enabled, Part A §2.1) and benefits
 * from `idx_cov_trgm`. `DISTINCT ON` picks each unmatched value's single best-scoring seed
 * term (highest similarity) so one value never gets two competing updates in the same pass.
 */
export function buildTrigramMatchGroupSql(): string {
  const seedValues = SEED_TERMS.map(
    (s) => `(${sqlStringLiteral(s.term)}, ${sqlStringLiteral(s.matchGroup)}, ${s.isSandGravel})`
  ).join(', ');

  return `
with candidates as (
  select
    cov.value,
    s.match_group,
    s.is_sand_gravel,
    similarity(cov.value, s.term) as sim
  from public.cargo_other_values cov
  cross join (values ${seedValues}) as s(term, match_group, is_sand_gravel)
  where cov.match_group is null
),
best as (
  select distinct on (value) value, match_group, is_sand_gravel
  from candidates
  where sim > ${TRIGRAM_THRESHOLD}
  order by value, sim desc
)
update public.cargo_other_values cov
set match_group = b.match_group,
    is_sand_gravel = b.is_sand_gravel
from best b
where b.value = cov.value;
  `.trim();
}

export interface FacetsResult {
  valuesUpserted: number;
  seedPassMatched: number;
  trigramPassMatched: number;
}

export async function runFacets(ctx: PipelineContext): Promise<FacetsResult> {
  const countsResult = await ctx.pg.query(buildCountsUpsertSql());
  const seedResult = await ctx.pg.query(buildSeedMatchGroupSql());
  const trigramResult = await ctx.pg.query(buildTrigramMatchGroupSql());

  const result: FacetsResult = {
    valuesUpserted: countsResult.rowCount ?? 0,
    seedPassMatched: seedResult.rowCount ?? 0,
    trigramPassMatched: trigramResult.rowCount ?? 0,
  };
  ctx.log.info('cargo-facets.done', { ...result });
  return result;
}
