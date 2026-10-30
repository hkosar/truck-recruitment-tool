// Test-database isolation (Gate 2 final check 2, tightened after the load-generator clash).
//
// Every DB-using test suite gets its OWN database per RUN: <base>_<run id>_<suite>, e.g.
// tr_signin_test_m1_store. The run id comes from A3_RUN_ID and must be unique per concurrent
// process; `scripts/a3-build-test-db.mjs --suites --run <id>` creates the databases (ownership
// checked) and `--drop-run <id>` drops them. On top of the name, each suite takes an exclusive
// claim on its database for its whole duration (a session advisory lock); a second process on the
// same database fails loudly instead of silently interleaving. test-db.test.ts enforces that every
// suite reads the settings only here and claims its database.

import pg from 'pg';

export const DB_SUITES = ['store', 'readiness', 'e2e'] as const;
export type DbSuite = (typeof DB_SUITES)[number];
export const RUN_ID = /^[a-z][a-z0-9]{1,15}$/;
/** Advisory-lock key for the per-database claim (advisory locks are per database). */
const CLAIM_KEY = 727_001;

function forSuite(base: string | undefined, run: string, suite: DbSuite): string | undefined {
  if (!base) return undefined;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return undefined;
  }
  const name = url.pathname.replace(/^\//, '');
  if (url.hostname !== '127.0.0.1' || !/^tr_[a-z0-9_]+$/.test(name)) return undefined; // loopback, tr_* only
  url.pathname = `/${name}_${run}_${suite}`;
  return url.toString();
}

/**
 * The suite's own app-role and admin URLs for this run, or undefined (suite skipped) when the A3
 * settings are absent. Throws when the settings are present but A3_RUN_ID is missing or invalid,
 * so a misconfigured run fails loudly instead of sharing a database.
 */
export function suiteDatabase(suite: DbSuite, env: Record<string, string | undefined> = process.env): { appUrl: string; adminUrl: string } | undefined {
  if (!env.A3_APP_URL && !env.A3_ADMIN_URL) return undefined;
  const run = env.A3_RUN_ID ?? '';
  if (!RUN_ID.test(run)) throw new Error('A3_RUN_ID must be set to a unique run id (a-z, 0-9, 2-16 chars) for DB test suites');
  const appUrl = forSuite(env.A3_APP_URL, run, suite);
  const adminUrl = forSuite(env.A3_ADMIN_URL, run, suite);
  return appUrl && adminUrl ? { appUrl, adminUrl } : undefined;
}

/**
 * Exclusive claim on the suite's database for the suite's whole duration. Rejects if another
 * process holds it. Call in beforeAll; call the returned release in afterAll.
 */
export async function claimSuiteDatabase(adminUrl: string): Promise<() => Promise<void>> {
  const client = new pg.Client({ connectionString: adminUrl });
  // The advisory lock lives as long as this connection. If it drops, the claim is gone: remember
  // that (instead of an uncaught exception) and fail the suite at release.
  let lost = false;
  client.on('error', () => {
    lost = true;
  });
  await client.connect();
  const { rows } = await client.query<{ ok: boolean }>('select pg_try_advisory_lock($1) as ok', [CLAIM_KEY]);
  if (!rows[0]?.ok) {
    await client.end();
    throw new Error(`test database ${new URL(adminUrl).pathname.slice(1)} is in use by another run; refusing to share it`);
  }
  return async () => {
    await client.end().catch(() => undefined); // ending the session releases the advisory lock
    if (lost) throw new Error(`the claim on test database ${new URL(adminUrl).pathname.slice(1)} was lost: its connection dropped during the run`);
  };
}
