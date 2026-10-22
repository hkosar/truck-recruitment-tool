// Test-database isolation (Gate 2 final check 2). Every DB-using test suite gets its OWN database
// in the task-owned A3 cluster: the base URL's database name plus a fixed per-suite suffix
// (tr_signin_test -> tr_signin_test_store, _readiness, _e2e), built by
// `scripts/a3-build-test-db.mjs --suites`. Suites that change global state (the emergency
// sign-out test revokes every staff session) therefore cannot share a database with another
// suite, even when vitest runs the files in parallel. test-db.test.ts enforces that every suite
// reads the database settings only through this helper and that no two suites share a name.

export const DB_SUITES = ['store', 'readiness', 'e2e'] as const;
export type DbSuite = (typeof DB_SUITES)[number];

function forSuite(base: string | undefined, suite: DbSuite): string | undefined {
  if (!base) return undefined;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return undefined;
  }
  const name = url.pathname.replace(/^\//, '');
  if (url.hostname !== '127.0.0.1' || !/^tr_[a-z0-9_]+$/.test(name)) return undefined; // loopback, tr_* only
  url.pathname = `/${name}_${suite}`;
  return url.toString();
}

/** The suite's own app-role and admin URLs, or undefined (suite skipped) when not configured. */
export function suiteDatabase(suite: DbSuite, env: Record<string, string | undefined> = process.env): { appUrl: string; adminUrl: string } | undefined {
  const appUrl = forSuite(env.A3_APP_URL, suite);
  const adminUrl = forSuite(env.A3_ADMIN_URL, suite);
  return appUrl && adminUrl ? { appUrl, adminUrl } : undefined;
}
