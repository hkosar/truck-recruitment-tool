import { bulkInsert, withStagingConnection, type PgPoolClient, type PipelineContext } from '../db.js';
import { DEFAULT_PAGE_SIZE, SOCRATA_DATASETS, SocrataClient } from '../socrata.js';

/**
 * sync-safety (monthly, day 5 per Part B §2.4/§6.3): SMS census snapshot -> `carrier_safety`
 * (PK `dot_number` + `snapshot_month`, amendment #7).
 *
 * ============================================================================================
 * ⚠️R3 STATUS -- dataset choice itself is unresolved, not just column names:
 * ============================================================================================
 * Part B §1.3 picks `4y6x-dmck` ("SMS AB PassProperty") as primary with `sjpe-nzai`
 * ("CSMS/SMS Raw Data") as fallback, explicitly flagged ⚠️R3: "probe both once; keep
 * whichever is row-queryable by dot_number with the standard SMS carrier columns." Task 2
 * could not resolve this -- every data.transportation.gov/dev.socrata.com fetch attempt
 * returned HTTP 403 this session, and no GitHub-indexed ingest code was found that queries
 * either `4y6x-dmck` or `sjpe-nzai` by name (unlike az4n-8mr2/qh9u-swkp, which several public
 * repos ingest directly). `SAFETY_DATASET_ID` below defaults to `4y6x-dmck` per Part B's own
 * pick; `syncSafety`'s `options.datasetId` exists specifically so the R3 probe can be re-run
 * with `sjpe-nzai` without touching this file's logic.
 *
 * ============================================================================================
 * NOTEWORTHY Task 2 finding -- safety_rating may not need this dataset at all:
 * ============================================================================================
 * kshivam4781/FMCSA-SOI-Data's actual census (az4n-8mr2) field list -- the same source Task 2
 * used to confirm the crgo_* spellings and mailing-address columns -- ALSO lists
 * `safety_rating`, `safety_rating_date`, `review_id`, `review_type`, `review_date` as CENSUS
 * fields, not SMS-dataset fields. If that holds up on a live probe, `carrier_safety.
 * safety_rating`/`safety_rating_date` could be sourced straight from the DAILY census pull
 * (sync-census, fresher than this monthly job) instead of, or in addition to, whatever this
 * SMS dataset carries. This file still writes safety_rating from the SMS pull (matching Part
 * B's original design and carrier_safety's monthly cadence) rather than silently
 * redesigning sync-census around an unconfirmed finding -- but this is a real simplification
 * opportunity worth a deliberate decision once R3 is probed for real, not busywork. See
 * ../COLUMN-VERIFICATION.md.
 *
 * Every SODA field name below is UNVERIFIED -- carried from Part B §1.3's own citation
 * ("Standard SMS carrier-file columns (confirmed across several ingesting codebases):
 * insp_total, driver_insp_total, driver_oos_insp_total, vehicle_insp_total,
 * vehicle_oos_insp_total, unsafe_driv_insp_w_viol, ... plus crash totals"), not
 * independently re-confirmed this session. Crash-total field names specifically were never
 * spelled out anywhere Task 2 could find -- CRASH_FIELD_MAP's names below are this pipeline's
 * best-guess pattern-matching off the confirmed inspection-field naming convention.
 */

export const SAFETY_DATASET_ID = SOCRATA_DATASETS.SMS_AB_PASSPROPERTY;
export const SAFETY_DATASET_FALLBACK_ID = SOCRATA_DATASETS.SMS_RAW_FALLBACK;

interface SafetyFieldMapping {
  soda: string;
  column: string;
  sqlType: string;
  castExpr?: string;
  verified: boolean;
}

const SAFETY_FIELD_MAP: SafetyFieldMapping[] = [
  { soda: 'dot_number', column: 'dot_number', sqlType: 'bigint', castExpr: '%COL%::bigint', verified: false },
  { soda: 'insp_total', column: 'inspections_24mo', sqlType: 'int', verified: true },
  { soda: 'driver_insp_total', column: 'driver_insp_24mo', sqlType: 'int', verified: true },
  { soda: 'driver_oos_insp_total', column: 'driver_oos_24mo', sqlType: 'int', verified: true },
  { soda: 'vehicle_insp_total', column: 'vehicle_insp_24mo', sqlType: 'int', verified: true },
  { soda: 'vehicle_oos_insp_total', column: 'vehicle_oos_24mo', sqlType: 'int', verified: true },
  // Guessed by analogy to the confirmed inspection-field naming convention -- not cited
  // anywhere Task 2 could find. Confirm against a live row before trusting these specifically.
  { soda: 'crash_total', column: 'crash_total_24mo', sqlType: 'int', verified: false },
  { soda: 'crash_fatal', column: 'crash_fatal_24mo', sqlType: 'int', verified: false },
  { soda: 'crash_injury', column: 'crash_injury_24mo', sqlType: 'int', verified: false },
  { soda: 'crash_tow', column: 'crash_tow_24mo', sqlType: 'int', verified: false },
  // See the "NOTEWORTHY Task 2 finding" header note -- may end up sourced from census instead.
  { soda: 'safety_rating', column: 'safety_rating', sqlType: 'text', verified: false },
  { soda: 'safety_rating_date', column: 'safety_rating_date', sqlType: 'date', verified: false },
];

function uniqueSodaFields(): string[] {
  return Array.from(new Set(SAFETY_FIELD_MAP.map((f) => f.soda)));
}

export function buildSelectClause(): string {
  return uniqueSodaFields().join(',');
}

function castedExpr(f: SafetyFieldMapping): string {
  const col = `sc."${f.soda}"`;
  if (f.castExpr) return f.castExpr.replaceAll('%COL%', col);
  return `nullif(${col}, '')::${f.sqlType}`;
}

function buildStagingDdl(): string {
  const cols = uniqueSodaFields()
    .map((f) => `  "${f}" text`)
    .join(',\n');
  return `
create temp table staging_safety (
${cols},
  "raw" jsonb
) on commit drop;
  `.trim();
}

/**
 * OOS rates computed in SQL from the just-cast totals (not trusted from any source field --
 * Part B §2.4: "we compute driver_oos_rate = driver_oos/driver_insp, vehicle_oos_rate =
 * vehicle_oos/vehicle_insp"), stored as a percent 0-100 to match Part A's
 * `numeric(5,2)` columns and the warning thresholds' own "> 34" / "> 10" percent-point form
 * (01-architecture.md §3, `internal.warning_reasons`).
 */
function oosRateExpr(oosCol: string, totalCol: string): string {
  return `(case when nullif(${totalCol}, 0) is null then null
      else round((${oosCol}::numeric / ${totalCol}::numeric) * 100, 2)
    end)`;
}

/**
 * TODO(live-db): assumes `carrier_safety` (Part A §2.4 + amendment #7's `snapshot_month`
 * column) already has the exact column names used below. `snapshot_month` is set to the
 * first-of-month for the run date, matching amendment #7's "latest snapshot only" contract
 * (this upsert always overwrites the prior snapshot, it doesn't append history).
 */
export function buildUpsertSql(): string {
  const castCols = SAFETY_FIELD_MAP.filter((f) => f.column !== 'dot_number').map((f) => ({
    column: f.column,
    selectExpr: castedExpr(f),
  }));

  const driverOos = castCols.find((c) => c.column === 'driver_oos_24mo');
  const driverInsp = castCols.find((c) => c.column === 'driver_insp_24mo');
  const vehicleOos = castCols.find((c) => c.column === 'vehicle_oos_24mo');
  const vehicleInsp = castCols.find((c) => c.column === 'vehicle_insp_24mo');
  if (!driverOos || !driverInsp || !vehicleOos || !vehicleInsp) {
    // Guards the hand-maintained SAFETY_FIELD_MAP against a future rename silently breaking
    // the rate computation below instead of failing loudly at SQL-build time.
    throw new Error('buildUpsertSql: SAFETY_FIELD_MAP is missing an OOS/inspection column the rate formulas depend on');
  }

  const cols = [
    { column: 'dot_number', selectExpr: 'sc."dot_number"::bigint' },
    ...castCols,
    { column: 'driver_oos_rate', selectExpr: oosRateExpr(`(${driverOos.selectExpr})`, `(${driverInsp.selectExpr})`) },
    { column: 'vehicle_oos_rate', selectExpr: oosRateExpr(`(${vehicleOos.selectExpr})`, `(${vehicleInsp.selectExpr})`) },
    { column: 'snapshot_month', selectExpr: "date_trunc('month', current_date)::date" },
    { column: 'last_synced_at', selectExpr: 'now()' },
  ];
  const columnList = cols.map((c) => `"${c.column}"`).join(', ');
  const selectList = cols.map((c) => c.selectExpr).join(',\n       ');
  const setClauses = cols
    .filter((c) => c.column !== 'dot_number')
    .map((c) => `"${c.column}" = excluded."${c.column}"`)
    .join(',\n    ');

  return `
insert into public.carrier_safety (${columnList})
select ${selectList}
from staging_safety sc
where exists (select 1 from public.carriers c where c.dot_number = sc."dot_number"::bigint)
on conflict (dot_number) do update set
    ${setClauses};
  `.trim();
}

function mapRowToStagingTuple(row: Record<string, unknown>, sodaFields: readonly string[]): unknown[] {
  const values: unknown[] = sodaFields.map((f) => {
    const v = row[f];
    return v === undefined || v === null ? null : String(v);
  });
  values.push(JSON.stringify(row));
  return values;
}

export interface SafetySyncOptions {
  /** Override for the ⚠️R3 probe -- pass SAFETY_DATASET_FALLBACK_ID to try sjpe-nzai instead. */
  datasetId?: string;
  maxPages?: number;
  pageSize?: number;
}

export interface SafetySyncResult {
  datasetId: string;
  rowsRead: number;
  rowsUpserted: number;
}

export async function syncSafety(
  ctx: PipelineContext,
  socrata: SocrataClient,
  options: SafetySyncOptions = {}
): Promise<SafetySyncResult> {
  const datasetId = options.datasetId ?? SAFETY_DATASET_ID;
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const sodaFields = uniqueSodaFields();
  const stagingColumns = [...sodaFields, 'raw'];

  const unverified = SAFETY_FIELD_MAP.filter((f) => !f.verified).map((f) => f.column);
  ctx.log.warn('sync-safety.unverified_columns', {
    note: 'entire SMS field map is UNVERIFIED (⚠️R3) -- see this file\'s header comment',
    datasetId,
    columns: unverified,
  });

  let rowsRead = 0;
  let pageCount = 0;

  const { rowsUpserted } = await withStagingConnection(ctx.pg, buildStagingDdl(), async (client: PgPoolClient) => {
    for await (const page of socrata.paginateOffset<Record<string, string>>(
      datasetId,
      { $select: buildSelectClause() },
      pageSize
    )) {
      pageCount += 1;
      rowsRead += page.length;

      const rows = page.map((row) => mapRowToStagingTuple(row, sodaFields));
      await bulkInsert(client, 'staging_safety', stagingColumns, rows, 2000);

      ctx.log.info('sync-safety.page', { page: pageCount, pageRows: page.length, rowsRead });

      if (options.maxPages && pageCount >= options.maxPages) {
        ctx.log.warn('sync-safety.capped', { maxPages: options.maxPages });
        break;
      }
    }

    const result = await client.query(buildUpsertSql());
    return { rowsUpserted: result.rowCount ?? 0 };
  });

  ctx.log.info('sync-safety.done', { datasetId, rowsRead, rowsUpserted, pages: pageCount });
  return { datasetId, rowsRead, rowsUpserted };
}
