#!/usr/bin/env node
// LOCAL ONLY: runs every real-PostgreSQL suite of this repo against ONE throwaway PostgreSQL 16 cluster that this script creates and
// always removes. It contacts no hosted or staging database, reads no secret store and uses no network except 127.0.0.1.
//
// How to run (from the repository root; app/node_modules and pipeline/node_modules must already exist, nothing is installed):
//   node scripts/run-real-db-suites.mjs
//   PG_BIN="C:\Program Files\PostgreSQL\16\bin" node scripts/run-real-db-suites.mjs     (only if PostgreSQL 16 is elsewhere)
// Output: one "PASS <suite>" or "FAIL <suite>: <reason>" line per suite, then a summary. The exit code is 0 only when every suite
// ran and passed; a failed suite, a suite that skipped itself (missing environment) or an interruption gives a non-zero exit code.
// Test switch: RDB_SUITES_INJECT_FAIL=<suite id> replaces that one suite with a command that fails, to prove the FAIL line, the
// summary, the exit code and the cleanup (suite ids are the words after PASS/FAIL, e.g. role-matrix).
// RDB_SUITES_ONLY=<id>,<id> runs just those suites (for fixing one); the others print SKIP and the exit code stays non-zero.
//
// What it does, in order:
//   1. refuses to start if DATABASE_URL, STAGING_DB_URL, any *_DB_URL / *DATABASE_URL or a PG* host variable points anywhere but
//      loopback (the children then run without any of those variables);
//   2. creates a fresh temp folder, runs initdb (scram-sha-256, random passwords kept only in files inside that folder) and starts the
//      cluster on 127.0.0.1 at a random free port;
//   3. builds the test databases with scripts/a3-build-test-db.mjs and gives recruiter_maintenance / recruiter_app throwaway logins
//      inside that cluster only;
//   4. runs each suite with its own database and environment, and (for the app suite) one vite build into app/dist;
//   5. ALWAYS (success, failure, Ctrl+C, unexpected error): pg_ctl -D <its own folder> stop, deletes the folder (passwords included)
//      and removes app/dist if this run built it. It never signals or stops any other process and never touches any other folder.
// If this run is killed so hard that no handler runs (Task Manager, power loss), the folder rdb-suites-* in the temp directory and
// the postgres process of its data folder remain: stop it with pg_ctl -D <that folder>\data stop, then delete the folder.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const ADMIN_USER = 'tr_test_admin';
const RUN_ID = 'rdb';

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
      let host;
      try { host = new URL(v).hostname; } catch { bad.push(k); continue; }
      if (!LOOPBACK_HOSTS.has(host.toLowerCase())) bad.push(k);
    } else if (key === 'PGHOST' || key === 'PGHOSTADDR') {
      if (!LOOPBACK_HOSTS.has(v.toLowerCase())) bad.push(k);
    } else if (/URL$/i.test(key)) {
      bad.push(k); // a URL variable that is not a URL we can check
    }
  }
  return bad;
}

/** The environment the children get: no connection variable of any kind, no secret-store variable. */
export function scrubbedEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (isConnectionVar(k) || /^(STAGING|PRODUCTION)_/i.test(k) || /^SUPABASE_/i.test(k) || /^(DOPPLER|SENDGRID|TWILIO|CLOUDFLARE|RENDER)_/i.test(k)) continue;
    out[k] = v;
  }
  return out;
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
  const results = []; // { id, status: 'PASS' | 'FAIL', reason }
  let dir;
  let dataDir;
  let pgBin;
  let clusterTouched = false;
  let builtDist = false;
  let interrupted = false;
  let cleaned = false;
  const secrets = [];
  const distDir = join(root, 'app', 'dist');

  const mask = (text) => secrets.reduce((t, s) => t.split(s).join('<masked>'), text);

  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    const problems = [];
    // 1. Stop only the cluster in our own folder.
    if (dataDir && pgBin && existsSync(join(dataDir, 'postmaster.pid'))) {
      const r = spawnSync(exe(pgBin, 'pg_ctl'), ['-D', dataDir, 'stop', '-m', 'fast', '-w'], { stdio: 'ignore', windowsHide: true });
      if (r.status !== 0) problems.push('pg_ctl stop did not report success');
    }
    // 2. Delete our own folder (passwords included), after checking it is the folder we made.
    if (dir) {
      if (resolve(dir).startsWith(resolve(tmpdir()) + sep) && basename(dir).startsWith('rdb-suites-')) {
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
    if (clusterTouched || dir) console.log(problems.length ? `CLEANUP INCOMPLETE: ${problems.join('; ')}` : 'CLEANUP OK: cluster stopped, temp folder and passwords deleted' + (builtDist ? ', app/dist removed' : ''));
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
      console.error('REFUSED: PostgreSQL 16 bin folder not found. Set PG_BIN or install it under "C:\\Program Files\\PostgreSQL\\16\\bin".');
      process.exitCode = 2;
      return;
    }
    const ver = spawnSync(exe(pgBin, 'pg_ctl'), ['--version'], { encoding: 'utf8', windowsHide: true });
    if (!/\b16\./.test(ver.stdout ?? '')) {
      console.error('REFUSED: the PostgreSQL bin folder is not version 16.');
      process.exitCode = 2;
      return;
    }
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

    // ---- Throwaway cluster.
    dir = mkdtempSync(join(tmpdir(), 'rdb-suites-'));
    dataDir = join(dir, 'data');
    const adminPw = token();
    const maintPw = token();
    const appPw = token();
    secrets.push(adminPw, maintPw, appPw);
    writeFileSync(join(dir, 'pw.txt'), adminPw);
    writeFileSync(join(dir, 'maintpw.txt'), maintPw);
    writeFileSync(join(dir, 'apppw.txt'), appPw);
    writeFileSync(join(dir, 'A3_TASK_OWNED'), token(24));

    const baseEnv = scrubbedEnv(process.env);
    const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024, env: baseEnv, ...opts });

    const init = sh(exe(pgBin, 'initdb'), ['-D', dataDir, '-U', ADMIN_USER, '-A', 'scram-sha-256', `--pwfile=${join(dir, 'pw.txt')}`, '-E', 'UTF8']);
    if (init.status !== 0) throw new Error('initdb failed: ' + mask(`${init.stdout}${init.stderr}`).split('\n').slice(-6).join(' | '));
    let port = await freePort();
    while (port === 5432 || port === 6543) port = await freePort();
    clusterTouched = true;
    const start = sh(exe(pgBin, 'pg_ctl'), ['-D', dataDir, '-l', join(dir, 'server.log'), '-o', `-p ${port} -c listen_addresses=127.0.0.1`, '-w', 'start'], { stdio: 'ignore' }); // not pipes: the server would inherit them and spawnSync would wait for it forever
    if (start.status !== 0) {
      let tail = '';
      try { tail = readFileSync(join(dir, 'server.log'), 'utf8').split('\n').filter(Boolean).slice(-4).join(' | '); } catch { /* no log */ }
      throw new Error('pg_ctl start failed: ' + mask(tail));
    }
    let pid = '?';
    try { pid = readFileSync(join(dataDir, 'postmaster.pid'), 'utf8').split('\n')[0]; } catch { /* reported as ? */ }
    console.log(`cluster: PostgreSQL 16 on 127.0.0.1:${port}, postmaster pid ${pid}, folder ${dir}`);

    const url = (user, pw, db) => `postgresql://${user}:${encodeURIComponent(pw)}@127.0.0.1:${port}/${db}`;
    const admin = (db) => url(ADMIN_USER, adminPw, db);
    const maint = (db) => url('recruiter_maintenance', maintPw, db);
    const app = (db) => url('recruiter_app', appPw, db);

    // ---- Databases. "full" = M1 + M1b + M1c; "m1" = M1 only; "base" = the baseline without M1.
    const FLAGS = { full: [], m1: ['--no-m1b', '--no-m1c'], base: ['--no-m1', '--no-m1b', '--no-m1c'] };
    const DBS = [
      ['tr_rm', 'm1'], ['tr_ret', 'm1'], ['tr_bdc', 'full'], ['tr_reapply', 'full'], ['tr_fm', 'full'],
      ['tr_owner', 'base'], ['tr_envpre', 'base'], ['tr_psql', 'base'], ['tr_rbt', 'full'],
    ];
    const build = (extra) => sh(process.execPath, [join(root, 'scripts', 'a3-build-test-db.mjs'), '--owner-dir', dir, '--port', String(port), ...extra], { cwd: root, env: { ...baseEnv, A3_PGPASSWORD: adminPw } });
    for (const [db, kind] of DBS) {
      const r = build(['--db', db, ...FLAGS[kind]]);
      if (r.status !== 0) throw new Error(`building database ${db} failed (exit ${r.status}): ` + mask(`${r.stdout}${r.stderr}`).split('\n').filter(Boolean).slice(-4).join(' | '));
      if (interrupted) throw new Error('interrupted');
    }
    const sb = build(['--db', 'tr_signin_test', '--suites', '--run', RUN_ID]);
    if (sb.status !== 0) throw new Error(`building the app suite databases failed (exit ${sb.status}): ` + mask(`${sb.stdout}${sb.stderr}`).split('\n').filter(Boolean).slice(-4).join(' | '));

    // Throwaway logins for two roles that M1 creates without one; inside this cluster only.
    const require = createRequire(join(root, 'app', 'package.json'));
    const pg = require('pg');
    const c = new pg.Client({ host: '127.0.0.1', port, user: ADMIN_USER, password: adminPw, database: 'postgres' });
    await c.connect();
    try {
      await c.query(`alter role recruiter_maintenance login password '${maintPw.replace(/'/g, "''")}'`);
      await c.query(`alter role recruiter_app login password '${appPw.replace(/'/g, "''")}'`);
    } finally {
      await c.end();
    }

    // ---- Suites.
    const tsx = (file, env) => ({ cmd: process.execPath, args: [join(root, 'pipeline', 'node_modules', 'tsx', 'dist', 'cli.mjs'), file], cwd: join(root, 'pipeline'), env, kind: 'tsx' });
    // app-vitest runs FIRST: run after the other suites it failed (they change cluster-level roles and settings); alone or first it passes.
    const SUITES = [
      {
        id: 'app-vitest', cmd: process.execPath, kind: 'vitest', cwd: join(root, 'app'),
        // --no-cache / --no-fsModuleCache keep vitest from writing a cache into node_modules.
        args: [join(root, 'app', 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--no-cache', '--no-fsModuleCache'],
        env: { RUN_HTTP_TESTS: '1', A3_RUN_ID: RUN_ID, A3_ADMIN_URL: admin('tr_signin_test'), A3_APP_URL: app('tr_signin_test'), ROLLBACK_TAG_TEST_URL: admin('tr_rbt') },
        before: () => {
          builtDist = true; // from here on this run owns app/dist
          const r = sh(process.execPath, [join(root, 'app', 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], { cwd: join(root, 'app') });
          return r.status === 0 ? undefined : 'vite build failed: ' + mask(`${r.stdout}${r.stderr}`).split('\n').filter(Boolean).slice(-3).join(' | ');
        },
      },
      { id: 'role-matrix', ...tsx('src/role-matrix-a3.test.ts', { ROLE_MATRIX_A3_ADMIN_URL: admin('tr_rm') }) },
      { id: 'batch-delete-compare', ...tsx('src/batch-delete-compare-a3.test.ts', { BDC_A3_ADMIN_URL: admin('tr_bdc') }) },
      { id: 'reapply-m1c', ...tsx('src/reapply-m1c-a3.test.ts', { REAPPLY_A3_ADMIN_URL: admin('tr_reapply') }) },
      { id: 'retention-run', ...tsx('src/retention-run-a3.test.ts', { RETENTION_A3_ADMIN_URL: admin('tr_ret'), RETENTION_A3_MAINT_URL: maint('tr_ret') }) },
      { id: 'retention-dry-run', ...tsx('src/retention-a3.test.ts', { RETENTION_A3_ADMIN_URL: admin('tr_ret'), RETENTION_A3_MAINT_URL: maint('tr_ret') }) },
      { id: 'first-manager', ...tsx('src/first-manager-bootstrap-a3.test.ts', { FIRST_MANAGER_A3_ADMIN_URL: admin('tr_fm'), FIRST_MANAGER_A3_APP_URL: app('tr_fm') }) },
      { id: 'owner-bootstrap', ...tsx('src/owner-bootstrap-a3.test.ts', { OWNER_A3_ADMIN_URL: admin('tr_owner') }) },
      { id: 'environment-preflight', ...tsx('src/environment-preflight-a3.test.ts', { ENVPRE_A3_ADMIN_URL: admin('tr_envpre') }) },
      { id: 'prod-sql', ...tsx('src/prod-sql-a3.test.ts', { PROD_SQL_A3_ADMIN_URL: admin('tr_psql') }) },
    ];
    const injected = process.env.RDB_SUITES_INJECT_FAIL;
    if (injected && !SUITES.some((s) => s.id === injected)) throw new Error(`RDB_SUITES_INJECT_FAIL names an unknown suite: ${injected}`);

    const only = process.env.RDB_SUITES_ONLY ? process.env.RDB_SUITES_ONLY.split(',').map((x) => x.trim()) : undefined;
    for (const s of SUITES) {
      if (interrupted) { results.push({ id: s.id, status: 'FAIL', reason: 'not run: interrupted' }); continue; }
      if (only && !only.includes(s.id)) { results.push({ id: s.id, status: 'SKIP', reason: 'not selected' }); console.log(`SKIP ${s.id}: not selected (RDB_SUITES_ONLY); the run counts as incomplete`); continue; }
      let reason;
      if (injected === s.id) {
        const r = sh(process.execPath, ['-e', 'console.error("injected failure"); process.exit(1)']);
        reason = `injected failure (exit ${r.status})`;
      } else {
        const pre = s.before ? s.before() : undefined;
        if (pre) {
          reason = pre;
        } else {
          const r = sh(s.cmd, s.args, { cwd: s.cwd, env: { ...baseEnv, ...s.env } });
          const out = mask(`${r.stdout ?? ''}${r.stderr ?? ''}`);
          if (interrupted) reason = 'interrupted';
          else if (r.error) reason = `could not start: ${r.error.code ?? 'error'}`;
          else if (r.status !== 0) {
            const lines = out.split('\n').filter((l) => l.trim());
            const key = lines.filter((l) => /\b(FAIL|Error|AssertionError|Tests\s+\d)/.test(l)).slice(0, 8);
            reason = `exit ${r.status}: ${[...key, ...lines.slice(-3)].join(' | ').slice(0, 1500)}`;
          }
          else if (s.kind === 'tsx' && (/^skip /im.test(out) || !/\bPASS\b/.test(out))) reason = 'skipped itself or printed no PASS line (exit 0)';
          else if (s.kind === 'vitest' && (/\b[1-9]\d* skipped\b/i.test(out) || !/Tests\s+\d+ passed/.test(out))) reason = 'some tests were skipped or no pass count was printed (exit 0)';
        }
      }
      results.push(reason ? { id: s.id, status: 'FAIL', reason } : { id: s.id, status: 'PASS' });
      console.log(reason ? `FAIL ${s.id}: ${reason}` : `PASS ${s.id}`);
    }
  } catch (err) {
    console.error(`ERROR: ${mask(String(err?.message ?? err))}`);
    results.push({ id: 'harness', status: 'FAIL', reason: mask(String(err?.message ?? err)) });
    process.exitCode = 1;
  } finally {
    cleanup();
    const failed = results.filter((r) => r.status !== 'PASS');
    const passed = results.length - failed.length;
    if (results.length) console.log(`SUMMARY: ${passed} of ${results.length} suites passed, ${failed.length} failed or skipped${interrupted ? ', interrupted' : ''}`);
    if (failed.length || interrupted) process.exitCode = process.exitCode || (interrupted ? 130 : 1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
