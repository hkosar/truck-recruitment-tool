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

  // Pools here connect with production's tolerant limit (main.ts: DB_ACQUIRE_TIMEOUT_MS, default
  // 5 s). The tight admission limit is per call (ADMISSION_ACQUIRE_MS, unchanged) and is what these
  // tests exercise; a short POOL limit only made opening a fresh connection fail under load.
  const POOL_CONNECT_MS = 5_000;

  it('start-up warm-up opens the minimum connections; admissions then stay well inside the budget', async () => {
    const authDb = db({ max: 4, connectionTimeoutMillis: POOL_CONNECT_MS, minWarm: 2 });
    expect(authDb.poolCounts.total).toBe(0);
    expect(await authDb.warm()).toBeGreaterThanOrEqual(2);
    const auth = new PgAuthStore(authDb);
    const times: number[] = [];
    for (let i = 0; i < 20; i++) times.push(await admit(auth));
    expect(Math.max(...times)).toBeLessThan(BUDGET);
  });

  it('after idle eviction the keep-warm timer reopens connections, so the pool is never cold', async () => {
    const cold = db({ max: 4, idleTimeoutMillis: 150, connectionTimeoutMillis: POOL_CONNECT_MS });
    await cold.transaction({ deadlineMs: 5_000 }, (tx) => tx.query('select 1')); // one connection, then idle
    // Without keep-warm the idle connection is evicted: the next admission would have to connect.
    await waitFor('the unwarmed pool is empty after idle eviction', () => cold.poolCounts.total === 0);
    const warm = db({ max: 4, idleTimeoutMillis: 150, minWarm: 2, keepWarmIntervalMs: 100, connectionTimeoutMillis: POOL_CONNECT_MS });
    await warm.warm();
    await sleep(600); // an observation window of four idle timeouts: the pool must stay warm throughout
    expect(warm.poolCounts.total).toBeGreaterThanOrEqual(2);
    expect(await admit(new PgAuthStore(warm))).toBeLessThan(BUDGET);
  });

  const closesWithin = (d: Database, ms: number) => Promise.race([d.close().then(() => true), sleep(ms).then(() => false)]);

  it('warm-up with mixed acquisition success and failure leaks no client; shutdown (pool.end) completes', async () => {
    // Pool of 2; one slot held by a running transaction. Warm-up wants 2 more: one acquisition gets
    // the free slot (slow warm query), the other must time out waiting. Timings make that outcome
    // independent of machine load: both slots stay busy for >= 2.5 s, far past the 1.5 s wait limit,
    // while opening the free slot's connection has the whole 1.5 s. Neither may be stranded.
    const d = new Database({ connectionString: APP_URL!, max: 2, connectionTimeoutMillis: 1_500, minWarm: 3, warmSql: 'select pg_sleep(2.5)', warmQueryTimeoutMs: 5_000 });
    const holder = holdConnection(d, 3);
    await holder.inside;
    await waitFor('the holder has its connection', allHeld(d, 1));
    const warmed = await d.warm().then((n) => ({ ok: true, n }), (e: Error) => ({ ok: false, n: -1, e: e.message }));
    expect(warmed.ok).toBe(true); // the successful acquisition counts; the timed-out one is reported, not fatal
    expect(await holder.outcome).toBe('ok');
    await waitFor('nothing still checked out by the warm-up', allHeld(d, 0));
    expect(await closesWithin(d, 3_000)).toBe(true);
  });

  it('a warm-up query that hangs is cut off; the client is destroyed, not returned; shutdown completes', async () => {
    const d = new Database({ connectionString: APP_URL!, max: 2, minWarm: 1, warmSql: 'select pg_sleep(5)', warmQueryTimeoutMs: 300, connectionTimeoutMillis: POOL_CONNECT_MS });
    const t0 = performance.now();
    await expect(d.warm()).rejects.toBeTruthy();
    expect(performance.now() - t0).toBeLessThan(POOL_CONNECT_MS); // cut off by the 300 ms query limit, not by a connect failure
    await waitFor('the timed-out client is destroyed, not returned', allHeld(d, 0));
    expect(await closesWithin(d, 3_000)).toBe(true);
  });

  // Contention is created explicitly, never assumed from a sleep (flaky 2 in 8 elsewhere):
  // holdConnection resolves `inside` only once its connection is checked out and its transaction
  // has started, and its outcome is captured immediately (no unhandled rejection if a holder fails
  // before the test reaches its end). waitFor polls a pool condition with a bound instead of
  // sleeping a guessed time.
  function holdConnection(d: Database, seconds: number) {
    let settled = false;
    let enter!: () => void;
    let fail!: (err: Error) => void;
    const inside = new Promise<void>((resolve, reject) => {
      enter = resolve;
      fail = reject;
    });
    inside.catch(() => undefined); // handled here too; the test awaits it and sees the rejection
    const outcome = d
      .transaction({ lockTimeoutMs: 10_000, statementTimeoutMs: 10_000, deadlineMs: 15_000 }, async (tx) => {
        if (!settled) {
          settled = true;
          enter();
        }
        await tx.query(`select pg_sleep(${seconds})`);
      })
      .then(() => 'ok' as const, (err: unknown) => err);
    // A holder that ends before holding its connection fails the test at once instead of hanging.
    void outcome.then((o) => {
      if (!settled) {
        settled = true;
        fail(new Error(`holder ended before holding its connection: ${o instanceof Error ? o.message : String(o)}`));
      }
    });
    return { inside, outcome };
  }
  async function waitFor(what: string, condition: () => boolean, ms = 5_000) {
    const until = performance.now() + ms;
    while (!condition()) {
      if (performance.now() > until) throw new Error(`timed out waiting for: ${what}`);
      await sleep(10);
    }
  }
  const allHeld = (d: Database, n: number) => () => d.poolCounts.total - d.poolCounts.idle === n;

  // Manager decision on the Gate 2 load failures: ordinary requests wait tolerantly for a
  // connection; only the sign-in admission check keeps its tight limit; both fail closed with a signal.
  it('ordinary requests wait through pool contention (tolerant limit) instead of failing after 250 ms', async () => {
    const signals: string[] = [];
    const d = db({ max: 1, connectionTimeoutMillis: 5_000, label: 'data', onAcquireFailure: (l) => signals.push(l) });
    const holder = holdConnection(d, 1.5);
    await holder.inside;
    await waitFor('the only connection is checked out', allHeld(d, 1));
    const t0 = performance.now();
    const r = await d.transaction({ deadlineMs: 2_000 }, (tx) => tx.query<{ ok: number }>('select 1 as ok'));
    const waited = performance.now() - t0;
    expect(r.rows[0].ok).toBe(1);
    expect(waited).toBeGreaterThan(1_000); // it really waited for the busy connection
    expect(signals).toEqual([]);
    expect(await holder.outcome).toBe('ok');
  });

  it('the admission check keeps its tight limit on the same busy pool, signals, and leaks nothing', async () => {
    const signals: string[] = [];
    const d = db({ max: 1, connectionTimeoutMillis: 5_000, label: 'auth', onAcquireFailure: (l) => signals.push(l) });
    const holder = holdConnection(d, 1.5);
    await holder.inside;
    await waitFor('the only connection is checked out', allHeld(d, 1));
    const t0 = performance.now();
    await expect(new PgAuthStore(d).bucketHit('request', `tight-${Date.now()}`, 'tight', BUDGET)).rejects.toBeInstanceOf(UnavailableError);
    expect(performance.now() - t0).toBeLessThan(BUDGET);
    expect(signals).toEqual(['auth']);
    expect(await holder.outcome).toBe('ok');
    // The connection that arrived after the admission limit is released, not leaked.
    await waitFor('no connection left checked out', allHeld(d, 0));
  });

  it('beyond the tolerant limit an ordinary request still fails closed (Unavailable -> 503) with a signal', async () => {
    const signals: string[] = [];
    // The tolerant limit under test is 1 s here; the holder keeps the only connection for 2.5 s.
    const d = db({ max: 1, connectionTimeoutMillis: 1_000, label: 'data', onAcquireFailure: (l) => signals.push(l) });
    const holder = holdConnection(d, 2.5);
    await holder.inside;
    await waitFor('the only connection is checked out', allHeld(d, 1));
    await expect(d.transaction({ deadlineMs: 2_000 }, (tx) => tx.query('select 1'))).rejects.toBeInstanceOf(UnavailableError);
    expect(signals).toEqual(['data']);
    expect(await holder.outcome).toBe('ok');
  });

  it('contention: a saturated shared pool fails admission; the separate sign-in pool admits within the budget', async () => {
    // A shared pool of 2, both connections demonstrably checked out, refuses admission.
    const shared = db({ max: 2, connectionTimeoutMillis: POOL_CONNECT_MS });
    const sharedHolders = [holdConnection(shared, 2), holdConnection(shared, 2)];
    await Promise.all(sharedHolders.map((h) => h.inside));
    await waitFor('both shared connections checked out', allHeld(shared, 2));
    await expect(new PgAuthStore(shared).bucketHit('request', `shared-${Date.now()}`, 'shared', BUDGET)).rejects.toBeInstanceOf(UnavailableError);
    // The separate sign-in pool, warmed and verified idle, admits while the data pool is saturated.
    const authDb = db({ max: 4, connectionTimeoutMillis: POOL_CONNECT_MS, minWarm: 2 });
    expect(await authDb.warm()).toBeGreaterThanOrEqual(2);
    await waitFor('the sign-in pool has idle warm connections', () => authDb.poolCounts.idle >= 2);
    const dataDb = db({ max: 2, connectionTimeoutMillis: POOL_CONNECT_MS });
    const dataHolders = [holdConnection(dataDb, 2), holdConnection(dataDb, 2)];
    await Promise.all(dataHolders.map((h) => h.inside));
    await waitFor('both data connections checked out', allHeld(dataDb, 2));
    expect(await admit(new PgAuthStore(authDb))).toBeLessThan(BUDGET);
    for (const h of [...sharedHolders, ...dataHolders]) expect(await h.outcome).toBe('ok');
  });
});
