// The one place the server talks to Postgres (doc 15 §4, §14.4). Every unit of work is one
// transaction on one pooled connection:
//   BEGIN; SET LOCAL lock_timeout / statement_timeout / idle_in_transaction_session_timeout;
//   set_config('app.session_hash', $hash, true); ...work...; COMMIT
// Deadlines are enforced on the transaction, not just the promise: past the deadline before
// COMMIT is sent, the connection is destroyed (the server rolls the transaction back); if COMMIT
// was sent but not acknowledged, the outcome is UNKNOWN and is reported as such, never retried.

import pg from 'pg';
import type { PoolClient, QueryResultRow } from 'pg';
import { NotFoundError, NotPermittedError, OutcomeUnknownError, RefusedError, UnavailableError } from '../core/types';
import { clientUsable, isDefiniteCommitRefusal, isRollbackTag } from './commit-outcome';

export interface Tx {
  query<R extends QueryResultRow = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[]; rowCount: number }>;
}

export interface TxOptions {
  sessionHash?: string;
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
  /** Work deadline, counted from when a connection has been obtained. */
  deadlineMs?: number;
  /**
   * A tighter limit on waiting for a pool connection than the pool's own (connectionTimeoutMillis).
   * Only the pre-response sign-in admission check uses it (D9/F-2); ordinary requests wait up to
   * the pool's tolerant limit (DB_ACQUIRE_TIMEOUT_MS) (manager decision on Gate 2 load failures).
   */
  acquireTimeoutMs?: number;
}

export interface DatabaseOptions {
  connectionString: string;
  max?: number;
  connectionTimeoutMillis?: number;
  idleTimeoutMillis?: number;
  /**
   * Readiness (Gate 2 review N1): keep at least this many connections open. `warm()` opens them
   * at start-up and a timer re-opens any that idle eviction or a broken link removed, so the
   * sign-in admission check does not pay connection set-up inside its 600 ms budget.
   */
  minWarm?: number;
  keepWarmIntervalMs?: number;
  /** Upper bound for each warm-up query (default 2 s); a client that exceeds it is destroyed. */
  warmQueryTimeoutMs?: number;
  /** Test hook only: the warm-up statement (default `select 1`). */
  warmSql?: string;
  /** Pool name for operator signals ('auth' or 'data'). */
  label?: string;
  /** Called whenever obtaining a connection fails or exceeds its limit (an operator signal). */
  onAcquireFailure?: (label: string) => void;
}

// Match PostgREST's JSON numbers (the SPA was written against it): int8 and numeric as numbers;
// dates stay as 'YYYY-MM-DD' strings (never shifted through a local-time Date).
const { types } = pg;
const INT8 = 20;
const INT8_ARRAY = 1016;
const NUMERIC = 1700;
const NUMERIC_ARRAY = 1231;
const DATE = 1082;
const parseArray = (value: string, parse: (s: string) => number): number[] =>
  value === '{}' ? [] : value.slice(1, -1).split(',').map((s) => parse(s));
const typeParsers = {
  getTypeParser(oid: number, format?: 'text' | 'binary') {
    if (oid === INT8) return (v: string) => Number(v);
    if (oid === INT8_ARRAY) return (v: string) => parseArray(v, Number);
    if (oid === NUMERIC) return (v: string) => Number(v);
    if (oid === NUMERIC_ARRAY) return (v: string) => parseArray(v, Number);
    if (oid === DATE) return (v: string) => v;
    return types.getTypeParser(oid, format ?? 'text');
  },
} as unknown as pg.CustomTypesConfig;

/** Fixed mapping from SQLSTATE to the handler's error types (never the database message). */
export function mapPgError(err: unknown): Error {
  const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : '';
  switch (code) {
    case '42501': // insufficient_privilege (lock_and_validate, team functions, grants)
      return new NotPermittedError();
    case '23514': // check_violation (DNC guard, team rules)
      return new RefusedError('dnc_blocked');
    case '23505': // unique_violation
      return new RefusedError('conflict');
    case '0A000': // feature_not_supported (recovery disabled)
      return new RefusedError('disabled');
    case '22P02': // invalid_text_representation
    case '22023': // invalid_parameter_value
      return new RefusedError('invalid');
    case 'P0002': // no_data_found
      return new NotFoundError();
    case '57014': // query_canceled (statement_timeout)
    case '55P03': // lock_not_available (lock_timeout)
    case '40P01': // deadlock_detected -> generic retry
    case '40001': // serialization_failure
    case '57P01': // admin_shutdown
    case '08006':
    case '08003':
    case '08001':
      return new UnavailableError();
    default:
      if (code === 'P0001') return new RefusedError('invalid'); // raise exception (business rule text)
      return new UnavailableError();
  }
}

/** A checked-out client with its per-checkout error guard (see Database.checkout). */
interface Checkout {
  client: PoolClient;
  /** The connection error seen while this client was checked out, if any. */
  failure(): Error | undefined;
  /** Rejects when the client reports a connection error (race it against work in flight). */
  dropped: Promise<never>;
  /** Detaches the listener and releases; passing an error (or having seen one) destroys the client. Idempotent. */
  release(err?: Error): void;
}

/** What the per-client error guard records (see Database.guard). */
interface ClientErrorState {
  failure: Error | undefined;
  /** Set while a checkout is waiting on the client; told once, at the first error. */
  onFailure: ((err: Error) => void) | undefined;
  listener: (err: unknown) => void;
}

function newClientErrorState(): ClientErrorState {
  const state: ClientErrorState = {
    failure: undefined,
    onFailure: undefined,
    listener: (err) => {
      if (state.failure) return;
      state.failure = err instanceof Error ? err : new Error('connection error');
      state.onFailure?.(state.failure);
    },
  };
  return state;
}

export { isDefiniteCommitRefusal } from './commit-outcome';

export class Database {
  private readonly pool: pg.Pool;
  private closed = false;
  private readonly guarded = new WeakSet<pg.Pool>();
  private readonly clientStates = new WeakMap<object, ClientErrorState>();

  constructor(options: DatabaseOptions) {
    this.pool = new pg.Pool({
      connectionString: options.connectionString,
      max: options.max ?? 10,
      connectionTimeoutMillis: options.connectionTimeoutMillis ?? 250,
      idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
      // Idle eviction never takes the pool below the warm minimum (pg-pool `min`); the keep-warm
      // timer below only replaces connections that broke and does the initial opening.
      min: options.minWarm ?? 0,
      types: typeParsers,
    });
    this.pool.on('error', () => {
      // An idle client died; the pool replaces it. Nothing to log beyond the category.
    });
    this.guard(this.pool);
    this.minWarm = options.minWarm ?? 0;
    this.label = options.label ?? 'db';
    this.onAcquireFailure = options.onAcquireFailure;
    this.warmQueryTimeoutMs = options.warmQueryTimeoutMs ?? 2_000;
    this.warmSql = options.warmSql ?? 'select 1';
    if (this.minWarm > 0) {
      this.keepWarmTimer = setInterval(() => void this.warm().catch(() => undefined), options.keepWarmIntervalMs ?? 5_000);
      this.keepWarmTimer.unref();
    }
  }

  private readonly minWarm: number;
  private readonly label: string;
  private readonly onAcquireFailure: ((label: string) => void) | undefined;

  /**
   * Continuous error coverage from the pool's own synchronous lifecycle. pg-pool removes its idle
   * 'error' listener inside `_acquireClient`, and then resolves the application's connect promise;
   * the await continuation runs later. If pg parses ReadyForQuery and a fatal ErrorResponse from
   * one input buffer, the error is emitted before that continuation, so a listener attached after
   * `await pool.connect()` is too late and Node throws. The pool emits 'acquire' BEFORE it removes
   * its idle listener, so this listener is attached with no gap, and it is removed on the pool's
   * 'release' event (which every release path emits), so listeners never pile up on reused
   * clients. The failure is recorded; checkout reads it and release destroys the client.
   * Idempotent per pool (tests swap the pool in).
   */
  private guard(pool: pg.Pool): void {
    if (this.guarded.has(pool)) return;
    this.guarded.add(pool);
    pool.on('acquire', (client) => {
      const state = newClientErrorState();
      this.clientStates.set(client, state);
      client.on('error', state.listener);
    });
    pool.on('release', (_err, client) => {
      const state = this.clientStates.get(client);
      if (!state) return;
      client.removeListener('error', state.listener);
      this.clientStates.delete(client);
    });
  }

  /**
   * Checks out a client. Its 'error' guard was attached by the pool's 'acquire' hook (see guard);
   * a client the hook never saw (a pool without it) gets one here, before any query. The guard
   * records the failure (callers destroy the client) and is removed at release.
   */
  private async checkout(): Promise<Checkout> {
    this.guard(this.pool);
    const client = await this.pool.connect();
    let state = this.clientStates.get(client);
    let ownListener = false;
    if (!state) {
      state = newClientErrorState();
      client.on('error', state.listener);
      ownListener = true;
    }
    const seen = state;
    let signal: (err: Error) => void = () => undefined;
    const dropped = new Promise<never>((_, reject) => {
      signal = reject;
    });
    dropped.catch(() => undefined); // a rejection nobody is racing is not an unhandled one
    if (seen.failure) signal(seen.failure); // it died in the acquisition window
    else seen.onFailure = signal;
    let released = false;
    return {
      client,
      failure: () => seen.failure,
      dropped,
      release: (err) => {
        if (released) return;
        released = true;
        seen.onFailure = undefined;
        if (ownListener) client.removeListener('error', seen.listener);
        // A client that reported an error is destroyed (release with an error), never reused.
        client.release(err ?? seen.failure);
      },
    };
  }

  /**
   * A pool connection, optionally within a limit tighter than the pool's own. If that limit
   * expires first, the connection that arrives later is released at once (never leaked).
   */
  private acquire(limitMs: number | undefined): Promise<Checkout> {
    const pending = this.checkout();
    if (!limitMs) return pending;
    return new Promise<Checkout>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        pending.then((late) => late.release(), () => undefined);
        reject(new Error('acquire limit exceeded'));
      }, limitMs);
      pending.then(
        (checkedOut) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(checkedOut);
        },
        (err: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }
  private readonly warmQueryTimeoutMs: number;
  private readonly warmSql: string;
  private warming: Promise<number> | undefined;
  private keepWarmTimer: ReturnType<typeof setInterval> | undefined;

  /** Pool counters for readiness checks and tests. */
  get poolCounts(): { total: number; idle: number; waiting: number } {
    return { total: this.pool.totalCount, idle: this.pool.idleCount, waiting: this.pool.waitingCount };
  }

  /**
   * Open connections up to `minWarm` (each runs `select 1`, so a dead link is found now, not by
   * a sign-in). Resolves to the number of open connections; rejects if none can be opened.
   */
  async warm(): Promise<number> {
    if (this.closed) return 0;
    // One warm-up at a time (the keep-warm timer may fire while one is running).
    this.warming ??= this.warmOnce().finally(() => {
      this.warming = undefined;
    });
    return this.warming;
  }

  /**
   * Each acquisition has its own guaranteed release (Gate 2 re-review 2): a failed acquisition
   * never strands the clients that succeeded; a warm-up query is bounded by query_timeout, and a
   * client that failed or timed out is destroyed rather than returned to the pool. Rejects only if
   * every acquisition failed.
   */
  private async warmOnce(): Promise<number> {
    const missing = Math.max(0, this.minWarm - this.pool.totalCount);
    if (missing === 0) return this.pool.totalCount;
    const attempts = await Promise.allSettled(
      Array.from({ length: missing }, async () => {
        const checkedOut = await this.checkout();
        try {
          await Promise.race([
            checkedOut.client.query({ text: this.warmSql, query_timeout: this.warmQueryTimeoutMs } as pg.QueryConfig),
            checkedOut.dropped,
          ]);
        } catch (err) {
          checkedOut.release(err instanceof Error ? err : new Error('warm-up failed'));
          throw err;
        }
        checkedOut.release();
      }),
    );
    const failed = attempts.filter((a) => a.status === 'rejected');
    if (failed.length === attempts.length) throw (failed[0] as PromiseRejectedResult).reason;
    return this.pool.totalCount;
  }

  async transaction<T>(options: TxOptions, work: (tx: Tx) => Promise<T>): Promise<T> {
    if (this.closed) throw new UnavailableError();
    const deadlineMs = options.deadlineMs ?? 5_000;
    let checkedOut: Checkout;
    try {
      checkedOut = await this.acquire(options.acquireTimeoutMs);
    } catch {
      // Fail closed (the caller answers 503), but never silently.
      this.onAcquireFailure?.(this.label);
      throw new UnavailableError();
    }
    const client = checkedOut.client;
    const started = Date.now();
    let destroyed = false;
    let commitSent = false;
    let committed = false;
    // A connection error settles the transaction early, unless COMMIT was already acknowledged.
    const dropped = new Promise<never>((_, reject) => {
      checkedOut.dropped.catch((err: unknown) => {
        if (!committed) reject(err);
      });
    });
    const destroy = () => {
      if (!destroyed) {
        destroyed = true;
        checkedOut.release(new Error('deadline'));
      }
    };
    const remaining = () => deadlineMs - (Date.now() - started);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('deadline')), Math.max(remaining(), 1));
    });
    const run = async (): Promise<T> => {
      await client.query('BEGIN');
      await client.query(`SET LOCAL lock_timeout = '${Math.max(1, Math.floor(options.lockTimeoutMs ?? 2_000))}ms'`);
      await client.query(`SET LOCAL statement_timeout = '${Math.max(1, Math.floor(options.statementTimeoutMs ?? 4_000))}ms'`);
      await client.query(`SET LOCAL idle_in_transaction_session_timeout = '1s'`);
      await client.query("select set_config('app.session_hash', $1, true), set_config('app.actor_locked', '', true)", [options.sessionHash ?? '']);
      const tx: Tx = {
        query: async (sql, params) => {
          const r = await client.query(sql, params as unknown[] | undefined);
          return { rows: r.rows, rowCount: r.rowCount ?? 0 };
        },
      };
      const value = await work(tx);
      commitSent = true;
      const answer = await client.query('COMMIT');
      if (isRollbackTag(answer)) {
        // COMMIT was answered with ROLLBACK: the transaction had already failed (the work caught a
        // query error and carried on), so the server rolled everything back. That is a CONFIRMED
        // rollback, not an unknown outcome and never a success. UnavailableError is the fit: the
        // write definitely did not happen (503 "unavailable"; a safe, honest "not saved"). A
        // RefusedError would claim a business rule (409 with a fixed slug, none applies), and
        // OutcomeUnknownError would wrongly tell the user to go and check.
        commitSent = false;
        throw new UnavailableError();
      }
      committed = true;
      return value;
    };
    const running = run();
    running.catch(() => undefined); // a late failure after the deadline is already handled below
    try {
      const value = await Promise.race([running, deadline, dropped]);
      // A connection error after the work finished still destroys the client (release passes it on).
      if (!destroyed) checkedOut.release();
      return value;
    } catch (err) {
      const isDeadline = err instanceof Error && err.message === 'deadline' && !('code' in err);
      if (isDeadline) {
        destroy();
        throw commitSent ? new OutcomeUnknownError() : new UnavailableError();
      }
      // The connection itself failed (its 'error' fired): the client is destroyed, never reused.
      const connectionFailed = checkedOut.failure() !== undefined;
      if (commitSent && (connectionFailed || !isDefiniteCommitRefusal(err) || !clientUsable(client))) {
        // COMMIT was sent and the answer is not a proven rollback on a healthy connection:
        // whatever the order of the query rejection and the client 'error' event, it is unknown.
        destroy();
        throw new OutcomeUnknownError();
      }
      if (connectionFailed) destroy();
      let cleanupFailed = false;
      try {
        if (!destroyed) await client.query('ROLLBACK');
      } catch {
        cleanupFailed = true;
        destroy();
      }
      // The connection failed during cleanup after COMMIT was sent: it is no longer proven rolled back.
      if (commitSent && (cleanupFailed || checkedOut.failure() !== undefined || !clientUsable(client))) {
        destroy();
        throw new OutcomeUnknownError();
      }
      if (!destroyed) checkedOut.release();
      throw err instanceof NotPermittedError || err instanceof RefusedError || err instanceof NotFoundError || err instanceof UnavailableError ? err : mapPgError(err);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.keepWarmTimer) clearInterval(this.keepWarmTimer);
    await this.pool.end();
  }
}
