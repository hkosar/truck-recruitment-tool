// Staging-2 is reached only through the Supabase session pooler (TRUCKRECRU-49): target-guard.ts STAGING2_POOLER_ADDRESS, enforced
// by pg-secure.ts refuseStaging2UnlessPooler at the one place every pg client and pool is configured, and by the staging-2 planners.
// FAKE URLs only (fake passwords and pooler label; the staging-2 ref is the repository constant). Nothing is dialled: clients are
// built but never connected, and every refusal happens before a client exists.
// Run: npx tsx src/staging2-pooler-guard.test.ts

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { planFirstManager, FIRST_MANAGER_CHECK_CONFIRMATION } from './first-manager-bootstrap.js';
import { newSecurePgClient, newSecurePgPool, refuseStaging2UnlessPooler, securePgConfig } from './pg-secure.js';
import { REFUSAL_IDS, RunnerRefusal, classifyRunnerFailure } from './refusals.js';
import { ROLE_PASSWORD_ACTIONS, planRolePassword } from './role-password.js';
import { REBUILT_STAGING_SQL_ACTIONS, planRebuiltSqlRun } from './staging-rebuilt.js';
import { RECORDED_PROJECT_REFS, parseSupabaseDbTarget } from './target-guard.js';

const ID = 'staging2_pooler_required';
const REBUILT = RECORDED_PROJECT_REFS.stagingRebuilt as string;
const OTHER_DEV = 'abcdefghijklmnopqrst';
const PW = 'Fake-Pw-NOT-REAL-7731';
const POOLER_HOST = 'aws-0-us-east-2.pooler.supabase.com'; // fake label in the shape this repository's tests use
const DIRECT_HOST = `db.${REBUILT}.supabase.co`;
const pooler = (ref: string, port = 5432, user = 'postgres') => `postgresql://${user}.${ref}:${PW}@${POOLER_HOST}:${port}/postgres`;
const direct = (ref: string, user = 'postgres') => `postgresql://${user}:${PW}@db.${ref}.supabase.co:5432/postgres`;
/** Text that must never appear in any message or output: password, ref, hosts, user names, the whole URL. */
const FORBIDDEN = [PW, REBUILT, POOLER_HOST, DIRECT_HOST, 'supabase.co', `postgres.${REBUILT}`, 'evil.example', 'postgresql://'];

let n = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean) => {
  if (ok) console.log(`PASS ${name}`);
  else { console.log(`FAIL ${name}`); failures.push(name); }
  n += 1;
};
const messages: string[] = [];
const refusalOf = (fn: () => unknown): string | undefined => {
  try { fn(); return undefined; } catch (e) {
    messages.push(e instanceof Error ? `${e.name} ${e.message} ${e.stack ?? ''}` : String(e));
    return e instanceof RunnerRefusal ? e.id : `other:${e instanceof Error ? e.name : typeof e}`;
  }
};
const clean = (text: string) => !FORBIDDEN.some((f) => text.toLowerCase().includes(f.toLowerCase()));

const env = REBUILT_STAGING_SQL_ACTIONS['environment-preflight'];
const rebuilt = (dbUrl: string | undefined) => () => planRebuiltSqlRun({ action: 'environment-preflight', dbUrl, confirm: env.confirmation });
const rolePw = (dbUrl: string | undefined) => () => planRolePassword({ action: 'set-app-password', dbUrl, confirm: ROLE_PASSWORD_ACTIONS['set-app-password'].confirmation, password: 'Zx9-test-password-NOT-A-REAL-SECRET-4471' });
const firstMgr = (dbUrl: string | undefined) => () => planFirstManager({ target: 'staging', action: 'first-manager-check', dbUrl, confirm: FIRST_MANAGER_CHECK_CONFIRMATION });
const PLANNERS = [['rebuilt runner', rebuilt], ['role-password', rolePw], ['first-manager staging', firstMgr]] as const;
const fields = (host: string, port: number, user = `postgres.${REBUILT}`) => ({ host, port, user, password: PW, database: 'postgres' });
/** Every builder that turns fields into a client config; each must refuse with the same id and build nothing. */
const BUILDERS = [
  ['securePgConfig', (f: ReturnType<typeof fields>) => securePgConfig(f)],
  ['newSecurePgClient', (f: ReturnType<typeof fields>) => newSecurePgClient(f)],
  ['newSecurePgPool', (f: ReturnType<typeof fields>) => { void newSecurePgPool(f).end(); }],
] as const;

async function main(): Promise<void> {
  // 1. The allowed shape is one named constant, and the session pooler is accepted everywhere.
  const guard = (await import('./target-guard.js')) as Record<string, unknown>;
  const shape = guard.STAGING2_POOLER_ADDRESS as { hostSuffix?: unknown; port?: unknown } | undefined;
  const isPooler = guard.isStaging2PoolerAddress as ((t: { host: string; port: number }) => boolean) | undefined;
  check('the allowed staging-2 address is one named constant: STAGING2_POOLER_ADDRESS = .pooler.supabase.com, port 5432',
    shape !== undefined && shape.hostSuffix === '.pooler.supabase.com' && shape.port === 5432);
  check(`pooler accepted: the fake pooler URL on 5432 passes the shape check, every staging-2 planner, and every client builder; ${ID} is a known refusal id`,
    typeof isPooler === 'function' && isPooler({ host: POOLER_HOST, port: 5432 })
    && (REFUSAL_IDS as readonly string[]).includes(ID)
    && PLANNERS.every(([, plan]) => refusalOf(plan(pooler(REBUILT))) === undefined)
    && BUILDERS.every(([, build]) => refusalOf(() => build(fields(POOLER_HOST, 5432))) === undefined));

  // 2. Direct database host refused, before anything is built.
  check(`direct host refused: db.<staging-2>.supabase.co (plain and pooler-style user) is refused by every staging-2 planner with ${ID}`,
    PLANNERS.every(([, plan]) => refusalOf(plan(direct(REBUILT))) === ID && refusalOf(plan(direct(REBUILT, `postgres.${REBUILT}`))) === ID));
  check(`direct host refused at the choke point: every client builder refuses a staging-2 target on the direct host or any non-pooler host with ${ID}`,
    BUILDERS.every(([, build]) => [DIRECT_HOST, 'db.example.com', `${REBUILT}.supabase.co`, 'evil.example'].every((h) =>
      refusalOf(() => build(fields(h, 5432))) === ID && refusalOf(() => build(fields(h, 5432, 'postgres'))) === (h.includes(REBUILT) ? ID : undefined))));
  check(`direct host refused: a parsed direct staging-2 target (projectRef from the host) is refused by newSecurePgClient with ${ID}`,
    refusalOf(() => newSecurePgClient(parseSupabaseDbTarget(direct(REBUILT)))) === ID);

  // 3. Wrong port refused (the pooler host on the transaction port or any other port).
  check(`wrong port refused at the choke point: pooler host on 6543, 5433, 6432, 0 and 65535 is refused by every builder with ${ID}`,
    BUILDERS.every(([, build]) => [6543, 5433, 6432, 0, 65535].every((p) => refusalOf(() => build(fields(POOLER_HOST, p))) === ID)));
  check(`wrong port refused before connecting in the planners too (port_must_be_5432 first, ${ID} at the client) for 6543 and 5433`,
    PLANNERS.every(([, plan]) => [6543, 5433].every((p) => refusalOf(plan(pooler(REBUILT, p))) === 'port_must_be_5432'))
    && refusalOf(() => newSecurePgClient(parseSupabaseDbTarget(pooler(REBUILT, 6543)))) === ID);

  // 4. Malformed or empty refused.
  const malformedHosts = ['', ' ', 'pooler.supabase.com', '.pooler.supabase.com', 'a.b.pooler.supabase.com', `${POOLER_HOST}.evil.example`, 'aws-0-us-east-2.pooler.supabase.co', 'aws_0.pooler.supabase.com', 'aws 0.pooler.supabase.com', '[::1].pooler.supabase.com'];
  check(`malformed or empty refused: empty, label-less, multi-label, look-alike and odd-character pooler hosts and NaN/fraction/negative ports are refused by every client builder with ${ID}; an empty or unparseable STAGING_DB_URL is still refused by every planner`,
    BUILDERS.every(([, build]) => malformedHosts.every((h) => refusalOf(() => build(fields(h, 5432))) === ID)
      && [Number.NaN, 5432.5, -5432].every((p) => refusalOf(() => build(fields(POOLER_HOST, p))) === ID))
    && PLANNERS.every(([, plan]) => ['', undefined].every((u) => refusalOf(plan(u)) === 'db_url_required')
      && ['not a url', `mysql://u:${PW}@${POOLER_HOST}:5432/x`, `${pooler(REBUILT)}?host=${DIRECT_HOST}`].every((u) => refusalOf(plan(u)) !== undefined)));

  // 5. Other projects are not affected (production and other dev refs keep their previous behaviour at the choke point).
  // Regression guard: this one passes on the code before TRUCKRECRU-49 too, by design.
  check(`not staging-2 (regression guard): production and another dev ref on a direct host, and loopback test databases, are not refused with ${ID}`,
    [RECORDED_PROJECT_REFS.production, OTHER_DEV].every((ref) => refusalOf(() => newSecurePgClient(parseSupabaseDbTarget(direct(ref)))) !== ID)
    && refusalOf(() => newSecurePgClient(fields('127.0.0.1', 54329, 'postgres'))) === undefined);
  // Local test databases (loopback, reserved .invalid names) are left to db-tls.ts at the client, but no planner accepts them.
  check(`local test hosts (regression guard): a staging-2 target on loopback or a reserved .invalid name is built by the client builders (local tests) but refused by every planner (only Supabase hosts parse)`,
    BUILDERS.every(([, build]) => ['127.0.0.1', 'localhost', '::1', 'db.tls-test.invalid'].every((h) => refusalOf(() => build(fields(h, 5432))) === undefined))
    && PLANNERS.every(([, plan]) => ['127.0.0.1', 'localhost', 'db.tls-test.invalid'].every((h) => refusalOf(plan(`postgresql://postgres.${REBUILT}:${PW}@${h}:5432/postgres`)) !== undefined)));

  // Review t49 note 7: the four mutants that survived (M3, M8, M9, M10). Each check below fails on its mutant.
  check(`M3: only a name that ENDS in .invalid is exempt; a staging-2 user on x.invalid.example or db.invalid-name.example is refused with ${ID} by every builder`,
    BUILDERS.every(([, build]) => ['x.invalid.example', 'db.invalid-name.example'].every((h) => refusalOf(() => build(fields(h, 5432))) === ID)));
  check(`M8: a target that names staging-2 only through its parsed projectRef (IP host, plain user) is refused with ${ID}`,
    refusalOf(() => refuseStaging2UnlessPooler({ host: '10.0.0.5', port: 5432, user: 'postgres', projectRef: REBUILT })) === ID
    && refusalOf(() => refuseStaging2UnlessPooler({ host: '10.0.0.5', port: 5432, user: 'postgres', projectRef: OTHER_DEV })) === undefined);
  check(`M9: the pooler host is compared case-insensitively: an upper-case pooler host with a staging-2 user is not refused with ${ID}`,
    BUILDERS.every(([, build]) => refusalOf(() => build(fields(POOLER_HOST.toUpperCase(), 5432))) !== ID));
  check(`M10: an upper-case staging-2 ref in the user alone (IP host) is refused with ${ID} by every builder`,
    BUILDERS.every(([, build]) => refusalOf(() => build(fields('10.0.0.5', 5432, `postgres.${REBUILT.toUpperCase()}`))) === ID));

  // 6. Nothing about the URL is ever printed: the refusal text, the classified report, and the real command line.
  check(`the ${ID} refusal message and its report carry no part of the URL; the report is exactly { refusal: "${ID}" }`,
    (() => { try { newSecurePgClient(fields(DIRECT_HOST, 5432)); return false; } catch (e) { return JSON.stringify(classifyRunnerFailure(e)) === JSON.stringify({ refusal: ID }) && clean(`${(e as Error).message} ${(e as Error).stack ?? ''}`); } })());
  const cli = (dbUrl: string) => spawnSync(process.execPath, ['--import', 'tsx', resolve(import.meta.dirname, 'staging-sql-runner.ts'), '--project=rebuilt', '--action=environment-preflight', `--confirm=${env.confirmation}`],
    { env: { PATH: process.env.PATH ?? '', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), STAGING_DB_URL: dbUrl }, encoding: 'utf8', cwd: resolve(import.meta.dirname, '..'), timeout: 60_000 });
  const runs = [cli(direct(REBUILT)), cli(direct(REBUILT, `postgres.${REBUILT}`))];
  check(`command line (plan-only, no --execute): a direct staging-2 STAGING_DB_URL exits 1 with exactly {"msg":"staging-sql.refused","refusal":"${ID}"} and prints no part of the URL; no captured refusal message or stack in this file contains the password, the ref, a host or a user name`,
    runs.every((r) => r.status === 1 && r.stdout === '' && r.stderr.trim() === JSON.stringify({ msg: 'staging-sql.refused', refusal: ID }) && clean(r.stdout + r.stderr))
    && messages.length > 0 && messages.every(clean));

  console.log(`staging2-pooler-guard: ${n - failures.length}/${n} checks passed`);
  assert.deepEqual(failures, [], `failed: ${failures.join(' | ')}`);
}

await main();
