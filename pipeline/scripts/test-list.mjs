// The one place that says which pipeline/src/**/*.test.ts files exist and what happens to them (run-tests.mjs enforces it).
// Adding a test file: add ONE line to TESTS (it runs in `npm test`) or to NOT_RUN (it runs elsewhere, with the reason).
// A *.test.ts that is in neither list, or a listed file that is missing, makes `npm test` refuse before anything runs.
// Keep each list sorted: one line per file keeps parallel branches from conflicting on the same line.

/** Runs first, always. */
export const SMOKE = 'src/smoke-tests.ts';

/** Run by `npm test`, in this (sorted) order, each as its own process; the first failure stops the run. */
export const TESTS = [
  'src/backout-rehearsal.test.ts',
  'src/batch-delete-compare.test.ts',
  'src/db-tls.test.ts',
  'src/first-manager-bootstrap.test.ts',
  'src/loopback-fetch.test.ts',
  'src/prod-sql.test.ts',
  'src/retention-secure-a3-pki-guard.test.ts',
  'src/role-matrix-a3.test.ts',
  'src/role-password.test.ts',
  'src/staging2-pooler-guard.test.ts',
  'src/target-guard-messages.test.ts',
];

/** Present on disk but deliberately not part of `npm test`; the reason says where (if anywhere) each one runs. */
export const NOT_RUN = [
  ['src/backout-rehearsal-a3.test.ts', 'real PostgreSQL: scripts/run-real-db-suites.mjs'],
  ['src/batch-delete-compare-a3.test.ts', 'real PostgreSQL: scripts/run-real-db-suites.mjs'],
  ['src/environment-preflight-a3.test.ts', 'real PostgreSQL: scripts/run-real-db-suites.mjs'],
  ['src/first-manager-bootstrap-a3.test.ts', 'real PostgreSQL: scripts/run-real-db-suites.mjs'],
  ['src/first-manager-failure.test.ts', 'a helper imported by first-manager-bootstrap.test.ts, not a stand-alone run'],
  ['src/ledger-preflight-a3.test.ts', 'real PostgreSQL: scripts/run-real-db-suites.mjs'],
  ['src/load-location-tables.test.ts', 'needs external ZCTA / places data files that are not in the repo (npm run test:location-tables)'],
  ['src/m1-supabase-runner-a3.test.ts', 'real PostgreSQL (own NOSUPERUSER cluster): scripts/run-real-db-suites.mjs'],
  ['src/owner-bootstrap-a3.test.ts', 'real PostgreSQL: scripts/run-real-db-suites.mjs'],
  ['src/prod-sql-a2-backouts-a3.test.ts', 'real PostgreSQL: scripts/run-real-db-suites.mjs'],
  ['src/prod-sql-a3.test.ts', 'real PostgreSQL: scripts/run-real-db-suites.mjs'],
  ['src/prod-sql-stop-tables-pg.test.ts', 'real PostgreSQL: scripts/run-real-db-suites.mjs'],
  ['src/reapply-m1c-a3.test.ts', 'real PostgreSQL: scripts/run-real-db-suites.mjs'],
  ['src/retention-a3.test.ts', 'real PostgreSQL: scripts/run-real-db-suites.mjs'],
  ['src/retention-run-a3.test.ts', 'real PostgreSQL: scripts/run-real-db-suites.mjs'],
  ['src/retention-secure-a3.test.ts', 'real PostgreSQL: scripts/run-real-db-suites.mjs'],
];
