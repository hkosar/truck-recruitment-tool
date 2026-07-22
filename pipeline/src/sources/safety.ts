import { bulkInsert, withStagingConnection, type PgPoolClient, type PipelineContext } from '../db.js';
import { DEFAULT_PAGE_SIZE, SOCRATA_DATASETS, SocrataClient } from '../socrata.js';

/**
 * Monthly carrier-safety snapshot.
 *
 * Live source contracts were verified on 2026-07-22 against official DOT DataHub metadata
 * and samples:
 * - 4y6x-dmck (SMS AB PassProperty) is a real SODA table with one row per carrier and exactly
 *   the five 24-month inspection/OOS totals used below. It does NOT contain crash totals or
 *   safety-rating columns.
 * - az4n-8mr2 (Company Census File) contains safety_rating using compact S/C/U codes and
 *   safety_rating_date as YYYYMMDD text.
 * - 4wxs-vbns (SMS Input - Crash) is the separate crash-event source. Crash aggregation is
 *   deliberately not enabled here yet: its report identifiers are not globally reliable
 *   enough to deduplicate without a reviewed event-key contract, and enabling an incorrect
 *   total would immediately feed the recent_crashes warning.
 *
 * This implementation therefore ships a fail-closed, read-only probe plus an inspection-only
 * sync. Crash totals remain NULL and must not be interpreted as zero. A later reviewed crash
 * source can extend this snapshot after deterministic event-key tests.
 */

export const SAFETY_DATASET_ID = SOCRATA_DATASETS.SMS_AB_PASSPROPERTY;
export const SAFETY_RATING_DATASET_ID = SOCRATA_DATASETS.COMPANY_CENSUS;

const SAFETY_SELECT_FIELDS = [
  'dot_number',
  'insp_total',
  'driver_insp_total',
  'driver_oos_insp_total',
  'vehicle_insp_total',
  'vehicle_oos_insp_total',
] as const;

const SAFETY_RATING_FIELDS = ['dot_number', 'safety_rating', 'safety_rating_date'] as const;
const ALLOWED_SOURCE_RATING_CODES = new Set(['', 'S', 'C', 'U']);

export function buildSelectClause(): string {
  return SAFETY_SELECT_FIELDS.join(',');
}

export function buildRatingSelectClause(): string {
  return SAFETY_RATING_FIELDS.join(',');
}

export function mapSafetyRatingCode(value: unknown): string | null {
  const code = value === undefined || value === null ? '' : String(value).trim().toUpperCase();
  if (!ALLOWED_SOURCE_RATING_CODES.has(code)) {
    throw new Error(`Unexpected FMCSA safety_rating code "${code}"`);
  }
  if (code === '') return null;
  if (code === 'S') return 'Satisfactory';
  if (code === 'C') return 'Conditional';
  return 'Unsatisfactory';
}

export function parseFmcsaCompactDate(value: unknown): string | null {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const raw = String(value).trim();
  if (!/^\d{8}$/.test(raw)) throw new Error(`Unexpected FMCSA compact date "${raw}"`);
  const year = Number(raw.slice(0, 4));
  const month = Number(raw.slice(4, 6));
  const day = Number(raw.slice(6, 8));
  const d = new Date(Date.UTC(year, month - 1, day));
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    throw new Error(`Invalid FMCSA compact date "${raw}"`);
  }
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

function parseNonNegativeInteger(value: unknown, field: string): number {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new Error(`Missing ${field} value`);
  }
  const raw = String(value).trim();
  if (!/^\d+$/.test(raw)) throw new Error(`Unexpected ${field} value "${raw}"`);
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`Out-of-range ${field} value "${raw}"`);
  return n;
}

export interface SafetySourceRow {
  dot_number: string;
  insp_total: string;
  driver_insp_total: string;
  driver_oos_insp_total: string;
  vehicle_insp_total: string;
  vehicle_oos_insp_total: string;
}

export interface SafetyRatingSourceRow {
  dot_number: string;
  safety_rating?: string;
  safety_rating_date?: string;
}

export interface ValidatedSafetyRow {
  dotNumber: number;
  inspections: number;
  driverInspections: number;
  driverOos: number;
  vehicleInspections: number;
  vehicleOos: number;
}

export function validateSafetyRow(row: Record<string, unknown>): ValidatedSafetyRow {
  const dotNumber = parseNonNegativeInteger(row.dot_number, 'dot_number');
  if (dotNumber <= 0) throw new Error(`Invalid dot_number "${String(row.dot_number)}"`);
  const inspections = parseNonNegativeInteger(row.insp_total, 'insp_total');
  const driverInspections = parseNonNegativeInteger(row.driver_insp_total, 'driver_insp_total');
  const driverOos = parseNonNegativeInteger(row.driver_oos_insp_total, 'driver_oos_insp_total');
  const vehicleInspections = parseNonNegativeInteger(row.vehicle_insp_total, 'vehicle_insp_total');
  const vehicleOos = parseNonNegativeInteger(row.vehicle_oos_insp_total, 'vehicle_oos_insp_total');

  if (driverOos > driverInspections) {
    throw new Error(`driver_oos_insp_total exceeds driver_insp_total for DOT ${dotNumber}`);
  }
  if (vehicleOos > vehicleInspections) {
    throw new Error(`vehicle_oos_insp_total exceeds vehicle_insp_total for DOT ${dotNumber}`);
  }
  if (driverInspections > inspections || vehicleInspections > inspections) {
    throw new Error(`inspection component exceeds insp_total for DOT ${dotNumber}`);
  }

  return { dotNumber, inspections, driverInspections, driverOos, vehicleInspections, vehicleOos };
}

function buildStagingDdl(): string {
  return `
create temp table staging_safety (
  dot_number bigint primary key,
  inspections_24mo int not null,
  driver_insp_24mo int not null,
  driver_oos_24mo int not null,
  vehicle_insp_24mo int not null,
  vehicle_oos_24mo int not null,
  safety_rating text,
  safety_rating_date date
) on commit drop;
  `.trim();
}

export function buildUpsertSql(): string {
  return `
insert into public.carrier_safety (
  dot_number,
  snapshot_month,
  inspections_24mo,
  driver_insp_24mo,
  driver_oos_24mo,
  vehicle_insp_24mo,
  vehicle_oos_24mo,
  driver_oos_rate,
  vehicle_oos_rate,
  safety_rating,
  safety_rating_date,
  last_synced_at
)
select
  sc.dot_number,
  date_trunc('month', current_date)::date,
  sc.inspections_24mo,
  sc.driver_insp_24mo,
  sc.driver_oos_24mo,
  sc.vehicle_insp_24mo,
  sc.vehicle_oos_24mo,
  case when sc.driver_insp_24mo = 0 then null
       else round((sc.driver_oos_24mo::numeric / sc.driver_insp_24mo::numeric) * 100, 2) end,
  case when sc.vehicle_insp_24mo = 0 then null
       else round((sc.vehicle_oos_24mo::numeric / sc.vehicle_insp_24mo::numeric) * 100, 2) end,
  sc.safety_rating,
  sc.safety_rating_date,
  now()
from staging_safety sc
where exists (select 1 from public.carriers c where c.dot_number = sc.dot_number)
on conflict (dot_number) do update set
  snapshot_month = excluded.snapshot_month,
  inspections_24mo = excluded.inspections_24mo,
  driver_insp_24mo = excluded.driver_insp_24mo,
  driver_oos_24mo = excluded.driver_oos_24mo,
  vehicle_insp_24mo = excluded.vehicle_insp_24mo,
  vehicle_oos_24mo = excluded.vehicle_oos_24mo,
  driver_oos_rate = excluded.driver_oos_rate,
  vehicle_oos_rate = excluded.vehicle_oos_rate,
  safety_rating = coalesce(excluded.safety_rating, public.carrier_safety.safety_rating),
  safety_rating_date = coalesce(excluded.safety_rating_date, public.carrier_safety.safety_rating_date),
  last_synced_at = excluded.last_synced_at;
  `.trim();
}

function stats(values: number[]): { min: number | null; max: number | null; avg: number | null } {
  if (values.length === 0) return { min: null, max: null, avg: null };
  return {
    min: Math.min(...values),
    max: Math.max(...values),
    avg: Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(2)),
  };
}

export interface SafetyProbeResult {
  datasetId: string;
  sampleRows: number;
  uniqueDots: number;
  inspectionStats: ReturnType<typeof stats>;
  driverOosRates: ReturnType<typeof stats>;
  vehicleOosRates: ReturnType<typeof stats>;
  ratingCounts: Record<string, number>;
}

export async function probeSafetySources(
  socrata: SocrataClient,
  options: { sampleLimit?: number } = {}
): Promise<SafetyProbeResult> {
  const sampleLimit = options.sampleLimit ?? 1_000;
  const rawSafety = await socrata.fetchPage<Record<string, unknown>>(SAFETY_DATASET_ID, {
    $select: buildSelectClause(),
    $limit: sampleLimit,
  });
  const safety = rawSafety.map(validateSafetyRow);
  const uniqueDots = new Set(safety.map((row) => row.dotNumber));
  if (uniqueDots.size !== safety.length) {
    throw new Error(`Safety probe found duplicate DOTs: ${safety.length} rows / ${uniqueDots.size} unique`);
  }

  const rawRatings = await socrata.fetchPage<Record<string, unknown>>(SAFETY_RATING_DATASET_ID, {
    $select: buildRatingSelectClause(),
    $where: "phy_state='TX' AND status_code='A' AND safety_rating is not null",
    $order: 'dot_number',
    $limit: sampleLimit,
  });
  const ratingCounts: Record<string, number> = { Satisfactory: 0, Conditional: 0, Unsatisfactory: 0, Unrated: 0 };
  for (const row of rawRatings) {
    const rating = mapSafetyRatingCode(row.safety_rating);
    if (row.safety_rating_date) parseFmcsaCompactDate(row.safety_rating_date);
    ratingCounts[rating ?? 'Unrated'] += 1;
  }

  const driverRates = safety
    .filter((row) => row.driverInspections > 0)
    .map((row) => Number(((row.driverOos / row.driverInspections) * 100).toFixed(2)));
  const vehicleRates = safety
    .filter((row) => row.vehicleInspections > 0)
    .map((row) => Number(((row.vehicleOos / row.vehicleInspections) * 100).toFixed(2)));

  return {
    datasetId: SAFETY_DATASET_ID,
    sampleRows: safety.length,
    uniqueDots: uniqueDots.size,
    inspectionStats: stats(safety.map((row) => row.inspections)),
    driverOosRates: stats(driverRates),
    vehicleOosRates: stats(vehicleRates),
    ratingCounts,
  };
}

export interface SafetySyncOptions {
  maxPages?: number;
  pageSize?: number;
  dryRun?: boolean;
  includeRatings?: boolean;
}

export interface SafetySyncResult {
  datasetId: string;
  rowsRead: number;
  rowsUpserted: number;
  ratingRowsRead: number;
  dryRun: boolean;
  validation: Record<string, unknown>;
}

export async function syncSafety(
  ctx: PipelineContext,
  socrata: SocrataClient,
  options: SafetySyncOptions = {}
): Promise<SafetySyncResult> {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const includeRatings = options.includeRatings ?? false;
  let rowsRead = 0;
  let ratingRowsRead = 0;
  let pageCount = 0;

  const totalSourceRows = await socrata.count(SAFETY_DATASET_ID);
  if (totalSourceRows < 100_000 || totalSourceRows > 1_500_000) {
    throw new Error(`Safety source row count ${totalSourceRows} is outside the expected 100k-1.5M range`);
  }

  const result = await withStagingConnection(ctx.pg, buildStagingDdl(), async (client: PgPoolClient) => {
    // dot_number is TEXT in this dataset. Use stable ordered offset paging; the generic
    // numeric-keyset helper would emit `dot_number > 123` and Socrata correctly rejects that
    // type mismatch. Offset depth is acceptable for this monthly ~695k-row source.
    for await (const page of socrata.paginateOffset<Record<string, unknown>>(
      SAFETY_DATASET_ID,
      { $select: buildSelectClause(), $order: 'dot_number' },
      pageSize
    )) {
      pageCount += 1;
      rowsRead += page.length;
      const rows = page.map((raw) => {
        const row = validateSafetyRow(raw);
        return [
          row.dotNumber,
          row.inspections,
          row.driverInspections,
          row.driverOos,
          row.vehicleInspections,
          row.vehicleOos,
          null,
          null,
        ];
      });
      await bulkInsert(
        client,
        'staging_safety',
        [
          'dot_number',
          'inspections_24mo',
          'driver_insp_24mo',
          'driver_oos_24mo',
          'vehicle_insp_24mo',
          'vehicle_oos_24mo',
          'safety_rating',
          'safety_rating_date',
        ],
        rows,
        1_000
      );
      ctx.log.info('sync-safety.page', { page: pageCount, pageRows: page.length, rowsRead });
      if (options.maxPages && pageCount >= options.maxPages) break;
    }

    // Ratings are live-verified on the Census dataset, but querying them for every safety DOT
    // would add thousands of requests to a 695k-row monthly pull. Keep bulk rating import behind
    // an explicit option until the census pipeline promotes these two fields directly. The
    // read-only probe still validates the source contract on every diagnostic run.
    if (includeRatings) {
      const stagedDots = await client.query<{ dot_number: string }>('select dot_number::text from staging_safety order by dot_number');
      const dots = stagedDots.rows.map((row) => row.dot_number);
      const ratingChunkSize = 100;
      for (let i = 0; i < dots.length; i += ratingChunkSize) {
        const chunk = dots.slice(i, i + ratingChunkSize);
        if (chunk.length === 0) continue;
        const rows = await socrata.fetchPage<Record<string, unknown>>(SAFETY_RATING_DATASET_ID, {
          $select: buildRatingSelectClause(),
          $where: `dot_number in (${chunk.join(',')})`,
          $limit: chunk.length,
        });
        ratingRowsRead += rows.length;
        for (const row of rows) {
          const dot = parseNonNegativeInteger(row.dot_number, 'dot_number');
          const rating = mapSafetyRatingCode(row.safety_rating);
          const ratingDate = parseFmcsaCompactDate(row.safety_rating_date);
          await client.query(
            'update staging_safety set safety_rating = $2, safety_rating_date = $3::date where dot_number = $1',
            [dot, rating, ratingDate]
          );
        }
      }
    }

    const expectedRows = options.maxPages
      ? Math.min(totalSourceRows, options.maxPages * pageSize)
      : totalSourceRows;
    if (rowsRead !== expectedRows) {
      throw new Error(`Safety paging completeness failed: read ${rowsRead} rows, expected ${expectedRows}`);
    }
    const finalSourceRows = await socrata.count(SAFETY_DATASET_ID);
    if (finalSourceRows !== totalSourceRows) {
      throw new Error(
        `Safety source changed during the pull (${totalSourceRows} -> ${finalSourceRows}); retry next run`
      );
    }

    const validationResult = await client.query(`
      select
        count(*)::int as staged_rows,
        count(distinct dot_number)::int as unique_dots,
        count(*) filter (where driver_oos_24mo > driver_insp_24mo)::int as invalid_driver_oos,
        count(*) filter (where vehicle_oos_24mo > vehicle_insp_24mo)::int as invalid_vehicle_oos,
        count(*) filter (where driver_insp_24mo > inspections_24mo or vehicle_insp_24mo > inspections_24mo)::int as invalid_inspection_totals,
        min(inspections_24mo)::int as min_inspections,
        max(inspections_24mo)::int as max_inspections,
        count(*) filter (where safety_rating is not null)::int as rated_rows
      from staging_safety
    `);
    const validation = validationResult.rows[0] ?? {};
    if (
      Number(validation.invalid_driver_oos) > 0 ||
      Number(validation.invalid_vehicle_oos) > 0 ||
      Number(validation.invalid_inspection_totals) > 0 ||
      Number(validation.staged_rows) !== Number(validation.unique_dots)
    ) {
      throw new Error(`Safety staging validation failed: ${JSON.stringify(validation)}`);
    }

    if (options.dryRun) return { rowsUpserted: 0, validation };
    const upsert = await client.query(buildUpsertSql());
    return { rowsUpserted: upsert.rowCount ?? 0, validation };
  });

  ctx.log.info(options.dryRun ? 'sync-safety.dry_run_validated' : 'sync-safety.done', {
    datasetId: SAFETY_DATASET_ID,
    rowsRead,
    ratingRowsRead,
    rowsUpserted: result.rowsUpserted,
    pages: pageCount,
    validation: { ...result.validation, totalSourceRows, includeRatings },
  });

  return {
    datasetId: SAFETY_DATASET_ID,
    rowsRead,
    rowsUpserted: result.rowsUpserted,
    ratingRowsRead,
    dryRun: options.dryRun ?? false,
    validation: { ...result.validation, totalSourceRows, includeRatings },
  };
}
