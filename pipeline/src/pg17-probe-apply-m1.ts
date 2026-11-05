// A3 LOCAL only (TRUCKRECRU-149): the M1 step of scripts/pg17-probe.mjs --apply-m1, on that probe's own throwaway cluster. It does
// what m1-supabase-runner-a3.test.ts does before its case 2 (PostGIS in public): as the superuser, that suite's runner setup
// (copied in m1-supabase-runner-setup.ts: a NOSUPERUSER CREATEROLE INHERIT login, the handover, membership of anon/authenticated/service_role)
// and PUBLIC EXECUTE on the PostGIS stand-ins; then, logged in as that runner, the staging runner's real apply-m1 plan and executor
// (planRebuiltSqlRun / executeRebuiltSqlPlan) with an injected loopback client. No SQL file is changed or altered in memory.
// Env: PG17_PROBE_ADMIN_URL (superuser URL of a loopback tr_ database built with a3-build-test-db.mjs --no-m1 --no-m1b --no-m1c),
// PG17_PROBE_RUNNER_PW (the runner login's throwaway password). Never prints either. Exit 0 = M1 applied; 1 = it did not.

import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { executeRebuiltSqlPlan, planRebuiltSqlRun, REBUILT_STAGING_SQL_ACTIONS } from './staging-rebuilt.js';
import { FAKE_URL, PUBLIC_EXECUTE_SQL, REF, RUNNER, runnerSetupStatements } from './m1-supabase-runner-setup.js';

/** The admin URL if it is loopback, has no query or fragment and names a tr_ database; otherwise throws. Pure. */
export function checkedAdminUrl(value: string | undefined): URL {
  if (!value) throw new Error('refusing: PG17_PROBE_ADMIN_URL is not set');
  const u = new URL(value);
  if (u.search || u.hash || u.hostname !== '127.0.0.1') throw new Error('refusing: PG17_PROBE_ADMIN_URL must be 127.0.0.1, without query or fragment');
  if (!/^\/tr_[a-z0-9_]+$/.test(u.pathname)) throw new Error('refusing: the database name must start with tr_');
  return u;
}

async function main(): Promise<number> {
  const adminUrl = checkedAdminUrl(process.env.PG17_PROBE_ADMIN_URL);
  const runnerPw = process.env.PG17_PROBE_RUNNER_PW ?? '';
  if (!/^[A-Za-z0-9]{20,}$/.test(runnerPw)) throw new Error('refusing: PG17_PROBE_RUNNER_PW must be a throwaway token of 20+ letters and digits');

  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    if ((await admin.query('select count(*)::int as n from pg_roles where rolname = $1', [RUNNER])).rows[0].n !== 0) throw new Error(`refusing: role ${RUNNER} already exists`);
    for (const sql of runnerSetupStatements(`'${runnerPw}'`)) await admin.query(sql);
    await admin.query(PUBLIC_EXECUTE_SQL);
    const f = (await admin.query('select rolsuper, rolcreaterole, rolinherit from pg_roles where rolname = $1', [RUNNER])).rows[0];
    console.log(`runner login ${RUNNER}: superuser=${f.rolsuper} createrole=${f.rolcreaterole} inherit=${f.rolinherit}`);
    if (f.rolsuper !== false || f.rolcreaterole !== true || f.rolinherit !== true) throw new Error('the runner login is not NOSUPERUSER CREATEROLE INHERIT');
  } finally {
    await admin.end();
  }

  const runnerUrl = new URL(adminUrl);
  runnerUrl.username = RUNNER;
  runnerUrl.password = runnerPw;
  const client = new pg.Client({ connectionString: runnerUrl.toString() });
  const plan = planRebuiltSqlRun({ action: 'apply-m1', dbUrl: FAKE_URL, confirm: REBUILT_STAGING_SQL_ACTIONS['apply-m1']!.confirmation, recordedRebuiltRef: REF });
  console.log(`apply-m1 plan: ${plan.steps.length} step(s) (${plan.steps.map((s) => s.label).join(', ')}), session settings: ${plan.settings.map(([n]) => n).join(', ')}`);
  try {
    await executeRebuiltSqlPlan(plan, () => client as never);
  } catch (e) {
    const err = e as Error & { code?: string; id?: string };
    console.log(`apply-m1 as ${RUNNER}: FAILED id=${err.id ?? ''} code=${err.code ?? ''} ${err.message}`);
    return 1;
  } finally {
    await client.end().catch(() => undefined);
  }
  console.log(`apply-m1 as ${RUNNER}: applied`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }, (e) => { console.log(`apply-m1 step: ERROR ${(e as Error)?.message ?? e}`); process.exitCode = 1; });
}
