import { readFileSync } from 'node:fs';
import pg from 'pg';
import { parseSupabaseDbTarget, verifyPipelineTarget } from './target-guard.js';

/**
 * Standalone, one-off loader for the geocode fallback reference tables `zip_centroids` and
 * `city_centroids` (columns documented in geocode.ts). NOT part of run.ts or the nightly flow.
 *
 *   tsx src/load-location-tables.ts --zcta=<2025_Gaz_zcta_national.txt> --places=<2025_Gaz_place_national.txt>
 *       [--state=TX] [--apply]
 *
 * Default is a DRY RUN: both files are parsed and validated and counts/samples are printed; no
 * database connection is opened. `--apply` upserts (insert, or update only when a value changed),
 * so re-running is idempotent. `--apply` requires the same target-guard environment as run.ts
 * (SUPABASE_URL, SUPABASE_DB_URL, PIPELINE_ENV, PIPELINE_ALLOWED_DEV_REFS, ...) and is a later,
 * separately approved step.
 *
 * Source files: US Census Bureau Gazetteer files, public domain, 2025 vintage:
 *   https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2025_Gazetteer/2025_Gaz_zcta_national.zip
 *   https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2025_Gazetteer/2025_Gaz_place_national.zip
 * (index: https://www.census.gov/geographies/reference-files/time-series/geo/gazetteer-files.html).
 * Unzip them yourself; this script only parses the extracted .txt files and never executes them.
 *
 * Mapping:
 *   zip_centroids.zcta      <- ZCTA file GEOID;           lat/lng <- INTPTLAT / INTPTLONG
 *   city_centroids.(state,city) <- place file USPS + NAME with the legal-area suffix removed
 *                              ("Austin city" -> "Austin"), because geocode.ts matches the
 *                              carrier's phy_city against `city` case-insensitively;
 *                              lat/lng <- INTPTLAT / INTPTLONG
 * The ZCTA file has no state column, so Texas ZCTAs are selected by ZIP prefix (TX_ZIP_PREFIXES) plus
 * the single Panhandle ZIP 73960 (TX_EXTRA_ZIPS). Place names shared by two places of the same standing
 * (two "Reno city", two "Lakeside town", ...) are ambiguous: they are omitted and listed in the report.
 * ZCTAs are Census approximations of ZIP areas, so a few USPS ZIPs (PO-box-only, unique-organisation
 * ZIPs) have no ZCTA row and fall through to the city tier.
 */

export interface ZipRow { zcta: string; lat: number; lng: number }
export interface CityRow { state: string; city: string; lat: number; lng: number }

/** Texas ZIPs run 75000-79999, plus 733xx (IRS Austin, 73301/73344) and 885xx (El Paso). */
export const TX_ZIP_PREFIXES: readonly string[] = ['75', '76', '77', '78', '79', '733', '885'];

/** Individual Texas ZCTAs outside those prefixes (73960 is in the Panhandle; the rest of 739xx is not Texas). */
export const TX_EXTRA_ZIPS: readonly string[] = ['73960'];

/** Sanity floors for Texas: a truncated/wrong file is refused rather than loaded. */
export const MIN_TX_ZIP_ROWS = 1500;
export const MIN_TX_CITY_ROWS = 1000;

/** Census legal/statistical area description codes (LSAD) -> suffix text in NAME. */
const LSAD_SUFFIX: Record<string, string> = {
  '25': 'city', '37': 'municipality', '43': 'town', '47': 'village', '53': 'borough', '57': 'CDP',
};
const INCORPORATED_LSAD = new Set(['25', '37', '43', '47', '53']);

export function parseGazetteer(text: string): Array<Record<string, string>> {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  const header = lines[0];
  if (header === undefined) throw new Error('Gazetteer file is empty');
  const delim = header.includes('|') ? '|' : '\t'; // 2025 files are pipe-delimited, older ones tab-delimited
  const cols = header.split(delim).map((c) => c.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(delim);
    const row: Record<string, string> = {};
    cols.forEach((c, i) => { row[c] = (cells[i] ?? '').trim(); });
    return row;
  });
}

function parseCoord(latRaw: string | undefined, lngRaw: string | undefined): { lat: number; lng: number } | null {
  const lat = Number(latRaw);
  const lng = Number(lngRaw);
  if (!latRaw || !lngRaw || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  // Continental US + Alaska/Hawaii/territories fit well inside this box; zeros/swapped values do not.
  if (lat < 17 || lat > 72 || lng < -180 || lng > -64) return null;
  return { lat, lng };
}

export interface ParseReport<T> { rows: T[]; rejected: string[] }

export function buildZipRows(text: string, prefixes: readonly string[] = TX_ZIP_PREFIXES): ParseReport<ZipRow> {
  const out = new Map<string, ZipRow>();
  const rejected: string[] = [];
  for (const r of parseGazetteer(text)) {
    const zcta = r.GEOID ?? '';
    if (!/^\d{5}$/.test(zcta)) { rejected.push(`bad ZCTA "${zcta}"`); continue; }
    if (!prefixes.some((p) => zcta.startsWith(p)) && !TX_EXTRA_ZIPS.includes(zcta)) continue;
    const c = parseCoord(r.INTPTLAT, r.INTPTLONG);
    if (!c) { rejected.push(`bad coordinates for ZCTA ${zcta}`); continue; }
    out.set(zcta, { zcta, ...c });
  }
  return { rows: [...out.values()].sort((a, b) => a.zcta.localeCompare(b.zcta)), rejected };
}

/** "Austin city" + LSAD 25 -> "Austin". Unknown LSAD codes keep the full NAME. */
export function placeBaseName(name: string, lsad: string): string {
  const suffix = LSAD_SUFFIX[lsad];
  if (suffix && name.endsWith(` ${suffix}`)) return name.slice(0, -(suffix.length + 1)).trim();
  return name;
}

export interface CityParseReport extends ParseReport<CityRow> {
  /** Base names shared by two or more places of the same standing; left out of the fallback. */
  ambiguous: string[];
}

export function buildCityRows(text: string, state = 'TX'): CityParseReport {
  // A town and a CDP with the same base name are one place: keep the incorporated one. Two places of
  // the SAME standing (two "Reno city", two "Lakeside town", two CDPs) cannot be told apart from the
  // carrier's city text, so that name is omitted rather than guessed.
  const byName = new Map<string, Array<{ row: CityRow; incorporated: boolean }>>();
  const rejected: string[] = [];
  for (const r of parseGazetteer(text)) {
    if (r.USPS !== state) continue;
    const lsad = r.LSAD ?? '';
    const city = placeBaseName(r.NAME ?? '', lsad);
    const c = parseCoord(r.INTPTLAT, r.INTPTLONG);
    if (!city || !c) { rejected.push(`bad place "${r.NAME ?? ''}" (${r.GEOID ?? ''})`); continue; }
    const key = city.toLowerCase();
    const list = byName.get(key) ?? [];
    list.push({ row: { state, city, ...c }, incorporated: INCORPORATED_LSAD.has(lsad) });
    byName.set(key, list);
  }
  const rows: CityRow[] = [];
  const ambiguous: string[] = [];
  for (const list of byName.values()) {
    const inc = list.filter((x) => x.incorporated);
    const top = inc.length > 0 ? inc : list;
    if (top.length === 1) rows.push((top[0] as { row: CityRow }).row);
    else ambiguous.push((top[0] as { row: CityRow }).row.city);
  }
  rows.sort((x, y) => x.city.localeCompare(y.city));
  ambiguous.sort((x, y) => x.localeCompare(y));
  return { rows, rejected, ambiguous };
}

export interface UpsertCounts { inserted: number; updated: number; unchanged: number }

type Queryable = Pick<pg.Pool, 'query'>;
const BATCH = 1000;

export async function upsertZipCentroids(db: Queryable, rows: ZipRow[]): Promise<UpsertCounts> {
  const counts: UpsertCounts = { inserted: 0, updated: 0, unchanged: 0 };
  for (let i = 0; i < rows.length; i += BATCH) {
    const b = rows.slice(i, i + BATCH);
    const res = await db.query<{ inserted: boolean }>(
      `insert into public.zip_centroids as t (zcta, lat, lng)
       select * from unnest($1::text[], $2::double precision[], $3::double precision[])
       on conflict (zcta) do update set lat = excluded.lat, lng = excluded.lng
         where (t.lat, t.lng) is distinct from (excluded.lat, excluded.lng)
       returning (xmax = 0) as inserted`,
      [b.map((r) => r.zcta), b.map((r) => r.lat), b.map((r) => r.lng)]
    );
    const ins = res.rows.filter((r) => r.inserted).length;
    counts.inserted += ins;
    counts.updated += res.rows.length - ins;
    counts.unchanged += b.length - res.rows.length;
  }
  return counts;
}

export async function upsertCityCentroids(db: Queryable, rows: CityRow[]): Promise<UpsertCounts> {
  const counts: UpsertCounts = { inserted: 0, updated: 0, unchanged: 0 };
  for (let i = 0; i < rows.length; i += BATCH) {
    const b = rows.slice(i, i + BATCH);
    const res = await db.query<{ inserted: boolean }>(
      `insert into public.city_centroids as t (state, city, lat, lng)
       select * from unnest($1::text[], $2::text[], $3::double precision[], $4::double precision[])
       on conflict (state, city) do update set lat = excluded.lat, lng = excluded.lng
         where (t.lat, t.lng) is distinct from (excluded.lat, excluded.lng)
       returning (xmax = 0) as inserted`,
      [b.map((r) => r.state), b.map((r) => r.city), b.map((r) => r.lat), b.map((r) => r.lng)]
    );
    const ins = res.rows.filter((r) => r.inserted).length;
    counts.inserted += ins;
    counts.updated += res.rows.length - ins;
    counts.unchanged += b.length - res.rows.length;
  }
  return counts;
}

/** Both tables in ONE transaction: either both load or neither does. */
export async function applyLoad(pool: pg.Pool, zips: ZipRow[], cities: CityRow[]): Promise<{ zip: UpsertCounts; city: UpsertCounts }> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const zip = await upsertZipCentroids(client, zips);
    const city = await upsertCityCentroids(client, cities);
    await client.query('commit');
    return { zip, city };
  } catch (e) {
    await client.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

interface CliArgs { zcta: string; places: string; state: string; apply: boolean }

export function parseCliArgs(argv: string[]): CliArgs {
  const a: CliArgs = { zcta: '', places: '', state: 'TX', apply: false };
  for (const raw of argv) {
    if (raw === '--apply') { a.apply = true; continue; }
    const m = /^--(zcta|places|state)=(.+)$/.exec(raw);
    if (!m) throw new Error(`Unrecognized argument "${raw}". Usage: load-location-tables --zcta=<file> --places=<file> [--state=TX] [--apply]`);
    a[m[1] as 'zcta' | 'places' | 'state'] = m[2] as string;
  }
  if (!a.zcta || !a.places) throw new Error('Both --zcta=<file> and --places=<file> are required');
  if (a.state !== 'TX') throw new Error('Only --state=TX is supported (ZIP selection is Texas-prefix based)');
  return a;
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const zips = buildZipRows(readFileSync(args.zcta, 'utf8'));
  const cities = buildCityRows(readFileSync(args.places, 'utf8'), args.state);
  const report = {
    mode: args.apply ? 'apply' : 'dry-run',
    zipRows: zips.rows.length,
    cityRows: cities.rows.length,
    rejected: zips.rejected.length + cities.rejected.length,
    ambiguousCityNames: { count: cities.ambiguous.length, names: cities.ambiguous },
    sampleZip: zips.rows.slice(0, 2),
    sampleCity: cities.rows.slice(0, 2),
  };
  console.log(JSON.stringify(report));
  for (const r of [...zips.rejected, ...cities.rejected]) console.warn(`rejected: ${r}`);
  if (zips.rows.length < MIN_TX_ZIP_ROWS || cities.rows.length < MIN_TX_CITY_ROWS) {
    throw new Error(`Refusing: expected at least ${MIN_TX_ZIP_ROWS} Texas ZIPs and ${MIN_TX_CITY_ROWS} places; got ${zips.rows.length} and ${cities.rows.length}`);
  }
  if (!args.apply) {
    console.log('Dry run only: nothing was written. Re-run with --apply (after approval) to load.');
    return;
  }

  const env = process.env;
  const dbUrl = env.SUPABASE_DB_URL ?? '';
  const target = parseSupabaseDbTarget(dbUrl);
  verifyPipelineTarget({
    environment: env.PIPELINE_ENV === 'prod' ? 'prod' : 'dev',
    supabaseUrl: env.SUPABASE_URL ?? '',
    supabaseDbUrl: dbUrl,
    allowedDevRefs: (env.PIPELINE_ALLOWED_DEV_REFS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    allowStagingWrites: env.PIPELINE_ALLOW_STAGING_WRITES === 'true',
  });
  const pool = new pg.Pool({
    host: target.host, port: target.port, user: target.user, password: target.password, database: target.database,
    max: 1, ssl: { rejectUnauthorized: false },
  });
  try {
    console.log(JSON.stringify(await applyLoad(pool, zips.rows, cities.rows)));
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && /load-location-tables\.[tj]s$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
