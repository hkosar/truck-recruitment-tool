// A3 DATABASE READINESS TESTS (Gate 2 review N1): the sign-in admission check must not miss its
// 600 ms budget because of connection set-up (start-up, idle eviction) or pool contention.
// Task-owned throwaway cluster only; skipped unless A3_APP_URL and A3_ADMIN_URL are set.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { UnavailableError } from '../core/types';
import { DEFAULT_TIMING } from '../app';
import { Database } from './database';
import { PgAuthStore } from './pg-auth-store';
import { claimSuiteDatabase, suiteDatabase } from '../testing/test-db';
// Loaded machines (manager decision): only TEST timeouts are raised; product limits are unchanged.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

// Own database per run (<base>_<run>_readiness; testing/test-db.ts), claimed exclusively.
const SUITE_DB = suiteDatabase('readiness');
const APP_URL = SUITE_DB?.appUrl;
const enabled = Boolean(APP_URL);
const BUDGET = DEFAULT_TIMING.admissionDeadlineMs;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!enabled)('A3 database readiness for sign-in admission', () => {
  const open: Database[] = [];
  const db = (o: Partial<ConstructorParameters<typeof Database>[0]>) => {
    const d = new Database({ connectionString: APP_URL!, ...o });
    open.push(d);
    return d;
  };
  let releaseClaim: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    releaseClaim = await claimSuiteDatabase(SUITE_DB!.adminUrl);
  });
  afterAll(async () => {
    await releaseClaim?.();
  });
  afterEach(async () => {
    await Promise.all(open.splice(0).map((d) => d.close()));
  });
  let n = 0;
  const admit = async (auth: PgAuthStore) => {
    const t0 = performance.now();
    await auth.bucketHit('request', `readiness-ip-${Date.now()}-${++n}`, `readiness-email-${n}`, BUDGET);
    return performance.now() - t0;
  };

  it('start-up warm-up opens the minimum connections; admissions then stay well inside the budget', async () => {
    const authDb = db({ max: 4, connectionTimeoutMillis: 400, minWarm: 2 });
    expect(authDb.poolCounts.total).toBe(0);
    expect(await authDb.warm()).toBeGreaterThanOrEqual(2);
    const auth = new PgAuthStore(authDb);
    const times: number[] = [];
    for (let i = 0; i < 20; i++) times.push(await admit(auth));
    expect(Math.max(...times)).toBeLessThan(BUDGET);
  });

  it('after idle eviction the keep-warm timer reopens connections, so the pool is never cold', async () => {
    const cold = db({ max: 4, idleTimeoutMillis: 150 });
    await new PgAuthStore(cold).bucketHit('request', `cold-${Date.now()}`, 'cold', BUDGET);
    await sleep(600);
    expect(cold.poolCounts.total).toBe(0); // without keep-warm: evicted, the next admission must connect
    const warm = db({ max: 4, idleTimeoutMillis: 150, minWarm: 2, keepWarmIntervalMs: 100 });
    await warm.warm();
    await sleep(600);
    expect(warm.poolCounts.total).toBeGreaterThanOrEqual(2);
    expect(await admit(new PgAuthStore(warm))).toBeLessThan(BUDGET);
  });

  const closesWithin = (d: Database, ms: number) => Promise.race([d.close().then(() => true), sleep(ms).then(() => false)]);

  it('warm-up with mixed acquisition success and failure leaks no client; shutdown (pool.end) completes', async () => {
    // Pool of 2; one slot held by a running transaction. Warm-up wants 2 more: one acquisition gets
    // the free slot (slow warm query), the other times out waiting. Neither may be stranded.
    const d = new Database({ connectionString: APP_URL!, max: 2, connectionTimeoutMillis: 300, minWarm: 3, warmSql: 'select pg_sleep(0.6)' });
    const holder = d.transaction({ lockTimeoutMs: 5_000, statementTimeoutMs: 5_000, deadlineMs: 5_000 }, (tx) => tx.query('select pg_sleep(1.2)'));
    await sleep(100);
    const warmed = await d.warm().then((n) => ({ ok: true, n }), (e: Error) => ({ ok: false, n: -1, e: e.message }));
    expect(warmed.ok).toBe(true); // the successful acquisition counts; the timed-out one is reported, not fatal
    await holder;
    await sleep(100);
    const c = d.poolCounts;
    expect(c.total - c.idle).toBe(0); // nothing still checked out by the warm-up
    expect(await closesWithin(d, 3_000)).toBe(true);
  });

  it('a warm-up query that hangs is cut off; the client is destroyed, not returned; shutdown completes', async () => {
    const d = new Database({ connectionString: APP_URL!, max: 2, minWarm: 1, warmSql: 'select pg_sleep(5)', warmQueryTimeoutMs: 300 });
    const t0 = performance.now();
    await expect(d.warm()).rejects.toBeTruthy();
    expect(performance.now() - t0).toBeLessThan(2_000);
    await sleep(100);
    expect(d.poolCounts.total - d.poolCounts.idle).toBe(0);
    expect(await closesWithin(d, 3_000)).toBe(true);
  });

  // Manager decision on the Gate 2 load failures: ordinary requests wait tolerantly for a
  // connection; only the sign-in admission check keeps its tight limit; both fail closed with a signal.
  const holdOne = (d: Database, seconds: number) =>
    d.transaction({ lockTimeoutMs: 5_000, statementTimeoutMs: 5_000, deadlineMs: 5_000 }, (tx) => tx.query(`select pg_sleep(${seconds})`));

  it('ordinary requests wait through pool contention (tolerant limit) instead of failing after 250 ms', async () => {
    const signals: string[] = [];
    const d = db({ max: 1, connectionTimeoutMillis: 5_000, label: 'data', onAcquireFailure: (l) => signals.push(l) });
    const busy = holdOne(d, 1.5);
    await sleep(100);
    const t0 = performance.now();
    const r = await d.transaction({ deadlineMs: 2_000 }, (tx) => tx.query<{ ok: number }>('select 1 as ok'));
    const waited = performance.now() - t0;
    expect(r.rows[0].ok).toBe(1);
    expect(waited).toBeGreaterThan(1_000); // it really waited for the busy connection
    expect(signals).toEqual([]);
    await busy;
  });

  it('the admission check keeps its tight limit on the same busy pool, signals, and leaks nothing', async () => {
    const signals: string[] = [];
    const d = db({ max: 1, connectionTimeoutMillis: 5_000, label: 'auth', onAcquireFailure: (l) => signals.push(l) });
    const busy = holdOne(d, 1.5);
    await sleep(100);
    const t0 = performance.now();
    await expect(new PgAuthStore(d).bucketHit('request', `tight-${Date.now()}`, 'tight', BUDGET)).rejects.toBeInstanceOf(UnavailableError);
    expect(performance.now() - t0).toBeLessThan(BUDGET);
    expect(signals).toEqual(['auth']);
    await busy;
    await sleep(200); // the connection that arrived after the admission limit is released, not leaked
    expect(d.poolCounts.total - d.poolCounts.idle).toBe(0);
  });

  it('beyond the tolerant limit an ordinary request still fails closed (Unavailable -> 503) with a signal', async () => {
    const signals: string[] = [];
    const d = db({ max: 1, connectionTimeoutMillis: 600, label: 'data', onAcquireFailure: (l) => signals.push(l) });
    const busy = holdOne(d, 1.5);
    await sleep(100);
    await expect(d.transaction({ deadlineMs: 2_000 }, (tx) => tx.query('select 1'))).rejects.toBeInstanceOf(UnavailableError);
    expect(signals).toEqual(['data']);
    await busy;
  });

  it('contention: a saturated shared pool fails admission; the separate sign-in pool admits within the budget', async () => {
    const hold = (d: Database) => d.transaction({ lockTimeoutMs: 5_000, statementTimeoutMs: 5_000, deadlineMs: 5_000 }, (tx) => tx.query('select pg_sleep(1.5)'));
    const shared = db({ max: 2, connectionTimeoutMillis: 250 });
    const busy = [hold(shared), hold(shared)];
    await sleep(100);
    await expect(new PgAuthStore(shared).bucketHit('request', `shared-${Date.now()}`, 'shared', BUDGET)).rejects.toBeInstanceOf(UnavailableError);
    const authDb = db({ max: 4, connectionTimeoutMillis: 400, minWarm: 2 });
    await authDb.warm();
    const dataDb = db({ max: 2 });
    const busy2 = [hold(dataDb), hold(dataDb)];
    await sleep(100);
    expect(await admit(new PgAuthStore(authDb))).toBeLessThan(BUDGET);
    await Promise.all([...busy, ...busy2]);
  });
});
