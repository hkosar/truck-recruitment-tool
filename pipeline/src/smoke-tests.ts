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
  fetchCompleteSafetyRatings,
  mapSafetyRatingCode,
  parseFmcsaCompactDate,
  SAFETY_DATASET_IDS,
  validateSafetyRow,
} from './sources/safety.js';
import { parse as parsePgConnectionString } from 'pg-connection-string';
import { RECORDED_PROJECT_REFS, parseSupabaseDbTarget, verifyPipelineTarget } from './target-guard.js';

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

test('pipeline target guard requires exact production and allowlisted development refs', () => {
  assert.deepEqual(
    verifyPipelineTarget({
      environment: 'prod',
      supabaseUrl: `https://${RECORDED_PROJECT_REFS.production}.supabase.co`,
      supabaseDbUrl: `postgresql://postgres.${RECORDED_PROJECT_REFS.production}:redacted@aws-0-us-east-2.pooler.supabase.com:5432/postgres`,
    }),
    { projectRef: RECORDED_PROJECT_REFS.production, environment: 'prod' }
  );
  assert.deepEqual(
    verifyPipelineTarget({
      environment: 'dev',
      supabaseUrl: `https://${RECORDED_PROJECT_REFS.staging}.supabase.co`,
      supabaseDbUrl: `postgresql://postgres.${RECORDED_PROJECT_REFS.staging}:redacted@aws-0-us-east-2.pooler.supabase.com:5432/postgres`,
      allowedDevRefs: [RECORDED_PROJECT_REFS.staging],
    }),
    { projectRef: RECORDED_PROJECT_REFS.staging, environment: 'dev' }
  );
  assert.throws(
    () => verifyPipelineTarget({
      environment: 'dev',
      supabaseUrl: `https://${RECORDED_PROJECT_REFS.production}.supabase.co`,
      supabaseDbUrl: `postgresql://postgres.${RECORDED_PROJECT_REFS.production}:redacted@aws-0-us-east-2.pooler.supabase.com:5432/postgres`,
      allowedDevRefs: [RECORDED_PROJECT_REFS.production],
    }),
    /refuses the production/
  );
  assert.throws(
    () => verifyPipelineTarget({
      environment: 'prod',
      supabaseUrl: `https://${RECORDED_PROJECT_REFS.staging}.supabase.co`,
      supabaseDbUrl: `postgresql://postgres.${RECORDED_PROJECT_REFS.staging}:redacted@aws-0-us-east-2.pooler.supabase.com:5432/postgres`,
    }),
    /requires the production Carrier Recruiter ref/
  );
  assert.throws(
    () => verifyPipelineTarget({
      environment: 'dev',
      supabaseUrl: 'https://fwmsyfndwgmvmbxaagzu.supabase.co',
      supabaseDbUrl: 'postgresql://postgres.fwmsyfndwgmvmbxaagzu:redacted@aws-0-us-east-2.pooler.supabase.com:5432/postgres',
      allowedDevRefs: [RECORDED_PROJECT_REFS.staging],
    }),
    /not in PIPELINE_ALLOWED_DEV_REFS/
  );
});

test('pipeline target guard binds SUPABASE_DB_URL to the same approved project as SUPABASE_URL', () => {
  const { production, staging } = RECORDED_PROJECT_REFS;
  const apiUrl = (ref: string) => `https://${ref}.supabase.co`;
  const poolerUrl = (ref: string) => `postgresql://postgres.${ref}:redacted@aws-0-us-east-2.pooler.supabase.com:5432/postgres`;
  const directUrl = (ref: string) => `postgresql://postgres:redacted@db.${ref}.supabase.co:5432/postgres`;

  // Matching pairs pass for both supported connection-string shapes.
  for (const dbUrl of [poolerUrl(staging), directUrl(staging)]) {
    assert.deepEqual(
      verifyPipelineTarget({ environment: 'dev', supabaseUrl: apiUrl(staging), supabaseDbUrl: dbUrl, allowedDevRefs: [staging] }),
      { projectRef: staging, environment: 'dev' }
    );
  }
  assert.deepEqual(
    verifyPipelineTarget({ environment: 'prod', supabaseUrl: apiUrl(production), supabaseDbUrl: poolerUrl(production) }),
    { projectRef: production, environment: 'prod' }
  );

  // Staging API settings + production bulk-write connection must be refused (Codex finding 2).
  for (const dbUrl of [poolerUrl(production), directUrl(production)]) {
    assert.throws(
      () => verifyPipelineTarget({ environment: 'dev', supabaseUrl: apiUrl(staging), supabaseDbUrl: dbUrl, allowedDevRefs: [staging] }),
      /SUPABASE_DB_URL .* does not match SUPABASE_URL/
    );
  }
  // And the reverse: production API settings with a staging bulk connection.
  assert.throws(
    () => verifyPipelineTarget({ environment: 'prod', supabaseUrl: apiUrl(production), supabaseDbUrl: poolerUrl(staging) }),
    /SUPABASE_DB_URL .* does not match SUPABASE_URL/
  );

  // Connection strings whose project cannot be established are refused, never assumed.
  for (const dbUrl of [
    'postgresql://postgres:redacted@localhost:5432/postgres',
    'postgresql://postgres:redacted@aws-0-us-east-2.pooler.supabase.com:5432/postgres',
    `postgresql://postgres.${staging}:redacted@db.${production}.supabase.co:5432/postgres`,
    `postgresql://postgres.${staging}:redacted@db.${staging}.supabase.co.evil.example:5432/postgres`,
  ]) {
    assert.throws(
      () => verifyPipelineTarget({ environment: 'dev', supabaseUrl: apiUrl(staging), supabaseDbUrl: dbUrl, allowedDevRefs: [staging] }),
      /SUPABASE_DB_URL/
    );
  }

  // The database connection string is required, and errors never echo its password.
  assert.throws(
    () => verifyPipelineTarget({ environment: 'dev', supabaseUrl: apiUrl(staging), supabaseDbUrl: '', allowedDevRefs: [staging] }),
    /SUPABASE_DB_URL/
  );
  try {
    verifyPipelineTarget({ environment: 'dev', supabaseUrl: apiUrl(staging), supabaseDbUrl: poolerUrl(production), allowedDevRefs: [staging] });
  } catch (error) {
    assert.doesNotMatch(String(error), /redacted/);
  }
});

test('pipeline target guard refuses driver-level host/user overrides in SUPABASE_DB_URL query parameters', () => {
  const { production, staging } = RECORDED_PROJECT_REFS;
  const apiUrl = `https://${staging}.supabase.co`;
  // pg-connection-string lets ?host= and ?user= override the URL hostname/username, so the
  // driver would connect to production while the URL "looks" like staging (Codex round 2).
  const bypasses = [
    `postgresql://postgres.${staging}:redacted@aws-0-us-east-2.pooler.supabase.com:5432/postgres?user=postgres.${production}`,
    `postgresql://postgres:redacted@db.${staging}.supabase.co:5432/postgres?host=db.${production}.supabase.co`,
    `postgresql://postgres:redacted@db.${staging}.supabase.co:5432/postgres?port=6543`,
    `postgresql://postgres:redacted@db.${staging}.supabase.co:5432/postgres?options=-c%20search_path%3Dx`,
    `postgresql://postgres:redacted@db.${staging}.supabase.co:5432/postgres#host=x`,
    `socket://postgres:redacted@db.${staging}.supabase.co/postgres`,
  ];
  for (const dbUrl of bypasses) {
    assert.throws(
      () => verifyPipelineTarget({ environment: 'dev', supabaseUrl: apiUrl, supabaseDbUrl: dbUrl, allowedDevRefs: [staging] }),
      /SUPABASE_DB_URL/,
      `must refuse ${dbUrl.replace(/:redacted@/, ':***@')}`
    );
  }
  // Sanity: the driver's own parser really would have been redirected by the first two.
  assert.equal(parsePgConnectionString(bypasses[0] ?? '').user, `postgres.${production}`);
  assert.equal(parsePgConnectionString(bypasses[1] ?? '').host, `db.${production}.supabase.co`);

  // For accepted strings, the explicit target the pool is built from equals what pg itself
  // would derive, so the guard checks exactly what the driver uses.
  for (const dbUrl of [
    `postgresql://postgres.${staging}:redacted@aws-0-us-east-2.pooler.supabase.com:5432/postgres`,
    `postgresql://postgres:redacted@db.${staging}.supabase.co:5432/postgres`,
  ]) {
    const target = parseSupabaseDbTarget(dbUrl);
    const driver = parsePgConnectionString(dbUrl);
    assert.equal(target.projectRef, staging);
    assert.equal(target.host, driver.host);
    assert.equal(String(target.port), String(driver.port));
    assert.equal(target.user, driver.user);
    assert.equal(target.database, driver.database);
    assert.equal(target.password, driver.password);
  }
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

test('Socrata numeric keyset paging is not used for text-keyed safety DOTs', async () => {
  const urls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    urls.push(String(input));
    const body = urls.length === 1
      ? JSON.stringify([{ dot_number: '10000' }])
      : '[]';
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const client = new SocrataClient({ appToken: 'test-token', fetchImpl });
  for await (const _page of client.paginateOffset('4y6x-dmck', { $order: 'dot_number' }, 1)) {
    // Consume both pages.
  }
  assert.equal(urls.length, 2);
  assert.match(urls[0] ?? '', /%24offset=0/);
  assert.match(urls[1] ?? '', /%24offset=1/);
  assert.doesNotMatch(urls.join('\n'), /dot_number%3E|dot_number\+%3E/);
});

test('safety source contract uses both disjoint PassProperty populations and only verified fields', () => {
  assert.deepEqual(SAFETY_DATASET_IDS, ['4y6x-dmck', 'h9zy-gjn8']);
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
  assert.throws(
    () => validateSafetyRow({
      dot_number: '1', insp_total: '2', driver_insp_total: '', driver_oos_insp_total: '0',
      vehicle_insp_total: '1', vehicle_oos_insp_total: '0',
    }),
    /Missing driver_insp_total value/
  );
});

function fakeRatingSource(options: {
  rows: number;
  /** Rows the server will actually return before silently truncating (simulates a cap). */
  serveRows?: number;
  /** Sequence of count(1) answers; the last one repeats. */
  counts?: number[];
}) {
  const all = Array.from({ length: options.rows }, (_, index) => ({
    dot_number: String(1_000_000 + index),
    safety_rating: 'S',
    safety_rating_date: '20240101',
  }));
  const served = all.slice(0, options.serveRows ?? options.rows);
  const counts = [...(options.counts ?? [options.rows])];
  const requests: URLSearchParams[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const params = new URL(String(input)).searchParams;
    requests.push(params);
    let body: unknown;
    if ((params.get('$select') ?? '').includes('count(1)')) {
      const count = counts.length > 1 ? counts.shift() : counts[0];
      body = [{ count: String(count) }];
    } else {
      const offset = Number(params.get('$offset') ?? 0);
      const limit = Number(params.get('$limit') ?? 1000);
      body = served.slice(offset, offset + limit);
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { client: new SocrataClient({ appToken: 'test-token', fetchImpl }), requests };
}

test('safety ratings are paginated past one page and checked against an independent filtered count', async () => {
  const { client, requests } = fakeRatingSource({ rows: 25 });
  const rows = await fetchCompleteSafetyRatings(client, 10);
  assert.equal(rows.length, 25);
  const pageRequests = requests.filter((params) => !(params.get('$select') ?? '').includes('count(1)'));
  assert.deepEqual(pageRequests.map((params) => params.get('$offset')), ['0', '10', '20']);
  const countRequests = requests.filter((params) => (params.get('$select') ?? '').includes('count(1)'));
  assert.equal(countRequests.length, 2, 'count before and after the pull');
  for (const params of [...pageRequests, ...countRequests]) {
    assert.equal(params.get('$where'), "phy_state='TX' AND status_code='A' AND safety_rating is not null");
  }
});

test('safety ratings refuse a silently truncated (capped) response', async () => {
  // 10,001 qualifying ratings but the source stops at 10,000 -- the old single capped fetch
  // would have reported success while omitting a rating.
  const { client } = fakeRatingSource({ rows: 10_001, serveRows: 10_000 });
  await assert.rejects(() => fetchCompleteSafetyRatings(client, 10_000), /Safety rating completeness failed: read 10000 rows, expected 10001/);
});

test('safety ratings refuse a source that changes during the pull', async () => {
  const { client } = fakeRatingSource({ rows: 25, counts: [25, 26] });
  await assert.rejects(() => fetchCompleteSafetyRatings(client, 10), /changed during the pull/);
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
