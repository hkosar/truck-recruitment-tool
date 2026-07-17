import { bulkInsert, withStagingConnection, type PgPoolClient, type PipelineContext } from '../db.js';
import { SOCRATA_DATASETS, SocrataClient } from '../socrata.js';

/**
 * sync-authority: `6eyk-hxee` ("Carrier -- All With History") -> rolled into
 * `carrier_insurance` (Part B §2.4, as merged by 01-architecture.md reconciliation amendment
 * #7: "Part B's carrier_authority merges INTO carrier_insurance (no separate table)").
 *
 * ============================================================================================
 * ⚠️R2 STATUS (Part B §7) -- STILL OPEN after Task 2's research pass, read before editing:
 * ============================================================================================
 * 6eyk-hxee's exact SODA column names are UNVERIFIED. Task 2 tried hard to confirm them --
 * every fetch attempt against data.transportation.gov, dev.socrata.com (including the Foundry
 * schema pages), and every fmcsa.dot.gov/li-public.fmcsa.dot.gov subdomain returned HTTP 403
 * this session (WAF blocking datacenter/proxy IPs; broader than the *.fmcsa.dot.gov-only
 * blocklist Part B §1 originally documented). GitHub code search corroborated the qh9u-swkp
 * (insurance) field names reasonably well (see insurance.ts) but turned up no repo that
 * queries 6eyk-hxee by its literal SODA field names. Search-engine results DID corroborate
 * the *semantics* -- three authority statuses (common/contract/broker), each valued
 * Active/Inactive/None, per FMCSA's public L&I documentation (li-public.fmcsa.dot.gov, only
 * reachable via indexed search snippets, not a direct fetch) -- but not the literal fieldName
 * spellings. Every `soda` value below is this pipeline's best-effort guess (Part B's own
 * hedge: "expect common_authority_status-style or close variants"), marked `verified: false`.
 *
 * DO NOT run this against production before executing the R2 probe Part B §7 already
 * prescribes:  GET /resource/6eyk-hxee.json?$limit=1   (with the X-App-Token header)
 * ...then rewriting AUTHORITY_FIELD_MAP's `soda` values from the real response keys. Everything
 * else here (paging, staging/upsert shape, retry, the division of labor with sync-insurance
 * below) is real and should not need to change once the field names are corrected.
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
  return `(case lower(btrim(coalesce(${col}, '')))
      when 'active' then 'active'
      when 'inactive' then 'inactive'
      when 'none' then 'none'
      when 'pending' then 'pending'
      else 'unknown'
    end)::authority_status`;
}

const AUTHORITY_FIELD_MAP: AuthorityFieldMapping[] = [
  // Part B §1.2: "dot_number in the L&I datasets is 8-char zero-padded TEXT -- join by
  // casting to int, never by string equality against census." Field NAME assumed consistent
  // with every other FMCSA Socrata dataset (census, qh9u-swkp) -- reasonable but unverified.
  { soda: 'dot_number', column: 'dot_number', sqlType: 'bigint', castExpr: '%COL%::bigint', verified: false },
  {
    soda: 'common_authority_status',
    column: 'common_status',
    sqlType: 'authority_status',
    castExpr: authorityStatusCastExpr('%COL%'),
    verified: false,
  },
  {
    soda: 'contract_authority_status',
    column: 'contract_status',
    sqlType: 'authority_status',
    castExpr: authorityStatusCastExpr('%COL%'),
    verified: false,
  },
  {
    soda: 'broker_authority_status',
    column: 'broker_status',
    sqlType: 'authority_status',
    castExpr: authorityStatusCastExpr('%COL%'),
    verified: false,
  },
  // DOLLARS. L&I publishes THOUSANDS -> ×1000 (Part A DDL comment, carried forward; not
  // independently re-verified against a live row this session).
  {
    soda: 'bipd_required_amount',
    column: 'bipd_required',
    sqlType: 'bigint',
    castExpr: "(nullif(%COL%, '')::numeric * 1000)::bigint",
    verified: false,
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
  const pageSize = options.pageSize ?? 50_000;
  const sodaFields = uniqueSodaFields();
  const stagingColumns = [...sodaFields, 'authority_raw'];

  ctx.log.warn('sync-authority.unverified_columns', {
    note: '6eyk-hxee column names are ⚠️R2 UNVERIFIED -- see this file\'s header comment',
    columns: AUTHORITY_FIELD_MAP.map((f) => f.soda),
  });

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
