// A3 DATABASE READINESS TESTS (Gate 2 review N1): the sign-in admission check must not miss its
// 600 ms budget because of connection set-up (start-up, idle eviction) or pool contention.
// Task-owned throwaway cluster only; skipped unless A3_APP_URL and A3_ADMIN_URL are set.

import { afterEach, describe, expect, it } from 'vitest';
import { UnavailableError } from '../core/types';
import { DEFAULT_TIMING } from '../app';
import { Database } from './database';
import { PgAuthStore } from './pg-auth-store';

const APP_URL = process.env.A3_APP_URL;
const enabled = Boolean(APP_URL && /@127\.0\.0\.1:\d+\/tr_/.test(APP_URL) && process.env.A3_ADMIN_URL);
const BUDGET = DEFAULT_TIMING.admissionDeadlineMs;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!enabled)('A3 database readiness for sign-in admission', () => {
  const open: Database[] = [];
  const db = (o: Partial<ConstructorParameters<typeof Database>[0]>) => {
    const d = new Database({ connectionString: APP_URL!, ...o });
    open.push(d);
    return d;
  };
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
