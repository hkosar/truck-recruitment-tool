import type { PipelineContext } from './db.js';
import { sleep } from './socrata.js';

/**
 * Bulk geocoding, $0 (Part B §4). No lat/lng in any FMCSA source -- this fills
 * `carriers.geom`/`geocode_precision` via, in order: (1) Census Bureau batch geocoder
 * (street-level), (2) ZCTA Gazetteer centroid, (3) Places Gazetteer city centroid.
 *
 * ============================================================================================
 * SCHEMA GAP (flag for the schema agent, not silently invented here): `zip_centroids` and
 * `city_centroids` -- the one-time-loaded Gazetteer reference tables Part B §4.2 requires for
 * tiers 2/3 -- appear NOWHERE in Part A's DDL (§2.4) or in 01-architecture.md's reconciliation
 * amendment #7's "gains Part B's..." list, even though amendment #7 otherwise enumerates every
 * other Part-B-originated table (`carrier_insurance_filings`, `carrier_qc_snapshots`). These
 * two tables need a migration before `zipCentroidFallback`/`cityCentroidFallback` below can
 * run for real. Proposed minimal shape (this pipeline's own proposal, not confirmed):
 *   zip_centroids  (zcta text primary key, lat double precision, lng double precision)
 *   city_centroids (state text, city text, lat double precision, lng double precision,
 *                   primary key (state, city))
 * ...loaded once from the Census 2025 Gazetteer files (census.gov gazetteer-files) via a
 * one-off script, not by this nightly/monthly pipeline -- Part B §4.2 describes them as
 * "one-time-loaded", not part of the daily job. `loadZipCentroids`/`loadCityCentroids` below
 * are therefore intentionally thin stubs: the real loader is out of scope for this nightly
 * pipeline's own runtime and belongs in a one-off backfill script once the tables exist.
 *
 * `geocode_precision` mapping (01-architecture.md reconciliation item 6): "street ->
 * (rooftop|range_interpolated|geometric_center)". The Census batch geocoder's own match-type
 * vocabulary is only two-valued (Exact/Non_Exact), so there is no clean 1:1 mapping onto Part
 * A's three street-level enum values -- `censusMatchToPrecision` below is a DECISION
 * (Exact->'rooftop', Non_Exact->'range_interpolated'), not a verified fact. 'geometric_center'
 * is left unused for now; revisit if the Census response ever supports a finer distinction.
 * ============================================================================================
 */

const PO_BOX_OR_RURAL_ROUTE = /^\s*(P\.?\s*O\.?\s*BOX|RR\s*\d|HC\s*\d)/i;

export interface GeocodeCandidate {
  dotNumber: number;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
}

export type GeocodePrecision =
  | 'rooftop'
  | 'range_interpolated'
  | 'geometric_center'
  | 'approximate'
  | 'zip_centroid'
  | 'city_centroid'
  | 'none';

export interface CensusMatchResult {
  dotNumber: number;
  matched: boolean;
  matchType: 'Exact' | 'Non_Exact' | null;
  lng: number | null;
  lat: number | null;
}

// ------------------------------------------------------------------------------------------
// Candidate selection
// ------------------------------------------------------------------------------------------

/**
 * Mirrors `idx_carriers_geocode_todo` (Part A §2.9): rows never geocoded, or whose address
 * changed since the last successful geocode (`geocode_addr_hash IS DISTINCT FROM
 * address_hash` -- Part A's actual column name; Part B §4.2's prose calls it
 * "geocoded_address_hash", which does not exist in the DDL -- using the DDL's real name).
 */
export function buildCandidateQuery(limit: number): { sql: string; params: unknown[] } {
  return {
    sql: `
      select dot_number, phy_street, phy_city, phy_state, phy_zip5
      from public.carriers
      where geom is null or geocode_addr_hash is distinct from address_hash
      order by dot_number
      limit $1
    `.trim(),
    params: [limit],
  };
}

export function splitByAddressType(rows: GeocodeCandidate[]): {
  streetEligible: GeocodeCandidate[];
  poBoxOrRural: GeocodeCandidate[];
} {
  const streetEligible: GeocodeCandidate[] = [];
  const poBoxOrRural: GeocodeCandidate[] = [];
  for (const row of rows) {
    if (row.street && PO_BOX_OR_RURAL_ROUTE.test(row.street)) {
      poBoxOrRural.push(row);
    } else {
      streetEligible.push(row);
    }
  }
  return { streetEligible, poBoxOrRural };
}

// ------------------------------------------------------------------------------------------
// Census batch geocoder (tier 1: street)
// ------------------------------------------------------------------------------------------

function csvField(value: string): string {
  if (value === '') return '';
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** No header row -- the Census addressbatch format is strictly unique_id,street,city,state,zip
 *  per record (geocoding.geo.census.gov/geocoder/Geocoding_Services_API.html). */
export function buildBatchCsv(rows: GeocodeCandidate[]): string {
  return rows
    .map((r) =>
      [String(r.dotNumber), r.street ?? '', r.city ?? '', r.state ?? '', r.zip ?? '']
        .map(csvField)
        .join(',')
    )
    .join('\r\n');
}

/**
 * Splits `candidates` into chunks respecting BOTH of the Census geocoder's hard caps:
 * 10,000 records AND 5MB per file (Part B §4.1/04-costs §1). Sized off `CENSUS_BATCH_MAX_RECORDS`
 * (config.ts) and a conservative per-row byte estimate so a handful of unusually long
 * addresses can't silently push a "10,000-row" chunk over the 5MB ceiling.
 */
export function chunkCandidates(
  candidates: GeocodeCandidate[],
  maxRecords: number,
  maxBytes = 4_500_000 // conservative margin under the real 5,000,000-byte cap
): GeocodeCandidate[][] {
  const chunks: GeocodeCandidate[][] = [];
  let current: GeocodeCandidate[] = [];
  let currentBytes = 0;

  for (const row of candidates) {
    const rowCsv = buildBatchCsv([row]);
    const rowBytes = Buffer.byteLength(rowCsv, 'utf8') + 2; // +2 for the \r\n joiner
    const wouldOverflow = current.length >= maxRecords || currentBytes + rowBytes > maxBytes;
    if (wouldOverflow && current.length > 0) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(row);
    currentBytes += rowBytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * One batch submission. Census's own docs + Part B §4.1 describe this as synchronous
 * (server holds the connection ~1-5 min then returns the result CSV directly) -- no
 * poll/webhook step, unlike some batch geocoding APIs. TODO(live-db): the exact response
 * CSV shape below (`parseCensusBatchCsv`) is written from the documented format, not a
 * fetched real sample (data.transportation.gov-adjacent hosts aside, geocoding.geo.census.gov
 * itself was not probed this session either) -- validate against one real response on day 1.
 */
export async function submitCensusBatch(
  ctx: PipelineContext,
  rows: GeocodeCandidate[],
  fetchImpl: typeof fetch = fetch
): Promise<CensusMatchResult[]> {
  const csv = buildBatchCsv(rows);
  const form = new FormData();
  form.append('addressFile', new Blob([csv], { type: 'text/csv' }), 'batch.csv');
  form.append('benchmark', ctx.config.CENSUS_GEOCODER_BENCHMARK);

  const url = `${ctx.config.CENSUS_GEOCODER_BASE_URL}/locations/addressbatch`;
  const res = await fetchImpl(url, { method: 'POST', body: form });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Census batch geocoder returned ${res.status}: ${res.statusText} ${body}`);
  }
  const text = await res.text();
  return parseCensusBatchCsv(text);
}

/** Minimal, dependency-free CSV row splitter (handles quoted fields with embedded commas /
 *  escaped quotes) -- the Census response's "Matched Address" field routinely contains
 *  commas, so naive `.split(',')` is not safe here. */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

/**
 * Documented shape (unique_id, input_address, match_indicator, match_type, matched_address,
 * lon, lat, tiger_line_id, side) for a Match/Tie row; No_Match rows carry far fewer fields.
 * TODO(live-db): confirm field COUNT and ORDER against a real response -- this is written
 * from Census's published documentation, not a fetched sample (see submitCensusBatch's doc).
 */
function parseCensusBatchCsv(text: string): CensusMatchResult[] {
  const results: CensusMatchResult[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const fields = parseCsvLine(line);
    const dotNumberRaw = fields[0];
    const matchIndicator = fields[2];
    if (dotNumberRaw === undefined || matchIndicator === undefined) continue;

    const dotNumber = Number(dotNumberRaw);
    if (!Number.isFinite(dotNumber)) continue;

    const matched = matchIndicator === 'Match' || matchIndicator === 'Tie';
    if (!matched) {
      results.push({ dotNumber, matched: false, matchType: null, lng: null, lat: null });
      continue;
    }

    const matchType = fields[3] === 'Exact' ? 'Exact' : 'Non_Exact';
    const lng = fields[5] !== undefined ? Number(fields[5]) : NaN;
    const lat = fields[6] !== undefined ? Number(fields[6]) : NaN;
    results.push({
      dotNumber,
      matched: Number.isFinite(lng) && Number.isFinite(lat),
      matchType,
      lng: Number.isFinite(lng) ? lng : null,
      lat: Number.isFinite(lat) ? lat : null,
    });
  }
  return results;
}

export function censusMatchToPrecision(matchType: 'Exact' | 'Non_Exact'): GeocodePrecision {
  // See this file's header note -- a documented judgment call, not a verified 1:1 mapping.
  return matchType === 'Exact' ? 'rooftop' : 'range_interpolated';
}

/** Applies a page of Census results as a single set-based UPDATE (batched VALUES list, not
 *  N round trips). Only touches rows that actually matched -- no-match rows fall through to
 *  the ZIP/city centroid fallback tiers. */
export async function applyCensusResults(ctx: PipelineContext, results: CensusMatchResult[]): Promise<number> {
  const matched = results.filter((r) => r.matched && r.lng !== null && r.lat !== null && r.matchType);
  if (matched.length === 0) return 0;

  const values: unknown[] = [];
  const tuples = matched.map((r, i) => {
    const base = i * 4;
    values.push(r.dotNumber, r.lng, r.lat, censusMatchToPrecision(r.matchType as 'Exact' | 'Non_Exact'));
    return `($${base + 1}::bigint, $${base + 2}::double precision, $${base + 3}::double precision, $${base + 4}::geocode_precision)`;
  });

  const sql = `
    update public.carriers c
    set geom = st_setsrid(st_makepoint(v.lng, v.lat), 4326)::geography,
        geocode_precision = v.precision,
        geocode_source = 'census_batch',
        geocode_addr_hash = c.address_hash,
        geocoded_at = now()
    from (values ${tuples.join(', ')}) as v(dot_number, lng, lat, precision)
    where v.dot_number = c.dot_number;
  `.trim();

  const result = await ctx.pg.query(sql, values);
  return result.rowCount ?? 0;
}

// ------------------------------------------------------------------------------------------
// Fallback tiers 2/3: ZCTA + city centroids -- see the SCHEMA GAP note at the top of this file
// ------------------------------------------------------------------------------------------

/**
 * TODO(schema + one-time data load): requires `zip_centroids` (does not exist yet -- see file
 * header) populated from the Census ZCTA Gazetteer file. That load is a one-off backfill
 * script's job, not this nightly/monthly pipeline's -- this function assumes the table is
 * already populated and just joins against it.
 */
export async function zipCentroidFallback(ctx: PipelineContext, candidates: GeocodeCandidate[]): Promise<number> {
  if (candidates.length === 0) return 0;
  const zips = candidates.map((c) => c.zip).filter((z): z is string => Boolean(z));
  if (zips.length === 0) return 0;

  const sql = `
    update public.carriers c
    set geom = st_setsrid(st_makepoint(zc.lng, zc.lat), 4326)::geography,
        geocode_precision = 'zip_centroid',
        geocode_source = 'census_zcta_gazetteer',
        geocode_addr_hash = c.address_hash,
        geocoded_at = now()
    from public.zip_centroids zc
    where zc.zcta = c.phy_zip5
      and c.dot_number = any($1::bigint[])
  `.trim();

  const result = await ctx.pg.query(sql, [candidates.map((c) => c.dotNumber)]);
  return result.rowCount ?? 0;
}

/**
 * TODO(schema + one-time data load): requires `city_centroids` (does not exist yet -- see
 * file header) populated from the Census Places Gazetteer file (TX places). Last-resort tier
 * -- only reached by rows that failed BOTH the street match and the ZIP centroid join (e.g. a
 * ZIP not present in the Gazetteer extract).
 */
export async function cityCentroidFallback(ctx: PipelineContext, candidates: GeocodeCandidate[]): Promise<number> {
  if (candidates.length === 0) return 0;

  const sql = `
    update public.carriers c
    set geom = st_setsrid(st_makepoint(cc.lng, cc.lat), 4326)::geography,
        geocode_precision = 'city_centroid',
        geocode_source = 'census_places_gazetteer',
        geocode_addr_hash = c.address_hash,
        geocoded_at = now()
    from public.city_centroids cc
    where cc.state = c.phy_state
      and lower(btrim(cc.city)) = lower(btrim(c.phy_city))
      and c.dot_number = any($1::bigint[])
  `.trim();

  const result = await ctx.pg.query(sql, [candidates.map((c) => c.dotNumber)]);
  return result.rowCount ?? 0;
}

/** Anything still ungeocoded after all three tiers -- surfaced in the dq-report (Part B §5)
 *  rather than left silently unmarked. Does not write 'none' eagerly on every run (a row
 *  might still get picked up by a later tier as gazetteer coverage improves); dq-report.ts
 *  computes this as a read-only count, not a stored terminal state. */
export function buildUngeocodedCountQuery(): string {
  return `select count(*) as n from public.carriers where phy_state = 'TX' and status_code = 'A' and geom is null`;
}

// ------------------------------------------------------------------------------------------
// Orchestration
// ------------------------------------------------------------------------------------------

export interface GeocodeOptions {
  /** Local dev / smoke test cap -- overrides config.CENSUS_MAX_BATCHES_PER_RUN. */
  maxBatches?: number;
  /** How many candidate rows to pull from `carriers` before chunking into batches. Defaults
   *  to maxBatches * CENSUS_BATCH_MAX_RECORDS so we never fetch more candidates than we could
   *  possibly submit this run. */
  candidateLimit?: number;
  /** Delay between sequential batch submissions (Part B §4.1: "Run batches sequentially (one
   *  in flight)") -- a good-citizen pause, not rate-limit-driven (Census's batch endpoint has
   *  no documented per-hour cap the way Socrata does). */
  interBatchDelayMs?: number;
}

export interface GeocodeResult {
  candidateCount: number;
  batchesSubmitted: number;
  streetMatched: number;
  zipFallbackMatched: number;
  cityFallbackMatched: number;
  stillUngeocoded: number;
}

export async function runGeocode(ctx: PipelineContext, options: GeocodeOptions = {}): Promise<GeocodeResult> {
  const maxBatches = options.maxBatches ?? ctx.config.CENSUS_MAX_BATCHES_PER_RUN;
  const maxRecords = ctx.config.CENSUS_BATCH_MAX_RECORDS;
  const candidateLimit = options.candidateLimit ?? maxBatches * maxRecords;
  const interBatchDelayMs = options.interBatchDelayMs ?? 1_000;

  const { sql, params } = buildCandidateQuery(candidateLimit);
  const candidateRows = await ctx.pg.query(sql, params);
  const candidates: GeocodeCandidate[] = candidateRows.rows.map((r: Record<string, unknown>) => ({
    dotNumber: Number(r.dot_number),
    street: (r.phy_street as string | null) ?? null,
    city: (r.phy_city as string | null) ?? null,
    state: (r.phy_state as string | null) ?? null,
    zip: (r.phy_zip5 as string | null) ?? null,
  }));

  const { streetEligible, poBoxOrRural } = splitByAddressType(candidates);
  const batches = chunkCandidates(streetEligible, maxRecords).slice(0, maxBatches);

  let streetMatched = 0;
  const unmatchedFromStreet: GeocodeCandidate[] = [];
  // Explicit tuple return type -- `.map((c) => [c.dotNumber, c])` alone commonly infers as
  // `(number | GeocodeCandidate)[][]` rather than `[number, GeocodeCandidate][]`, which
  // `new Map()`'s constructor won't accept. Annotating the callback's return type sidesteps
  // that inference gap entirely rather than relying on it resolving favorably.
  const streetEligibleById = new Map(
    streetEligible.map((c): [number, GeocodeCandidate] => [c.dotNumber, c])
  );

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i] as GeocodeCandidate[];
    ctx.log.info('geocode.batch_submit', { batch: i + 1, of: batches.length, rows: batch.length });
    const results = await submitCensusBatch(ctx, batch);
    streetMatched += await applyCensusResults(ctx, results);

    for (const r of results) {
      if (!r.matched) {
        const original = streetEligibleById.get(r.dotNumber);
        if (original) unmatchedFromStreet.push(original);
      }
    }
    if (i < batches.length - 1) await sleep(interBatchDelayMs);
  }

  // Anything beyond maxBatches this run simply waits for tomorrow's/next month's pass --
  // idx_carriers_geocode_todo means it stays queued, nothing is lost. Sliced at the ACTUAL
  // number of rows packed into `batches`, not `batches.length * maxRecords` -- chunkCandidates
  // can pack fewer than maxRecords rows into a chunk when the 5MB byte cap bites first, so
  // that multiplication would over-count and silently skip rows that were never submitted.
  const submittedCount = batches.reduce((sum, batch) => sum + batch.length, 0);
  const skippedByBatchCap = streetEligible.slice(submittedCount);

  const fallbackCandidates = [...poBoxOrRural, ...unmatchedFromStreet, ...skippedByBatchCap];
  const zipFallbackMatched = await zipCentroidFallback(ctx, fallbackCandidates);
  // TODO(live-db): re-querying "still unmatched" from the DB (rather than tracking in JS)
  // once zip_centroids exists, so city fallback only sees rows the ZIP tier truly missed.
  const cityFallbackMatched = await cityCentroidFallback(ctx, fallbackCandidates);

  const ungeocodedResult = await ctx.pg.query(buildUngeocodedCountQuery());
  const stillUngeocoded = Number(ungeocodedResult.rows[0]?.n ?? 0);

  const result: GeocodeResult = {
    candidateCount: candidates.length,
    batchesSubmitted: batches.length,
    streetMatched,
    zipFallbackMatched,
    cityFallbackMatched,
    stillUngeocoded,
  };
  ctx.log.info('geocode.done', { ...result });
  return result;
}
