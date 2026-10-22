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
      idleTimeoutMillis: 30_000,
      types: typeParsers,
    });
    this.pool.on('error', () => {
      // An idle client died; the pool replaces it. Nothing to log beyond the category.
    });
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
    await this.pool.end();
  }
}
