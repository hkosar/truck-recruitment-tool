// Liveness, readiness and database health (doc 16 §2.5).
//
// - /signin stays the process-liveness page (it serves even when the database is down).
// - readiness(): false until ONE bounded database round trip has succeeded, then true for the
//   life of the process. Render's health path uses it, so a deploy with broken database
//   credentials never becomes ready (Render cancels it and keeps the old instance), while a later
//   database outage does not make Render restart healthy instances in a loop.
// - liveDb(): a live bounded check on every call, for external outage monitoring only.
// Both answer only true/false; callers expose a generic body with no detail.

import type { Database } from '../db/database';

/** Bounds for one database health check: acquire, statement, whole check (ms). */
export const HEALTH_ACQUIRE_MS = 2_000;
export const HEALTH_STATEMENT_MS = 1_000;
export const HEALTH_CHECK_MS = 3_000;

export interface HealthOptions {
  /** One database round trip; rejects on any failure. The caller bounds acquire and statement. */
  probe: () => Promise<void>;
  /** Overall bound for one check, whatever the probe does (ms). */
  timeoutMs: number;
}

export interface Health {
  readiness(): Promise<boolean>;
  liveDb(): Promise<boolean>;
}

export function createHealth({ probe, timeoutMs }: HealthOptions): Health {
  let ready = false;
  // At most one probe in flight: concurrent health requests share it, so a slow or failing
  // database never accumulates checks.
  let inflight: Promise<boolean> | undefined;

  const check = (): Promise<boolean> => {
    inflight ??= new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      probe().then(
        () => {
          clearTimeout(timer);
          resolve(true);
        },
        () => {
          clearTimeout(timer);
          resolve(false);
        },
      );
    }).finally(() => {
      inflight = undefined;
    });
    return inflight;
  };

  return {
    async readiness() {
      if (ready) return true;
      if (await check()) ready = true;
      return ready;
    },
    liveDb: check,
  };
}

/** The server's check: one bounded `select 1` (no session) through the given pool. */
export function databaseHealth(db: Pick<Database, 'transaction'>): Health {
  return createHealth({
    probe: () =>
      db.transaction({ acquireTimeoutMs: HEALTH_ACQUIRE_MS, statementTimeoutMs: HEALTH_STATEMENT_MS, deadlineMs: HEALTH_ACQUIRE_MS }, async (tx) => {
        await tx.query('select 1');
      }),
    timeoutMs: HEALTH_CHECK_MS,
  });
}
