import type { PipelineContext } from './db.js';
import { checkStaleness, type PipelineStep } from './runs.js';

/**
 * dq-report: fill-rate report + staleness watchdog (Part B §5, G10 "honest coverage").
 *
 * TODO(schema-drift): `data_quality_reports (run_date PK, metrics jsonb, created_at)` --
 * exactly like `pipeline_runs` (see runs.ts's header comment), this table is specified in
 * Part B §5 but absent from Part A's DDL (§2.4) and from amendment #7's added-table list.
 * Flag for the schema agent alongside `pipeline_runs`, `pipeline_config`, `zip_centroids`,
 * `city_centroids` -- this pipeline depends on a handful of tables Part A's migrations don't
 * yet define. Written here as if it already exists.
 *
 * Warning distribution deliberately does NOT reimplement `internal.warning_reasons`'s
 * threshold logic. Amendment #8 is explicit: warnings are "computed live by
 * internal.warning_reasons + view (D6 stands -- never stored); Part B computes only the
 * *inputs*." This file queries the same `public.carrier_warnings` view the app reads (Part A
 * §3) rather than recomputing thresholds -- one source of truth for what a warning even is.
 * It also reports against amendment #8's NINE-code closed vocabulary (carrier_inactive,
 * no_insurance, insurance_below_standard, insurance_expiring_30d, authority_not_active,
 * safety_rating, high_oos, recent_crashes, missing_from_source), not Part B §5's original
 * seven-code list -- whatever `internal.warning_reasons` actually returns is authoritative;
 * this file just tallies it.
 */

export interface FillRateMetrics {
  totalActive: number;
  phone: number;
  cellPhone: number;
  phoneOrCellPhone: number;
  email: number;
  companyOfficer1: number;
  cargoOtherDesc: number;
  bipdOnFile: number;
  safetySnapshot: number;
}

export interface WarningDistributionRow {
  code: string;
  carrierCount: number;
}

export interface GeocodePrecisionRow {
  precision: string;
  carrierCount: number;
}

export interface TopCargoValueRow {
  value: string;
  sampleRaw: string | null;
  carrierCount: number;
}

export interface FreshnessEntry {
  lastSuccessAt: string | null;
  stale: boolean;
}

export interface DqReportMetrics {
  runDate: string;
  fillRates: FillRateMetrics;
  distinctCargoValues: number;
  topCargoValues: TopCargoValueRow[];
  warningDistribution: WarningDistributionRow[];
  geocodePrecision: GeocodePrecisionRow[];
  freshness: Record<string, FreshnessEntry>;
}

/** Fill rates over the TX-active scope (amendment #13) -- the same "who can we actually
 *  contact / what does Tier-1 coverage look like" numbers Part B §5 + the M2.7 owner-facing
 *  coverage brief both need. `bipd_on_file`/`safety_snapshot` are EXISTS checks against the
 *  satellite tables rather than column nullity, since those live in carrier_insurance/
 *  carrier_safety, not on carriers itself. */
async function computeFillRates(ctx: PipelineContext): Promise<FillRateMetrics> {
  const sql = `
    select
      count(*) as total_active,
      count(*) filter (where c.phone is not null and c.phone <> '') as phone,
      count(*) filter (where c.cell_phone is not null and c.cell_phone <> '') as cell_phone,
      count(*) filter (
        where (c.phone is not null and c.phone <> '')
           or (c.cell_phone is not null and c.cell_phone <> '')
      ) as phone_or_cell,
      count(*) filter (where c.email_address is not null) as email,
      count(*) filter (where c.company_officer_1 is not null and c.company_officer_1 <> '') as company_officer_1,
      count(*) filter (where c.crgo_cargoothr_desc is not null) as cargo_other_desc,
      count(*) filter (
        where exists (
          select 1 from public.carrier_insurance ci
          where ci.dot_number = c.dot_number and coalesce(ci.bipd_on_file, 0) > 0
        )
      ) as bipd_on_file,
      count(*) filter (
        where exists (select 1 from public.carrier_safety cs where cs.dot_number = c.dot_number)
      ) as safety_snapshot
    from public.carriers c
    where c.phy_state = 'TX' and c.status_code = 'A'
  `.trim();

  const result = await ctx.pg.query(sql);
  const row = (result.rows[0] ?? {}) as Record<string, unknown>;
  const n = (key: string) => Number(row[key] ?? 0);
  return {
    totalActive: n('total_active'),
    phone: n('phone'),
    cellPhone: n('cell_phone'),
    phoneOrCellPhone: n('phone_or_cell'),
    email: n('email'),
    companyOfficer1: n('company_officer_1'),
    cargoOtherDesc: n('cargo_other_desc'),
    bipdOnFile: n('bipd_on_file'),
    safetySnapshot: n('safety_snapshot'),
  };
}

async function computeDistinctCargoValues(ctx: PipelineContext): Promise<number> {
  const result = await ctx.pg.query('select count(*) as n from public.cargo_other_values');
  return Number((result.rows[0] as Record<string, unknown> | undefined)?.n ?? 0);
}

async function computeTopCargoValues(ctx: PipelineContext, limit = 50): Promise<TopCargoValueRow[]> {
  const sql = `
    select value, sample_raw, carrier_count_tx as carrier_count
    from public.cargo_other_values
    order by carrier_count_tx desc, value asc
    limit $1
  `.trim();
  const result = await ctx.pg.query(sql, [limit]);
  return result.rows.map((r: Record<string, unknown>) => ({
    value: String(r.value),
    sampleRaw: (r.sample_raw as string | null) ?? null,
    carrierCount: Number(r.carrier_count ?? 0),
  }));
}

async function computeWarningDistribution(ctx: PipelineContext): Promise<WarningDistributionRow[]> {
  const sql = `
    select code, count(*) as carrier_count
    from public.carrier_warnings cw
    join public.carriers c on c.dot_number = cw.dot_number
    cross join lateral unnest(cw.warning_reasons) as code
    where c.phy_state = 'TX' and c.status_code = 'A'
    group by code
    order by carrier_count desc
  `.trim();
  const result = await ctx.pg.query(sql);
  return result.rows.map((r: Record<string, unknown>) => ({
    code: String(r.code),
    carrierCount: Number(r.carrier_count ?? 0),
  }));
}

async function computeGeocodePrecision(ctx: PipelineContext): Promise<GeocodePrecisionRow[]> {
  const sql = `
    select geocode_precision::text as precision, count(*) as carrier_count
    from public.carriers
    where phy_state = 'TX' and status_code = 'A'
    group by geocode_precision
    order by carrier_count desc
  `.trim();
  const result = await ctx.pg.query(sql);
  return result.rows.map((r: Record<string, unknown>) => ({
    precision: String(r.precision),
    carrierCount: Number(r.carrier_count ?? 0),
  }));
}

/** Nightly steps get a 48h ceiling (Part B §2.5's literal example). sync-safety is monthly
 *  (§2.4/§6.3) -- a 48h ceiling on it would false-alarm every single night, so it gets a
 *  40-day ceiling instead (comfortably longer than the ~30-day cadence, short enough to still
 *  catch a genuinely broken monthly job). */
const FRESHNESS_STEPS: Array<{ step: PipelineStep; maxAgeHours: number }> = [
  { step: 'sync-census', maxAgeHours: 48 },
  { step: 'sync-authority', maxAgeHours: 48 },
  { step: 'sync-insurance', maxAgeHours: 48 },
  { step: 'cargo-facets', maxAgeHours: 48 },
  { step: 'geocode', maxAgeHours: 48 },
  { step: 'sync-safety', maxAgeHours: 40 * 24 },
];

async function computeFreshness(ctx: PipelineContext): Promise<Record<string, FreshnessEntry>> {
  const entries = await Promise.all(
    FRESHNESS_STEPS.map(async ({ step, maxAgeHours }): Promise<[string, FreshnessEntry]> => {
      const { stale, lastSuccessAt } = await checkStaleness(ctx, step, maxAgeHours);
      return [step, { lastSuccessAt, stale }];
    })
  );
  return Object.fromEntries(entries);
}

async function writeDqReport(ctx: PipelineContext, metrics: DqReportMetrics): Promise<void> {
  const { error } = await ctx.supabase
    .from('data_quality_reports')
    .upsert({ run_date: metrics.runDate, metrics, created_at: new Date().toISOString() }, { onConflict: 'run_date' });
  if (error) {
    throw new Error(`writeDqReport: upsert into data_quality_reports failed: ${error.message}`);
  }
}

export async function runDqReport(ctx: PipelineContext): Promise<DqReportMetrics> {
  const [fillRates, distinctCargoValues, topCargoValues, warningDistribution, geocodePrecision, freshness] =
    await Promise.all([
      computeFillRates(ctx),
      computeDistinctCargoValues(ctx),
      computeTopCargoValues(ctx),
      computeWarningDistribution(ctx),
      computeGeocodePrecision(ctx),
      computeFreshness(ctx),
    ]);

  const metrics: DqReportMetrics = {
    runDate: new Date().toISOString().slice(0, 10),
    fillRates,
    distinctCargoValues,
    topCargoValues,
    warningDistribution,
    geocodePrecision,
    freshness,
  };

  await writeDqReport(ctx, metrics);

  ctx.log.info('dq-report.done', {
    runDate: metrics.runDate,
    totalActive: fillRates.totalActive,
    distinctCargoValues,
    warningCodes: warningDistribution.length,
    staleSteps: Object.entries(freshness)
      .filter(([, v]) => v.stale)
      .map(([k]) => k),
  });

  return metrics;
}
