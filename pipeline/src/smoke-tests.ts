import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
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
import { REBUILT_STAGING_SQL_ACTIONS, executeRebuiltSqlPlan, planRebuiltSqlRun, requireRecordedRebuiltRef, retargetSqlToRebuiltRef } from './staging-rebuilt.js';
import { APPROVED_OWNER_EMAIL, OWNER_AUTH_CREATE_CONFIRMATION, planOwnerAuthCreate, runOwnerAuthCreate, type OwnerFetch } from './owner-bootstrap.js';
import { RECORDED_PROJECT_REFS, parseSupabaseDbTarget, verifyPipelineTarget } from './target-guard.js';
import { readFileSync } from 'node:fs';
import { REPOSITORY_ROOT } from './staging-rebuilt.js';
import { RETENTION_RULES, runRetention, type Queryable } from './retention.js';
import { AUDIT_FN_BODY_M1C, AUDIT_FN_DEF_M1C, AUDIT_FN_DEF_M1_PINNED, TABLE_CANON_M1C, collapseWhitespace } from './reapply-m1c-expected.js';
import { REAPPLY_PRECHECKS, classifyM1cState, idempotentReapplySql } from './reapply.js';
import { assessLedger, type LedgerFacts } from './ledger-preflight.js';
import { KNOWN_SERVER_REFUSALS, REFUSAL_IDS, RunnerRefusal, classifyRunnerFailure } from './refusals.js';
import { DENIED_STATEMENTS } from './retention-dry-run.js';
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

test('rebuilt staging runner: the recorded ref is the exact reviewed value, and only that ref (with the same guards) is accepted', () => {
  const { production, staging } = RECORDED_PROJECT_REFS;
  const rebuilt = 'abcdefghijklmnopqrst';
  const pooler = (ref: string, port = 5432) => `postgresql://postgres.${ref}:redacted@aws-0-us-east-2.pooler.supabase.com:${port}/postgres`;
  const fixtures = REBUILT_STAGING_SQL_ACTIONS['install-shutdown-fixtures']!;
  const plan = (over: Partial<Parameters<typeof planRebuiltSqlRun>[0]> = {}) =>
    planRebuiltSqlRun({ action: 'install-shutdown-fixtures', dbUrl: pooler(rebuilt), confirm: fixtures.confirmation, recordedRebuiltRef: rebuilt, ...over });

  // The recorded rebuilt ref (doc 16 R1 step 2) is exactly this reviewed value, 20 letters, and differs from production, the old staging and the test fixture.
  const recorded = String(RECORDED_PROJECT_REFS.stagingRebuilt);
  assert.equal(recorded, 'ojqtsftfclhxauhjwott');
  assert.match(String(recorded), /^[a-z]{20}$/);
  const others: string[] = [production, staging, rebuilt];
  assert.ok(!others.includes(recorded));
  // With the real default, the recorded ref is accepted and the test fixture ref (and any other) is refused.
  const real = planRebuiltSqlRun({ action: 'window-on', dbUrl: pooler(recorded), confirm: REBUILT_STAGING_SQL_ACTIONS['window-on']!.confirmation });
  assert.equal(real.target.projectRef, recorded);
  assert.throws(() => planRebuiltSqlRun({ action: 'window-on', dbUrl: pooler(production), confirm: REBUILT_STAGING_SQL_ACTIONS['window-on']!.confirmation }), /refuses the production/);
  assert.throws(() => planRebuiltSqlRun({ action: 'window-on', dbUrl: pooler(staging), confirm: REBUILT_STAGING_SQL_ACTIONS['window-on']!.confirmation }), /only targets the recorded rebuilt/);
  assert.throws(() => planRebuiltSqlRun({ action: 'window-on', dbUrl: pooler('zzzzzzzzzzzzzzzzzzzz'), confirm: REBUILT_STAGING_SQL_ACTIONS['window-on']!.confirmation }), /only targets the recorded rebuilt/);
  assert.throws(() => planRebuiltSqlRun({ action: 'window-on', dbUrl: pooler(rebuilt), confirm: REBUILT_STAGING_SQL_ACTIONS['window-on']!.confirmation }), /only targets the recorded rebuilt/); // the fixture ref is not the recorded one
  assert.throws(() => planRebuiltSqlRun({ action: 'window-on', dbUrl: pooler(rebuilt), confirm: REBUILT_STAGING_SQL_ACTIONS['window-on']!.confirmation, recordedRebuiltRef: null }), /not recorded yet/); // the unrecorded state still refuses

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
      dbUrl: spec.kind === 'retention' ? pooler(rebuilt).replace('postgres.', 'recruiter_maintenance.') : pooler(rebuilt),
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

test('reapply-m1c expected audit-function text is the reviewed M1c file text (offline drift guard)', () => {
  const file = readFileSync(resolve(REPOSITORY_ROOT, 'supabase/pending/M1c_batch_delete_audit.sql'), 'utf8').replace(/\r\n/g, '\n');
  const m = /create function internal\.batch_delete_audit_append_only\(\)\nreturns trigger\nlanguage plpgsql\nset search_path = internal, pg_temp\nas \$\$\n([\s\S]*?)\n\$\$;/.exec(file);
  assert.ok(m, 'the reviewed M1c file no longer has the audit function in the expected form; update reapply-m1c-expected.ts from a fresh local apply');
  assert.equal(m[1], AUDIT_FN_BODY_M1C);
  assert.ok(collapseWhitespace(AUDIT_FN_DEF_M1C).includes(collapseWhitespace(AUDIT_FN_BODY_M1C)));
  assert.ok(AUDIT_FN_DEF_M1_PINNED.includes("SET search_path TO 'public', 'internal', 'pg_temp'") && !AUDIT_FN_DEF_M1_PINNED.includes("TO 'internal', 'pg_temp'"));
  for (const col of ['id', 'batch_id', 'batch_name', 'actor_id', 'deleted_at', 'member_count']) assert.ok(TABLE_CANON_M1C.includes(`${col} `));
});

test('reapply-m1c state classification: backed-out state and the interrupted-run state are the only accepted ones; every guard fact must be true', async () => {
  const intact = { audit_table: true, trigger_function: true, trigger_function_pinned: false, triggers: true, table_shape: true, table_acl_clean: true, function_acl_clean: true, batch_delete: false, batch_delete_acl_ok: true, batches_delete_clean: true, service_role_direct_execute: false, service_role_other_path_execute: false };
  const interrupted = { ...intact, trigger_function_pinned: true, batch_delete: true, service_role_direct_execute: true };
  // backed-out state (batch_delete absent): normal when the retained guards are intact, with or without the direct entry
  assert.equal(classifyM1cState(intact).state, 'normal');
  assert.equal(classifyM1cState({ ...intact, service_role_direct_execute: true }).state, 'normal');
  assert.equal(classifyM1cState({ ...intact, audit_table: false, trigger_function: false, triggers: false, table_shape: false }).state, 'normal'); // the plan's own precheck then refuses
  for (const k of ['trigger_function', 'triggers', 'table_shape', 'table_acl_clean', 'function_acl_clean'] as const) {
    const c = classifyM1cState({ ...intact, [k]: false });
    assert.equal(c.state, 'refuse', `backed-out with ${k} false`);
    assert.deepEqual(c.failed, [k]);
  }
  assert.equal(classifyM1cState({ ...intact, service_role_other_path_execute: true }).state, 'refuse');
  // interrupted state: exactly one accepted shape
  assert.equal(classifyM1cState(interrupted).state, 'recover');
  for (const k of ['audit_table', 'trigger_function', 'trigger_function_pinned', 'triggers', 'table_shape', 'table_acl_clean', 'function_acl_clean', 'batch_delete_acl_ok', 'batches_delete_clean', 'service_role_direct_execute'] as const) {
    assert.equal(classifyM1cState({ ...interrupted, [k]: false }).state, 'refuse', `interrupted with ${k} false`);
  }
  assert.equal(classifyM1cState({ ...interrupted, service_role_other_path_execute: true }).state, 'refuse');
  assert.equal(classifyM1cState({ ...interrupted, triggers: undefined as unknown as boolean }).state, 'refuse');
  // plan + executor against a fake client
  const rebuilt = 'abcdefghijklmnopqrst';
  const url = `postgresql://postgres.${rebuilt}:redacted-pw@aws-0-us-east-2.pooler.supabase.com:5432/postgres`;
  const spec = REBUILT_STAGING_SQL_ACTIONS['reapply-m1c']!;
  const plan = planRebuiltSqlRun({ action: 'reapply-m1c', dbUrl: url, confirm: spec.confirmation, recordedRebuiltRef: rebuilt });
  const run = async (facts: Record<string, boolean>, stillExecutes = false) => {
    const sent: string[] = [];
    const client = {
      async connect() {},
      async query(sql: string) {
        sent.push(sql);
        if (/audit_table/.test(sql)) return { rows: [facts] };
        if (/as service_role_execute/.test(sql)) return { rows: [{ service_role_execute: stillExecutes }] };
        return { rows: [] };
      },
      async end() {},
    };
    const logs = console.log; const errs = console.error; console.log = () => undefined; console.error = () => undefined;
    try { await executeRebuiltSqlPlan(plan, () => client); } finally { console.log = logs; console.error = errs; }
    return sent.filter((q) => !/set_config|audit_table|as service_role_execute/.test(q));
  };
  assert.deepEqual(await run(intact), plan.steps.map((st) => st.sql));
  assert.deepEqual(await run(interrupted), [plan.steps[plan.steps.length - 1]!.sql]);
  await assert.rejects(run({ ...interrupted, triggers: false }), /refused/);
  await assert.rejects(run({ ...intact, triggers: false }), /refused/);
  await assert.rejects(run({ ...interrupted, service_role_other_path_execute: true }), /refused/);
  // postcondition: after the revoke, effective EXECUTE must be gone or the run does not report success
  await assert.rejects(run(interrupted, true), /still has effective EXECUTE/);
  await assert.rejects(run(intact, true), /still has effective EXECUTE/);
});

test('re-apply after backout: only idempotence guards are added; the reviewed files are not edited; unknown creators fail closed', () => {
  const rebuilt = 'abcdefghijklmnopqrst';
  const pooler = `postgresql://postgres.${rebuilt}:redacted-pw@aws-0-us-east-2.pooler.supabase.com:5432/postgres`;
  for (const [action, pre] of [['reapply-m1', 'm1'], ['reapply-m1b', 'm1b'], ['reapply-m1c', 'm1c']] as const) {
    const spec = REBUILT_STAGING_SQL_ACTIONS[action]!;
    const plan = planRebuiltSqlRun({ action, dbUrl: pooler, confirm: spec.confirmation, recordedRebuiltRef: rebuilt });
    assert.deepEqual(plan.steps.map((st) => st.transaction), pre === 'm1c' ? [false, false, false] : [false, false]);
    if (pre === 'm1c') assert.equal(plan.steps[2]!.sql, 'revoke execute on function internal.batch_delete_audit_append_only() from service_role;');
    assert.equal(plan.steps[0]!.sql, REAPPLY_PRECHECKS[pre]);
    const sent = plan.steps[1]!.sql;
    const original = readFileSync(resolve(REPOSITORY_ROOT, spec.file!), 'utf8').replace(/\r\n/g, '\n');
    // Undoing exactly the guards gives back the reviewed file (compared with every `create [or replace] function` unified).
    const undone = sent
      .replace(/^drop trigger if exists \w+ on [\w.]+;\n/gm, '')
      .replace(/^create table if not exists internal\./gm, 'create table internal.')
      .replace(/^create (unique )?index if not exists /gm, (_m, u) => `create ${u ?? ''}index `)
      .replace(/^create or replace function\b/gm, 'create function')
      .replace(/ on conflict do nothing;/g, ';');
    assert.equal(undone, original.replace(/^create or replace function\b/gm, 'create function'), action);
  }
  assert.equal(
    idempotentReapplySql('create table internal.t (a int);\ncreate index i on internal.t (a);\ncreate function f() returns int language sql as $$ select 1 $$;\ninsert into internal.roster_lock default values;'),
    'create table if not exists internal.t (a int);\ncreate index if not exists i on internal.t (a);\ncreate or replace function f() returns int language sql as $$ select 1 $$;\ninsert into internal.roster_lock default values on conflict do nothing;',
  );
  assert.throws(() => idempotentReapplySql('create sequence internal.s;'), /unguarded creating statement/);
  assert.throws(() => idempotentReapplySql("create type internal.t as enum ('a');"), /unguarded creating statement/);
  assert.throws(() => idempotentReapplySql('create view internal.v as select 1;'), /unguarded creating statement/);
});

test('retention-dry-run: only as recruiter_maintenance on the rebuilt project; counts, never deletes, reports a failed check', async () => {
  const rebuilt = 'abcdefghijklmnopqrst';
  const url = (role: string) => `postgresql://${role}.${rebuilt}:redacted-pw@aws-0-us-east-2.pooler.supabase.com:5432/postgres`;
  const confirm = REBUILT_STAGING_SQL_ACTIONS['retention-dry-run']!.confirmation;
  const plan = (dbUrl: string, over: Record<string, unknown> = {}) => planRebuiltSqlRun({ action: 'retention-dry-run', dbUrl, confirm, recordedRebuiltRef: rebuilt, ...over });
  assert.equal(plan(url('recruiter_maintenance')).kind, 'retention');
  assert.throws(() => plan(url('postgres')), /must connect as recruiter_maintenance/);
  assert.throws(() => plan(url('recruiter_app')), /must connect as recruiter_maintenance/);
  assert.throws(() => plan(url('recruiter_maintenance').replace(':5432/', ':6543/')), /port 5432/);
  assert.throws(() => plan(url('recruiter_maintenance'), { confirm: 'nope' }), /--confirm=/);
  assert.throws(() => plan(url('recruiter_maintenance'), { out: '/x' }), /only valid for snapshot/);

  // Fake session: counts come back, every denied statement is refused with 42501.
  const sent: string[] = [];
  const session = (refuseAll: boolean) => ({
    async connect() {},
    async end() {},
    async query(sql: string, params?: unknown[]) {
      sent.push(sql);
      if (/current_user as u/.test(sql)) return { rows: [{ u: 'recruiter_maintenance' }] };
      if (/count\(\*\)::int/.test(sql)) return { rows: [{ n: 3 }] };
      if (/has_table_privilege/.test(sql)) return { rows: [{ s: true, d: true, i: false, u: false, t: false }] };
      if (DENIED.some((d) => sql === d)) {
        if (refuseAll) throw Object.assign(new Error('permission denied'), { code: '42501' });
        return { rows: [] };
      }
      return { rows: [] };
    },
  });
  const DENIED = DENIED_STATEMENTS.map((d) => d.sql);
  const lines: string[] = [];
  const origLog = console.log; console.log = (m: string) => lines.push(m);
  try {
    await executeRebuiltSqlPlan(plan(url('recruiter_maintenance')), () => session(true));
  } finally { console.log = origLog; }
  const report = JSON.parse(lines.find((l) => l.includes('retention_dry_run'))!);
  assert.equal(report.ok, true);
  assert.deepEqual(Object.keys(report.wouldDelete).sort(), ['app_sessions', 'email_events', 'recovery_failures', 'request_buckets', 'signin_links']);
  assert.ok(Object.values(report.wouldDelete).every((n) => n === 3));
  assert.ok(!sent.some((q) => /^\s*delete/i.test(q)), 'never deletes');
  assert.equal(sent.filter((q) => q === 'rollback').length, 2);
  assert.ok(!sent.includes('commit'));
  assert.ok(!lines.join('').includes('redacted-pw'));
  // A role that is NOT refused fails the run.
  console.log = () => undefined;
  try {
    await assert.rejects(executeRebuiltSqlPlan(plan(url('recruiter_maintenance')), () => session(false)), /check\(s\) failed/);
  } finally { console.log = origLog; }
});

const LEDGER_ABSENT: LedgerFacts = { profiles_absent: true, schema_exists: false, table_exists: false, db_create: true, schema_usage: null, schema_create: null, table_ordinary: null, version_text_not_null: null, statements_type: null, name_type: null, other_columns: null, special_columns: null, version_key: null, other_constraints: null, other_indexes: null, has_triggers_rules_rls: null, can_select: null, can_insert: null, owner_is_runner: null };
const LEDGER_CLI: LedgerFacts = { ...LEDGER_ABSENT, schema_exists: true, table_exists: true, schema_usage: true, schema_create: true, table_ordinary: true, version_text_not_null: true, statements_type: 'text[]', name_type: 'text', other_columns: 0, special_columns: 0, version_key: true, other_constraints: 0, other_indexes: 0, has_triggers_rules_rls: false, can_select: true, can_insert: true, owner_is_runner: true };

test('ledger preflight: every uncertain or incompatible ledger shape is a failed check; only the known shapes pass', () => {
  const failing = (f: Partial<LedgerFacts>, rows: number | null = 0) => assessLedger({ ...LEDGER_CLI, ...f }, rows).checks.filter((c) => !c.ok).map((c) => c.check);
  assert.equal(assessLedger(LEDGER_ABSENT, null).ok, true);
  assert.equal(assessLedger(LEDGER_ABSENT, null).case, 'schema_absent');
  assert.deepEqual(assessLedger({ ...LEDGER_ABSENT, db_create: false }, null).checks.filter((c) => !c.ok).map((c) => c.check), ['runner_can_create_schema']);
  assert.equal(assessLedger({ ...LEDGER_ABSENT, schema_exists: true, schema_usage: true, schema_create: true }, null).ok, true);
  assert.deepEqual(assessLedger({ ...LEDGER_ABSENT, schema_exists: true, schema_usage: true, schema_create: false }, null).checks.filter((c) => !c.ok).map((c) => c.check), ['runner_can_create_table_in_schema']);
  assert.equal(assessLedger(LEDGER_CLI, 0).ok, true);
  assert.equal(assessLedger({ ...LEDGER_CLI, statements_type: 'absent', name_type: 'absent' }, 0).ok, true);
  assert.deepEqual(failing({ db_create: false }), ['runner_can_create_schema']); // checked before IF NOT EXISTS, so also when the schema and table exist
  assert.deepEqual(failing({ owner_is_runner: false }), ['runner_owns_ledger_table']); // even when no column has to be added: the ALTER ... IF NOT EXISTS is unconditional
  assert.deepEqual(failing({ statements_type: 'absent', owner_is_runner: false }), ['runner_owns_ledger_table']);
  assert.deepEqual(failing({ owner_is_runner: null }), ['runner_owns_ledger_table']);
  assert.deepEqual(failing({}, 1), ['ledger_is_empty']);
  assert.deepEqual(failing({}, null), ['ledger_is_empty']);
  assert.deepEqual(failing({ profiles_absent: false }), ['public_profiles_absent']);
  assert.deepEqual(failing({ statements_type: 'text' }), ['statements_is_text_array_or_absent']);
  assert.deepEqual(failing({ statements_type: 'integer[]' }), ['statements_is_text_array_or_absent']);
  assert.deepEqual(failing({ name_type: 'integer' }), ['name_is_text_or_absent']);
  assert.deepEqual(failing({ version_text_not_null: false }), ['version_is_text_not_null']);
  assert.deepEqual(failing({ other_columns: 1 }), ['only_the_reviewed_columns']);
  assert.deepEqual(failing({ special_columns: 1 }), ['reviewed_columns_have_no_default_identity_or_generation']);
  // the catalogue-derived type text is never part of the printed output
  assert.ok(assessLedger({ ...LEDGER_CLI, statements_type: 'secret-looking-type' }, 0).checks.every((c) => c.detail === undefined || /^([0-9]+|unreadable)$/.test(c.detail)));
  assert.deepEqual(failing({ version_key: false }), ['version_is_the_primary_or_unique_key']);
  assert.deepEqual(failing({ other_constraints: 1 }), ['no_other_constraints']);
  assert.deepEqual(failing({ other_indexes: 1 }), ['no_other_indexes']);
  assert.deepEqual(failing({ has_triggers_rules_rls: true }), ['no_triggers_rules_or_row_security']);
  assert.deepEqual(failing({ can_insert: false }), ['runner_can_insert']);
  assert.deepEqual(failing({ can_select: false }, null), ['runner_can_select', 'ledger_is_empty']);
  assert.deepEqual(failing({ table_ordinary: false }), ['ledger_is_ordinary_table']);
  // a missing fact is a failure, never a pass
  assert.equal(assessLedger({ ...LEDGER_CLI, version_key: undefined as unknown as boolean }, 0).ok, false);
});

test('environment preflight action: read-only, reports identifiers/booleans/counts only, is a report (no pass/fail), and is a recorded-ref, typed-confirmation action', async () => {
  const rebuilt = 'abcdefghijklmnopqrst';
  const url = `postgresql://postgres.${rebuilt}:redacted-pw@aws-0-us-east-2.pooler.supabase.com:5432/postgres`;
  const spec = REBUILT_STAGING_SQL_ACTIONS['environment-preflight']!;
  assert.equal(spec.confirmation, 'RUN TNBS ENVIRONMENT PREFLIGHT');
  assert.throws(() => planRebuiltSqlRun({ action: 'environment-preflight', dbUrl: url, confirm: 'wrong', recordedRebuiltRef: rebuilt }), /requires --confirm/);
  assert.throws(() => planRebuiltSqlRun({ action: 'environment-preflight', dbUrl: url.replace(rebuilt, 'zzzzzzzzzzzzzzzzzzzz'), confirm: spec.confirmation, recordedRebuiltRef: rebuilt }), /only targets the recorded rebuilt/);
  const plan = planRebuiltSqlRun({ action: 'environment-preflight', dbUrl: url, confirm: spec.confirmation, recordedRebuiltRef: rebuilt });
  assert.equal(plan.kind, 'environment-preflight');
  const sent: string[] = [];
  const client = {
    async connect() {},
    async query(sql: string) {
      sent.push(sql);
      if (/join pg_proc/.test(sql)) return { rows: [{ name: 'pgrst_ddl_watch', event: 'ddl_command_end', enabled: 'O', function: 'pgrst_ddl_watch' }, { name: 'weird name with spaces', event: 'ddl_command_end', enabled: 'O', function: 'rls_auto_enable' }] };
      if (sql.includes('as total from pg_event_trigger')) return { rows: [{ total: 2 }] };
      if (sql.includes('where r.rolname in')) return { rows: [{ role: 'anon' }, { role: 'authenticated' }, { role: 'authenticator' }] };
      if (/from pg_default_acl/.test(sql)) return { rows: [{ grantee: 'anon', objtype: 'r', scope: 'public', privilege: 'SELECT', grantable: false }, { grantee: 'anon', objtype: 'r', scope: 'public', privilege: 'INSERT', grantable: false }, { grantee: 'PUBLIC', objtype: 'f', scope: 'global', privilege: 'EXECUTE', grantable: false }, { grantee: 'anon', objtype: 'n', scope: 'public', privilege: 'USAGE', grantable: false }] };
      if (/authenticator_exists/.test(sql)) return { rows: [{ authenticator_exists: true, role_wide_entries: 1, this_database_entries: 0, names_public_if_single: true }] };
      return { rows: [] };
    },
    async end() {},
  };
  const lines: string[] = []; const l = console.log;
  console.log = (...a: unknown[]) => { lines.push(String(a[0])); };
  try { await executeRebuiltSqlPlan(plan, () => client); } finally { console.log = l; }
  assert.ok(sent.includes('begin read only') && sent.includes('rollback') && sent.every((q) => !/^(insert|create|alter|drop|update|delete|grant|revoke)/i.test(q.trim())));
  assert.ok(lines.some((x) => /"msg":"staging-sql.environment_event_triggers","count":2,"listed":2,"truncated":false/.test(x)));
  assert.ok(lines.every((x) => !/enables_rls/.test(x)), 'no heuristic verdict about function text is printed');
  assert.ok(lines.some((x) => /"name":"other"/.test(x)), 'a name that is not a plain identifier is never printed');
  assert.ok(lines.some((x) => x.includes('"msg":"staging-sql.environment_default_acl","role":"anon","role_present":true,"tables_public":["INSERT","SELECT"],"sequences_public":[],"functions_public":[]')), 'full privilege types, not a boolean');
  assert.ok(lines.some((x) => /"msg":"staging-sql.environment_default_acl","role":"service_role","role_present":false/.test(x)), 'a missing role is reported as missing');
  assert.ok(lines.some((x) => x.includes('"role":"PUBLIC"') && x.includes('"functions_global":["EXECUTE"]')));
  assert.ok(lines.some((x) => /"msg":"staging-sql.environment_default_acl_total","entries":4,"outside_these_cells":1/.test(x)));
  assert.ok(lines.some((x) => /"msg":"staging-sql.environment_authenticator_setting".*"names_public":true,"is_the_data_api_switch":false/.test(x)));
  assert.ok(lines.every((x) => !/weird name|redacted-pw|pooler/.test(x)));
});

test('owner Auth create (G1 step 1): exact request to the recorded address, one attempt, created only on a matching body; every other outcome stops; tested against a LOCAL fake HTTP server only', async () => {
  const ref = 'abcdefghijklmnopqrst';
  const key = 'sb-test-service-role-key-0123456789';
  const password = 'Owner-Test-Password-9981!';
  assert.throws(() => planOwnerAuthCreate({ ref, confirm: 'wrong', serviceRoleKey: key, password }), /requires --confirm/);
  assert.throws(() => planOwnerAuthCreate({ ref, confirm: OWNER_AUTH_CREATE_CONFIRMATION, serviceRoleKey: key, password: 'short' }), /at least 16/);
  assert.throws(() => planOwnerAuthCreate({ ref, confirm: OWNER_AUTH_CREATE_CONFIRMATION, serviceRoleKey: key, password: ' leading-space-password ' }), /at least 16/);
  assert.throws(() => planOwnerAuthCreate({ ref, confirm: OWNER_AUTH_CREATE_CONFIRMATION, serviceRoleKey: 'has space in it 0123456789', password }), /SUPABASE_SERVICE_ROLE_KEY/);
  assert.throws(() => planOwnerAuthCreate({ ref, confirm: OWNER_AUTH_CREATE_CONFIRMATION, serviceRoleKey: undefined, password }), /SUPABASE_SERVICE_ROLE_KEY/);
  // the address is derived from the verified recorded ref only; production, the old staging ref and malformed refs are refused first
  assert.equal(requireRecordedRebuiltRef(), RECORDED_PROJECT_REFS.stagingRebuilt);
  assert.throws(() => requireRecordedRebuiltRef(RECORDED_PROJECT_REFS.production), /invalid or equals/);
  assert.throws(() => requireRecordedRebuiltRef(RECORDED_PROJECT_REFS.staging), /invalid or equals/);
  assert.throws(() => requireRecordedRebuiltRef(null), /not recorded yet/);
  assert.throws(() => requireRecordedRebuiltRef('short'), /invalid or equals/);
  const plan = planOwnerAuthCreate({ ref, confirm: OWNER_AUTH_CREATE_CONFIRMATION, serviceRoleKey: key, password });
  assert.equal(plan.baseUrl, `https://${ref}.supabase.co`);
  assert.equal(plan.email, APPROVED_OWNER_EMAIL);

  type Seen = { method?: string; url?: string; apikey?: string; auth?: string; body?: Record<string, unknown> };
  const seen: Seen[] = [];
  let behaviour: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void = () => undefined;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += String(c); });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, apikey: String(req.headers.apikey), auth: String(req.headers.authorization), body: JSON.parse(raw) });
      behaviour(req, res);
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as import('node:net').AddressInfo).port;
  const requested: string[] = [];
  // Only a loopback address is ever contacted: the production address is asserted, then rewritten to the fake server.
  const toLocal = (timeoutMs?: number): OwnerFetch => (url, init) => {
    requested.push(url);
    return fetch(url.replace(`https://${ref}.supabase.co`, `http://127.0.0.1:${port}`), timeoutMs ? { ...init, signal: AbortSignal.timeout(timeoutMs) } : init);
  };
  const reply = (status: number, body: unknown) => (_q: unknown, res: import('node:http').ServerResponse) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
  const uuid = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
  const lines: string[] = []; const l = console.log;
  const attempt = async (fetchImpl: OwnerFetch) => {
    seen.length = 0; lines.length = 0;
    console.log = (...a: unknown[]) => { lines.push(String(a[0])); };
    try { return await runOwnerAuthCreate(plan, fetchImpl).then(() => undefined, (e: unknown) => e); } finally { console.log = l; }
  };
  try {
    behaviour = reply(200, { id: uuid, email: APPROVED_OWNER_EMAIL, role: 'authenticated', aud: 'authenticated' });
    assert.equal(await attempt(toLocal()), undefined);
    assert.equal(seen.length, 1, 'exactly one request, no retry');
    assert.deepEqual({ method: seen[0]!.method, url: seen[0]!.url, apikey: seen[0]!.apikey, auth: seen[0]!.auth }, { method: 'POST', url: '/auth/v1/admin/users', apikey: key, auth: `Bearer ${key}` });
    assert.deepEqual(seen[0]!.body, { email: APPROVED_OWNER_EMAIL, password, email_confirm: true }, 'confirmed email, no invite, no other fields');
    assert.equal(requested.at(-1), `https://${ref}.supabase.co/auth/v1/admin/users`);
    assert.deepEqual(lines.map((x) => JSON.parse(x)), [{ msg: 'staging-sql.owner_auth_create', result: 'created', http_status: 200, email_matches: true, id_present: true }]);
    assert.ok(lines.every((x) => !x.includes(key) && !x.includes(password) && !x.includes(uuid)), 'the key, the password and the new id are never printed');

    behaviour = reply(200, { id: uuid, email: 'HUNTER@TWISTEDNAIL.COM' });
    assert.equal(await attempt(toLocal()), undefined, 'a case difference in the echoed address is the same address');

    for (const [label, status, body, want] of [
      ['already registered', 422, { code: 'email_exists' }, 'owner_auth_not_created'],
      ['bad key', 401, { message: 'invalid' }, 'owner_auth_not_created'],
      ['server error', 500, { message: 'boom' }, 'owner_auth_unknown_result'],
      ['bad gateway', 502, 'bad gateway', 'owner_auth_unknown_result'],
      ['success but a different email', 200, { id: uuid, email: 'someone.else@example.invalid' }, 'owner_auth_unknown_result'],
      ['success without an id', 200, { email: APPROVED_OWNER_EMAIL }, 'owner_auth_unknown_result'],
      ['success with an unparsable body', 200, 'not json', 'owner_auth_unknown_result'],
    ] as const) {
      behaviour = reply(status, body);
      const err = await attempt(toLocal());
      assert.ok(err instanceof RunnerRefusal && err.id === want, `${label}: expected ${want}, got ${String(err)}`);
      assert.equal(seen.length, 1, `${label}: no retry`);
      assert.deepEqual(classifyRunnerFailure(err), { refusal: want });
      assert.ok(lines.every((x) => !x.includes(key) && !x.includes(password)), `${label}: nothing secret printed`);
    }
    assert.match(lines[0]!, /"result":"unknown"/);
    // connection dropped without a response, redirect, and a hung server (shortened timeout) are all unknown, one attempt each
    behaviour = (req) => { req.socket.destroy(); };
    let err = await attempt(toLocal());
    assert.ok(err instanceof RunnerRefusal && err.id === 'owner_auth_unknown_result' && seen.length === 1, 'dropped connection is unknown');
    behaviour = (_q, res) => { res.writeHead(302, { location: '/elsewhere' }); res.end(); };
    err = await attempt(toLocal());
    assert.ok(err instanceof RunnerRefusal && err.id === 'owner_auth_unknown_result' && seen.length === 1, 'a redirect is not followed and is unknown');
    behaviour = () => undefined;
    err = await attempt(toLocal(60));
    assert.ok(err instanceof RunnerRefusal && err.id === 'owner_auth_unknown_result' && seen.length === 1, 'a timeout is unknown');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test('ledger preflight action: read-only, reports check names and counts, stops the replay when a check fails, verifies the full (version, name) set', async () => {
  const rebuilt = 'abcdefghijklmnopqrst';
  const url = `postgresql://postgres.${rebuilt}:redacted-pw@aws-0-us-east-2.pooler.supabase.com:5432/postgres`;
  const pre = REBUILT_STAGING_SQL_ACTIONS['ledger-preflight']!;
  const prePlan = planRebuiltSqlRun({ action: 'ledger-preflight', dbUrl: url, confirm: pre.confirmation, recordedRebuiltRef: rebuilt });
  assert.equal(prePlan.kind, 'ledger-preflight');
  const mig = planRebuiltSqlRun({ action: 'apply-migrations', dbUrl: url, confirm: REBUILT_STAGING_SQL_ACTIONS['apply-migrations']!.confirmation, recordedRebuiltRef: rebuilt });
  const make = (facts: LedgerFacts, ledgerRows: Array<{ version: string; name: string }>) => {
    const sent: string[] = [];
    const client = {
      async connect() {},
      async query(sql: string) {
        sent.push(sql);
        if (/from pg_namespace n where n.nspname = 'supabase_migrations'/.test(sql)) return { rows: [facts] };
        if (/order by version/.test(sql)) return { rows: ledgerRows };
        if (/to_regclass/.test(sql)) return { rows: [{ t: null }] };
        if (/count\(\*\)::int/.test(sql)) return { rows: [{ n: 0 }] };
        return { rows: [] };
      },
      async end() {},
    };
    return { client, sent };
  };
  const quiet = async <T>(fn: () => Promise<T>): Promise<{ result?: T; error?: unknown; lines: string[] }> => {
    const lines: string[] = []; const l = console.log; const e = console.error;
    console.log = (...a: unknown[]) => { lines.push(String(a[0])); }; console.error = (...a: unknown[]) => { lines.push(String(a[0])); };
    try { return { result: await fn(), lines }; } catch (error) { return { error, lines }; } finally { console.log = l; console.error = e; }
  };
  // preflight alone: passes on an absent ledger, sends only reads, prints names and counts
  const ok = make(LEDGER_ABSENT, []);
  const r1 = await quiet(() => executeRebuiltSqlPlan(prePlan, () => ok.client));
  assert.equal(r1.error, undefined);
  assert.ok(r1.lines.some((x) => /"msg":"staging-sql.ledger_preflight".*"ok":true.*"failed":0/.test(x)));
  assert.ok(ok.sent.every((q) => !/^(insert|create|alter|drop|update|delete)/i.test(q.trim())) && ok.sent.includes('begin read only') && ok.sent.includes('rollback'));
  // a failing check stops both the preflight action and the replay before any file is sent
  const bad = { ...LEDGER_CLI, statements_type: 'text' };
  for (const plan of [prePlan, mig]) {
    const m = make(bad, []);
    const r = await quiet(() => executeRebuiltSqlPlan(plan, () => m.client));
    assert.match(String((r.error as Error).message), /ledger preflight: 1 check\(s\) failed/);
    assert.ok(r.lines.some((x) => x.includes('statements_is_text_array_or_absent') && x.includes('"ok":false')));
    assert.ok(!m.sent.includes('begin') && !m.sent.some((q) => /create schema/.test(q)), 'nothing was written');
  }
  // the replay verifies the exact pairs: a wrong name or a missing row is a failure
  const wanted = mig.steps.map((st) => st.ledger!);
  const good = make(LEDGER_ABSENT, wanted);
  const r2 = await quiet(() => executeRebuiltSqlPlan(mig, () => good.client));
  assert.equal(r2.error, undefined);
  assert.ok(r2.lines.some((x) => /"msg":"staging-sql.ledger_verified","expected":20,"found":20,"exact_match":true/.test(x)));
  for (const rows of [wanted.slice(0, 19), [...wanted.slice(0, 19), { ...wanted[19]!, name: 'other' }]]) {
    const w = make(LEDGER_ABSENT, rows);
    const r = await quiet(() => executeRebuiltSqlPlan(mig, () => w.client));
    assert.match(String((r.error as Error).message), /exactly the reviewed/);
  }
});

test('failure output: only a fixed identifier and a validated code are ever produced; no part of a message is forwarded', () => {
  const url = 'postgresql://postgres.abcdefghijklmnopqrst:Zq%40x-Secret-Pw-9981@aws-0-us-east-2.pooler.supabase.com:5432/postgres';
  const driver = Object.assign(new Error(`connect ECONNREFUSED 10.20.30.40:5432 for ${url}`), { code: 'ECONNREFUSED' });
  assert.deepEqual(classifyRunnerFailure(driver), { refusal: 'server_or_driver_error', err_code: 'ECONNREFUSED' });
  assert.deepEqual(classifyRunnerFailure(new Error('anything at all')), { refusal: 'server_or_driver_error' });
  assert.deepEqual(classifyRunnerFailure(Object.assign(new Error('x'), { code: 'not a code; secret' })), { refusal: 'server_or_driver_error' });
  assert.deepEqual(classifyRunnerFailure(new RunnerRefusal('port_must_be_5432', 'a long message')), { refusal: 'port_must_be_5432' });
  // a server exception that merely STARTS like a known refusal (the forged-prefix case) is generic, whatever follows
  const forged = Object.assign(new Error('re-apply M1c refused: the retained audit table is missing (this is not a backed-out database); use the plain apply action fragment-Zq9981-xyz'), { code: 'P0001' });
  assert.deepEqual(classifyRunnerFailure(forged), { refusal: 'server_or_driver_error', err_code: 'P0001' });
  assert.ok(!JSON.stringify(classifyRunnerFailure(forged)).includes('fragment'));
  // ...but the complete known message is recognised
  const exact = new Error('re-apply M1c refused: M1c is still applied; run its backout first');
  assert.deepEqual(classifyRunnerFailure(exact), { refusal: 'reapply_m1c_still_applied' });
  // every known server message is really raised by the re-apply prechecks, and every id used is on the list
  const raised = Object.values(REAPPLY_PRECHECKS).flatMap((sql) => [...sql.matchAll(/raise exception '([^']+)'/g)].map((m) => m[1]));
  assert.deepEqual([...raised].sort(), Object.keys(KNOWN_SERVER_REFUSALS).sort());
  for (const id of Object.values(KNOWN_SERVER_REFUSALS)) assert.ok((REFUSAL_IDS as readonly string[]).includes(id));
  assert.equal(new Set(REFUSAL_IDS).size, REFUSAL_IDS.length);
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
      if (/from pg_namespace n where n.nspname = 'supabase_migrations'/.test(sql)) return { rows: [LEDGER_ABSENT] };
      if (/order by version/.test(sql)) return { rows: plan.steps.slice(0, 2).map((st) => st.ledger!) };
      if (/to_regclass/.test(sql)) return { rows: [{ t: null }] };
      if (/count\(\*\)::int/.test(sql)) return { rows: [{ n: 0 }] };
      return { rows: [] };
    },
    async end() {},
  };
  await executeRebuiltSqlPlan({ ...plan, steps: plan.steps.slice(0, 2) }, () => client);
  assert.ok(sent.indexOf('begin read only') >= 0 && sent.indexOf('begin read only') < sent.indexOf('begin'), 'the read-only ledger preflight runs before the first file');
  const afterGuards = sent.findIndex((q) => q === 'begin');
  assert.deepEqual(
    sent.slice(afterGuards).filter((q) => !/order by version/.test(q)).map((q) => (q.startsWith('insert into supabase_migrations') ? q.replace(/^.*\(\$1, \$2, array\[\]::text\[\]\)/, 'insert') : q === 'begin' || q === 'commit' ? q : 'sql')),
    ['begin', 'sql', 'insert [\"20260720000100\",\"extensions\"]', 'commit', 'begin', 'sql', 'insert [\"20260720000200\",\"enums\"]', 'commit'],
  );
  // A failing file is rolled back (the insert never commits) and nothing later runs.
  const failing = { ...client, async query(sql: string, params?: unknown[]) { sent.push(sql); if (/from pg_namespace n where n.nspname = 'supabase_migrations'/.test(sql)) return { rows: [LEDGER_ABSENT] }; if (/to_regclass/.test(sql)) return { rows: [{ t: null }] }; if (/count\(\*\)::int/.test(sql)) return { rows: [{ n: 0 }] }; if (sql.startsWith('-- fail')) throw new Error('boom'); return { rows: [] }; } };
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
