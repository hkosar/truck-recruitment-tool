import assert from 'node:assert/strict';
import { parseArgs } from './run.js';
import { buildSelectClause as buildInsuranceSelectClause, buildWhereClause as buildInsuranceWhereClause, buildFilingsUpsertSql } from './sources/insurance.js';
import { buildSelectClause as buildAuthoritySelectClause, buildUpsertSql as buildAuthorityUpsertSql } from './sources/authority.js';
import { DEFAULT_PAGE_SIZE, SocrataClient } from './socrata.js';
import { CensusGeocoderHttpError, buildCandidateQuery, isRetryableCensusError, parseCensusBatchCsv } from './geocode.js';
import {
  buildRatingSelectClause,
  buildSelectClause as buildSafetySelectClause,
  buildUpsertSql as buildSafetyUpsertSql,
  mapSafetyRatingCode,
  parseFmcsaCompactDate,
  validateSafetyRow,
} from './sources/safety.js';

type Test = { name: string; run: () => void | Promise<void> };
const tests: Test[] = [];
const test = (name: string, run: Test['run']) => tests.push({ name, run });

test('parseArgs supports isolated capped dry-runs', () => {
  assert.deepEqual(parseArgs(['sync-insurance', '--pages=1', '--dry-run=true']), {
    command: 'sync-insurance',
    pages: 1,
    dryRun: true,
  });
  assert.throws(() => parseArgs(['sync-insurance', '--dry-run=yes']), /must be true or false/);
});

test('Socrata defaults to memory-safe 10k pages', async () => {
  assert.equal(DEFAULT_PAGE_SIZE, 10_000);
  let capturedUrl = '';
  const fetchImpl: typeof fetch = async (input) => {
    capturedUrl = String(input);
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const client = new SocrataClient({ appToken: 'test-token', fetchImpl });
  for await (const _page of client.paginateOffset('fixture')) {
    // Empty first page terminates immediately.
  }
  assert.match(capturedUrl, /%24limit=10000/);
});

test('authority query and rollup use live field names and deduplicate history by DOT', () => {
  const select = buildAuthoritySelectClause();
  assert.equal(select, 'dot_number,common_stat,contract_stat,broker_stat,min_cov_amount');
  const sql = buildAuthorityUpsertSql();
  assert.match(sql, /group by "dot_number"/i);
  assert.match(sql, /bool_or\("common_stat" = 'A'\)/i);
  assert.match(sql, /\* 1000/);
});

test('insurance query aliases the live fieldName and excludes removed guesses', () => {
  const select = buildInsuranceSelectClause();
  assert.match(select, /mod_col_1 as ins_type_desc/);
  assert.doesNotMatch(select, /ins_class_code/);
  assert.doesNotMatch(select, /min_cov_amount/);
  assert.equal(buildInsuranceWhereClause(), "mod_col_1 like 'BIPD%'");
});

test('insurance upsert targets the migrated schema and deduplicates source natural keys', () => {
  const sql = buildFilingsUpsertSql();
  assert.match(sql, /"max_cov_amount"/);
  assert.match(sql, /"underl_lim_amount"/);
  assert.doesNotMatch(sql, /max_cov_amount_usd/);
  assert.doesNotMatch(sql, /underl_lim_amount_usd/);
  assert.doesNotMatch(sql, /"raw"/);
  assert.match(sql, /select distinct on \("dot_number", "docket_number", "policy_no", "effective_date"\)/i);
  assert.match(sql, /nullif\("effective_date", ''\) is not null/i);
});

test('safety source contract uses only live-verified inspection fields', () => {
  assert.equal(
    buildSafetySelectClause(),
    'dot_number,insp_total,driver_insp_total,driver_oos_insp_total,vehicle_insp_total,vehicle_oos_insp_total'
  );
  assert.equal(buildRatingSelectClause(), 'dot_number,safety_rating,safety_rating_date');
  assert.doesNotMatch(buildSafetySelectClause(), /crash|safety_rating/);
});

test('safety row validation rejects impossible OOS and inspection totals', () => {
  assert.deepEqual(
    validateSafetyRow({
      dot_number: '100002',
      insp_total: '23',
      driver_insp_total: '23',
      driver_oos_insp_total: '1',
      vehicle_insp_total: '7',
      vehicle_oos_insp_total: '2',
    }),
    {
      dotNumber: 100002,
      inspections: 23,
      driverInspections: 23,
      driverOos: 1,
      vehicleInspections: 7,
      vehicleOos: 2,
    }
  );
  assert.throws(
    () => validateSafetyRow({
      dot_number: '1', insp_total: '2', driver_insp_total: '2', driver_oos_insp_total: '3',
      vehicle_insp_total: '1', vehicle_oos_insp_total: '0',
    }),
    /exceeds driver_insp_total/
  );
  assert.throws(
    () => validateSafetyRow({
      dot_number: '1', insp_total: '2', driver_insp_total: '3', driver_oos_insp_total: '0',
      vehicle_insp_total: '1', vehicle_oos_insp_total: '0',
    }),
    /component exceeds insp_total/
  );
});

test('safety rating codes and compact dates map fail-closed', () => {
  assert.equal(mapSafetyRatingCode('S'), 'Satisfactory');
  assert.equal(mapSafetyRatingCode('C'), 'Conditional');
  assert.equal(mapSafetyRatingCode('U'), 'Unsatisfactory');
  assert.equal(mapSafetyRatingCode(null), null);
  assert.throws(() => mapSafetyRatingCode('X'), /Unexpected FMCSA safety_rating code/);
  assert.equal(parseFmcsaCompactDate('20260625'), '2026-06-25');
  assert.equal(parseFmcsaCompactDate(''), null);
  assert.throws(() => parseFmcsaCompactDate('20260231'), /Invalid FMCSA compact date/);
});

test('safety upsert leaves crash inputs untouched until crash event keys are verified', () => {
  const sql = buildSafetyUpsertSql();
  assert.doesNotMatch(sql, /crash_total_24mo|crash_fatal_24mo|crash_injury_24mo|crash_tow_24mo/);
  assert.match(sql, /driver_oos_rate/);
  assert.match(sql, /vehicle_oos_rate/);
  assert.match(sql, /safety_rating = coalesce\(excluded\.safety_rating, public\.carrier_safety\.safety_rating\)/i);
  assert.match(sql, /on conflict \(dot_number\) do update/i);
});

test('Census geocoder classifies gateway and overload responses as retryable', () => {
  for (const status of [429, 502, 503, 504]) {
    assert.equal(isRetryableCensusError(new CensusGeocoderHttpError(status, 'temporary', '')), true);
  }
  assert.equal(isRetryableCensusError(new CensusGeocoderHttpError(400, 'bad request', '')), false);
  assert.equal(isRetryableCensusError(new TypeError('fetch failed')), true);
});

test('Census batch parser reads the live quoted lon,lat coordinate field', () => {
  const csv = [
    '"1","1600 Pennsylvania Ave NW, Washington, DC, 20500","Match","Exact","1600 PENNSYLVANIA AVE NW, WASHINGTON, DC, 20500","-77.03518753691,38.89869893252","76225813","L"',
    '"2","PO BOX 10, AUSTIN, TX, 78701","No_Match"',
  ].join('\n');
  assert.deepEqual(parseCensusBatchCsv(csv), [
    { dotNumber: 1, matched: true, matchType: 'Exact', lng: -77.03518753691, lat: 38.89869893252 },
    { dotNumber: 2, matched: false, matchType: null, lng: null, lat: null },
  ]);
});

test('location candidate queue excludes already-attempted no-match addresses', () => {
  const { sql } = buildCandidateQuery(100);
  assert.match(sql, /where geocode_addr_hash is distinct from address_hash/i);
  assert.doesNotMatch(sql, /geom is null or/i);
});

let failed = 0;
for (const { name, run } of tests) {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(error);
  }
}

if (failed > 0) {
  process.exitCode = 1;
} else {
  console.log(`PASS ${tests.length} pipeline smoke tests`);
}
