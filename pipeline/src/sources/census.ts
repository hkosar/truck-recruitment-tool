import { bulkInsert, withStagingConnection, type PgPoolClient, type PipelineContext } from '../db.js';
import { SOCRATA_DATASETS, SocrataClient } from '../socrata.js';

/**
 * sync-census: full TX-active slice -> staging -> row-hash diff upsert (Part B §2.1-§2.3).
 *
 * ============================================================================================
 * DELIBERATE DEVIATION FROM Part B §1.1's LITERAL EXAMPLE -- read before changing the $where:
 * ============================================================================================
 * Part B §1.1 says "Scope decision: ingest ALL TX rows regardless of status_code (active +
 * inactive)" (~380-450k rows). But 01-architecture.md's reconciliation section -- which is
 * explicitly authoritative "wherever documents differ" -- amendment #13 overrides this:
 * "ingest scope = TX active carriers (status_code='A', ~150-220k rows)". This file implements
 * amendment #13 (`$where = phy_state='TX' AND status_code='A'`), NOT Part B §1.1's broader
 * example. This is still coherent with amendment #13's own next clause -- "carriers later
 * missing from the active slice keep their rows and trigger missing_from_source" -- because
 * the set-difference pass below (`buildSourceMissingSql`) operates against exactly this same
 * active-TX scope: a carrier that goes inactive, leaves TX, or deregisters simply stops
 * appearing in tomorrow's pull and gets flagged `source_missing_since`, without us ever
 * needing to re-pull inactive rows to know why. One real consequence: because we never
 * re-fetch a carrier once it drops out of the active slice, its `status_code` column freezes
 * at its last known value ('A') forever after that point -- the `missing_from_source` warning
 * is what actually signals "we no longer see this carrier," not a live status_code flip. This
 * matches the product's closed warning vocabulary (amendment #8) fine, just don't expect
 * status_code to be a reliable "did this carrier go inactive" signal on its own.
 *
 * ============================================================================================
 * OPEN TENSION -- Part A D2 ("census_raw = full 142-field record") vs Part B §1.1's
 * literal $select example ("~70-column list") -- NOT resolved by this file, flagged not hidden:
 * ============================================================================================
 * D2's whole justification for `census_raw jsonb` is "the F7 rich profile renders the long
 * tail without 142 columns" -- i.e. it expects the COMPLETE record. But Part B's own worked
 * `$select` example trims to the mapped subset for bandwidth ("50k keeps responses ~25-50MB").
 * `CENSUS_SELECT_COLUMNS` below currently matches Part B's trimmed-list approach (the
 * concrete, immediately actionable interpretation, and the one Task 2 could actually verify
 * field-by-field). If D2's "full record" promise is meant literally, the fix is a one-line
 * change: drop the `$select` param entirely (or select `*`) in `syncCensus`'s Socrata calls --
 * every other line of this file (the `census_raw` staging column, `JSON.stringify(row)`)
 * already works unmodified either way, since it just serializes whatever was fetched.
 *
 * ============================================================================================
 * Column-name contract (Task 2, ../COLUMN-VERIFICATION.md): entries below marked
 * `verified: false` are this pipeline's own reasonable guesses, not confirmed against a live
 * row or independent source this session -- re-check before this file's SQL runs for real.
 * ============================================================================================
 */

/** SODA `X` = checked, matching Part B §1.1's own cited code evidence (Wooohan/hussfix5ba:
 *  `val.strip().upper() == "X"`). Carried forward as CONFIRMED by Part B's prior research;
 *  not independently re-verified this session (no live row was fetchable -- see
 *  ../COLUMN-VERIFICATION.md), but Task 2 found no contradicting evidence either. */
const CRGO_TRUE_VALUE_CAST = "coalesce(%COL% = 'X', false)";

/** The canonical MCS-150 30-flag set. Order and spelling CONFIRMED in Task 2 via
 *  kshivam4781/FMCSA-SOI-Data's actual client source (`fmcsa_api_client.py`'s ALL_FIELDS
 *  list) -- notably `crgo_motoveh`, NOT `crgo_motorveh` (a web-wide code search for
 *  "crgo_motorveh" turned up zero hits anywhere; see ../COLUMN-VERIFICATION.md). */
const CRGO_FLAG_NAMES = [
  'crgo_genfreight', 'crgo_household', 'crgo_metalsheet', 'crgo_motoveh',
  'crgo_drivetow', 'crgo_logpole', 'crgo_bldgmat', 'crgo_mobilehome',
  'crgo_machlrg', 'crgo_produce', 'crgo_liqgas', 'crgo_intermodal',
  'crgo_passengers', 'crgo_oilfield', 'crgo_livestock', 'crgo_grainfeed',
  'crgo_coalcoke', 'crgo_meat', 'crgo_garbage', 'crgo_usmail',
  'crgo_chem', 'crgo_drybulk', 'crgo_coldfood', 'crgo_beverages',
  'crgo_paperprod', 'crgo_utility', 'crgo_farmsupp', 'crgo_construct',
  'crgo_waterwell', 'crgo_cargoothr',
] as const;

interface CensusFieldMapping {
  /** Exact SODA fieldName in az4n-8mr2. */
  soda: string;
  /** Destination column in public.carriers (post reconciliation #1/#7 renames). */
  column: string;
  /** Documented Postgres type -- always present even when `castExpr` overrides the actual
   *  generated cast, for readability/cross-reference with the carriers DDL. */
  sqlType: string;
  /** Full cast expression; `%COL%` is replaced with the schema-qualified staging column ref.
   *  Default when omitted: `nullif(%COL%, '')::<sqlType>`. */
  castExpr?: string;
  /** false = this pipeline's own assumption, not confirmed this session -- see
   *  ../COLUMN-VERIFICATION.md. */
  verified: boolean;
}

const CENSUS_FIELD_MAP: CensusFieldMapping[] = [
  { soda: 'dot_number', column: 'dot_number', sqlType: 'bigint', verified: true },
  { soda: 'legal_name', column: 'legal_name', sqlType: 'text', verified: true },
  { soda: 'dba_name', column: 'dba_name', sqlType: 'text', verified: true },
  { soda: 'status_code', column: 'status_code', sqlType: 'text', verified: true },
  // Field name CONFIRMED (used literally in 3 independent production repos, Task 2). Value
  // DOMAIN unverified -- Part B guessed A/B/C codes (⚠️R5); no live row could be sampled this
  // session (see ../COLUMN-VERIFICATION.md), so no cast beyond nullif/text is applied here.
  { soda: 'carrier_operation', column: 'carrier_operation', sqlType: 'text', verified: true },
  // Field name CONFIRMED. Value domain: multi-word descriptive strings confirmed (production
  // code filters `classdef LIKE '%BROKER%'`/`NOT LIKE '%FORWARDER%'`), and FMCSA's public
  // Operation Classification categories are well documented ("Authorized For Hire", "Exempt
  // For Hire", "Private (Property)", ...) -- but the li-public.fmcsa.dot.gov glossary that
  // would confirm exact casing/spacing was unreachable (403) this session. Treat the *field
  // name* as solid, the *exact string spellings* as still open -- see
  // ../COLUMN-VERIFICATION.md before writing anything that pattern-matches classdef values.
  { soda: 'classdef', column: 'classdef', sqlType: 'text', verified: true },
  { soda: 'add_date', column: 'fmcsa_add_date', sqlType: 'date', verified: true },
  { soda: 'mcs150_date', column: 'mcs150_date', sqlType: 'date', verified: true },
  { soda: 'mcs150_mileage', column: 'mcs150_mileage', sqlType: 'bigint', verified: true },
  { soda: 'mcs150_mileage_year', column: 'mcs150_mileage_year', sqlType: 'int', verified: true },
  // 'Y' encoding CONFIRMED for hm_ind specifically by Part B's own citation; carried forward.
  { soda: 'hm_ind', column: 'hm_ind', sqlType: 'boolean', castExpr: "%COL% = 'Y'", verified: true },
  // 'Y'/blank encoding ASSUMED by analogy to hm_ind -- Part B's table didn't cite direct
  // evidence for this one specifically. Confirm against a live row before relying on it.
  {
    soda: 'prior_revoke_flag',
    column: 'prior_revoke_flag',
    sqlType: 'boolean',
    castExpr: "%COL% = 'Y'",
    verified: false,
  },
  { soda: 'prior_revoke_dot_number', column: 'prior_revoke_dot_number', sqlType: 'bigint', verified: true },
  { soda: 'recordable_crash_rate', column: 'recordable_crash_rate', sqlType: 'numeric', verified: true },
  { soda: 'dun_bradstreet_no', column: 'duns_number', sqlType: 'text', verified: true },
  { soda: 'phy_street', column: 'phy_street', sqlType: 'text', verified: true },
  { soda: 'phy_city', column: 'phy_city', sqlType: 'text', verified: true },
  { soda: 'phy_state', column: 'phy_state', sqlType: 'text', verified: true },
  { soda: 'phy_zip', column: 'phy_zip', sqlType: 'text', verified: true },
  // Derived from the same source field as phy_zip -- amendment #7's phy_zip5 addition.
  {
    soda: 'phy_zip',
    column: 'phy_zip5',
    sqlType: 'text',
    castExpr: "nullif(left(%COL%, 5), '')",
    verified: true,
  },
  { soda: 'phy_cnty', column: 'phy_county', sqlType: 'text', verified: true },
  // Mailing fields: street/zip field names carried from Part B's original citation;
  // city/state CONFIRMED this session (Task 2 -- kshivam4781/FMCSA-SOI-Data ALL_FIELDS list
  // *and* its get_ca_companies.py script actually SELECTing carrier_mailing_city /
  // carrier_mailing_zip). This resolves Part B's own ⚠️R5 on the mailing city/state names.
  { soda: 'carrier_mailing_street', column: 'mail_street', sqlType: 'text', verified: true },
  { soda: 'carrier_mailing_city', column: 'mail_city', sqlType: 'text', verified: true },
  { soda: 'carrier_mailing_state', column: 'mail_state', sqlType: 'text', verified: true },
  { soda: 'carrier_mailing_zip', column: 'mail_zip', sqlType: 'text', verified: true },
  { soda: 'phone', column: 'phone', sqlType: 'text', verified: true },
  { soda: 'cell_phone', column: 'cell_phone', sqlType: 'text', verified: true },
  { soda: 'fax', column: 'fax', sqlType: 'text', verified: true },
  // citext per amendment #7 ("Extensions migration adds citext (used by email_address)").
  { soda: 'email_address', column: 'email_address', sqlType: 'citext', castExpr: "nullif(lower(btrim(%COL%)), '')::citext", verified: true },
  // Contact-person fields: reconciliation #1 is explicit that these land in
  // company_officer_1/2 (the canonical carriers columns), NOT Part B's original
  // `contact_name_1/2` alias. Field names CONFIRMED (3 independent repos, Task 2).
  { soda: 'company_officer_1', column: 'company_officer_1', sqlType: 'text', verified: true },
  { soda: 'company_officer_2', column: 'company_officer_2', sqlType: 'text', verified: true },
  { soda: 'power_units', column: 'power_units', sqlType: 'int', verified: true },
  { soda: 'truck_units', column: 'truck_units', sqlType: 'int', verified: true },
  { soda: 'bus_units', column: 'bus_units', sqlType: 'int', verified: true },
  { soda: 'total_drivers', column: 'total_drivers', sqlType: 'int', verified: true },
  { soda: 'total_cdl', column: 'total_cdl', sqlType: 'int', verified: true },
  // fleetsize is documented (Part A DDL comment + Task 2 sources) as a text bucket
  // (e.g. a size-range label), not a number -- do not cast to int.
  { soda: 'fleetsize', column: 'fleetsize', sqlType: 'text', verified: true },
  { soda: 'owntruck', column: 'owned_trucks', sqlType: 'int', verified: true },
  { soda: 'owntract', column: 'owned_tractors', sqlType: 'int', verified: true },
  { soda: 'owntrail', column: 'owned_trailers', sqlType: 'int', verified: true },
  // 30 cargo flags, 1:1 boolean columns (Part A DDL §2.4).
  ...CRGO_FLAG_NAMES.map(
    (name): CensusFieldMapping => ({
      soda: name,
      column: name,
      sqlType: 'boolean',
      castExpr: CRGO_TRUE_VALUE_CAST,
      verified: true,
    })
  ),
  // THE core F14 signal (Part A amendment #7: canonical column is `crgo_cargoothr_desc`
  // itself, 1:1 raw -- Part B's `cargo_other_raw` alias is explicitly dropped by that
  // amendment). `cargo_other_norm` is a Postgres GENERATED column derived from this one
  // (Part A §2.4) -- it must NEVER appear in this file's INSERT/SET column lists, or the
  // upsert will fail with "cannot insert a non-DEFAULT value into column 'cargo_other_norm'".
  {
    soda: 'crgo_cargoothr_desc',
    column: 'crgo_cargoothr_desc',
    sqlType: 'text',
    castExpr: "nullif(btrim(%COL%), '')",
    verified: true,
  },
];

/**
 * Fetched (for census_raw + possible future promotion) but NOT written to a dedicated
 * `carriers` column. Field names + prefixes CONFIRMED this session (Task 2, correcting Part
 * B §2.3's own hedge of "termtruck..., triptruck..." ⚠️R5): owned/leased equipment actually
 * uses `own*` / `trm*` (term-leased) / `trp*` (trip-leased) prefixes, plus a bus/coach
 * ownership field (`owncoach`) that amendment #7's added-column list never mentions at all.
 * Amendment #7 only names `owned_trucks/tractors/trailers (+leased)` -- it does not specify
 * exact leased-equipment column names, whether term vs trip need separate columns, or
 * whether coach ownership gets a column. Rather than invent unreviewed schema, these stay in
 * census_raw only; promote them to real mapped columns once the schema agent settles names.
 */
const CENSUS_RAW_ONLY_FIELDS = [
  'owncoach',
  'trmtruck', 'trmtract', 'trmtrail',
  'trptruck', 'trptract', 'trptrail',
] as const;

/** Two-column derived field: docket1prefix + docket1 -> carriers.docket_display
 *  (Part B §2.3: "display-only (MC deprecated)"). Handled as a one-off rather than
 *  generalizing CensusFieldMapping to multi-source fields for a single case. */
const DOCKET_SOURCE_FIELDS = ['docket1prefix', 'docket1'] as const;
const DOCKET_DISPLAY_EXPR = `nullif(btrim(concat_ws('', sc."docket1prefix", sc."docket1")), '')`;

function uniqueSodaFields(): string[] {
  const set = new Set<string>();
  for (const f of CENSUS_FIELD_MAP) set.add(f.soda);
  for (const f of DOCKET_SOURCE_FIELDS) set.add(f);
  for (const f of CENSUS_RAW_ONLY_FIELDS) set.add(f);
  return Array.from(set);
}

/** `$select` column list (see the D2-vs-§1.1 note at the top of this file for the case for
 *  eventually dropping this restriction). */
export function buildSelectClause(): string {
  return uniqueSodaFields().join(',');
}

function castedExpr(f: CensusFieldMapping): string {
  const col = `sc."${f.soda}"`;
  if (f.castExpr) return f.castExpr.replaceAll('%COL%', col);
  return `nullif(${col}, '')::${f.sqlType}`;
}

function buildRowHashExpr(): string {
  // Deliberately every fetched column, not just CENSUS_FIELD_MAP's *promoted* ones: Part B
  // §2.2 step 3 says "all mapped source columns", but the CENSUS_RAW_ONLY_FIELDS (owncoach,
  // trm*/trp*) still land inside `census_raw` every time this UPDATE branch fires (see
  // buildGeneratedColumns). If row_hash ignored them, a change in e.g. `owncoach` alone
  // wouldn't trigger a re-sync, and census_raw would silently go stale for that field even
  // though a fresher value was sitting right there in staging. Hashing everything we fetched
  // is the more correct reading of "did anything we know about this row change" -- a
  // deliberate, minor widening of the spec's literal wording, not an oversight.
  const fields = uniqueSodaFields().filter((f) => f !== 'dot_number');
  const refs = fields.map((f) => `sc."${f}"`).join(', ');
  return `md5(concat_ws('|', ${refs}))`;
}

/** address_hash = md5(street|city|zip) per Part B §4.2, lower/trimmed so harmless
 *  case/whitespace-only differences don't trigger a spurious re-geocode. */
const ADDRESS_HASH_EXPR = `md5(concat_ws('|',
    lower(btrim(coalesce(sc."phy_street", ''))),
    lower(btrim(coalesce(sc."phy_city", ''))),
    lower(btrim(coalesce(sc."phy_zip", '')))
  ))`;

function buildStagingDdl(): string {
  const cols = uniqueSodaFields()
    .map((f) => `  "${f}" text`)
    .join(',\n');
  return `
create temp table staging_census (
${cols},
  "census_raw" jsonb,
  primary key ("dot_number")
) on commit drop;
  `.trim();
}

interface GeneratedColumn {
  column: string;
  selectExpr: string;
}

/**
 * Single source of truth for the upsert's column <-> value-expression pairing, built as one
 * array of pairs (not two hand-aligned parallel arrays) specifically so the generated
 * `insert into t (cols...) select exprs...` can never drift out of positional alignment.
 */
function buildGeneratedColumns(): GeneratedColumn[] {
  const cols: GeneratedColumn[] = [{ column: 'dot_number', selectExpr: 'sc."dot_number"::bigint' }];
  for (const f of CENSUS_FIELD_MAP) {
    if (f.column === 'dot_number') continue;
    cols.push({ column: f.column, selectExpr: castedExpr(f) });
  }
  cols.push({ column: 'docket_display', selectExpr: DOCKET_DISPLAY_EXPR });
  cols.push({ column: 'row_hash', selectExpr: buildRowHashExpr() });
  cols.push({ column: 'address_hash', selectExpr: ADDRESS_HASH_EXPR });
  cols.push({ column: 'census_raw', selectExpr: 'sc."census_raw"' });
  // TODO(schema-drift): census_updated_at (Part A's ORIGINAL DDL, "when the source row last
  // changed") and last_changed_at (amendment #7's NEW sync-bookkeeping addition) read as the
  // same concept under two names -- flag for the schema agent to reconcile (likely drop one).
  // Both are populated identically here so the code is correct under either reading.
  cols.push({ column: 'census_updated_at', selectExpr: 'now()' });
  cols.push({ column: 'last_changed_at', selectExpr: 'now()' });
  // NOTE: because the whole UPDATE branch below is gated `WHERE row_hash IS DISTINCT FROM
  // EXCLUDED.row_hash` (Part B §2.2 step 4, deliberately -- "only changed rows write ... so
  // Realtime/pg triggers don't storm"), last_synced_at also only advances on rows whose
  // content changed, NOT on every row we successfully re-saw today. That's a real (if minor)
  // semantic gap against Part A's plain-English column comment for last_synced_at ("when
  // last synced"); it's the literal, deliberate tradeoff Part B's spec text asks for, so this
  // file follows it rather than adding a second, unconditional 150-220k-row touch every night
  // that would defeat the anti-storm point of the gate in the first place.
  cols.push({ column: 'last_synced_at', selectExpr: 'now()' });
  // Every row present in today's pull is, by definition, not missing right now.
  cols.push({ column: 'source_missing_since', selectExpr: 'null::date' });
  return cols;
}

/**
 * TODO(live-db): assumes the amendment #7 migration has landed (row_hash, last_changed_at,
 * source_missing_since, every added column named above) with EXACTLY these column names.
 * Validate column-by-column against the real migration before this runs for real -- a
 * mismatch here fails loudly (undefined column), which is the right failure mode, but it's
 * cheaper to catch by reading the migration than by running it.
 */
export function buildDiffUpsertSql(): string {
  const cols = buildGeneratedColumns();
  const columnList = cols.map((c) => `"${c.column}"`).join(', ');
  const selectList = cols.map((c) => c.selectExpr).join(',\n       ');
  const setClauses = cols
    .filter((c) => c.column !== 'dot_number')
    .map((c) => `"${c.column}" = excluded."${c.column}"`)
    .join(',\n    ');

  return `
insert into public.carriers (${columnList})
select ${selectList}
from staging_census sc
on conflict (dot_number) do update set
    ${setClauses}
where public.carriers.row_hash is distinct from excluded.row_hash;
  `.trim();
}

/**
 * Set-difference pass (Part B §2.2 step 5): carriers we last knew to be TX-active that are
 * absent from today's active-TX pull get flagged, never deleted (amendment #13). Only ever
 * SETS the flag (never clears it here) -- a carrier that goes missing then genuinely
 * reappears in a later pull DOES get cleared, but that happens via the diff-upsert above
 * (`source_missing_since = null::date` on every row present in today's slice), not here.
 */
export function buildSourceMissingSql(): string {
  return `
update public.carriers
set source_missing_since = current_date
where phy_state = 'TX'
  and status_code = 'A'
  and source_missing_since is null
  and not exists (
    select 1 from staging_census sc where sc."dot_number"::bigint = public.carriers.dot_number
  );
  `.trim();
}

function mapRowToStagingTuple(row: Record<string, unknown>, sodaFields: readonly string[]): unknown[] {
  const values: unknown[] = sodaFields.map((f) => {
    const v = row[f];
    return v === undefined || v === null ? null : String(v);
  });
  // See the D2-vs-§1.1 note at the top of this file: currently only the trimmed $select
  // fields, not the full 142-field record, because that's all `row` contains.
  values.push(JSON.stringify(row));
  return values;
}

export interface CensusSyncOptions {
  /** Defaults to the amendment #13 scope (`phy_state='TX' AND status_code='A'`). Override
   *  only for a deliberate one-off (e.g. a full all-status research pull) -- production
   *  nightly/backfill runs should not need to pass this. */
  where?: string;
  /** Caps pages fetched -- local dev / smoke test only (run.ts's --pages flag). When set,
   *  the source_missing_since pass is SKIPPED (a partial pull would wrongly flag the rest of
   *  TX as missing). undefined = no cap, full slice. */
  maxPages?: number;
  pageSize?: number;
  /** Insert chunk size for the wide (~80-column) staging rows -- see db.ts's bulkInsert
   *  TODO(perf) re: Postgres's 65535-bound-parameter limit. */
  insertChunkSize?: number;
}

export interface CensusSyncResult {
  rowsRead: number;
  /** Rows actually written (row_hash changed) -- expect ~1-3% of rowsRead on a steady-state
   *  nightly run per Part B §2.2, ~100% on the very first backfill. */
  rowsUpserted: number;
  rowsMarkedMissing: number;
}

const DEFAULT_WHERE = "phy_state='TX' AND status_code='A'"; // amendment #13 -- see file header

export async function syncCensus(
  ctx: PipelineContext,
  socrata: SocrataClient,
  options: CensusSyncOptions = {}
): Promise<CensusSyncResult> {
  const where = options.where ?? DEFAULT_WHERE;
  const pageSize = options.pageSize ?? 50_000;
  const sodaFields = uniqueSodaFields();
  const stagingColumns = [...sodaFields, 'census_raw'];

  const unverified = CENSUS_FIELD_MAP.filter((f) => !f.verified).map((f) => f.column);
  if (unverified.length > 0) {
    ctx.log.warn('sync-census.unverified_columns', { columns: unverified });
  }

  let rowsRead = 0;
  let pageCount = 0;

  const { rowsUpserted, rowsMarkedMissing } = await withStagingConnection(
    ctx.pg,
    buildStagingDdl(),
    async (client: PgPoolClient) => {
      for await (const page of socrata.paginateKeyset<Record<string, string>>(
        SOCRATA_DATASETS.COMPANY_CENSUS,
        { $select: buildSelectClause(), $where: where },
        { keyColumn: 'dot_number', pageSize }
      )) {
        pageCount += 1;
        rowsRead += page.length;

        const rows = page.map((row) => mapRowToStagingTuple(row, sodaFields));
        await bulkInsert(client, 'staging_census', stagingColumns, rows, options.insertChunkSize ?? 300);

        ctx.log.info('sync-census.page', { page: pageCount, pageRows: page.length, rowsRead });

        if (options.maxPages && pageCount >= options.maxPages) {
          ctx.log.warn('sync-census.capped', { maxPages: options.maxPages, note: 'dev/smoke run -- skipping source_missing_since pass' });
          break;
        }
      }

      const upsertResult = await client.query(buildDiffUpsertSql());

      let missing = 0;
      if (!options.maxPages) {
        const missingResult = await client.query(buildSourceMissingSql());
        missing = missingResult.rowCount ?? 0;
      }

      return { rowsUpserted: upsertResult.rowCount ?? 0, rowsMarkedMissing: missing };
    }
  );

  ctx.log.info('sync-census.done', { rowsRead, rowsUpserted, rowsMarkedMissing, pages: pageCount });
  return { rowsRead, rowsUpserted, rowsMarkedMissing };
}
