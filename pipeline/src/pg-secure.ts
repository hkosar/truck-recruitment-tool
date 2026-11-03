import pg from 'pg';
import { DbTlsRefusal, dbSecurityFields, scramOnlyClient } from './db-tls.js';

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
const ALLOWED_EXTRA_OPTIONS: ReadonlySet<string> = new Set(['max', 'idleTimeoutMillis', 'connectionTimeoutMillis', 'allowExitOnIdle', 'statement_timeout', 'query_timeout', 'application_name']);

/** `application_name` goes into the startup message unescaped: only a short plain label may pass, so it cannot add parameters. */
const SAFE_APPLICATION_NAME = /^[A-Za-z0-9._-]{1,63}$/;

function checkedExtra<T extends object>(extra: T): T {
  for (const key of Object.keys(extra)) {
    if (!ALLOWED_EXTRA_OPTIONS.has(key)) throw new DbTlsRefusal('connection_override', 'refusing: a caller option may not replace the database target or its TLS settings');
  }
  const applicationName = (extra as { application_name?: unknown }).application_name;
  if ('application_name' in extra && (typeof applicationName !== 'string' || !SAFE_APPLICATION_NAME.test(applicationName))) {
    throw new DbTlsRefusal('connection_override', 'refusing: a caller option may not replace the database target or its TLS settings');
  }
  if (Object.getOwnPropertySymbols(extra).length > 0 || Object.getPrototypeOf(extra) !== Object.prototype) {
    throw new DbTlsRefusal('connection_override', 'refusing: a caller option may not replace the database target or its TLS settings');
  }
  return extra;
}

export function securePgConfig(target: PgTargetFields): pg.ClientConfig {
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
