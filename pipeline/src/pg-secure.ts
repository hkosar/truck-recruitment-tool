import { types } from 'node:util';
import pg from 'pg';
import { DbTlsRefusal, dbSecurityFields, isLoopbackHost, scramOnlyClient } from './db-tls.js';
import { RunnerRefusal } from './refusals.js';
import { isStaging2PoolerAddress, namesRebuiltStaging } from './target-guard.js';

/**
 * pg clients and pools for the pipeline and its runners, with the hosted-database policy of db-tls.ts: a hosted target
 * uses verify-full TLS against the pinned root only (refused before dialling when none is pinned), SCRAM-SHA-256 only,
 * channel binding when offered. Built from explicit fields, never from a connection string. `pg.Client` is looked up at
 * call time (tests replace it).
 */
export interface PgTargetFields {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/**
 * The only tuning options a caller may add. Anything else is refused before dialling: pg lets `connectionString` replace
 * host, port and ssl (so `?sslmode=disable` would switch TLS off), and `ssl`, `host`, `port`, `stream`, `Client` and the like
 * replace the target or the checked transport. An allow-list, so an option pg adds later is refused until reviewed.
 */
const ALLOWED_EXTRA_OPTIONS: ReadonlySet<string> = new Set(['max', 'idleTimeoutMillis', 'connectionTimeoutMillis', 'allowExitOnIdle', 'statement_timeout', 'query_timeout', 'application_name', 'keepAlive', 'keepAliveInitialDelayMillis']);

/** `application_name` goes into the startup message unescaped: only a short plain label may pass, so it cannot add parameters. */
const SAFE_APPLICATION_NAME = /^[A-Za-z0-9._-]{1,63}$/;
/** TCP keep-alive (socket.setKeepAlive): a boolean switch and an initial delay that is a whole number of milliseconds, 0 to 10 minutes. */
const MAX_KEEPALIVE_INITIAL_DELAY_MS = 600_000;

function refuseOverride(): never {
  throw new DbTlsRefusal('connection_override', 'refusing: a caller option may not replace the database target or its TLS settings');
}

/**
 * Copies the caller's options once into a fresh null-prototype object of plain data values and returns only that copy.
 * Each own key is read exactly once, through its property descriptor: a getter/setter, a Proxy, a symbol key, a non-plain
 * prototype or a non-primitive value is refused, so nothing can answer differently between the check and the use.
 */
function checkedExtra<T extends object>(extra: T): T {
  if (types.isProxy(extra) || Object.getPrototypeOf(extra) !== Object.prototype || Object.getOwnPropertySymbols(extra).length > 0) refuseOverride();
  const copy: Record<string, string | number | boolean> = Object.create(null);
  for (const key of Object.getOwnPropertyNames(extra)) {
    if (!ALLOWED_EXTRA_OPTIONS.has(key)) refuseOverride();
    const descriptor = Object.getOwnPropertyDescriptor(extra, key);
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) refuseOverride();
    const value: unknown = descriptor.value;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') refuseOverride();
    if (key === 'application_name' && (typeof value !== 'string' || !SAFE_APPLICATION_NAME.test(value))) refuseOverride();
    if (key === 'keepAlive' && typeof value !== 'boolean') refuseOverride();
    if (key === 'keepAliveInitialDelayMillis' && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_KEEPALIVE_INITIAL_DELAY_MS)) refuseOverride();
    copy[key] = value;
  }
  return copy as unknown as T;
}

/**
 * Staging-2 is reached only through the session pooler (target-guard.ts STAGING2_POOLER_ADDRESS): a target that points at
 * staging-2 by any other host or port is refused here, before a client exists. Every pg client and pool in the pipeline is
 * configured through securePgConfig, so this is the one choke point; the staging-2 planners also call it so a plan-only run
 * refuses too. Fixed text only: never the host, user, password or project ref. Other projects are not affected.
 * Local test databases are not the hosted project: a loopback host, or a name under the reserved `.invalid` top-level domain
 * (RFC 6761: never resolves; the TLS test kit redirects it to a local fake server), is left to db-tls.ts. The planners still
 * refuse both, because parseSupabaseDbTarget accepts only Supabase hosts.
 */
export function refuseStaging2UnlessPooler(target: { host: string; port: number; user: string; projectRef?: string }): void {
  const host = String(target.host).toLowerCase();
  if (isLoopbackHost(host) || host.endsWith('.invalid')) return;
  if (namesRebuiltStaging(target) && !isStaging2PoolerAddress(target)) {
    throw new RunnerRefusal('staging2_pooler_required', 'refusing: staging-2 is reached only through the Supabase session pooler (pooler host, port 5432)');
  }
}

export function securePgConfig(target: PgTargetFields): pg.ClientConfig {
  refuseStaging2UnlessPooler(target);
  const { ssl, enableChannelBinding } = dbSecurityFields(target.host);
  return { host: target.host, port: target.port, user: target.user, password: target.password, database: target.database, ssl, enableChannelBinding } as pg.ClientConfig;
}

export function newSecurePgClient(target: PgTargetFields, extra: pg.ClientConfig = {}): pg.Client {
  const checked = checkedExtra(extra);
  const config = securePgConfig(target);
  const Client = scramOnlyClient(pg.Client);
  return new Client({ ...checked, ...config });
}

export function newSecurePgPool(target: PgTargetFields, extra: pg.PoolConfig = {}): pg.Pool {
  const checked = checkedExtra(extra);
  const config = securePgConfig(target);
  return new pg.Pool({ ...checked, ...config, Client: scramOnlyClient(pg.Client) as unknown as pg.PoolConfig['Client'] });
}
