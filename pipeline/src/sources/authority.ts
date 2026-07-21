import { bulkInsert, withStagingConnection, type PgPoolClient, type PipelineContext } from '../db.js';
import { DEFAULT_PAGE_SIZE, SOCRATA_DATASETS, SocrataClient } from '../socrata.js';

/**
 * sync-authority: `6eyk-hxee` ("Carrier -- All With History") -> rolled into
 * `carrier_insurance` (Part B §2.4, as merged by 01-architecture.md reconciliation amendment
 * #7: "Part B's carrier_authority merges INTO carrier_insurance (no separate table)").
 *
 * ============================================================================================
 * ⚠️R2 STATUS -- RESOLVED against live Socrata metadata + sample rows on 2026-07-21:
 * ============================================================================================
 * The first production run proved the earlier guessed names wrong with a Socrata 400. A live
 * `/api/views/6eyk-hxee` metadata probe and token-authenticated sample then confirmed the exact
 * fields: `dot_number`, `common_stat`, `contract_stat`, `broker_stat`, and `min_cov_amount`.
 * Status values are compact codes (`A`, `I`, `N`, with `P` handled defensively), not words.
 * `min_cov_amount` is a zero-padded dollar string and is stored directly, without the earlier
 * unverified ×1000 transform. AUTHORITY_FIELD_MAP below is now the verified runtime contract.
 *
 * ============================================================================================
 * Division of labor with sync-insurance (deliberate, not from a single literal spec line):
 * ============================================================================================
 * Part B §1.2 describes 6eyk-hxee as itself carrying "BIPD/cargo/bond insurance
 * required-vs-on-file" summary fields, which could tempt writing bipd_on_file/cargo_on_file/
 * bond_on_file from here too. But §2.4 explicitly assigns the CURRENT-STATE bipd_on_file
 * computation to sync-insurance's rollup over qh9u-swkp's policy-level filings
 * ("bipd_on_file_usd = max_cov_amount::int * 1000 of the policy in effect"). Having two jobs
 * both write the same columns from two different sources in the same nightly chain is a race
 * with no clear winner (whichever runs later silently overwrites the other with a
 * differently-derived number). So: this file writes ONLY authority statuses + `bipd_required`
 * (the regulatory minimum, not a policy-derived figure) + `authority_raw`; sync-insurance
 * (which runs after this step in the nightly chain, §2.1) owns bipd_on_file/cargo_on_file/
 * bond_on_file/bipd_cancel_date/insurance_effective_date exclusively. If 6eyk-hxee's real
 * on-file summary fields turn out more reliable than the qh9u-swkp rollup once both are
 * inspected on day 1, that's a deliberate follow-up change, not something to silently do here.
 */

interface AuthorityFieldMapping {
  soda: string;
  column: string;
  sqlType: string;
  castExpr?: string;
  verified: boolean;
}

function authorityStatusCastExpr(col: string): string {
  return `(case upper(btrim(coalesce(${col}, '')))
      when 'A' then 'active'
      when 'ACTIVE' then 'active'
      when 'I' then 'inactive'
      when 'INACTIVE' then 'inactive'
      when 'N' then 'none'
      when 'NONE' then 'none'
      when 'P' then 'pending'
      when 'PENDING' then 'pending'
      else 'unknown'
    end)::authority_status`;
}

const AUTHORITY_FIELD_MAP: AuthorityFieldMapping[] = [
  // Live metadata + rows verified 2026-07-21. DOT is 8-char zero-padded TEXT; join by
  // casting to bigint, never by string equality against census.
  { soda: 'dot_number', column: 'dot_number', sqlType: 'bigint', castExpr: '%COL%::bigint', verified: true },
  {
    soda: 'common_stat',
    column: 'common_status',
    sqlType: 'authority_status',
    castExpr: authorityStatusCastExpr('%COL%'),
    verified: true,
  },
  {
    soda: 'contract_stat',
    column: 'contract_status',
    sqlType: 'authority_status',
    castExpr: authorityStatusCastExpr('%COL%'),
    verified: true,
  },
  {
    soda: 'broker_stat',
    column: 'broker_status',
    sqlType: 'authority_status',
    castExpr: authorityStatusCastExpr('%COL%'),
    verified: true,
  },
  // Live dataset field is MIN_COV_AMOUNT. Values are zero-padded dollar amounts (for example,
  // 00000), so store the parsed amount directly; do not apply the earlier unverified ×1000.
  {
    soda: 'min_cov_amount',
    column: 'bipd_required',
    sqlType: 'bigint',
    castExpr: "nullif(%COL%, '')::numeric::bigint",
    verified: true,
  },
];

function uniqueSodaFields(): string[] {
  return Array.from(new Set(AUTHORITY_FIELD_MAP.map((f) => f.soda)));
}

export function buildSelectClause(): string {
  return uniqueSodaFields().join(',');
}

function castedExpr(f: AuthorityFieldMapping): string {
  const col = `sc."${f.soda}"`;
  if (f.castExpr) return f.castExpr.replaceAll('%COL%', col);
  return `nullif(${col}, '')::${f.sqlType}`;
}

function buildStagingDdl(): string {
  const cols = uniqueSodaFields()
    .map((f) => `  "${f}" text`)
    .join(',\n');
  return `
create temp table staging_authority (
${cols},
  "authority_raw" jsonb,
  primary key ("dot_number")
) on commit drop;
  `.trim();
}

/**
 * TODO(live-db): assumes `carrier_insurance` (Part A §2.4) already has rows for every known
 * dot_number (it's a 1:1 satellite of `carriers`, FK'd `on delete cascade`) OR that inserting
 * a new row here ahead of `carriers` having one is fine. Since carrier_insurance.dot_number
 * has `references public.carriers(dot_number)`, an authority row for a DOT sync-census hasn't
 * written yet (out-of-TX carrier appearing in a national authority pull, for instance) WILL
 * fail the FK constraint -- hence the staging-side filter to known carriers below, per Part B
 * §2.4 ("filter in-worker to DOTs present in carriers").
 */
export function buildUpsertSql(): string {
  const cols = [
    { column: 'dot_number', selectExpr: 'sc."dot_number"::bigint' },
    ...AUTHORITY_FIELD_MAP.filter((f) => f.column !== 'dot_number').map((f) => ({
      column: f.column,
      selectExpr: castedExpr(f),
    })),
    { column: 'authority_raw', selectExpr: 'sc."authority_raw"' },
    { column: 'last_synced_at', selectExpr: 'now()' },
  ];
  const columnList = cols.map((c) => `"${c.column}"`).join(', ');
  const selectList = cols.map((c) => c.selectExpr).join(',\n       ');
  const setClauses = cols
    .filter((c) => c.column !== 'dot_number')
    .map((c) => `"${c.column}" = excluded."${c.column}"`)
    .join(',\n    ');

  return `
insert into public.carrier_insurance (${columnList})
select ${selectList}
from staging_authority sc
-- Part B §2.4: "filter in-worker to DOTs present in carriers" -- enforced here in SQL rather
-- than in JS so it stays correct even if a future caller skips the JS-side filter.
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

export interface AuthoritySyncOptions {
  maxPages?: number;
  pageSize?: number;
}

export interface AuthoritySyncResult {
  rowsRead: number;
  rowsUpserted: number;
}

export async function syncAuthority(
  ctx: PipelineContext,
  socrata: SocrataClient,
  options: AuthoritySyncOptions = {}
): Promise<AuthoritySyncResult> {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const sodaFields = uniqueSodaFields();
  const stagingColumns = [...sodaFields, 'authority_raw'];

  const unverified = AUTHORITY_FIELD_MAP.filter((field) => !field.verified).map((field) => field.soda);
  if (unverified.length > 0) {
    ctx.log.warn('sync-authority.unverified_columns', { columns: unverified });
  }

  let rowsRead = 0;
  let pageCount = 0;

  const { rowsUpserted } = await withStagingConnection(ctx.pg, buildStagingDdl(), async (client: PgPoolClient) => {
    // Offset paging (Part B §2.4: "~55 pages" -- not deep enough to need census's keyset
    // approach, and this dataset's identity/order column isn't confirmed yet anyway).
    for await (const page of socrata.paginateOffset<Record<string, string>>(
      SOCRATA_DATASETS.LI_CARRIER_ALL_WITH_HISTORY,
      { $select: buildSelectClause() },
      pageSize
    )) {
      pageCount += 1;
      rowsRead += page.length;

      const rows = page.map((row) => mapRowToStagingTuple(row, sodaFields));
      await bulkInsert(client, 'staging_authority', stagingColumns, rows, 2000);

      ctx.log.info('sync-authority.page', { page: pageCount, pageRows: page.length, rowsRead });

      if (options.maxPages && pageCount >= options.maxPages) {
        ctx.log.warn('sync-authority.capped', { maxPages: options.maxPages });
        break;
      }
    }

    const result = await client.query(buildUpsertSql());
    return { rowsUpserted: result.rowCount ?? 0 };
  });

  ctx.log.info('sync-authority.done', { rowsRead, rowsUpserted, pages: pageCount });
  return { rowsRead, rowsUpserted };
}
