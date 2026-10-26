import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
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
import { STAGING_SQL_ACTIONS, planStagingSqlRun } from './staging-sql-runner.js';
import { REBUILT_STAGING_SQL_ACTIONS, executeRebuiltSqlPlan, planRebuiltSqlRun, retargetSqlToRebuiltRef } from './staging-rebuilt.js';
import { RECORDED_PROJECT_REFS, parseSupabaseDbTarget, verifyPipelineTarget } from './target-guard.js';
import { readFileSync } from 'node:fs';
import { RETENTION_RULES, runRetention, type Queryable } from './retention.js';
import { retentionClientConfig, runRetentionForCron, runRetentionStep, type RetentionClient } from './retention-step.js';

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

test('staging SQL runner verifies the staging project offline before any connection', () => {
  const { production, staging } = RECORDED_PROJECT_REFS;
  const pooler = (ref: string, port = 5432) => `postgresql://postgres.${ref}:redacted@aws-0-us-east-2.pooler.supabase.com:${port}/postgres`;
  const reset = STAGING_SQL_ACTIONS.reset;

  const plan = planStagingSqlRun({ action: 'reset', dbUrl: pooler(staging), confirm: reset.confirmation });
  assert.equal(plan.target.projectRef, staging);
  assert.match(plan.file, /supabase[\\/]staging[\\/]reset-fictional-data\.sql$/);
  assert.deepEqual(plan.settings, [
    ['app.staging_runner_verified_ref', staging],
    ['app.staging_project_ref', staging],
    ['app.staging_reset_confirmation', reset.confirmation],
  ]);
  for (const action of Object.keys(STAGING_SQL_ACTIONS) as Array<keyof typeof STAGING_SQL_ACTIONS>) {
    const spec = STAGING_SQL_ACTIONS[action];
    assert.ok(existsSync(planStagingSqlRun({ action, dbUrl: pooler(staging), confirm: spec.confirmation }).file));
  }

  const refuse = (input: Parameters<typeof planStagingSqlRun>[0], pattern: RegExp) =>
    assert.throws(() => planStagingSqlRun(input), pattern);
  refuse({ action: 'reset', dbUrl: pooler(production), confirm: reset.confirmation }, /refuses the production/);
  refuse({ action: 'install-marker', dbUrl: `postgresql://postgres:redacted@db.${production}.supabase.co:5432/postgres`, confirm: STAGING_SQL_ACTIONS['install-marker'].confirmation }, /refuses the production/);
  refuse({ action: 'reset', dbUrl: pooler('fwmsyfndwgmvmbxaagzu'), confirm: reset.confirmation }, /only targets the recorded staging project/);
  // The same query-parameter overrides that bypassed the pipeline guard.
  refuse({ action: 'reset', dbUrl: `${pooler(staging)}?user=postgres.${production}`, confirm: reset.confirmation }, /query parameters/);
  refuse({ action: 'reset', dbUrl: `postgresql://postgres:redacted@db.${staging}.supabase.co:5432/postgres?host=db.${production}.supabase.co`, confirm: reset.confirmation }, /query parameters/);
  refuse({ action: 'reset', dbUrl: pooler(staging, 6543), confirm: reset.confirmation }, /port 5432/);
  refuse({ action: 'reset', dbUrl: pooler(staging), confirm: 'yes' }, /--confirm=/);
  refuse({ action: 'cleanup', dbUrl: pooler(staging), confirm: reset.confirmation }, /--confirm=/);
  refuse({ action: 'reset', dbUrl: undefined, confirm: reset.confirmation }, /STAGING_DB_URL is required/);
  refuse({ action: 'drop-everything', dbUrl: pooler(staging), confirm: reset.confirmation }, /Unknown staging SQL action/);
});

test('rebuilt staging runner: refused until a ref is recorded, then only that exact ref, with the same guards', () => {
  const { production, staging } = RECORDED_PROJECT_REFS;
  const rebuilt = 'abcdefghijklmnopqrst';
  const pooler = (ref: string, port = 5432) => `postgresql://postgres.${ref}:redacted@aws-0-us-east-2.pooler.supabase.com:${port}/postgres`;
  const fixtures = REBUILT_STAGING_SQL_ACTIONS['install-shutdown-fixtures']!;
  const plan = (over: Partial<Parameters<typeof planRebuiltSqlRun>[0]> = {}) =>
    planRebuiltSqlRun({ action: 'install-shutdown-fixtures', dbUrl: pooler(rebuilt), confirm: fixtures.confirmation, recordedRebuiltRef: rebuilt, ...over });

  // No rebuilt ref is recorded in this commit, so the real default refuses everything.
  assert.equal(RECORDED_PROJECT_REFS.stagingRebuilt, null);
  assert.throws(() => planRebuiltSqlRun({ action: 'window-on', dbUrl: pooler(rebuilt), confirm: REBUILT_STAGING_SQL_ACTIONS['window-on']!.confirmation }), /not recorded yet/);

  const ok = plan();
  assert.equal(ok.target.projectRef, rebuilt);
  assert.deepEqual(ok.settings, [
    ['app.staging_runner_verified_ref', rebuilt],
    ['app.staging_project_ref', rebuilt],
    ['app.staging_shutdown_fixtures_confirmation', fixtures.confirmation],
  ]);
  // The file is re-pinned in memory: the new ref replaces the old one, which must not remain.
  const sql = ok.steps[0]!.sql;
  assert.ok(sql.includes(`'${rebuilt}'`) && !sql.includes(staging) && !sql.includes(production));

  const refuse = (over: Partial<Parameters<typeof planRebuiltSqlRun>[0]>, pattern: RegExp) => assert.throws(() => plan(over), pattern);
  refuse({ dbUrl: pooler(production) }, /refuses the production/);
  refuse({ dbUrl: pooler(staging) }, /only targets the recorded rebuilt/);
  refuse({ dbUrl: pooler('zzzzzzzzzzzzzzzzzzzz') }, /only targets the recorded rebuilt/);
  refuse({ dbUrl: pooler(rebuilt, 6543) }, /port 5432/);
  refuse({ dbUrl: `${pooler(rebuilt)}?user=postgres.${production}` }, /query parameters/);
  refuse({ dbUrl: undefined }, /STAGING_DB_URL is required/);
  refuse({ confirm: 'yes' }, /--confirm=/);
  refuse({ confirm: REBUILT_STAGING_SQL_ACTIONS['remove-shutdown-fixtures']!.confirmation }, /--confirm=/);
  refuse({ action: 'drop-everything' }, /Unknown rebuilt/);
  refuse({ out: '/tmp/x' }, /only valid for snapshot/);
  // A recorded ref must itself be sane: never production, never the old staging project.
  refuse({ recordedRebuiltRef: production, dbUrl: pooler(production) }, /invalid or equals/);
  refuse({ recordedRebuiltRef: staging, dbUrl: pooler(staging) }, /invalid or equals/);
  refuse({ recordedRebuiltRef: 'short', dbUrl: pooler(rebuilt) }, /invalid or equals/);

  // Every action's file exists, and every pinned file re-pins cleanly.
  for (const [action, spec] of Object.entries(REBUILT_STAGING_SQL_ACTIONS)) {
    const p = planRebuiltSqlRun({
      action,
      dbUrl: pooler(rebuilt),
      confirm: spec.confirmation,
      recordedRebuiltRef: rebuilt,
      ...(spec.kind === 'snapshot' ? { out: resolve(tmpdir(), `tnbs-snapshot-test-${process.pid}.json`) } : {}),
    });
    assert.ok(p.steps.length >= 1, action);
    for (const step of p.steps) assert.ok(!step.sql.includes(staging) && !step.sql.includes(production), `${action}: ${step.label}`);
  }
  assert.equal(planRebuiltSqlRun({ action: 'apply-migrations', dbUrl: pooler(rebuilt), confirm: REBUILT_STAGING_SQL_ACTIONS['apply-migrations']!.confirmation, recordedRebuiltRef: rebuilt }).steps.length, 20);
  // Snapshot output must be absolute, new, and outside the repository.
  const snap = REBUILT_STAGING_SQL_ACTIONS.snapshot!;
  const snapPlan = (out: string | undefined) => planRebuiltSqlRun({ action: 'snapshot', dbUrl: pooler(rebuilt), confirm: snap.confirmation, recordedRebuiltRef: rebuilt, out });
  assert.throws(() => snapPlan(undefined), /requires --out/);
  assert.throws(() => snapPlan('relative.json'), /requires --out/);
  assert.throws(() => snapPlan(resolve(process.cwd(), 'snapshot.json')), /outside the repository/);
  assert.throws(() => snapPlan(resolve(import.meta.dirname, '..', 'package.json')), /outside the repository/);

  // The re-pin helper refuses a file that holds the production ref, or has nothing to re-pin.
  assert.throws(() => retargetSqlToRebuiltRef(`select '${production}'`, rebuilt, false), /production/);
  assert.throws(() => retargetSqlToRebuiltRef('select 1', rebuilt, true), /no pinned staging ref/);
  assert.equal(retargetSqlToRebuiltRef(`select '${staging}'`, rebuilt, true), `select '${rebuilt}'`);
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

test('rebuilt staging runner: every migration is one transaction that also records its version and name in the ledger', async () => {
  const rebuilt = 'abcdefghijklmnopqrst';
  const url = `postgresql://postgres.${rebuilt}:redacted-pw@aws-0-us-east-2.pooler.supabase.com:5432/postgres`;
  const spec = REBUILT_STAGING_SQL_ACTIONS['apply-migrations']!;
  const plan = planRebuiltSqlRun({ action: 'apply-migrations', dbUrl: url, confirm: spec.confirmation, recordedRebuiltRef: rebuilt });
  const files = plan.steps.map((s) => s.label);
  assert.equal(files.length, 20);
  for (const step of plan.steps) {
    assert.equal(step.transaction, true, step.label);
    assert.deepEqual(step.ledger, { version: step.label.slice(0, 14), name: step.label.slice(15, -'.sql'.length) });
  }
  // Order of what is sent: guard, ledger table, empty-ledger check, then per file begin / sql / insert / commit.
  const sent: string[] = [];
  const client = {
    async connect() {},
    async query(sql: string, params?: unknown[]) {
      sent.push(params ? `${sql} ${JSON.stringify(params)}` : sql);
      if (/to_regclass/.test(sql)) return { rows: [{ t: null }] };
      if (/count\(\*\)::int/.test(sql)) return { rows: [{ n: 0 }] };
      return { rows: [] };
    },
    async end() {},
  };
  await executeRebuiltSqlPlan({ ...plan, steps: plan.steps.slice(0, 2) }, () => client);
  const afterGuards = sent.findIndex((q) => q === 'begin');
  assert.deepEqual(
    sent.slice(afterGuards).map((q) => (q.startsWith('insert into supabase_migrations') ? q.replace(/^.*\(\$1, \$2, array\[\]::text\[\]\)/, 'insert') : q === 'begin' || q === 'commit' ? q : 'sql')),
    ['begin', 'sql', 'insert [\"20260720000100\",\"extensions\"]', 'commit', 'begin', 'sql', 'insert [\"20260720000200\",\"enums\"]', 'commit'],
  );
  // A failing file is rolled back (the insert never commits) and nothing later runs.
  const failing = { ...client, async query(sql: string, params?: unknown[]) { sent.push(sql); if (/to_regclass/.test(sql)) return { rows: [{ t: null }] }; if (/count\(\*\)::int/.test(sql)) return { rows: [{ n: 0 }] }; if (sql.startsWith('-- fail')) throw new Error('boom'); return { rows: [] }; } };
  sent.length = 0;
  const bad = { ...plan, steps: [{ ...plan.steps[0]!, sql: '-- fail' }, plan.steps[1]!] };
  const origError = console.error; console.error = () => undefined;
  await assert.rejects(executeRebuiltSqlPlan(bad, () => failing), /boom/);
  console.error = origError;
  assert.ok(sent.includes('rollback') && !sent.includes('commit'));
  assert.equal(sent.filter((q) => q === 'begin').length, 1);
});

// ---- Sign-in ledger retention (moved from app/server/scripts/retention.test.ts) -------------
const M1_SQL = readFileSync(new URL('../../supabase/pending/M1_same_origin_signin.sql', import.meta.url), 'utf8');

function fakeRetentionDb(counts: Record<string, number[]>, failOn?: string): Queryable & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    async query(sql: string) {
      log.push(sql);
      const table = /delete from ([\w.]+)/.exec(sql)?.[1];
      if (!table) return { rowCount: null };
      if (table === failOn) throw new Error('boom');
      const queue = counts[table] ?? [];
      return { rowCount: queue.length ? queue.shift()! : 0 };
    },
  };
}

test('retention: events are kept longer than links, and the link foreign key cannot block link deletion', () => {
  const days = (rule: string) => Number(/interval '(\d+) (days|hours)'/.exec(RETENTION_RULES.find((r) => r.name === rule)!.where)![1]);
  assert.equal(days('email_events'), 180);
  assert.equal(days('signin_links'), 30);
  assert.match(M1_SQL, /link_id\s+uuid references internal\.signin_links\(id\) on delete set null/);
  assert.match(M1_SQL, /create table internal\.email_events \([\s\S]*recipient_email\s+text not null/);
});

test('retention: never deletes events by link, and every rule uses the wall clock', () => {
  for (const rule of RETENTION_RULES) {
    assert.ok(rule.where.includes('clock_timestamp()'), rule.name);
    assert.doesNotMatch(rule.where, /\bnow\(\)/);
  }
  assert.ok(!RETENTION_RULES.find((r) => r.name === 'email_events')!.where.includes('link'));
});

test('retention: deletes in bounded batches until a short batch, per table', async () => {
  const db = fakeRetentionDb({ 'internal.signin_links': [5000, 5000, 12], 'internal.email_events': [3] });
  const result = await runRetention(db, { batchSize: 5000 });
  assert.equal(result.deleted.signin_links, 10_012);
  assert.equal(result.deleted.email_events, 3);
  assert.deepEqual(result.failed, []);
  assert.equal(db.log[0], "set statement_timeout = '30s'");
});

test('retention: a failing rule is reported and the others still run', async () => {
  const db = fakeRetentionDb({ 'internal.app_sessions': [2] }, 'internal.signin_links');
  const result = await runRetention(db);
  assert.deepEqual(result.failed, ['signin_links']);
  assert.equal(result.deleted.app_sessions, 2);
});

test('retention: stops after the per-rule batch cap', async () => {
  const db = fakeRetentionDb({ 'internal.auth_request_buckets': Array(10).fill(1) });
  const result = await runRetention(db, { batchSize: 1, maxBatchesPerRule: 3 });
  assert.equal(result.deleted.request_buckets, 3);
});

// ---- The nightly retention step (retention-step.ts) -----------------------------------------
const STAGING = RECORDED_PROJECT_REFS.staging;
const PROD = RECORDED_PROJECT_REFS.production;
const maintUrl = (role: string, ref: string, extra = '') => `postgresql://${role}.${ref}:redacted-pw@aws-0-us-east-2.pooler.supabase.com:5432/postgres${extra}`;

function stepHarness(currentUser = 'recruiter_maintenance', failQuery = false) {
  const events: Array<{ level: string; event: string; fields?: Record<string, unknown> }> = [];
  const alerts: string[] = [];
  const created: Array<Record<string, unknown>> = [];
  let ended = 0;
  const deps = {
    log: {
      info: (event: string, fields?: Record<string, unknown>) => events.push({ level: 'info', event, fields }),
      error: (event: string, fields?: Record<string, unknown>) => events.push({ level: 'error', event, fields }),
    },
    alert: async (message: string) => {
      alerts.push(message);
    },
    createClient: (fields: Record<string, unknown>): RetentionClient => {
      created.push(fields);
      return {
        async connect() {},
        async query(sql: string) {
          if (failQuery) throw new Error('db down');
          if (/current_user/.test(sql)) return { rowCount: 1, rows: [{ u: currentUser }] };
          return { rowCount: 0 };
        },
        async end() {
          ended += 1;
        },
      };
    },
  };
  return { deps, events, alerts, created, ended: () => ended };
}

test('retention step: OFF unless MAINTENANCE_DATABASE_URL is set (no connection, no alert)', async () => {
  const h = stepHarness();
  const out = await runRetentionStep({ MAINTENANCE_DATABASE_URL: undefined }, PROD, h.deps);
  assert.deepEqual(out, { status: 'skipped', reason: 'not_configured' });
  assert.equal(h.created.length, 0);
  assert.deepEqual(h.alerts, []);
  assert.deepEqual(h.events.map((e) => e.event), ['retention.skipped']);
});

test('retention config: a malformed or empty MAINTENANCE_DATABASE_URL never stops config loading; the step refuses it', async () => {
  for (const bad of ['not a url', 'mysql://x', '   ']) {
    const config = loadConfig({
      SUPABASE_URL: `https://${PROD}.supabase.co`,
      SUPABASE_SERVICE_ROLE_KEY: 'x'.repeat(40),
      SUPABASE_DB_URL: `postgresql://postgres.${PROD}:redacted@aws-0-us-east-2.pooler.supabase.com:5432/postgres`,
      SOCRATA_APP_TOKEN: 'test-token',
      MAINTENANCE_DATABASE_URL: bad,
    } as NodeJS.ProcessEnv);
    const h = stepHarness();
    const out = await runRetentionStep(config, PROD, h.deps);
    assert.ok(out.status === 'refused' || out.status === 'skipped', bad);
    assert.equal(h.created.length, 0);
  }
});

test('retention step: refuses another project, another role, and a query string; never connects; logs no URL', async () => {
  for (const [url, reason] of [
    [maintUrl('recruiter_maintenance', STAGING), 'other_project'],
    [maintUrl('postgres', PROD), 'wrong_role'],
    [maintUrl('recruiter_api', PROD), 'wrong_role'],
    [maintUrl('recruiter_maintenance', PROD, '?host=evil.example.com'), 'unparseable'],
    ['postgresql://recruiter_maintenance:pw@db.example.com:5432/postgres', 'unparseable'],
    [maintUrl('recruiter_maintenance', PROD).replace(':5432/', ':6543/'), 'wrong_port'],
  ] as const) {
    const h = stepHarness();
    const out = await runRetentionStep({ MAINTENANCE_DATABASE_URL: url }, PROD, h.deps);
    assert.deepEqual(out, { status: 'refused', reason });
    assert.equal(h.created.length, 0, url);
    assert.equal(h.alerts.length, 1);
    assert.ok(!JSON.stringify(h.events).includes('redacted-pw') && !JSON.stringify(h.alerts).includes('redacted-pw'));
  }
});

test('retention step: connects with explicit fields as recruiter_maintenance, runs, logs counts only, closes', async () => {
  const h = stepHarness();
  const out = await runRetentionStep({ MAINTENANCE_DATABASE_URL: maintUrl('recruiter_maintenance', PROD) }, PROD, h.deps);
  assert.equal(out.status, 'done');
  assert.equal(h.created.length, 1);
  assert.deepEqual(Object.keys(h.created[0]!).sort(), ['database', 'host', 'password', 'port', 'user']);
  assert.equal(h.created[0]!.user, `recruiter_maintenance.${PROD}`);
  assert.equal(h.ended(), 1);
  assert.deepEqual(h.alerts, []);
  const done = h.events.find((e) => e.event === 'retention.done')!;
  assert.deepEqual(Object.keys(done.fields!).sort(), ['deleted', 'failed']);
});

test('retention step: the real client config sets TLS explicitly and uses only the verified fields', () => {
  const cfg = retentionClientConfig({ host: 'h.pooler.supabase.com', port: 5432, user: 'recruiter_maintenance.x', password: 'pw', database: 'postgres' });
  assert.deepEqual(cfg.ssl, { rejectUnauthorized: false });
  assert.equal(cfg.port, 5432);
  assert.equal(cfg.connectionString, undefined);
});

test('retention step: refuses if the session is not recruiter_maintenance; a DB error never throws', async () => {
  const other = stepHarness('postgres');
  assert.deepEqual(await runRetentionStep({ MAINTENANCE_DATABASE_URL: maintUrl('recruiter_maintenance', PROD) }, PROD, other.deps), { status: 'refused', reason: 'connected_as_other_role' });
  assert.equal(other.ended(), 1);
  const down = stepHarness('recruiter_maintenance', true);
  assert.deepEqual(await runRetentionStep({ MAINTENANCE_DATABASE_URL: maintUrl('recruiter_maintenance', PROD) }, PROD, down.deps), { status: 'failed', reason: 'connect_or_query_error' });
  assert.equal(down.alerts.length, 1);
  assert.equal(down.ended(), 1);
});

test('retention cron: a failure with no email delivered is flagged unalerted; delivered or healthy is not; never throws', async () => {
  const url = { MAINTENANCE_DATABASE_URL: maintUrl('recruiter_maintenance', PROD) };
  const cron = async (h: ReturnType<typeof stepHarness>, config: { MAINTENANCE_DATABASE_URL: string | undefined }, sendAlert: (m: string) => Promise<boolean>) =>
    runRetentionForCron(config, PROD, { log: h.deps.log, createClient: h.deps.createClient, sendAlert });
  const down = () => stepHarness('recruiter_maintenance', true);
  // email not configured (sendFailureEmail returns false): unalerted
  assert.equal((await cron(down(), url, async () => false)).unalerted, true);
  // email send throws: unalerted, and nothing escapes
  assert.equal((await cron(down(), url, async () => { throw new Error('resend down'); })).unalerted, true);
  // email delivered: alerted, no non-zero exit needed
  assert.equal((await cron(down(), url, async () => true)).unalerted, false);
  // refusal (malformed URL) with no email: unalerted
  assert.equal((await cron(stepHarness(), { MAINTENANCE_DATABASE_URL: 'not a url' }, async () => false)).unalerted, true);
  // healthy run and not-configured: nothing to alert
  assert.equal((await cron(stepHarness(), url, async () => false)).unalerted, false);
  assert.equal((await cron(stepHarness(), { MAINTENANCE_DATABASE_URL: undefined }, async () => false)).unalerted, false);
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
