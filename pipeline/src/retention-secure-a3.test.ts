// LOCAL test (TRUCKRECRU-33): a SUCCESSFUL retention fixture run (install the tagged fixtures, run, deletes committed, post-checks
// pass) through the TLS-hardened client path: planRebuiltSqlRun -> executeRebuiltSqlPlan with NO client factory, so the executor's
// own default (newSecurePgClient, pg-secure.ts / db-tls.ts) is the client. retention-run-a3.test.ts proves the same run only with a
// plain pg.Client; this file closes that gap. Real PostgreSQL, task-owned throwaway databases built by scripts/a3-build-test-db.mjs
// (M1 applied, recruiter_maintenance given a login). Skipped unless the URLs below are set; every URL must be LOOPBACK.
//
//  Scenario 1 (RETENTION_SECURE_A3_ADMIN_URL + RETENTION_SECURE_A3_MAINT_URL): a plain loopback cluster. The loopback exemption
//    applies (no TLS), SCRAM-only still does. Proves the executor's client is the secure subclass and the run commits.
//  Scenario 2 (optional, RETENTION_SECURE_A3_TLS_ADMIN_URL + RETENTION_SECURE_A3_TLS_MAINT_URL + RETENTION_SECURE_A3_TLS_ROOT_CRT):
//    a cluster with ssl=on whose pg_hba lets recruiter_maintenance in over `hostssl` + scram-sha-256 only, with a throwaway
//    self-signed CA (retention-secure-a3-make-pki.ts). The client dials the hosted-looking name TEST_HOST (a socket redirect sends it
//    to the loopback cluster, no DNS), trusting the throwaway root only through the existing test hook setDefaultPinsForTests.
//    Proves verify-full TLS + SCRAM-SHA-256-PLUS (channel binding) carry a successful run, and that with no pinned root the run is
//    refused before dialling with nothing deleted. Production code is not changed or weakened.
// It creates a minimal staging_identity.marker in each throwaway database and removes everything it made.
// Run: npx tsx src/retention-secure-a3.test.ts

import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { dbConnectionFieldsFromUrl, setDefaultPinsForTests } from './db-tls.js';
import { TEST_HOST, redirectHosts } from './db-tls-testkit.js';
import { RETENTION_RULES } from './retention.js';
import { REBUILT_STAGING_SQL_ACTIONS, REPOSITORY_ROOT, executeRebuiltSqlPlan, planRebuiltSqlRun, retargetSqlToRebuiltRef } from './staging-rebuilt.js';

const ENV = process.env;
const REF = 'zzzzzzzzzzzzzzzzzzzz'; // a fake ref for the throwaway databases only
const MARKER_ID = 'a8512f81-fe47-485d-95cd-092c46e4920b';
const INSTALL = 'supabase/staging/rebuild/install-retention-fixtures.sql';
const REMOVE = 'supabase/staging/rebuild/remove-retention-fixtures.sql';
const LEDGERS = RETENTION_RULES.map((r) => r.table);

function loopback(raw: string): string {
  const u = new URL(raw);
  if (u.search || u.hash) throw new Error('refusing: a test URL must not carry a query string or fragment');
  if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') throw new Error('refusing: test URLs must be loopback');
  return raw;
}

interface Scenario {
  label: string;
  adminUrl: string;
  maintUrl: string;
  /** Present for the TLS scenario: the throwaway root, trusted only through the test hook, and the name dialled. */
  tls?: { rootPem: string };
}

interface Seen { clients: pg.Client[]; mechanisms: Array<string | undefined>; encrypted: boolean[] }

async function runScenario(s: Scenario): Promise<void> {
  const admin = new pg.Client({ connectionString: loopback(s.adminUrl) });
  await admin.connect();
  const counts = async () => { const out: Record<string, number> = {}; for (const t of LEDGERS) out[t] = Number((await admin.query(`select count(*)::int as n from ${t}`)).rows[0].n); return out; };
  const runFile = async (rel: string, confirmation: string) => {
    const sql = retargetSqlToRebuiltRef(readFileSync(resolve(REPOSITORY_ROOT, rel), 'utf8'), REF, true);
    await admin.query(`select set_config('app.staging_runner_verified_ref', $1, false), set_config('app.staging_retention_fixtures_confirmation', $2, false)`, [REF, confirmation]);
    try { await admin.query(sql); } catch (e) { await admin.query('rollback').catch(() => undefined); throw e; }
  };
  const fixturesPresent = async () => Number((await admin.query(`select count(*)::int as n from internal.recovery_failures where email_hash like 'ret-fixture-20261101-%'`)).rows[0].n);

  // The plan comes from the runner's own planner (fake hosted URL), then points at the local cluster; no client factory is passed.
  const spec = REBUILT_STAGING_SQL_ACTIONS['retention-run']!;
  const fake = `postgresql://recruiter_maintenance.${REF}:x@aws-0-us-east-2.pooler.supabase.com:5432/postgres`;
  const hosted = planRebuiltSqlRun({ action: 'retention-run', dbUrl: fake, confirm: spec.confirmation, recordedRebuiltRef: REF });
  const local = dbConnectionFieldsFromUrl(loopback(s.maintUrl));
  assert.equal(local.user, 'recruiter_maintenance', 'the run must connect as the real maintenance login');
  const plan = { ...hosted, target: { ...hosted.target, host: s.tls ? TEST_HOST : local.host, port: local.port, user: local.user, password: local.password, database: local.database as string } };

  // Record every pg.Client the executor builds (pg-secure.ts looks pg.Client up at call time) and what its SCRAM start negotiated.
  const seen: Seen = { clients: [], mechanisms: [], encrypted: [] };
  const Original = pg.Client;
  class Recorder extends Original {
    constructor(config?: string | pg.ClientConfig) { super(config as pg.ClientConfig); seen.clients.push(this); }
    _handleAuthSASL(...args: unknown[]): unknown {
      const out = (Original.prototype as unknown as Record<string, (...a: unknown[]) => unknown>)._handleAuthSASL!.apply(this, args);
      const self = this as unknown as { saslSession?: { mechanism?: string }; connection: { stream: { encrypted?: boolean } } };
      seen.mechanisms.push(self.saslSession?.mechanism);
      seen.encrypted.push(self.connection.stream.encrypted === true);
      return out;
    }
  }
  const execute = async (): Promise<{ events: Array<Record<string, unknown>>; error?: unknown }> => {
    const events: Array<Record<string, unknown>> = [];
    const logs = console.log; const errs = console.error;
    const grab = (l: unknown[]) => { try { events.push(JSON.parse(String(l[0])) as Record<string, unknown>); } catch { /* not an event line */ } };
    console.log = (...a: unknown[]) => grab(a); console.error = (...a: unknown[]) => grab(a);
    (pg as unknown as { Client: unknown }).Client = Recorder;
    const undoRedirect = s.tls ? redirectHosts([TEST_HOST], local.port) : () => undefined;
    const undoPins = s.tls ? setDefaultPinsForTests([{ name: 'retention-secure-a3 throwaway root', sha256: new X509Certificate(s.tls.rootPem).fingerprint256, source: 'test', pem: s.tls.rootPem }]) : () => undefined;
    try {
      await executeRebuiltSqlPlan(plan as never);
      return { events };
    } catch (error) {
      return { events, error };
    } finally {
      undoPins(); undoRedirect();
      (pg as unknown as { Client: unknown }).Client = Original;
      console.log = logs; console.error = errs;
    }
  };

  let markerMade = false;
  try {
    assert.equal((await admin.query(`select to_regclass('staging_identity.marker') as t`)).rows[0].t, null, 'the throwaway database must not already have a staging marker');
    await admin.query(`create schema staging_identity; create table staging_identity.marker (singleton boolean primary key default true, environment text not null, marker_id uuid not null, project_ref text not null, project_name text not null default 'x', installed_at timestamptz not null default now(), installed_by text not null default current_user);
      insert into staging_identity.marker (environment, marker_id, project_ref) values ('staging', '${MARKER_ID}', '${REF}')`);
    markerMade = true;
    const baseline = await counts();
    await runFile(INSTALL, 'INSTALL TNBS RETENTION TEST FIXTURES');
    const afterInstall = await counts();
    for (const t of LEDGERS) assert.equal(afterInstall[t], baseline[t]! + 2, `${t}: one aged and one fresh fixture installed`);

    if (s.tls) {
      // No pinned root: refused before dialling, nothing sent, nothing deleted (the hosted policy, not the loopback exemption).
      const restorePins = setDefaultPinsForTests([]);
      const undoRedirect = redirectHosts([TEST_HOST], local.port);
      (pg as unknown as { Client: unknown }).Client = Recorder;
      let refused: unknown;
      try { await executeRebuiltSqlPlan(plan as never); } catch (e) { refused = e; } finally { (pg as unknown as { Client: unknown }).Client = Original; undoRedirect(); restorePins(); }
      assert.match((refused as Error | undefined)?.message ?? '', /no pinned database root certificate/, `${s.label}: with no pinned root the run is refused before dialling`);
      assert.equal(seen.mechanisms.length, 0, 'no authentication was attempted');
      assert.deepEqual(await counts(), afterInstall, 'the refused run deleted nothing');
      seen.clients.length = 0;
    }

    // The successful run, through the executor's default (secure) client.
    const out = await execute();
    assert.equal(out.error, undefined, `${s.label}: the run must not throw: ${out.error instanceof Error ? out.error.message : ''}`);
    const ev = out.events.find((e) => e.msg === 'staging-sql.retention_run');
    assert.deepEqual(ev, { msg: 'staging-sql.retention_run', ok: true, deletes_sent: true, failed_checks: [], deleted: { request_buckets: 1, recovery_failures: 1, email_events: 1, signin_links: 1, app_sessions: 1 } });

    // The deletes were committed and are visible to a different session (the admin one): exactly the five aged fixtures went.
    const afterRun = await counts();
    for (const t of LEDGERS) assert.equal(afterRun[t], afterInstall[t]! - 1, `${t}: exactly the one aged fixture was deleted and committed`);
    assert.equal(await fixturesPresent(), 1, 'only the fresh control fixture remains in recovery_failures');

    // It really was the hardened client: the SCRAM-only subclass of the recording class, a single connection, not a plain pg.Client.
    assert.equal(seen.clients.length, 1, 'the executor built exactly one client');
    const client = seen.clients[0] as unknown as Record<string, unknown>;
    for (const hook of ['_handleAuthCleartextPassword', '_handleAuthMD5Password', '_handleReadyForQuery']) {
      assert.notEqual(client[hook], (Original.prototype as unknown as Record<string, unknown>)[hook], `${hook} is overridden (scramOnlyClient)`);
    }
    assert.deepEqual(seen.mechanisms.length, 1, 'one SCRAM exchange');
    if (s.tls) {
      assert.deepEqual(seen.encrypted, [true], 'the SCRAM exchange ran over TLS');
      assert.deepEqual(seen.mechanisms, ['SCRAM-SHA-256-PLUS'], 'channel binding was used');
    } else {
      assert.deepEqual(seen.encrypted, [false], 'loopback exemption: no TLS');
      assert.deepEqual(seen.mechanisms, ['SCRAM-SHA-256'], 'SCRAM-SHA-256 without channel binding (no TLS)');
    }

    // Tidy: removal deletes only the tagged controls; back to baseline.
    await runFile(REMOVE, 'REMOVE TNBS RETENTION TEST FIXTURES');
    assert.deepEqual(await counts(), baseline, 'back to baseline');
    console.log(`PASS ${s.label}: successful retention run committed through the secure client path (${s.tls ? 'verify-full TLS, SCRAM-SHA-256-PLUS' : 'loopback exemption, SCRAM-SHA-256'})`);
  } finally {
    for (const [table, col] of [['internal.auth_request_buckets', 'key_hash'], ['internal.recovery_failures', 'email_hash'], ['internal.signin_links', 'token_hash'], ['internal.app_sessions', 'token_hash'], ['internal.email_events', 'provider_event_id']]) {
      await admin.query(`delete from ${table} where ${col} like 'ret-fixture-20261101-%'`).catch(() => undefined);
    }
    await admin.query('rollback').catch(() => undefined);
    if (markerMade) await admin.query('drop schema staging_identity cascade').catch(() => undefined);
    await admin.end();
  }
}

async function main(): Promise<void> {
  if (!ENV.RETENTION_SECURE_A3_ADMIN_URL || !ENV.RETENTION_SECURE_A3_MAINT_URL) {
    console.log('skip retention secure-client A3 test (set RETENTION_SECURE_A3_ADMIN_URL and RETENTION_SECURE_A3_MAINT_URL, loopback only)');
    return;
  }
  await runScenario({ label: 'loopback cluster', adminUrl: ENV.RETENTION_SECURE_A3_ADMIN_URL, maintUrl: ENV.RETENTION_SECURE_A3_MAINT_URL });
  if (ENV.RETENTION_SECURE_A3_TLS_ADMIN_URL && ENV.RETENTION_SECURE_A3_TLS_MAINT_URL && ENV.RETENTION_SECURE_A3_TLS_ROOT_CRT) {
    await runScenario({ label: 'TLS cluster', adminUrl: ENV.RETENTION_SECURE_A3_TLS_ADMIN_URL, maintUrl: ENV.RETENTION_SECURE_A3_TLS_MAINT_URL, tls: { rootPem: readFileSync(ENV.RETENTION_SECURE_A3_TLS_ROOT_CRT, 'utf8') } });
  } else {
    console.log('skip TLS scenario (set RETENTION_SECURE_A3_TLS_ADMIN_URL, RETENTION_SECURE_A3_TLS_MAINT_URL and RETENTION_SECURE_A3_TLS_ROOT_CRT)');
  }
}

main().catch((err: unknown) => {
  console.error('FAIL retention secure-client A3 test:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
