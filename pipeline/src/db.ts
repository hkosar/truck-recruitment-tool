import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import pg from 'pg';
// Named type-only import alongside the default import (two import statements from the same
// specifier is valid ESM) -- used for PoolClient instead of the `pg.PoolClient` dotted-type
// form so this file doesn't depend on `pg`'s `export =` namespace also being reachable for
// type-position access through the default binding. `Pool` itself is derived via
// `InstanceType<typeof Pool>` below from the VALUE-level `const { Pool } = pg`, so only
// PoolClient needs this named-import treatment.
import type { PoolClient } from 'pg';
import type { Config } from './config.js';
import { clientUsable, isDefiniteCommitRefusal, isRollbackTag } from './commit-outcome.js';
import { parseSupabaseDbTarget } from './target-guard.js';

const { Pool } = pg;

/** node-postgres pool + client instance types (see the import comment above for why
 *  PoolClient comes from a named type import rather than `pg.PoolClient`). */
export type PgPool = InstanceType<typeof Pool>;
export type PgPoolClient = PoolClient;

export interface Logger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

/**
 * One-line structured JSON logs -- Render's log viewer (and any future log drain) can
 * grep/parse these without a special integration. `scope` is usually the job/step name
 * (e.g. 'sync-census') so interleaved chain output stays attributable.
 */
export function createLogger(scope: string): Logger {
  const emit = (level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, scope, msg, ...meta });
    if (level === 'error') {
      console.error(line);
    } else {
      console.log(line);
    }
  };
  return {
    info: (msg, meta) => emit('info', msg, meta),
    warn: (msg, meta) => emit('warn', msg, meta),
    error: (msg, meta) => emit('error', msg, meta),
  };
}

/**
 * Everything a job function needs, assembled once in run.ts's main() and threaded through
 * by parameter -- deliberately no hidden singletons, so every job is independently
 * dry-runnable/testable (see config.ts's `loadConfig` doc comment for the same reasoning).
 */
export interface PipelineContext {
  config: Config;
  /** Service-role PostgREST client -- RLS-bypassing by design (Part A D9). Right tool for
   *  small reads/writes and RPC calls (pipeline_runs rows, per-carrier rollup upserts under
   *  a few hundred rows). NOT for the big census/L&I merges -- see `pg` below. */
  supabase: SupabaseClient;
  /** Direct Postgres pool (session pooler, port 5432) for COPY / staging tables / set-based
   *  upserts. PostgREST is the wrong tool for 150-220k-row merges (Part B §6.1). */
  pg: PgPool;
  log: Logger;
}

export function createSupabaseClient(config: Config): SupabaseClient {
  return createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: 'public' },
  });
}

export function createPgPool(config: Config): PgPool {
  // Build from the guard's explicit fields, never from the raw string: pg would let query
  // parameters in a connection string override host/user/port (see target-guard.ts).
  const target = parseSupabaseDbTarget(config.SUPABASE_DB_URL);
  const pool = new Pool({
    host: target.host,
    port: target.port,
    user: target.user,
    password: target.password,
    database: target.database,
    // Render Cron Jobs are short-lived, one-shot processes handling one chain at a time:
    // a small pool + explicit `closePipelineContext()` on exit beats tuning idle timeouts.
    max: 5,
    idleTimeoutMillis: 30_000,
    // TODO(live-db): Supabase's pooler cert chain commonly needs this relaxed setting with
    // node-postgres depending on Node/OpenSSL trust-store versions (a very common pattern in
    // production Supabase+pg setups). Tighten to a pinned CA bundle
    // (`ssl: { ca: fs.readFileSync(...), rejectUnauthorized: true }`) once real credentials
    // exist and this has been verified against the actual pooler endpoint -- don't leave
    // this relaxed by default forever, just for the skeleton.
    ssl: { rejectUnauthorized: false },
  });
  // An IDLE client whose connection drops emits 'error' on the pool; with no listener Node throws
  // it as an uncaught exception. The pool drops that client itself. Fixed text only: a driver
  // message can carry an address.
  pool.on('error', () => createLogger('pg').warn('pg.idle_client_connection_error'));
  watchPoolClients(pool);
  return pool;
}

export function createPipelineContext(config: Config, scope = 'pipeline'): PipelineContext {
  return {
    config,
    supabase: createSupabaseClient(config),
    pg: createPgPool(config),
    log: createLogger(scope),
  };
}

/** Drains the pg pool. Always call from a `finally` around run.ts's chain so a failed run
 *  doesn't leak connections and hang the Render Cron Job past its own exit. */
export async function closePipelineContext(ctx: PipelineContext): Promise<void> {
  await ctx.pg.end();
}

// =====================================================================================
// Staging-table helpers -- the "full slice -> staging -> row-hash diff upsert" flow that
// every sources/*.ts job follows (Part B §2.2).
// =====================================================================================

// ---- Continuous client error coverage --------------------------------------------------------
// pg-pool removes its idle 'error' listener inside _acquireClient and then resolves pool.connect();
// the await continuation runs later. If pg parses ReadyForQuery and a fatal ErrorResponse from one
// input buffer, the error is emitted before that continuation, so a listener attached after
// `await pool.connect()` is too late and Node throws. The pool emits 'acquire' BEFORE it removes its
// idle listener, so the listener below has no gap; it is removed on the pool's 'release' event (every
// release path emits it), so listeners never pile up on reused clients.
interface ClientErrorState {
  failure: Error | undefined;
  listener: (err: unknown) => void;
}
const clientStates = new WeakMap<object, ClientErrorState>();
const watchedPools = new WeakSet<object>();

function newClientErrorState(): ClientErrorState {
  const state: ClientErrorState = {
    failure: undefined,
    listener: (err) => {
      state.failure ??= err instanceof Error ? err : new Error('connection error');
    },
  };
  return state;
}

/** Idempotent and synchronous: call before `pool.connect()`. A pool without events is skipped. */
export function watchPoolClients(pool: Pick<PgPool, 'on'>): void {
  if (typeof pool.on !== 'function' || watchedPools.has(pool)) return;
  watchedPools.add(pool);
  pool.on('acquire', (client) => {
    const state = newClientErrorState();
    clientStates.set(client, state);
    client.on('error', state.listener);
  });
  pool.on('release', (_err, client) => {
    const state = clientStates.get(client);
    if (!state) return;
    client.removeListener('error', state.listener);
    clientStates.delete(client);
  });
}

export interface ClientGuard {
  /** The connection error seen while the client was checked out, if any. */
  failure(): Error | undefined;
  /** Detaches a listener this guard attached itself (the pool hook's is removed by the pool). */
  stop(): void;
}

/** The guard for a checked-out client: the pool hook's record, or (no hook) a listener attached now. */
export function guardClient(client: PgPoolClient): ClientGuard {
  const hooked = clientStates.get(client);
  const state = hooked ?? newClientErrorState();
  if (!hooked) client.on('error', state.listener);
  return {
    failure: () => state.failure,
    stop: () => {
      if (!hooked) client.removeListener('error', state.listener);
    },
  };
}

/**
 * Runs `ddl` (one or more `create temp table ...` statements) then `fn`, on one checked-out
 * pooled client -- temp tables are session-scoped, so every query `fn` issues must reuse the
 * same client. Wrapped in a transaction; the temp table (and the transaction) both vanish
 * automatically when the client is released back to the pool, even if `fn` throws.
 */
export async function withStagingConnection<T>(
  pool: PgPool,
  ddl: string,
  fn: (client: PgPoolClient) => Promise<T>
): Promise<T> {
  watchPoolClients(pool);
  const client = await pool.connect();
  // The pool's 'acquire' hook (watchPoolClients) already covers the client; a dropped connection
  // becomes a failed query (the run fails and exits non-zero) instead of an uncaught exception. A
  // client that reported an error is destroyed, never reused.
  const guard = guardClient(client);
  // Same COMMIT rules as load-location-tables.ts applyLoad and app/server/db/database.ts: once COMMIT
  // is sent, only an allowlisted refusal on a healthy connection with a successful ROLLBACK is a
  // definite failure; everything else is an unknown outcome and the client is destroyed.
  let commitSent = false;
  let lostByCode: Error | undefined; // no 'error' event (yet) but the client must not be reused
  const unknownOutcome = () =>
    new Error('The connection was lost after COMMIT was sent; whether the changes were saved is unknown. Check the target tables before running the job again.');
  try {
    const earlier = guard.failure();
    if (earlier) throw earlier; // it died while the pool was handing it over
    await client.query('begin');
    await client.query(ddl);
    const result = await fn(client);
    commitSent = true;
    const answer = await client.query('commit');
    if (isRollbackTag(answer)) {
      // COMMIT answered with ROLLBACK: the transaction had already failed (a caught query error), so
      // the server rolled everything back. A confirmed rollback: a definite failure, never success.
      commitSent = false;
      throw new Error('COMMIT was answered with ROLLBACK: the transaction had already failed, so nothing was saved.');
    }
    return result;
  } catch (err) {
    if (commitSent && (guard.failure() || !isDefiniteCommitRefusal(err) || !clientUsable(client))) {
      lostByCode = new Error('connection lost');
      throw unknownOutcome();
    }
    let rollbackFailed = false;
    await client.query('rollback').catch(() => { rollbackFailed = true; });
    // A failed ROLLBACK never leaves the client in the pool, and after COMMIT was sent it also means unknown.
    if (rollbackFailed) lostByCode = new Error('connection lost');
    if (commitSent && (rollbackFailed || guard.failure() || !clientUsable(client))) {
      lostByCode = new Error('connection lost');
      throw unknownOutcome();
    }
    throw err;
  } finally {
    guard.stop();
    client.release(guard.failure() ?? lostByCode);
  }
}

/**
 * Chunked parameterized multi-row INSERT -- a dependency-free stand-in for real
 * `COPY FROM STDIN`.
 *
 * TODO(perf): at full scale (~150-220k active-TX rows/night steady-state, more for a
 * from-scratch backfill) this is measurably slower than streaming COPY. Swap in
 * `pg-copy-streams` (`client.query(copyFrom('COPY staging_census FROM STDIN WITH (FORMAT
 * csv)'))`, streaming rows through a CSV writer) once the staging DDL is finalized against
 * real column counts from a live probe -- left as parameterized INSERT here so the skeleton
 * has zero extra runtime dependencies and is trivial to read/adjust before that call is
 * made. `chunkSize` defaults conservatively; callers with wide rows (census: ~50 columns)
 * should pass a smaller value than callers with narrow rows (insurance filings: ~10) to stay
 * well under Postgres's 65535-bound-parameter-per-statement protocol limit.
 */
export async function bulkInsert(
  client: PgPoolClient,
  table: string,
  columns: readonly string[],
  rows: readonly unknown[][],
  chunkSize = 500
): Promise<number> {
  if (rows.length === 0) return 0;
  const colList = columns.map((c) => `"${c}"`).join(', ');
  let inserted = 0;

  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const values: unknown[] = [];
    const tuples = chunk.map((row, rowIdx) => {
      const placeholders = row.map((_, colIdx) => `$${rowIdx * columns.length + colIdx + 1}`);
      values.push(...row);
      return `(${placeholders.join(', ')})`;
    });
    await client.query(`insert into ${table} (${colList}) values ${tuples.join(', ')}`, values);
    inserted += chunk.length;
  }
  return inserted;
}
