#!/usr/bin/env node
// LOCAL ONLY: runs the real-PostgreSQL suites listed in SUITE_FILES (17 suites, see the "Not covered" list below) against throwaway
// PostgreSQL 16 (default) or 17 (PG_BIN) clusters that this script creates and always removes: one shared by 15 suites, a second one only for role-password
// (it drops and recreates recruiter_app / recruiter_maintenance, which are cluster-wide, and needs pg_stat_statements preloaded and a
// server log it can read), and a third one only for retention-secure's TLS scenario (ssl=on with a throwaway CA, recruiter_maintenance
// allowed in over hostssl + scram-sha-256 only), and a fourth one only for m1-supabase-runner (it applies M1 as a NOSUPERUSER
// CREATEROLE login, which needs the cluster-wide recruiter_* roles NOT to exist yet, and drops them after each case). It contacts no
// hosted or staging database, reads no secret store and uses no network except 127.0.0.1.
//
// How to run (from the repository root; app/node_modules and pipeline/node_modules must already exist, nothing is installed):
//   node scripts/run-real-db-suites.mjs
//   PG_BIN="C:\Program Files\PostgreSQL\16\bin" node scripts/run-real-db-suites.mjs     (only if PostgreSQL 16 is elsewhere)
//   PG_BIN="<PostgreSQL 17 folder>\bin" node scripts/run-real-db-suites.mjs                 (the same suites on PostgreSQL 17, as hosted staging-2)
// Only major 16 or 17 is accepted (pg_ctl --version); the first output line names the major and bin folder used. On 17 role-password
// runs all its real-server checks plus the 17-only transaction_timeout ones (TRUCKRECRU-142), and the A3 shim's empty
// stand-in extension is built from tsm_system_rows when test_ext5 is not installed (scripts/a3-build-test-db.mjs).
// Output: one "PASS <suite>", "FAIL <suite>: <reason>" or "TIMEOUT <suite>: ..." line per suite, then a summary. The exit code is 0 only
// when every listed suite ran and passed; a failed, timed-out, skipped, missing or interrupted suite gives a non-zero exit code.
// Test switches: RDB_SUITES_INJECT_FAIL=<suite id> replaces that one suite with a command that fails; RDB_SUITES_INJECT_HANG=<suite id>
// replaces it with a command that never ends (to prove the TIMEOUT line); RDB_SUITES_TIMEOUT_MS=<n> sets the per-suite time limit
// (default 15 minutes). RDB_SUITES_ONLY=<id>,<id> runs just those suites (for fixing one); the others print SKIP and the exit code stays non-zero.
// RDB_SUITES_FIRST=<suite id> runs that suite first instead of in its normal place (to prove that no suite depends on the order).
//
// Not covered (no real-database run by this script):
//   - pipeline/src/load-location-tables.test.ts: its real-PostgreSQL part needs external ZCTA / places data files that are not in the repo.
//   - Anything hosted: Supabase Auth service writes, the hosted login's privileges and TLS are only ever proven by the hosted probes.
// Every other env-gated real-PostgreSQL test file in pipeline/src and app/server is listed in SUITE_FILES; the contract
// (scripts/verify-real-db-suites-contract.mjs) fails if a new one appears on disk and is neither listed nor excluded with a reason.
//
// What it does, in order:
//   1. refuses to start if DATABASE_URL, STAGING_DB_URL, any *_DB_URL / *DATABASE_URL or a PG* variable points anywhere but loopback
//      (a URL variable with a query string is refused too). Every child process this script starts (suites, initdb, pg_ctl, vite) gets
//      only the short allow-list in ENV_ALLOW (PATH, Windows system folders, ...) plus NO_COLOR=1 / FORCE_COLOR=0 and the loopback
//      settings this script gives that child; the only spawn call is inside makeSh, which always sets that environment;
//   2. creates a fresh temp folder, runs initdb (scram-sha-256, random passwords kept only in files inside that folder) and starts the
//      cluster on 127.0.0.1 at a random free port; then the same for the role-password cluster (folder rp-data, pg_stat_statements
//      preloaded, server log rp-server.log, one database tr_role_password with the "role-password-owned:" comment and the extension);
//      then the TLS cluster (folder tls\data): pipeline/src/retention-secure-a3-make-pki.ts writes a throwaway root CA and a server
//      certificate/key into the temp folder (tls-pki, deleted with it), and tlsClusterFiles() turns ssl on and replaces pg_hba.conf;
//      then the m1-supabase-runner cluster (folder m1sr\data, with its own A3_TASK_OWNED);
//   3. builds the test databases with scripts/a3-build-test-db.mjs, creates three empty owned databases for the suites that need one,
//      and gives recruiter_maintenance / recruiter_app throwaway logins inside that cluster only;
//   4. runs each suite with its own database and environment (a time limit per suite), and (for the app suite) one vite build into
//      app/dist. vite and vitest write their caches under the temp folder, not under node_modules;
//   5. ALWAYS (success, failure, Ctrl+C, unexpected error): pg_ctl -D <its own folder> stop for each of its four clusters, deletes the
//      folder (passwords and the throwaway TLS key included) and removes app/dist if this run built it. It never signals or stops any
//      other process.
// If this run is killed so hard that no handler runs (Task Manager, power loss), the folder rdb-suites-* in the temp directory and
// the postgres processes of its data folders remain: stop them with pg_ctl -D <that folder>\data stop, pg_ctl -D <that folder>\rp-data
// stop, pg_ctl -D <that folder>\tls\data stop and pg_ctl -D <that folder>\m1sr\data stop, then delete the folder.
//
// Test isolation: PostgreSQL roles belong to the whole cluster, not to one database. The prod-sql suites run production back-out steps
// that take two things away from recruiter_app: supabase/backout/retire-app-credentials.sql:13 ("alter role recruiter_app nologin
// password null": no login, no password) and, through prod-sql-a3.test.ts section 8, supabase/backout/M1-backout.sql:482 ("revoke
// recruiter_api from recruiter_app": the role through which recruiter_app gets all its rights). So the script (a) puts the prod-sql
// suites last and (b) after EVERY suite re-applies LOGIN, the password and the recruiter_api membership (restoreStatements), so no suite
// depends on the order of the others; RDB_SUITES_FIRST=prod-sql proves it (17 of 17). Other cluster-wide changes (authenticator
// settings, zz_ roles, recruiter_maintenance grants) are made and undone by the suites themselves; a suite that crashes half way can leave
// them behind, which makes later suites FAIL (never a false PASS).

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const ADMIN_USER = 'tr_test_admin';
const RUN_ID = 'rdb';
export const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
/** Colour off for every child: vitest colours its summary on Windows unless NO_COLOR is set, and colour codes break the result parsing. */
export const CHILD_COLOR_OFF = { NO_COLOR: '1', FORCE_COLOR: '0' };

/** The per-suite time limit in ms. Anything that is not a number above zero gives the default (0 would mean "no limit" to spawnSync). Pure. */
export function resolveTimeoutMs(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

/** A time limit for messages: under 1 second in ms (never "0 s"), otherwise in seconds (one decimal only when needed). Pure. */
export function formatLimit(ms) {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${Number((ms / 1000).toFixed(1))} s`;
}

/** Removes ANSI escape sequences (colour, cursor) from child output. Pure. */
export function stripAnsi(text) {
  return String(text).replace(/\x1b\[[0-9;?]*[\x20-\x2f]*[\x40-\x7e]/g, '');
}

/** Variables that can name a database or a server. Anything URL-like must be loopback; hosts must be loopback; service files are refused. */
const isConnectionVar = (k) => /^(DATABASE_URL|PG.*)$/i.test(k) || /(_|^)DB_URL$/i.test(k) || /DATABASE_URL$/i.test(k);
const isUrlLike = (v) => /^[a-z][a-z0-9+.-]*:\/\//i.test(v);

/** Returns the names (never values) of connection variables that do not point at loopback. Pure. */
export function nonLoopbackConnectionVars(env) {
  const bad = [];
  for (const [k, v] of Object.entries(env)) {
    if (!isConnectionVar(k) || v === undefined || v === '') continue;
    const key = k.toUpperCase();
    if (key === 'PGSERVICE' || key === 'PGSERVICEFILE' || key === 'PGSYSCONFDIR') { bad.push(k); continue; }
    if (isUrlLike(v)) {
      let u;
      try { u = new URL(v); } catch { bad.push(k); continue; }
      // libpq and pg-connection-string honour ?host= / ?hostaddr=, so a query string can redirect a loopback-looking URL.
      if (!LOOPBACK_HOSTS.has(u.hostname.toLowerCase()) || u.search !== '') bad.push(k);
    } else if (key === 'PGHOST' || key === 'PGHOSTADDR') {
      if (!LOOPBACK_HOSTS.has(v.toLowerCase())) bad.push(k);
    } else if (/URL$/i.test(key)) {
      bad.push(k); // a URL variable that is not a URL we can check
    }
  }
  return bad;
}

/** The only parent variables a child may inherit (compared case-insensitively). Everything else, including every *_URL, PG*, token
 *  and secret-store variable, is dropped. */
export const ENV_ALLOW = [
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'OS', 'TEMP', 'TMP', 'TMPDIR',
  'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
  'PROGRAMW6432', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'COMMONPROGRAMW6432', 'ALLUSERSPROFILE', 'PUBLIC',
  'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER',
  'LANG', 'LC_ALL', 'TZ', 'TERM',
];
const ENV_ALLOW_SET = new Set(ENV_ALLOW.map((n) => n.toUpperCase()));

/** The environment the children get: an explicit allow-list copy of the parent environment. Pure. */
export function scrubbedEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && ENV_ALLOW_SET.has(k.toUpperCase())) out[k] = v;
  }
  return out;
}

/** Replaces every secret in text by <masked>. Empty secrets are ignored (splitting on '' would shred the text). Pure. */
export function maskSecrets(text, secrets) {
  return secrets.filter((s) => typeof s === 'string' && s.length > 0).reduce((t, s) => t.split(s).join('<masked>'), String(text));
}

/** Lines in the output that announce a self-skip: "skip ...", "skip: ..." or just "skip", except exact lines the suite is known to print
 *  legitimately (allowed). Pure. */
export function findSkipLines(out, allowed = []) {
  const ok = new Set(allowed.map((l) => l.trim()));
  return out.split(/\r?\n/).filter((l) => /^\s*skip\b/i.test(l) && !ok.has(l.trim()));
}

/** True only if dir is a direct child of tmp whose name starts with rdb-suites-. A drive root, tmp itself, a parent, a sibling or a
 *  relative-escape path is refused. Pure. */
export function isSafeToDelete(dir, tmp) {
  if (!dir || !tmp) return false;
  const rel = relative(resolve(tmp), resolve(dir));
  if (rel === '' || isAbsolute(rel) || rel.split(/[\\/]/).length !== 1 || rel === '..') return false;
  return basename(resolve(dir)).startsWith('rdb-suites-') && basename(resolve(dir)) === rel;
}

/** Turns one finished child process into { status: 'PASS' | 'FAIL' | 'TIMEOUT', reason }. `out` must already be masked. Pure. */
export function classifyOutcome({ kind, r, out, interrupted = false, allowedSkips = [], timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (interrupted) return { status: 'FAIL', reason: 'interrupted' };
  if (r.error?.code === 'ETIMEDOUT') return { status: 'TIMEOUT', reason: `exceeded the ${formatLimit(timeoutMs)} time limit and was ended` };
  if (r.error) return { status: 'FAIL', reason: `could not start: ${r.error.code ?? 'error'}` };
  if (r.status !== 0) {
    const lines = out.split('\n').filter((l) => l.trim());
    const key = lines.filter((l) => /\b(FAIL|Error|AssertionError|Tests\s+\d)/.test(l)).slice(0, 8);
    return { status: 'FAIL', reason: `exit ${r.status ?? `signal ${r.signal}`}: ${[...key, ...lines.slice(-3)].join(' | ').slice(0, 1500)}` };
  }
  const tail = out.split('\n').filter((l) => l.trim()).slice(-3).join(' | ').slice(0, 600);
  if (kind === 'tsx') {
    if (findSkipLines(out, allowedSkips).length || !/^\s*PASS\b/m.test(out)) return { status: 'FAIL', reason: `skipped itself or printed no PASS line (exit 0); last lines: ${tail}` };
  } else if (kind === 'vitest') {
    if (/\b[1-9]\d* (skipped|todo)\b/i.test(out) || !/Tests\s+\d+ passed/.test(out)) return { status: 'FAIL', reason: `some tests were skipped or no pass count was printed (exit 0); last lines: ${tail}` };
  } else {
    return { status: 'FAIL', reason: `unknown suite kind: ${kind}` };
  }
  return { status: 'PASS' };
}

/** Runs one suite through `sh` and classifies it. Children get exactly baseEnv + the suite's own variables. */
export function executeSuite(s, { sh, mask, baseEnv, timeoutMs, isInterrupted }) {
  const pre = s.before ? s.before() : undefined;
  if (pre) return { status: 'FAIL', reason: pre };
  const r = sh(s.cmd, s.args, { cwd: s.cwd, env: { ...baseEnv, ...s.env }, timeout: timeoutMs });
  const out = mask(stripAnsi(`${r.stdout ?? ''}${r.stderr ?? ''}`));
  return classifyOutcome({ kind: s.kind, r, out, interrupted: isInterrupted(), allowedSkips: s.allowedSkips ?? [], timeoutMs });
}

/** The one place a child process is started. `spawn` is spawnSync (a fake in the tests). Every call gets `env: baseEnv` unless the caller
 *  passes its own env, which the callers build from baseEnv. A missing, undefined or null env also gets baseEnv (spawn would hand the
 *  child the whole parent environment). */
export function makeSh(baseEnv, spawn = spawnSync) {
  return (cmd, args, opts = {}) => spawn(cmd, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024, ...opts, env: opts.env ?? baseEnv });
}

/** The arguments of the app suite's vitest run. --no-cache: no results.json in node_modules/.vite; the module cache and the config loader
 *  stay under the temp folder. Pure. */
export function vitestArgs(vitestMjs, cacheDir) {
  return [vitestMjs, 'run', '--no-cache', '--fsModuleCachePath', join(cacheDir, 'vitest'), '--configLoader', 'runner'];
}

/** The statements that give back everything the prod-sql suites can take from the throwaway logins (roles are cluster-wide):
 *  retire-app-credentials.sql (nologin, no password) and M1-backout.sql (recruiter_api membership of recruiter_app). Pure. */
export function restoreStatements({ maintPw, appPw }) {
  const q = (s) => `'${s.replace(/'/g, "''")}'`;
  return [
    `alter role recruiter_maintenance login password ${q(maintPw)}`,
    `alter role recruiter_app login password ${q(appPw)}`,
    'grant recruiter_api to recruiter_app',
  ];
}

/** The server options (pg_ctl -o) of a throwaway cluster: its port, loopback only. `rolePassword` adds what role-password.test.ts needs:
 *  pg_stat_statements preloaded, and statements of failed commands written to the stderr log that pg_ctl -l captures (no collector). Pure. */
export function pgServerOptions(port, { rolePassword = false } = {}) {
  const base = `-p ${Number(port)} -c listen_addresses=127.0.0.1`;
  return rolePassword ? `${base} -c shared_preload_libraries=pg_stat_statements -c log_min_error_statement=error -c logging_collector=off` : base;
}

/** The two files that make a throwaway cluster the TLS cluster of retention-secure-a3.test.ts: `conf` is appended to postgresql.conf
 *  (ssl on, the throwaway server certificate and key), `hba` replaces pg_hba.conf: recruiter_maintenance only over TLS with
 *  scram-sha-256 (a plain connection is rejected), the admin login over scram-sha-256, 127.0.0.1 only; nothing else matches (refused).
 *  A path with a quote or a line break is refused. Pure. */
export function tlsClusterFiles({ certFile, keyFile }) {
  const q = (p) => {
    const s = String(p).replace(/\\/g, '/');
    if (!s || /['\r\n]/.test(s)) throw new Error('refusing: a TLS file path that is empty or has a quote or a line break');
    return `'${s}'`;
  };
  return {
    conf: `\n# run-real-db-suites: TLS cluster for retention-secure\nssl = on\nssl_cert_file = ${q(certFile)}\nssl_key_file = ${q(keyFile)}\n`,
    hba: [
      'hostssl   all recruiter_maintenance 127.0.0.1/32 scram-sha-256',
      'hostnossl all recruiter_maintenance 127.0.0.1/32 reject',
      `host      all ${ADMIN_USER} 127.0.0.1/32 scram-sha-256`,
      '',
    ].join('\n'),
  };
}

/** Moves the suite named `first` (if any) to the front; everything else keeps its order. Pure. */
export function orderSuites(suites, first) {
  if (!first) return suites;
  return [...suites.filter((s) => s.id === first), ...suites.filter((s) => s.id !== first)];
}

/** The statements that end the client sessions of a throwaway cluster (all but the one running them) and count what is left. Pure. */
export const STRAY_BACKENDS_SQL = "select pg_terminate_backend(pid) from pg_stat_activity where backend_type = 'client backend' and pid <> pg_backend_pid()";
export const STRAY_COUNT_SQL = "select count(*)::int as n from pg_stat_activity where backend_type = 'client backend' and pid <> pg_backend_pid()";

/** After a suite was ended by its time limit, its database sessions can outlive it (a backend waiting on a lock does not notice that the
 *  client is gone). `query(sql)` runs on one of THIS run's own clusters and returns the rows; the sessions are ended there and the count
 *  is polled until it is 0. Returns the number still open after `tries` polls. */
export async function terminateStrayBackends(query, { tries = 20, sleep = (ms) => new Promise((ok) => setTimeout(ok, ms)) } = {}) {
  let n = 0;
  for (let i = 0; i < tries; i++) {
    await query(STRAY_BACKENDS_SQL);
    n = Number((await query(STRAY_COUNT_SQL))[0]?.n ?? 0);
    if (n === 0) return 0;
    await sleep(250);
  }
  return n;
}

/** How long the runner's own admin client waits to connect to a throwaway cluster (a stuck local server must not hang the run). */
export const ADMIN_CONNECT_TIMEOUT_MS = 30000;

/** The connection settings of the runner's own admin client: loopback only, with a connect time limit. Pure. */
export function adminClientConfig({ port, password, database = 'postgres' }) {
  return { host: '127.0.0.1', port, user: ADMIN_USER, password, database, connectionTimeoutMillis: ADMIN_CONNECT_TIMEOUT_MS };
}

/** Ends the stray sessions on each given port through withAdmin(fn, { onPort }); throws if any session cannot be cleared. */
export async function endStrayOnPorts(ports, withAdmin, terminate = terminateStrayBackends) {
  for (const onPort of ports) {
    let left = 0;
    await withAdmin(async (c) => { left = await terminate(async (sql) => (await c.query(sql)).rows); }, { onPort });
    if (left) throw new Error(`${left} session(s) still open on port ${onPort}`);
  }
}

/** The line that says which suite RDB_SUITES_FIRST moved to the front (so a misspelt switch cannot go unnoticed). Pure. */
export function orderNotice(first) {
  return first ? `order: ${first} moved first (RDB_SUITES_FIRST)` : undefined;
}

/** Why the throwaway-certificate step failed: the time limit, or the helper's own refusing/usage line, or else its last lines.
 *  `out` must already be masked. Pure. */
export function describePkiFailure({ r, out, timeoutMs }) {
  if (r.error?.code === 'ETIMEDOUT') return `the certificate step exceeded the ${formatLimit(timeoutMs)} time limit and was ended`;
  if (r.error) return `the certificate step could not start: ${r.error.code ?? 'error'}`;
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
  const why = lines.filter((l) => /^(Error:\s*)?(refusing|usage)\b/i.test(l)); // anchored: tsx also prints the helper's source line, which contains the word
  return (why.length ? why : lines.slice(-4)).join(' | ').slice(0, 600);
}

/** Runs the suites one after another and pushes one result per suite into `results` (so a throw keeps what was done). After every suite
 *  that ran, `restore()` is awaited; if it fails the whole run fails. A suite not selected by `only` is recorded as SKIP (not a pass);
 *  after an interrupt no further suite is started. */
export async function runSuites(suites, { results, only, injectedFail, injectedHang, sh, mask, baseEnv, timeoutMs, isInterrupted, restore, afterTimeout, log = console.log }) {
  for (const s of suites) {
    if (isInterrupted()) { results.push({ id: s.id, status: 'FAIL', reason: 'not run: interrupted' }); continue; }
    if (only && !only.includes(s.id)) { results.push({ id: s.id, status: 'SKIP', reason: 'not selected' }); log(`SKIP ${s.id}: not selected (RDB_SUITES_ONLY); the run counts as incomplete`); continue; }
    let outcome;
    if (injectedFail === s.id) {
      const r = sh(process.execPath, ['-e', 'console.error("injected failure"); process.exit(1)']);
      outcome = { status: 'FAIL', reason: `injected failure (exit ${r.status})` };
    } else if (injectedHang === s.id) {
      const r = sh(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { timeout: timeoutMs });
      outcome = classifyOutcome({ kind: 'tsx', r, out: 'PASS', timeoutMs });
      if (outcome.status === 'PASS') outcome = { status: 'FAIL', reason: 'injected hang ended without a timeout' };
    } else {
      outcome = executeSuite(s, { sh, mask, baseEnv, timeoutMs, isInterrupted });
    }
    results.push({ id: s.id, ...outcome });
    log(outcome.status === 'PASS' ? `PASS ${s.id}` : `${outcome.status} ${s.id}: ${outcome.reason}`);
    if (outcome.status === 'TIMEOUT' && afterTimeout) {
      try { await afterTimeout(s.id); } catch (e) { throw new Error(`could not end the leftover database sessions after ${s.id} timed out: ${String(e?.message ?? e)}`); }
    }
    try { await restore(); } catch (e) { throw new Error(`could not restore the throwaway logins after ${s.id}: ${String(e?.message ?? e)}`); }
  }
}

/** Summary line and exit code. Any result that is not PASS counts as failed, and an expected suite with no result counts as missing
 *  (failed). A non-zero exit code already decided (priorExitCode) is never lowered. Pure. */
export function summarize(results, { expectedIds = [], interrupted = false, priorExitCode = 0 } = {}) {
  const all = [...results];
  const missing = expectedIds.filter((id) => !all.some((x) => x.id === id));
  for (const id of missing) all.push({ id, status: 'FAIL', reason: 'no result (suite never ran)' });
  const failed = all.filter((x) => x.status !== 'PASS');
  const passed = all.length - failed.length;
  const line = all.length
    ? `SUMMARY: ${passed} of ${all.length} suites passed, ${failed.length} failed, skipped or missing${interrupted ? ', interrupted' : ''}`
    : '';
  let exitCode = priorExitCode ?? 0;
  if (failed.length || interrupted) exitCode = exitCode || (interrupted ? 130 : 1);
  return { line, exitCode, failed: failed.map((x) => x.id) };
}

/** Every real-PostgreSQL test file this script runs. `file` is relative to the repository root. The contract compares this list with the disk. */
export const SUITE_FILES = [
  { id: 'app-vitest', kind: 'vitest', file: 'app/server/db/pg.db.test.ts' },
  { id: 'app-vitest', kind: 'vitest', file: 'app/server/db/readiness.db.test.ts' },
  { id: 'app-vitest', kind: 'vitest', file: 'app/server/e2e.http.test.ts' },
  { id: 'app-vitest', kind: 'vitest', file: 'app/server/db/database.rollback-tag.db.test.ts' },
  { id: 'role-matrix', kind: 'tsx', file: 'pipeline/src/role-matrix-a3.test.ts' },
  { id: 'batch-delete-compare', kind: 'tsx', file: 'pipeline/src/batch-delete-compare-a3.test.ts' },
  { id: 'reapply-m1c', kind: 'tsx', file: 'pipeline/src/reapply-m1c-a3.test.ts' },
  { id: 'retention-run', kind: 'tsx', file: 'pipeline/src/retention-run-a3.test.ts' },
  { id: 'retention-dry-run', kind: 'tsx', file: 'pipeline/src/retention-a3.test.ts' },
  { id: 'retention-secure', kind: 'tsx', file: 'pipeline/src/retention-secure-a3.test.ts' },
  { id: 'first-manager', kind: 'tsx', file: 'pipeline/src/first-manager-bootstrap-a3.test.ts' },
  { id: 'owner-bootstrap', kind: 'tsx', file: 'pipeline/src/owner-bootstrap-a3.test.ts' },
  { id: 'environment-preflight', kind: 'tsx', file: 'pipeline/src/environment-preflight-a3.test.ts' },
  { id: 'ledger-preflight', kind: 'tsx', file: 'pipeline/src/ledger-preflight-a3.test.ts' },
  { id: 'role-password', kind: 'tsx', file: 'pipeline/src/role-password.test.ts' },
  { id: 'backout-rehearsal', kind: 'tsx', file: 'pipeline/src/backout-rehearsal-a3.test.ts' },
  { id: 'm1-supabase-runner', kind: 'tsx', file: 'pipeline/src/m1-supabase-runner-a3.test.ts' },
  { id: 'prod-sql-stop-tables', kind: 'tsx', file: 'pipeline/src/prod-sql-stop-tables-pg.test.ts' },
  { id: 'prod-sql-a2-backouts', kind: 'tsx', file: 'pipeline/src/prod-sql-a2-backouts-a3.test.ts' },
  { id: 'prod-sql', kind: 'tsx', file: 'pipeline/src/prod-sql-a3.test.ts' },
];
/** Real-PostgreSQL (or env-gated) files that exist on purpose without being run here, each with its reason. */
export const EXCLUDED_FILES = [
  { file: 'pipeline/src/load-location-tables.test.ts', reason: 'its real-PostgreSQL part needs external ZCTA / places data files that are not in the repo' },
];
export const SUITE_IDS = [...new Set(SUITE_FILES.map((f) => f.id))];

/** The PostgreSQL major versions this script runs on: 16 (the default install, the line's audited version) and 17 (hosted staging-2). */
export const SUPPORTED_PG_MAJORS = [16, 17];

/** The one full-line shape `pg_ctl --version` prints on the supported installs ("pg_ctl (PostgreSQL) 16.15", "pg_ctl (PostgreSQL) 17.11"):
 *  no vendor suffix, no leading zero, no third number, no pre-release tag. */
const PG_CTL_VERSION_LINE = /^pg_ctl \(PostgreSQL\) (16|17)\.(0|[1-9][0-9]*)$/;

/** The major version from a finished `pg_ctl --version` process ({ status, signal, stdout }), or undefined unless the process
 *  succeeded (status 0, no signal) and its whole trimmed output is exactly one line of the shape above. Anything else fails closed. Pure. */
export function supportedPgMajor(result) {
  if (!result || typeof result !== 'object' || result.status !== 0 || result.signal || typeof result.stdout !== 'string') return undefined;
  const m = result.stdout.trim().match(PG_CTL_VERSION_LINE);
  return m ? Number(m[1]) : undefined;
}
function findPgBin() {
  const candidates = [process.env.PG_BIN, 'C:\\Program Files\\PostgreSQL\\16\\bin'].filter(Boolean);
  for (const dir of candidates) {
    const has = (n) => existsSync(join(dir, n + '.exe')) || existsSync(join(dir, n));
    if (has('initdb') && has('pg_ctl')) return dir;
  }
  return undefined;
}
const exe = (bin, name) => (existsSync(join(bin, name + '.exe')) ? join(bin, name + '.exe') : join(bin, name));
const token = (bytes = 24) => randomBytes(bytes).toString('base64url').replace(/[^A-Za-z0-9]/g, 'x');

function freePort() {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
}

function main() {
  return run();
}

async function run() {
  const results = []; // { id, status: 'PASS' | 'FAIL' | 'TIMEOUT' | 'SKIP', reason }
  let dir;
  const dataDirs = []; // the clusters this run made (main, role-password, tls, m1-supabase-runner), each stopped by its own folder
  let pgBin;
  let pgMajor;
  let clusterTouched = false;
  let builtDist = false;
  let interrupted = false;
  let cleaned = false;
  const secrets = [];
  const distDir = join(root, 'app', 'dist');

  const mask = (text) => maskSecrets(text, secrets);
  const baseEnv = { ...scrubbedEnv(process.env), ...CHILD_COLOR_OFF };
  const sh = makeSh(baseEnv);

  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    const problems = [];
    // 1. Stop only the clusters in our own folder.
    for (const dataDir of dataDirs) {
      if (!pgBin || !existsSync(join(dataDir, 'postmaster.pid'))) continue;
      const r = sh(exe(pgBin, 'pg_ctl'), ['-D', dataDir, 'stop', '-m', 'fast', '-w'], { stdio: 'ignore' });
      if (r.status !== 0) problems.push(`pg_ctl stop did not report success (${basename(dataDir)})`);
    }
    // 2. Delete our own folder (passwords included), after checking it is the folder we made.
    if (dir) {
      if (isSafeToDelete(dir, tmpdir())) {
        try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { problems.push('could not delete the temp folder'); }
        if (existsSync(dir)) problems.push('temp folder still exists');
      } else {
        problems.push('refused to delete a folder this run did not create');
      }
    }
    // 3. Remove app/dist only if this run built it.
    if (builtDist) {
      try { rmSync(distDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { problems.push('could not delete app/dist'); }
      if (existsSync(distDir)) problems.push('app/dist still exists');
    }
    if (clusterTouched || dir) console.log(problems.length ? `CLEANUP INCOMPLETE: ${problems.join('; ')}` : 'CLEANUP OK: clusters stopped, temp folder and passwords deleted' + (builtDist ? ', app/dist removed' : ''));
    if (problems.length) process.exitCode = 1;
  }

  const onSignal = () => { interrupted = true; };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(sig, onSignal);
  process.on('exit', cleanup); // last resort; cleanup is idempotent

  try {
    // ---- Refusals before anything is created.
    const bad = nonLoopbackConnectionVars(process.env);
    if (bad.length) {
      console.error(`REFUSED: these environment variables point somewhere other than loopback (values not shown): ${bad.join(', ')}. Unset them and run again.`);
      process.exitCode = 2;
      return;
    }
    pgBin = findPgBin();
    if (!pgBin) {
      console.error('REFUSED: PostgreSQL bin folder not found. Set PG_BIN (PostgreSQL 16 or 17) or install PostgreSQL 16 under "C:\\Program Files\\PostgreSQL\\16\\bin".');
      process.exitCode = 2;
      return;
    }
    const ver = sh(exe(pgBin, 'pg_ctl'), ['--version']);
    pgMajor = supportedPgMajor(ver);
    if (!pgMajor) {
      console.error(`REFUSED: the PostgreSQL bin folder is not version ${SUPPORTED_PG_MAJORS.join(' or ')} (pg_ctl --version: ${String(ver.stdout ?? '').trim().slice(0, 80) || 'no output'}).`);
      process.exitCode = 2;
      return;
    }
    console.log(`PostgreSQL major ${pgMajor} (bin folder ${pgBin})`);
    const need = [
      join(root, 'app', 'node_modules', 'pg', 'package.json'),
      join(root, 'app', 'node_modules', 'vitest', 'vitest.mjs'),
      join(root, 'app', 'node_modules', 'vite', 'bin', 'vite.js'),
      join(root, 'pipeline', 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    ];
    const missing = need.filter((p) => !existsSync(p));
    if (missing.length) {
      console.error(`REFUSED: dependencies missing (this script installs nothing): ${missing.map((p) => p.slice(root.length + 1)).join(', ')}`);
      process.exitCode = 2;
      return;
    }
    if (existsSync(distDir)) {
      console.error('REFUSED: app/dist already exists and this script will not overwrite or delete a folder it did not create.');
      process.exitCode = 2;
      return;
    }
    const timeoutMs = resolveTimeoutMs(process.env.RDB_SUITES_TIMEOUT_MS);

    // ---- Throwaway cluster.
    dir = mkdtempSync(join(tmpdir(), 'rdb-suites-'));
    const dataDir = join(dir, 'data');
    const rpDataDir = join(dir, 'rp-data');
    const rpLog = join(dir, 'rp-server.log');
    const tlsDir = join(dir, 'tls'); // its own owner folder: a3-build-test-db.mjs checks the server's data_directory is <owner-dir>/data
    const tlsDataDir = join(tlsDir, 'data');
    const tlsPkiDir = join(dir, 'tls-pki');
    const m1srDir = join(dir, 'm1sr'); // its own owner folder, like tls
    const m1srDataDir = join(m1srDir, 'data');
    const cacheDir = join(dir, 'caches');
    mkdirSync(cacheDir);
    mkdirSync(tlsDir);
    mkdirSync(m1srDir);
    const adminPw = token();
    const maintPw = token();
    const appPw = token();
    const ownerToken = token(24);
    secrets.push(adminPw, maintPw, appPw);
    writeFileSync(join(dir, 'pw.txt'), adminPw);
    writeFileSync(join(dir, 'maintpw.txt'), maintPw);
    writeFileSync(join(dir, 'apppw.txt'), appPw);
    writeFileSync(join(dir, 'A3_TASK_OWNED'), ownerToken);
    writeFileSync(join(dir, 'tls', 'A3_TASK_OWNED'), ownerToken);
    writeFileSync(join(dir, 'm1sr', 'A3_TASK_OWNED'), ownerToken);

    // All clusters: same admin login and password (masked), own folder, own random free port, own server log. `configure` runs after
    // initdb and before the start (the TLS cluster's settings).
    const startCluster = async (clusterDir, logFile, opts, label, configure) => {
      const init = sh(exe(pgBin, 'initdb'), ['-D', clusterDir, '-U', ADMIN_USER, '-A', 'scram-sha-256', `--pwfile=${join(dir, 'pw.txt')}`, '-E', 'UTF8']);
      if (init.status !== 0) throw new Error(`initdb (${label}) failed: ` + mask(`${init.stdout}${init.stderr}`).split('\n').slice(-6).join(' | '));
      if (configure) configure();
      let p = await freePort();
      while (p === 5432 || p === 6543) p = await freePort();
      clusterTouched = true;
      dataDirs.push(clusterDir);
      const start = sh(exe(pgBin, 'pg_ctl'), ['-D', clusterDir, '-l', logFile, '-o', pgServerOptions(p, opts), '-w', 'start'], { stdio: 'ignore' }); // not pipes: the server would inherit them and spawnSync would wait for it forever
      if (start.status !== 0) {
        let tail = '';
        try { tail = readFileSync(logFile, 'utf8').split('\n').filter(Boolean).slice(-4).join(' | '); } catch { /* no log */ }
        throw new Error(`pg_ctl start (${label}) failed: ` + mask(tail));
      }
      let pid = '?';
      try { pid = readFileSync(join(clusterDir, 'postmaster.pid'), 'utf8').split('\n')[0]; } catch { /* reported as ? */ }
      console.log(`cluster (${label}): PostgreSQL ${pgMajor} on 127.0.0.1:${p}, postmaster pid ${pid}, folder ${clusterDir}`);
      return p;
    };
    const port = await startCluster(dataDir, join(dir, 'server.log'), {}, 'main');
    const rpPort = await startCluster(rpDataDir, rpLog, { rolePassword: true }, 'role-password');
    // The TLS cluster: a throwaway CA and server certificate/key from the repository's own helper (it refuses any folder inside the
    // repository), written into this run's temp folder and deleted with it.
    const pki = sh(process.execPath, [join(root, 'pipeline', 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/retention-secure-a3-make-pki.ts', tlsPkiDir], { cwd: join(root, 'pipeline'), timeout: timeoutMs });
    if (pki.error || pki.status !== 0 || !/wrote root\.crt, server\.crt, server\.key/.test(pki.stdout ?? '')) throw new Error('making the throwaway TLS certificates failed: ' + describePkiFailure({ r: pki, out: mask(stripAnsi(`${pki.stdout ?? ''}${pki.stderr ?? ''}`)), timeoutMs }));
    const tlsRootCrt = join(tlsPkiDir, 'root.crt');
    const tlsPort = await startCluster(tlsDataDir, join(dir, 'tls-server.log'), {}, 'tls', () => {
      const files = tlsClusterFiles({ certFile: join(tlsPkiDir, 'server.crt'), keyFile: join(tlsPkiDir, 'server.key') });
      writeFileSync(join(dir, 'tls', 'data', 'postgresql.conf'), readFileSync(join(tlsDataDir, 'postgresql.conf'), 'utf8') + files.conf);
      writeFileSync(join(dir, 'tls', 'data', 'pg_hba.conf'), files.hba);
    });
    // m1-supabase-runner: no recruiter_* role may exist when M1 is applied by the non-superuser login, so it gets a cluster of its own.
    const m1srPort = await startCluster(m1srDataDir, join(dir, 'm1sr-server.log'), {}, 'm1-supabase-runner');

    const url = (user, pw, db, onPort = port) => `postgresql://${user}:${encodeURIComponent(pw)}@127.0.0.1:${onPort}/${db}`;
    const admin = (db) => url(ADMIN_USER, adminPw, db);
    const maint = (db) => url('recruiter_maintenance', maintPw, db);
    const app = (db) => url('recruiter_app', appPw, db);

    // ---- Databases. "full" = M1 + M1b + M1c; "m1" = M1 only; "base" = the baseline without M1.
    const FLAGS = { full: [], m1: ['--no-m1b', '--no-m1c'], base: ['--no-m1', '--no-m1b', '--no-m1c'] };
    const DBS = [
      ['tr_rm', 'm1'], ['tr_ret', 'm1'], ['tr_bdc', 'full'], ['tr_reapply', 'full'], ['tr_fm', 'full'],
      ['tr_owner', 'base'], ['tr_envpre', 'base'], ['tr_psql', 'base'], ['tr_rbt', 'full'], ['tr_ret_sec', 'm1'], ['tr_backout', 'full'],
    ];
    const build = (extra, { ownerDir = dir, onPort = port } = {}) => sh(process.execPath, [join(root, 'scripts', 'a3-build-test-db.mjs'), '--owner-dir', ownerDir, '--port', String(onPort), ...extra], { cwd: root, env: { ...baseEnv, A3_PGPASSWORD: adminPw } });
    for (const [db, kind, where] of [...DBS.map(([db, kind]) => [db, kind, {}]), ['tr_ret', 'm1', { ownerDir: tlsDir, onPort: tlsPort }]]) {
      const r = build(['--db', db, ...FLAGS[kind]], where);
      if (r.status !== 0) throw new Error(`building database ${db}${where.onPort ? ' (tls cluster)' : ''} failed (exit ${r.status}): ` + mask(`${r.stdout}${r.stderr}`).split('\n').filter(Boolean).slice(-4).join(' | '));
      if (interrupted) throw new Error('interrupted');
    }
    // Baseline databases (no M1) for m1-supabase-runner on its own cluster: PostGIS in public, in extensions, and in extensions for the
    // refused case.
    for (const [db, extra] of [['tr_m1sr_pub', []], ['tr_m1sr_ext', ['--postgis-schema', 'extensions']], ['tr_m1sr_neg', ['--postgis-schema', 'extensions']]]) {
      const r = build(['--db', db, ...FLAGS.base, ...extra], { ownerDir: m1srDir, onPort: m1srPort });
      if (r.status !== 0) throw new Error(`building database ${db} (m1-supabase-runner cluster) failed (exit ${r.status}): ` + mask(`${r.stdout}${r.stderr}`).split('\n').filter(Boolean).slice(-4).join(' | '));
      if (interrupted) throw new Error('interrupted');
    }
    const sb = build(['--db', 'tr_signin_test', '--suites', '--run', RUN_ID]);
    if (sb.status !== 0) throw new Error(`building the app suite databases failed (exit ${sb.status}): ` + mask(`${sb.stdout}${sb.stderr}`).split('\n').filter(Boolean).slice(-4).join(' | '));

    // Roles are cluster-wide: give two of them throwaway logins now, and again after every suite (see "Test isolation" above).
    const require = createRequire(join(root, 'app', 'package.json'));
    const pg = require('pg');
    const withAdmin = async (fn, { onPort = port, database = 'postgres' } = {}) => {
      const c = new pg.Client(adminClientConfig({ port: onPort, password: adminPw, database }));
      await c.connect();
      try { await fn(c); } finally { await c.end(); }
    };
    // On the TLS cluster only recruiter_maintenance logs in (retention-secure); its login is given back after every suite too.
    const restoreLogins = async () => {
      await withAdmin(async (c) => {
        for (const sql of restoreStatements({ maintPw, appPw })) await c.query(sql);
      });
      await withAdmin(async (c) => {
        for (const sql of restoreStatements({ maintPw, appPw }).filter((s) => s.startsWith('alter role recruiter_maintenance '))) await c.query(sql);
      }, { onPort: tlsPort });
    };
    await restoreLogins();
    // Three suites need an EMPTY tr_ database carrying an ownership comment; each gets its own.
    await withAdmin(async (c) => {
      for (const [db, prefix] of [['tr_ledger', 'a3-task-owned'], ['tr_psql_a2', 'a3-task-owned'], ['tr_stop', 'stop-test-owned']]) {
        await c.query(`create database ${db}`);
        await c.query(`comment on database ${db} is '${prefix}:${ownerToken}'`);
      }
    });
    // role-password runs on its own cluster: an empty owned tr_ database with pg_stat_statements (preloaded at start) created in it.
    await withAdmin(async (c) => {
      await c.query('create database tr_role_password');
      await c.query(`comment on database tr_role_password is 'role-password-owned:${ownerToken}'`);
    }, { onPort: rpPort });
    await withAdmin((c) => c.query('create extension pg_stat_statements'), { onPort: rpPort, database: 'tr_role_password' });

    // ---- Suites. The prod-sql suites change cluster-wide roles, so they come last.
    const tsx = (file, env, extra = {}) => ({ cmd: process.execPath, args: [join(root, 'pipeline', 'node_modules', 'tsx', 'dist', 'cli.mjs'), file], cwd: join(root, 'pipeline'), env, kind: 'tsx', ...extra });
    const SUITES = [
      {
        id: 'app-vitest', cmd: process.execPath, kind: 'vitest', cwd: join(root, 'app'),
        args: vitestArgs(join(root, 'app', 'node_modules', 'vitest', 'vitest.mjs'), cacheDir),
        env: { RUN_HTTP_TESTS: '1', A3_RUN_ID: RUN_ID, A3_ADMIN_URL: admin('tr_signin_test'), A3_APP_URL: app('tr_signin_test'), ROLLBACK_TAG_TEST_URL: admin('tr_rbt') },
        before: () => {
          builtDist = true; // from here on this run owns app/dist
          const r = sh(process.execPath, [join(root, 'app', 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--configLoader', 'runner'], { cwd: join(root, 'app'), timeout: timeoutMs });
          return r.status === 0 ? undefined : 'vite build failed: ' + mask(`${r.stdout}${r.stderr}`).split('\n').filter(Boolean).slice(-3).join(' | ');
        },
      },
      { id: 'role-matrix', ...tsx('src/role-matrix-a3.test.ts', { ROLE_MATRIX_A3_ADMIN_URL: admin('tr_rm') }) },
      { id: 'batch-delete-compare', ...tsx('src/batch-delete-compare-a3.test.ts', { BDC_A3_ADMIN_URL: admin('tr_bdc') }) },
      { id: 'reapply-m1c', ...tsx('src/reapply-m1c-a3.test.ts', { REAPPLY_A3_ADMIN_URL: admin('tr_reapply') }) },
      { id: 'retention-run', ...tsx('src/retention-run-a3.test.ts', { RETENTION_A3_ADMIN_URL: admin('tr_ret'), RETENTION_A3_MAINT_URL: maint('tr_ret') }) },
      { id: 'retention-dry-run', ...tsx('src/retention-a3.test.ts', { RETENTION_A3_ADMIN_URL: admin('tr_ret'), RETENTION_A3_MAINT_URL: maint('tr_ret') }) },
      // Both scenarios: the plain (loopback-exemption) run on the main cluster, and the verify-full TLS + SCRAM-SHA-256-PLUS run on the
      // TLS cluster. No skip line is allowed, so a missing TLS scenario is a FAIL.
      {
        id: 'retention-secure', ...tsx('src/retention-secure-a3.test.ts', {
          RETENTION_SECURE_A3_ADMIN_URL: admin('tr_ret_sec'), RETENTION_SECURE_A3_MAINT_URL: maint('tr_ret_sec'),
          RETENTION_SECURE_A3_TLS_ADMIN_URL: url(ADMIN_USER, adminPw, 'tr_ret', tlsPort), RETENTION_SECURE_A3_TLS_MAINT_URL: url('recruiter_maintenance', maintPw, 'tr_ret', tlsPort),
          RETENTION_SECURE_A3_TLS_ROOT_CRT: tlsRootCrt,
        }),
      },
      // The one legitimate "skip:" line: the schema's roster control table allows only one row, so that branch cannot run.
      { id: 'first-manager', ...tsx('src/first-manager-bootstrap-a3.test.ts', { FIRST_MANAGER_A3_ADMIN_URL: admin('tr_fm'), FIRST_MANAGER_A3_APP_URL: app('tr_fm') }, { allowedSkips: ['skip: the roster control table does not allow a second row'] }) },
      { id: 'owner-bootstrap', ...tsx('src/owner-bootstrap-a3.test.ts', { OWNER_A3_ADMIN_URL: admin('tr_owner') }) },
      { id: 'environment-preflight', ...tsx('src/environment-preflight-a3.test.ts', { ENVPRE_A3_ADMIN_URL: admin('tr_envpre') }) },
      { id: 'ledger-preflight', ...tsx('src/ledger-preflight-a3.test.ts', { LEDGER_A3_ADMIN_URL: admin('tr_ledger') }) },
      { id: 'role-password', ...tsx('src/role-password.test.ts', { ROLE_PASSWORD_PG_URL: url(ADMIN_USER, adminPw, 'tr_role_password', rpPort), ROLE_PASSWORD_PG_LOG: rpLog }) },
      // Ends the cluster-wide recruiter_app login's connections and sets it NOLOGIN (restoreLogins gives it back), and runs the M1 backouts on its own database.
      { id: 'backout-rehearsal', ...tsx('src/backout-rehearsal-a3.test.ts', { BACKOUT_A3_ADMIN_URL: admin('tr_backout'), BACKOUT_A3_APP_URL: app('tr_backout') }) },
      // On its own cluster: M1 applied by a NOSUPERUSER CREATEROLE login (PostGIS in public, in extensions, and a refused case).
      {
        id: 'm1-supabase-runner', ...tsx('src/m1-supabase-runner-a3.test.ts', {
          M1SR_A3_PUBLIC_ADMIN_URL: url(ADMIN_USER, adminPw, 'tr_m1sr_pub', m1srPort), M1SR_A3_EXT_ADMIN_URL: url(ADMIN_USER, adminPw, 'tr_m1sr_ext', m1srPort),
          M1SR_A3_NEG_ADMIN_URL: url(ADMIN_USER, adminPw, 'tr_m1sr_neg', m1srPort),
        }),
      },
      { id: 'prod-sql-stop-tables', ...tsx('src/prod-sql-stop-tables-pg.test.ts', { PROD_SQL_STOP_PG_URL: admin('tr_stop') }) },
      { id: 'prod-sql-a2-backouts', ...tsx('src/prod-sql-a2-backouts-a3.test.ts', { PROD_SQL_A3_ADMIN_URL: admin('tr_psql_a2') }) },
      { id: 'prod-sql', ...tsx('src/prod-sql-a3.test.ts', { PROD_SQL_A3_ADMIN_URL: admin('tr_psql') }) },
    ];
    const suiteIds = SUITES.map((s) => s.id);
    if (suiteIds.join() !== SUITE_IDS.join()) throw new Error('internal: SUITES and SUITE_FILES list different suites');
    const injectedFail = process.env.RDB_SUITES_INJECT_FAIL;
    const injectedHang = process.env.RDB_SUITES_INJECT_HANG;
    const first = process.env.RDB_SUITES_FIRST;
    for (const [name, v] of [['RDB_SUITES_INJECT_FAIL', injectedFail], ['RDB_SUITES_INJECT_HANG', injectedHang], ['RDB_SUITES_FIRST', first]]) {
      if (v && !suiteIds.includes(v)) throw new Error(`${name} names an unknown suite: ${v}`);
    }

    const only = process.env.RDB_SUITES_ONLY ? process.env.RDB_SUITES_ONLY.split(',').map((x) => x.trim()) : undefined;
    // After a TIMEOUT: end the leftover sessions on this run's own four clusters (SQL on each cluster, no process is signalled by us).
    const endStraySessions = () => endStrayOnPorts([port, rpPort, tlsPort, m1srPort], withAdmin);
    if (orderNotice(first)) console.log(orderNotice(first));
    await runSuites(orderSuites(SUITES, first), { results, only, injectedFail, injectedHang, sh, mask, baseEnv, timeoutMs, isInterrupted: () => interrupted, restore: restoreLogins, afterTimeout: endStraySessions });
  } catch (err) {
    console.error(`ERROR: ${mask(String(err?.message ?? err))}`);
    results.push({ id: 'harness', status: 'FAIL', reason: mask(String(err?.message ?? err)) });
    process.exitCode = 1;
  } finally {
    cleanup();
    const s = summarize(results, { expectedIds: results.length ? SUITE_IDS : [], interrupted, priorExitCode: process.exitCode ?? 0 });
    if (s.line) console.log(s.line);
    process.exitCode = s.exitCode;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
