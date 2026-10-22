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

export interface Tx {
  query<R extends QueryResultRow = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[]; rowCount: number }>;
}

export interface TxOptions {
  sessionHash?: string;
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
  /** Whole-transaction deadline including pool acquisition. */
  deadlineMs?: number;
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

export class Database {
  private readonly pool: pg.Pool;
  private closed = false;

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
    this.minWarm = options.minWarm ?? 0;
    this.warmQueryTimeoutMs = options.warmQueryTimeoutMs ?? 2_000;
    this.warmSql = options.warmSql ?? 'select 1';
    if (this.minWarm > 0) {
      this.keepWarmTimer = setInterval(() => void this.warm().catch(() => undefined), options.keepWarmIntervalMs ?? 5_000);
      this.keepWarmTimer.unref();
    }
  }

  private readonly minWarm: number;
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
        const client = await this.pool.connect();
        try {
          await client.query({ text: this.warmSql, query_timeout: this.warmQueryTimeoutMs } as pg.QueryConfig);
        } catch (err) {
          client.release(err instanceof Error ? err : new Error('warm-up failed'));
          throw err;
        }
        client.release();
      }),
    );
    const failed = attempts.filter((a) => a.status === 'rejected');
    if (failed.length === attempts.length) throw (failed[0] as PromiseRejectedResult).reason;
    return this.pool.totalCount;
  }

  async transaction<T>(options: TxOptions, work: (tx: Tx) => Promise<T>): Promise<T> {
    if (this.closed) throw new UnavailableError();
    const deadlineMs = options.deadlineMs ?? 5_000;
    const started = Date.now();
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch {
      throw new UnavailableError();
    }
    let destroyed = false;
    let commitSent = false;
    const destroy = () => {
      if (!destroyed) {
        destroyed = true;
        client.release(new Error('deadline'));
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
      await client.query('COMMIT');
      return value;
    };
    const running = run();
    running.catch(() => undefined); // a late failure after the deadline is already handled below
    try {
      const value = await Promise.race([running, deadline]);
      if (!destroyed) client.release();
      return value;
    } catch (err) {
      const isDeadline = err instanceof Error && err.message === 'deadline' && !('code' in err);
      if (isDeadline) {
        destroy();
        throw commitSent ? new OutcomeUnknownError() : new UnavailableError();
      }
      if (commitSent && !('code' in (err as object))) {
        // COMMIT was sent and the connection failed without a server answer.
        destroy();
        throw new OutcomeUnknownError();
      }
      try {
        if (!destroyed) await client.query('ROLLBACK');
      } catch {
        destroy();
      }
      if (!destroyed) client.release();
      throw err instanceof NotPermittedError || err instanceof RefusedError || err instanceof NotFoundError ? err : mapPgError(err);
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
