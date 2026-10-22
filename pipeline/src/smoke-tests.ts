import assert from 'node:assert/strict';
import { parseArgs } from './run.js';
import { loadConfig } from './config.js';
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
import { buildLastSafetySuccessSql, isSafetyDue, parseReloadAfter, safetyWindowStart } from './nightly-safety.js';

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
      allowStagingWrites: true,
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
      allowStagingWrites: true,
    }),
    /not in PIPELINE_ALLOWED_DEV_REFS/
  );
});

test('pipeline refuses to write to staging unless PIPELINE_ALLOW_STAGING_WRITES=true', () => {
  const { staging } = RECORDED_PROJECT_REFS;
  const baseEnv = {
    SUPABASE_URL: `https://${staging}.supabase.co`,
    SUPABASE_SERVICE_ROLE_KEY: 'x'.repeat(40),
    SUPABASE_DB_URL: `postgresql://postgres.${staging}:redacted@aws-0-us-east-2.pooler.supabase.com:5432/postgres`,
    SOCRATA_APP_TOKEN: 'test-token',
  };
  const guardFor = (env: Record<string, string>) => {
    const config = loadConfig(env as NodeJS.ProcessEnv);
    return verifyPipelineTarget({
      environment: config.PIPELINE_ENV,
      supabaseUrl: config.SUPABASE_URL,
      supabaseDbUrl: config.SUPABASE_DB_URL,
      allowedDevRefs: config.PIPELINE_ALLOWED_DEV_REFS,
      allowStagingWrites: config.PIPELINE_ALLOW_STAGING_WRITES,
    });
  };

  // Defaults: no dev project is allowlisted and staging writes are off.
  const defaults = loadConfig(baseEnv as NodeJS.ProcessEnv);
  assert.deepEqual(defaults.PIPELINE_ALLOWED_DEV_REFS, []);
  assert.equal(defaults.PIPELINE_ALLOW_STAGING_WRITES, false);
  assert.throws(() => guardFor(baseEnv), /not in PIPELINE_ALLOWED_DEV_REFS/);
  // Allowlisting staging is not enough on its own.
  assert.throws(() => guardFor({ ...baseEnv, PIPELINE_ALLOWED_DEV_REFS: staging }), /PIPELINE_ALLOW_STAGING_WRITES=true/);
  assert.throws(
    () => guardFor({ ...baseEnv, PIPELINE_ALLOWED_DEV_REFS: staging, PIPELINE_ALLOW_STAGING_WRITES: 'false' }),
    /PIPELINE_ALLOW_STAGING_WRITES=true/
  );
  assert.throws(() => loadConfig({ ...baseEnv, PIPELINE_ALLOW_STAGING_WRITES: 'yes' } as NodeJS.ProcessEnv), /PIPELINE_ALLOW_STAGING_WRITES/);
  // Explicit opt-in plus allowlist is the only way in.
  assert.deepEqual(
    guardFor({ ...baseEnv, PIPELINE_ALLOWED_DEV_REFS: staging, PIPELINE_ALLOW_STAGING_WRITES: 'true' }),
    { projectRef: staging, environment: 'dev' }
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
      verifyPipelineTarget({ environment: 'dev', supabaseUrl: apiUrl(staging), supabaseDbUrl: dbUrl, allowedDevRefs: [staging], allowStagingWrites: true }),
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
      () => verifyPipelineTarget({ environment: 'dev', supabaseUrl: apiUrl(staging), supabaseDbUrl: dbUrl, allowedDevRefs: [staging], allowStagingWrites: true }),
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
      () => verifyPipelineTarget({ environment: 'dev', supabaseUrl: apiUrl(staging), supabaseDbUrl: dbUrl, allowedDevRefs: [staging], allowStagingWrites: true }),
      /SUPABASE_DB_URL/
    );
  }

  // The database connection string is required, and errors never echo its password.
  assert.throws(
    () => verifyPipelineTarget({ environment: 'dev', supabaseUrl: apiUrl(staging), supabaseDbUrl: '', allowedDevRefs: [staging], allowStagingWrites: true }),
    /SUPABASE_DB_URL/
  );
  try {
    verifyPipelineTarget({ environment: 'dev', supabaseUrl: apiUrl(staging), supabaseDbUrl: poolerUrl(production), allowedDevRefs: [staging], allowStagingWrites: true });
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
      () => verifyPipelineTarget({ environment: 'dev', supabaseUrl: apiUrl, supabaseDbUrl: dbUrl, allowedDevRefs: [staging], allowStagingWrites: true }),
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
  assert.match(sql, /on conflict \(dot_number\) do update/i);
  // Rating and date are reconciled together: rated -> source; active Texas but absent from the
  // complete source -> confirmed unrated (NULL); outside that population -> unavailable (kept).
  assert.match(sql, /case when rated then r_rating when in_rating_population then null else e_rating end as safety_rating,/);
  assert.match(sql, /case when rated then r_date   when in_rating_population then null else e_date   end as safety_rating_date/);
  // Ratings are keyed independently of AB/C rows.
  assert.match(sql, /select dot_number from staging_safety_ratings/);
  // Unchanged rows are not rewritten, so rowCount counts real changes only.
  assert.match(sql, /where \(public\.carrier_safety\.snapshot_month, .*public\.carrier_safety\.safety_rating_date\)\s+is distinct from \(excluded\.snapshot_month, .*excluded\.safety_rating_date\)/s);
  assert.doesNotMatch(sql, /last_synced_at\) is distinct/);
});

test('SUPABASE_DB_URL allows only benign query parameters, mapped like the pg driver', () => {
  const { production, staging } = RECORDED_PROJECT_REFS;
  const base = `postgresql://postgres.${production}:redacted@aws-0-us-east-2.pooler.supabase.com:5432/postgres`;
  const prodGuard = (dbUrl: string) =>
    verifyPipelineTarget({ environment: 'prod', supabaseUrl: `https://${production}.supabase.co`, supabaseDbUrl: dbUrl });

  // No parameters: the pool keeps its existing default (TLS without verification).
  assert.equal(parseSupabaseDbTarget(base).ssl, undefined);
  // Each supported sslmode is accepted and mapped exactly as pg-connection-string maps it.
  for (const mode of ['disable', 'prefer', 'require', 'verify-ca', 'verify-full', 'no-verify']) {
    const url = `${base}?sslmode=${mode}`;
    assert.deepEqual(prodGuard(url), { projectRef: production, environment: 'prod' }, `sslmode=${mode}`);
    const driverSsl = parsePgConnectionString(url).ssl;
    const expected = driverSsl === false ? false : { ...(driverSsl as object) };
    assert.deepEqual(parseSupabaseDbTarget(url).ssl, expected, `sslmode=${mode} maps like the driver`);
  }
  const target = parseSupabaseDbTarget(`${base}?sslmode=require&application_name=tnbs-pipeline&pgbouncer=true&connect_timeout=10`);
  assert.deepEqual(target.ssl, {});
  assert.equal(target.applicationName, 'tnbs-pipeline');
  assert.equal(target.host, 'aws-0-us-east-2.pooler.supabase.com');
  assert.equal(target.user, `postgres.${production}`);
  assert.equal(target.port, 5432);
  assert.equal(target.database, 'postgres');
  prodGuard(`${base}?pgbouncer=false`);
  prodGuard(`${base}?connect_timeout=5`);

  // Every key that can redirect or reconfigure the connection is refused by name.
  for (const key of [
    'host', 'hostaddr', 'port', 'user', 'password', 'dbname', 'database', 'options', 'service',
    'sslcert', 'sslkey', 'sslrootcert', 'sslpassword', 'ssl', 'uselibpqcompat', 'client_encoding',
    'replication', 'target_session_attrs', 'fallback_application_name', 'sslnegotiation', 'unknown_key',
  ]) {
    assert.throws(() => prodGuard(`${base}?${key}=x`), new RegExp(`query parameter "${key}" is not allowed`), key);
    assert.throws(() => prodGuard(`${base}?sslmode=require&${key}=x`), /is not allowed/, `${key} after sslmode`);
  }
  // Unsupported values, duplicates and fragments are refused; values are never echoed.
  for (const [url, pattern] of [
    [`${base}?sslmode=bogus`, /"sslmode" has an unsupported value/],
    [`${base}?sslmode=`, /"sslmode" has an unsupported value/],
    [`${base}?application_name=a;b`, /"application_name" has an unsupported value/],
    [`${base}?pgbouncer=yes`, /"pgbouncer" has an unsupported value/],
    [`${base}?connect_timeout=-1`, /"connect_timeout" has an unsupported value/],
    [`${base}?sslmode=require&sslmode=disable`, /appears more than once/],
    [`${base}#sslmode=require`, /fragment/],
  ] as Array<[string, RegExp]>) {
    assert.throws(() => prodGuard(url), pattern, url.replace(/:redacted@/, ':***@'));
    try { prodGuard(url); } catch (error) { assert.doesNotMatch(String(error), /bogus|redacted|a;b/); }
  }
  // The project checks still apply with allowed parameters present.
  assert.throws(
    () => prodGuard(`postgresql://postgres.${staging}:redacted@aws-0-us-east-2.pooler.supabase.com:5432/postgres?sslmode=require`),
    /does not match SUPABASE_URL/
  );
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

test('nightly safety is off by default and only accepts off, dry-run or on', () => {
  const env = {
    SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'x'.repeat(40),
    SOCRATA_APP_TOKEN: 'test-token',
    SUPABASE_DB_URL: 'postgresql://postgres:redacted@db.abcdefghijklmnopqrst.supabase.co:5432/postgres',
  } as NodeJS.ProcessEnv;
  assert.equal(loadConfig(env).PIPELINE_NIGHTLY_SAFETY, 'off');
  assert.equal(loadConfig({ ...env, PIPELINE_NIGHTLY_SAFETY: 'dry-run' }).PIPELINE_NIGHTLY_SAFETY, 'dry-run');
  assert.equal(loadConfig({ ...env, PIPELINE_NIGHTLY_SAFETY: 'on' }).PIPELINE_NIGHTLY_SAFETY, 'on');
  assert.throws(() => loadConfig({ ...env, PIPELINE_NIGHTLY_SAFETY: 'true' }), /PIPELINE_NIGHTLY_SAFETY/);
});

test('nightly safety runs once per monthly window that opens on the 5th (UTC)', () => {
  const at = (iso: string) => new Date(iso);
  assert.equal(safetyWindowStart(at('2026-10-22T09:00:00Z')).toISOString(), '2026-10-05T00:00:00.000Z');
  assert.equal(safetyWindowStart(at('2026-10-05T00:00:00Z')).toISOString(), '2026-10-05T00:00:00.000Z');
  assert.equal(safetyWindowStart(at('2026-10-04T23:59:59Z')).toISOString(), '2026-09-05T00:00:00.000Z');
  assert.equal(safetyWindowStart(at('2027-01-03T09:00:00Z')).toISOString(), '2026-12-05T00:00:00.000Z');

  assert.equal(isSafetyDue(at('2026-10-22T09:00:00Z'), null), true, 'first ever run is due immediately');
  assert.equal(isSafetyDue(at('2026-10-22T09:00:00Z'), at('2026-10-21T09:20:00Z')), false);
  assert.equal(isSafetyDue(at('2026-11-04T09:00:00Z'), at('2026-10-21T09:20:00Z')), false);
  assert.equal(isSafetyDue(at('2026-11-05T09:00:00Z'), at('2026-10-21T09:20:00Z')), true);
});

test('nightly safety counts only full runs of the reviewed source, and dry runs only in dry-run mode', () => {
  const sql = buildLastSafetySuccessSql();
  assert.match(sql, /step = 'sync-safety'/);
  assert.match(sql, /status = 'success'/);
  assert.match(sql, /meta \? 'datasetIds'/);
  assert.match(sql, /meta->'pages' is null/);
  assert.match(sql, /\$1::boolean or coalesce\(meta->>'dryRun', 'false'\) <> 'true'/);
});

test('a deliberate reload override ignores earlier successes, is one-shot, and refuses future times', () => {
  const sql = buildLastSafetySuccessSql();
  assert.match(sql, /\$2::timestamptz is null or finished_at > \$2::timestamptz/);
  const now = new Date('2026-11-06T16:00:00Z');
  assert.equal(parseReloadAfter(undefined, now), null);
  assert.equal(parseReloadAfter('2026-11-06T15:00:00Z', now)?.toISOString(), '2026-11-06T15:00:00.000Z');
  assert.throws(() => parseReloadAfter('2026-11-07T00:00:00Z', now), /in the future/);
  const env = {
    SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'x'.repeat(40),
    SOCRATA_APP_TOKEN: 'test-token',
    SUPABASE_DB_URL: 'postgresql://postgres:redacted@db.abcdefghijklmnopqrst.supabase.co:5432/postgres',
  } as NodeJS.ProcessEnv;
  assert.equal(loadConfig(env).PIPELINE_SAFETY_RELOAD_AFTER, undefined);
  assert.equal(loadConfig({ ...env, PIPELINE_SAFETY_RELOAD_AFTER: '2026-11-06T15:00:00Z' }).PIPELINE_SAFETY_RELOAD_AFTER, '2026-11-06T15:00:00Z');
  assert.throws(() => loadConfig({ ...env, PIPELINE_SAFETY_RELOAD_AFTER: 'yesterday' }), /PIPELINE_SAFETY_RELOAD_AFTER/);
  assert.equal(loadConfig({ ...env, PIPELINE_SAFETY_RELOAD_AFTER: '' }).PIPELINE_SAFETY_RELOAD_AFTER, undefined);
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
