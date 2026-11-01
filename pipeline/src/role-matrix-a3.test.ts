// Role matrix result reporting (role-matrix-m1). Two halves:
//  - OFFLINE (always runs): a scripted client returns the matrix's final row; the executor must report the fixed
//    counts event, refuse on any failed probe or a missing/malformed row, and never print step_done after a failure.
//  - REAL POSTGRESQL (only when ROLE_MATRIX_A3_ADMIN_URL is set, loopback only): the real matrix file on a throwaway
//    database that holds M1 (scripts/a3-build-test-db.mjs). The healthy matrix passes with its real total; a
//    deliberately broken grant makes a probe fail, the run is refused, and nothing is left behind (rollback-only).
// Run: ROLE_MATRIX_A3_ADMIN_URL=postgresql://... npx tsx src/role-matrix-a3.test.ts

import assert from 'node:assert/strict';
import pg from 'pg';
import { readRoleMatrixCounts, REBUILT_STAGING_SQL_ACTIONS, executeRebuiltSqlPlan, planRebuiltSqlRun } from './staging-rebuilt.js';
import { REFUSAL_IDS, RunnerRefusal } from './refusals.js';

const REF = 'abcdefghijklmnopqrst';
const fake = `postgresql://postgres.${REF}:x@aws-0-us-east-2.pooler.supabase.com:5432/postgres`;
const spec = REBUILT_STAGING_SQL_ACTIONS['role-matrix-m1']!;
const plan = planRebuiltSqlRun({ action: 'role-matrix-m1', dbUrl: fake, confirm: spec.confirmation, recordedRebuiltRef: REF });

interface Outcome { events: Array<Record<string, unknown>>; error?: unknown }

async function run(clientFactory: () => never): Promise<Outcome> {
  const events: Array<Record<string, unknown>> = [];
  const logs = console.log; const errs = console.error;
  const grab = (l: unknown[]) => { try { events.push(JSON.parse(String(l[0])) as Record<string, unknown>); } catch { /* not an event line */ } };
  console.log = (...a: unknown[]) => grab(a); console.error = (...a: unknown[]) => grab(a);
  try {
    await executeRebuiltSqlPlan(plan, clientFactory);
    return { events };
  } catch (error) {
    return { events, error };
  } finally {
    console.log = logs; console.error = errs;
  }
}

const scripted = (finalResult: unknown) => () => ({
  connect: async () => undefined,
  query: async (sql: string) => (sql.startsWith('select set_config') ? { rows: [] } : finalResult),
  end: async () => undefined,
}) as never;
const matrixRow = (m: Record<string, unknown>) => [{ rows: [] }, { rows: [{ role_matrix: m }] }, { rows: [] }];
const msgs = (o: Outcome) => o.events.map((e) => e.msg);

async function offline(): Promise<void> {
  assert.equal(plan.roleMatrix, true, 'the plan marks role-matrix-m1');
  assert.ok(!planRebuiltSqlRun({ action: 'apply-m1', dbUrl: fake, confirm: REBUILT_STAGING_SQL_ACTIONS['apply-m1']!.confirmation, recordedRebuiltRef: REF }).roleMatrix, 'no other action is a matrix');
  for (const id of ['role_matrix_failed', 'role_matrix_result_missing']) assert.ok((REFUSAL_IDS as readonly string[]).includes(id), id);

  const ok = await run(scripted(matrixRow({ failures: 0, failed: [], passed: 62, total: 62 })));
  assert.equal(ok.error, undefined);
  assert.deepEqual(ok.events.find((e) => e.msg === 'staging-sql.role_matrix'), { msg: 'staging-sql.role_matrix', ok: true, total: 62, passed: 62, failed: 0 });
  assert.ok(msgs(ok).includes('staging-sql.step_done'));

  // counts come back as strings from some drivers (bigint): accepted
  assert.deepEqual(readRoleMatrixCounts(matrixRow({ failures: '0', passed: '3', total: '3' })), { total: 3, passed: 3, failed: 0 });

  const bad = await run(scripted(matrixRow({ failures: 2, failed: [{ actor: 'editor', test: 'x', expected: 'denied', observed: 'ROW DATA' }], passed: 60, total: 62 })));
  assert.ok(bad.error instanceof RunnerRefusal && bad.error.id === 'role_matrix_failed');
  assert.deepEqual(bad.events.find((e) => e.msg === 'staging-sql.role_matrix'), { msg: 'staging-sql.role_matrix', ok: false, total: 62, passed: 60, failed: 2 });
  assert.ok(!msgs(bad).includes('staging-sql.step_done'), 'a failing matrix never prints step_done');
  assert.ok(!JSON.stringify(bad.events).includes('ROW DATA'), 'no probe text in any event');

  for (const [label, result] of [
    ['no row', [{ rows: [] }]],
    ['zero probes', matrixRow({ failures: 0, passed: 0, total: 0 })],
    ['counts do not add up', matrixRow({ failures: 0, passed: 5, total: 62 })],
    ['negative', matrixRow({ failures: -1, passed: 63, total: 62 })],
    ['not a number', matrixRow({ failures: 'x', passed: 62, total: 62 })],
  ] as const) {
    const o = await run(scripted(result));
    assert.ok(o.error instanceof RunnerRefusal && o.error.id === 'role_matrix_result_missing', `${label}: refused as result_missing`);
    assert.ok(!msgs(o).includes('staging-sql.step_done'), `${label}: no step_done`);
    assert.equal(o.events.find((e) => e.msg === 'staging-sql.role_matrix')?.ok, false, `${label}: event says not ok`);
  }
  console.log('PASS offline role matrix reporting');
}

function loopback(raw: string): string {
  const u = new URL(raw);
  if (u.search || u.hash) throw new Error('refusing: a test URL must not carry a query string or fragment');
  if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') throw new Error('refusing: test URLs must be loopback');
  return raw;
}

async function real(adminUrl: string): Promise<void> {
  const url = loopback(adminUrl);
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  const q = (sql: string) => admin.query(sql);
  const snapshot = async () => JSON.stringify((await q(`select
      (select count(*) from internal.app_sessions) as sessions,
      (select count(*) from internal.recovery_sets) as recovery_sets,
      (select count(*) from public.profiles) as profiles,
      (select count(*) from public.batches) as batches`)).rows[0]);
  const factory = () => {
    const client = new pg.Client({ connectionString: url });
    return { on: (e: 'error', l: (err: Error) => void) => client.on(e, l), connect: () => client.connect(), query: (s: string, p?: unknown[]) => client.query(s, p as never), end: () => client.end() } as never;
  };
  try {
    const before = await snapshot();
    const good = await run(factory);
    assert.equal(good.error, undefined, `healthy matrix: ${String((good.error as Error)?.message)}`);
    const ev = good.events.find((e) => e.msg === 'staging-sql.role_matrix') as { ok: boolean; total: number; passed: number; failed: number };
    assert.ok(ev && ev.ok === true && ev.failed === 0 && ev.total > 0 && ev.passed === ev.total, `healthy counts ${JSON.stringify(ev)}`);
    assert.ok(msgs(good).includes('staging-sql.step_done'));
    assert.equal(await snapshot(), before, 'healthy run is rollback-only');
    console.log(`PASS real PG healthy matrix ${ev.passed}/${ev.total}`);

    // A deliberately broken grant: the matrix expects the app role to be able to run recovery_set_status (its 'allowed' probe).
    const sig = (await q(`select to_regprocedure('public.recovery_set_status(uuid,bigint,text)')::text as s`)).rows[0].s as string | null;
    const fn = sig ?? (await q(`select oid::regprocedure::text as s from pg_proc where proname = 'recovery_set_status' and pronamespace = 'public'::regnamespace`)).rows[0].s as string;
    const acl = async () => (await q(`select proacl::text as a from pg_proc where oid = '${fn}'::regprocedure`)).rows[0].a as string;
    const aclBefore = await acl();
    await q(`revoke execute on function ${fn} from recruiter_api`);
    try {
      const broken = await run(factory);
      assert.ok(broken.error, 'broken grant: run refused');
      assert.ok(broken.error instanceof RunnerRefusal && broken.error.id === 'role_matrix_failed');
      const bev = broken.events.find((e) => e.msg === 'staging-sql.role_matrix') as { ok: boolean; total: number; passed: number; failed: number };
      assert.ok(bev && bev.ok === false && bev.failed > 0 && bev.total === ev.total && bev.passed + bev.failed === bev.total, `broken counts ${JSON.stringify(bev)}`);
      assert.ok(!msgs(broken).includes('staging-sql.step_done'), 'no step_done after a failed probe');
      assert.equal(await snapshot(), before, 'broken run is rolled back too');
      console.log(`PASS real PG broken grant: ${bev.failed} of ${bev.total} failed, refused, rolled back`);
    } finally {
      await q(`grant execute on function ${fn} to recruiter_api`);
      assert.equal(await acl(), aclBefore, 'the grant is put back exactly');
    }
  } finally {
    await admin.end();
  }
}

async function main(): Promise<void> {
  await offline();
  const adminUrl = process.env.ROLE_MATRIX_A3_ADMIN_URL;
  if (!adminUrl) { console.log('skip real-PG half (set ROLE_MATRIX_A3_ADMIN_URL, loopback only)'); return; }
  await real(adminUrl);
}

main().catch((err) => { console.error(err); process.exit(1); });
