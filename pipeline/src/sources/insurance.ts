import { bulkInsert, withStagingConnection, type PgPoolClient, type PipelineContext } from '../db.js';
import { DEFAULT_PAGE_SIZE, SOCRATA_DATASETS, SocrataClient } from '../socrata.js';

/**
 * sync-insurance: `qh9u-swkp` ("ActPendInsur -- All With History") -> append-only
 * `carrier_insurance_filings` -> nightly rollup into `carrier_insurance`'s current-state
 * columns (Part B §2.4, `carrier_insurance_filings` table per 01-architecture.md
 * reconciliation amendment #7).
 *
 * Column-name confidence (Task 2): MODERATE, better than 6eyk-hxee's (see authority.ts's
 * ⚠️R2 header) but still not a live-row confirmation. Part B §1.2 cites production-code
 * evidence for the exact field list below. Task 2 additionally found a search-engine-indexed
 * snippet of a crawled `qh9u-swkp` CSV header showing `ins_type_desc`, `max_cov_amount`, and
 * `cancl_effective_date` appearing together with a real example value ("BIPD/Primary") --
 * independent, if indirect, corroboration of those three specifically. The rest of the list
 * (`docket_number`, `name_company`, `ins_form_code`, `ins_class_code`, `policy_no`,
 * `min_cov_amount`, `underl_lim_amount`, `effective_date`, `trans_date`) is carried from Part
 * B's citation only -- not independently re-confirmed this session. See
 * ../COLUMN-VERIFICATION.md.
 *
 * `carrier_insurance_filings`'s full column list (beyond the amendment #7 natural key
 * `(dot_number, docket_number, policy_no, effective_date)`) is THIS FILE'S OWN PROPOSAL --
 * amendment #7 only names the natural key, not the rest of the table shape. Reconcile
 * `FILINGS_STAGING_DDL`'s shape with whatever the schema agent actually migrates.
 */

interface InsuranceFieldMapping {
  soda: string;
  column: string;
  sqlType: string;
  castExpr?: string;
}

const INSURANCE_FIELD_MAP: InsuranceFieldMapping[] = [
  // Part B §1.2: L&I dot_number is 8-char zero-padded TEXT -- cast to int/bigint to join
  // against census, never compare as a string.
  { soda: 'dot_number', column: 'dot_number', sqlType: 'bigint', castExpr: '%COL%::bigint' },
  { soda: 'docket_number', column: 'docket_number', sqlType: 'text' },
  { soda: 'name_company', column: 'insurer_name', sqlType: 'text' },
  { soda: 'ins_form_code', column: 'ins_form_code', sqlType: 'text' },
  { soda: 'ins_class_code', column: 'ins_class_code', sqlType: 'text' },
  { soda: 'ins_type_desc', column: 'ins_type_desc', sqlType: 'text' },
  { soda: 'policy_no', column: 'policy_no', sqlType: 'text' },
  // Coverage amounts arrive in THOUSANDS (Part B §1.2, "critical quirk", confirmed via
  // multiple codebases in Part B's own prior research) -- ×1000 to store real dollars.
  { soda: 'max_cov_amount', column: 'max_cov_amount_usd', sqlType: 'bigint', castExpr: "(nullif(%COL%, '')::numeric * 1000)::bigint" },
  { soda: 'min_cov_amount', column: 'min_cov_amount_usd', sqlType: 'bigint', castExpr: "(nullif(%COL%, '')::numeric * 1000)::bigint" },
  { soda: 'underl_lim_amount', column: 'underl_lim_amount_usd', sqlType: 'bigint', castExpr: "(nullif(%COL%, '')::numeric * 1000)::bigint" },
  { soda: 'effective_date', column: 'effective_date', sqlType: 'date' },
  { soda: 'cancl_effective_date', column: 'cancl_effective_date', sqlType: 'date' },
  { soda: 'trans_date', column: 'trans_date', sqlType: 'date' },
];

function uniqueSodaFields(): string[] {
  return Array.from(new Set(INSURANCE_FIELD_MAP.map((f) => f.soda)));
}

export function buildSelectClause(): string {
  return uniqueSodaFields().join(',');
}

/**
 * Part B §2.4: "keep ins_type_desc ILIKE 'BIPD%' rows for known DOTs". Applied server-side in
 * the $where -- narrows the pull itself, not just a local filter, saving bandwidth. Uses
 * plain (case-sensitive) `like`, not `ilike`: SoQL's documented operator set includes `like`;
 * `ilike` is a PostgreSQL-ism not confirmed to exist in SoQL, and risking an unsupported
 * operator failing the whole query is worse than a case-sensitive match against a value
 * ("BIPD/Primary") that Task 2's research found consistently capitalized in the one real
 * example observed. `buildRollupSql()` below re-applies the filter with a real Postgres
 * `ilike` against the already-landed data, so casing drift can't silently exclude a filing
 * from the rollup even if it does get past this SoQL-level prefilter.
 */
export function buildWhereClause(): string {
  return "ins_type_desc like 'BIPD%'";
}

function castedExpr(f: InsuranceFieldMapping): string {
  const col = `sc."${f.soda}"`;
  if (f.castExpr) return f.castExpr.replaceAll('%COL%', col);
  return `nullif(${col}, '')::${f.sqlType}`;
}

function buildStagingDdl(): string {
  const cols = uniqueSodaFields()
    .map((f) => `  "${f}" text`)
    .join(',\n');
  return `
create temp table staging_insurance (
${cols},
  "raw" jsonb
) on commit drop;
  `.trim();
}

/**
 * Append/upsert into the natural-key filings ledger. TODO(live-db): Postgres unique
 * constraints treat NULL as distinct from every other value, including another NULL -- if
 * `docket_number` or `policy_no` is ever legitimately NULL on a BIPD filing, ON CONFLICT
 * won't dedupe those rows against each other and they'll accumulate as "new" filings on every
 * re-run. Not fixed here (would need the schema agent's natural-key columns to be NOT NULL,
 * or a coalesced generated column for the constraint) -- flagged, not silently worked around.
 */
export function buildFilingsUpsertSql(): string {
  const cols = [
    ...INSURANCE_FIELD_MAP.map((f) => ({ column: f.column, selectExpr: castedExpr(f) })),
    { column: 'raw', selectExpr: 'sc."raw"' },
    { column: 'synced_at', selectExpr: 'now()' },
  ];
  const columnList = cols.map((c) => `"${c.column}"`).join(', ');
  const selectList = cols.map((c) => c.selectExpr).join(',\n       ');
  const nonKeyCols = cols
    .map((c) => c.column)
    .filter((c) => !['dot_number', 'docket_number', 'policy_no', 'effective_date'].includes(c));
  const setClauses = nonKeyCols.map((c) => `"${c}" = excluded."${c}"`).join(',\n    ');

  return `
insert into public.carrier_insurance_filings (${columnList})
select ${selectList}
from staging_insurance sc
where exists (select 1 from public.carriers c where c.dot_number = sc."dot_number"::bigint)
on conflict (dot_number, docket_number, policy_no, effective_date) do update set
    ${setClauses};
  `.trim();
}

/**
 * Nightly rollup (Part B §2.4): "bipd_on_file_usd = max_cov_amount::int * 1000 of the policy
 * in effect, bipd_cancel_date = min(cancl_effective_date > today)". Recomputes from the FULL
 * `carrier_insurance_filings` history every run (not just today's delta) -- filings are a
 * comparatively small, TX-scoped table (Part B §1.2: ~468k rows nationally before any
 * filtering), so a full recompute is cheap and avoids partial-update staleness bugs. Scope it
 * to just-touched dot_numbers later only if this ever shows up as a real bottleneck.
 *
 * TODO(live-db): this is a plain UPDATE (no INSERT branch) -- a dot_number with filings but
 * no existing `carrier_insurance` row (e.g. authority's pull hasn't seen it yet, or never
 * will) is silently skipped rather than backfilled. sync-authority runs earlier in the
 * nightly chain (§2.1) so this should be rare in steady state; worth an explicit check the
 * first time this runs for real.
 */
export function buildRollupSql(): string {
  return `
with bipd_current as (
  select distinct on (f.dot_number)
    f.dot_number, f.max_cov_amount_usd, f.effective_date
  from public.carrier_insurance_filings f
  where f.ins_type_desc ilike 'BIPD%'
    and f.effective_date <= current_date
    and (f.cancl_effective_date is null or f.cancl_effective_date > current_date)
  order by f.dot_number, f.effective_date desc
),
bipd_next_cancel as (
  select f.dot_number, min(f.cancl_effective_date) as bipd_cancel_date
  from public.carrier_insurance_filings f
  where f.ins_type_desc ilike 'BIPD%'
    and f.cancl_effective_date is not null
    and f.cancl_effective_date > current_date
  group by f.dot_number
),
rollup as (
  select
    coalesce(bc.dot_number, nc.dot_number) as dot_number,
    bc.max_cov_amount_usd,
    bc.effective_date,
    nc.bipd_cancel_date
  from bipd_current bc
  full outer join bipd_next_cancel nc on nc.dot_number = bc.dot_number
)
update public.carrier_insurance ci
set bipd_on_file = coalesce(r.max_cov_amount_usd, ci.bipd_on_file),
    insurance_effective_date = coalesce(r.effective_date, ci.insurance_effective_date),
    bipd_cancel_date = r.bipd_cancel_date,
    last_synced_at = now()
from rollup r
where r.dot_number = ci.dot_number;
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

export interface InsuranceSyncOptions {
  maxPages?: number;
  pageSize?: number;
}

export interface InsuranceSyncResult {
  rowsRead: number;
  filingsUpserted: number;
  carriersRolledUp: number;
}

export async function syncInsurance(
  ctx: PipelineContext,
  socrata: SocrataClient,
  options: InsuranceSyncOptions = {}
): Promise<InsuranceSyncResult> {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const sodaFields = uniqueSodaFields();
  const stagingColumns = [...sodaFields, 'raw'];

  let rowsRead = 0;
  let pageCount = 0;

  const { filingsUpserted, carriersRolledUp } = await withStagingConnection(
    ctx.pg,
    buildStagingDdl(),
    async (client: PgPoolClient) => {
      for await (const page of socrata.paginateOffset<Record<string, string>>(
        SOCRATA_DATASETS.LI_ACT_PEND_INSUR,
        { $select: buildSelectClause(), $where: buildWhereClause() },
        pageSize
      )) {
        pageCount += 1;
        rowsRead += page.length;

        const rows = page.map((row) => mapRowToStagingTuple(row, sodaFields));
        await bulkInsert(client, 'staging_insurance', stagingColumns, rows, 2000);

        ctx.log.info('sync-insurance.page', { page: pageCount, pageRows: page.length, rowsRead });

        if (options.maxPages && pageCount >= options.maxPages) {
          ctx.log.warn('sync-insurance.capped', { maxPages: options.maxPages });
          break;
        }
      }

      const filingsResult = await client.query(buildFilingsUpsertSql());
      const rollupResult = await client.query(buildRollupSql());
      return {
        filingsUpserted: filingsResult.rowCount ?? 0,
        carriersRolledUp: rollupResult.rowCount ?? 0,
      };
    }
  );

  ctx.log.info('sync-insurance.done', { rowsRead, filingsUpserted, carriersRolledUp, pages: pageCount });
  return { rowsRead, filingsUpserted, carriersRolledUp };
}
