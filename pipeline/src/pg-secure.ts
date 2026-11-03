import pg from 'pg';
import { dbSecurityFields, scramOnlyClient } from './db-tls.js';

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

export function securePgConfig(target: PgTargetFields): pg.ClientConfig {
  const { ssl, enableChannelBinding } = dbSecurityFields(target.host);
  return { host: target.host, port: target.port, user: target.user, password: target.password, database: target.database, ssl, enableChannelBinding } as pg.ClientConfig;
}

export function newSecurePgClient(target: PgTargetFields, extra: pg.ClientConfig = {}): pg.Client {
  const config = securePgConfig(target);
  const Client = scramOnlyClient(pg.Client);
  return new Client({ ...extra, ...config });
}

export function newSecurePgPool(target: PgTargetFields, extra: pg.PoolConfig = {}): pg.Pool {
  const config = securePgConfig(target);
  return new pg.Pool({ ...extra, ...config, Client: scramOnlyClient(pg.Client) as unknown as pg.PoolConfig['Client'] });
}
