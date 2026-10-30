// REAL-POSTGRESQL regression: COMMIT answered with the command tag ROLLBACK must not be reported as
// a saved write. Opt-in, like the other *.db.test.ts suites: skipped unless ROLLBACK_TAG_TEST_URL is
// set to a LOOPBACK database named tr_* on a throwaway local cluster (it needs no schema; it creates
// and drops its own uniquely named table). Never point it at a hosted database.
//   ROLLBACK_TAG_TEST_URL = postgres://<user>:<throwaway>@127.0.0.1:<port>/tr_<name>
//
// The work inserts a row, runs a query that fails (1/0), CATCHES that error and returns normally.
// PostgreSQL then answers COMMIT with the tag ROLLBACK (the transaction was already aborted) and
// writes nothing. A second, independent session checks that the row is absent.

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OutcomeUnknownError, UnavailableError } from '../core/types';
import { Database } from './database';

const URL_VALUE = process.env.ROLLBACK_TAG_TEST_URL;
function approved(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.hostname === '127.0.0.1' && /^\/tr_[a-z0-9_]+$/.test(url.pathname);
  } catch {
    return false;
  }
}
const enabled = approved(URL_VALUE);
if (URL_VALUE && !enabled) throw new Error('ROLLBACK_TAG_TEST_URL must be a 127.0.0.1 URL to a database named tr_*');

describe.skipIf(!enabled)('real PostgreSQL: COMMIT answered with ROLLBACK', () => {
  const table = `rollback_tag_proof_${Date.now().toString(36)}`;
  let admin: pg.Client;
  let db: Database;
  const count = async () => (await admin.query<{ n: number }>(`select count(*)::int as n from ${table}`)).rows[0]!.n;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: URL_VALUE });
    admin.on('error', () => undefined);
    await admin.connect();
    await admin.query(`create table ${table} (id int primary key)`);
    db = new Database({ connectionString: URL_VALUE!, max: 1, connectionTimeoutMillis: 2_000 });
  });
  afterAll(async () => {
    await db?.close();
    await admin?.query(`drop table if exists ${table}`);
    await admin?.end();
  });

  it('Database.transaction: a caught failed query then COMMIT is a definite failure and nothing is written (checked from another session)', async () => {
    let caughtCode: string | undefined;
    const outcome = await db
      .transaction({}, async (tx) => {
        await tx.query(`insert into ${table} values (1)`);
        try {
          await tx.query('select 1/0');
        } catch (e) {
          caughtCode = (e as { code?: string }).code;
        }
        return 'saved';
      })
      .then(() => 'RESOLVED', (e: unknown) => e);
    expect(caughtCode).toBe('22012');
    expect(outcome).toBeInstanceOf(UnavailableError);
    expect(outcome).not.toBeInstanceOf(OutcomeUnknownError);
    expect(await count()).toBe(0); // absent for an independent session
    expect(db.poolCounts.idle).toBe(1); // the connection is healthy and was returned
    // The very next transaction on the same pool still works.
    await db.transaction({}, async (tx) => {
      await tx.query(`insert into ${table} values (2)`);
    });
    expect(await count()).toBe(1);
  });

  it('pipeline withStagingConnection: the same sequence rejects and nothing is written', async () => {
    const { withStagingConnection } = await import('../../../pipeline/src/db');
    const pool = new pg.Pool({ connectionString: URL_VALUE, max: 1 });
    pool.on('error', () => undefined);
    try {
      const before = await count();
      // The pipeline package has its own copy of the pg types; the cast only bridges the two.
      const work = (async (client: pg.PoolClient) => {
        await client.query(`insert into ${table} values (3)`);
        try {
          await client.query('select 1/0');
        } catch {
          /* caught on purpose */
        }
        return 'saved';
      }) as never;
      const outcome = await withStagingConnection(pool as never, 'select 1', work).then(() => 'RESOLVED', (e: unknown) => e);
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toMatch(/answered with ROLLBACK/);
      expect(await count()).toBe(before);
    } finally {
      await pool.end();
    }
  });
});
