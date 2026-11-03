#!/usr/bin/env node
// Offline contract check for scripts/run-real-db-suites.mjs: loopback only, no network, no secret store, cleanup in a finally block.
// Text-level checks of the script source, a comparison of its suite list with the test files on disk, and a few direct tests of the pure
// helpers (their behaviour is tested in depth by scripts/run-real-db-suites.test.mjs). It starts no database and opens no socket.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { EXCLUDED_FILES, SUITE_FILES, nonLoopbackConnectionVars, scrubbedEnv } from './run-real-db-suites.mjs';

const root = resolve(import.meta.dirname, '..');
const src = readFileSync(resolve(root, 'scripts/run-real-db-suites.mjs'), 'utf8').replace(/\r\n/g, '\n');
/** Source without comments, so a word in prose does not count and a real statement does. */
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '')).join('\n');
const failures = [];
const check = (name, ok) => { if (!ok) failures.push(name); };

// ---- No network, no secret store.
check('no fetch / XMLHttpRequest / WebSocket', !/\b(fetch|XMLHttpRequest|WebSocket)\s*\(/.test(code) && !/new\s+(WebSocket|XMLHttpRequest)\b/.test(code));
check('no http, https, http2, dns, tls or dgram import', !/from\s+['"]node:(https?|http2|dns|tls|dgram)['"]|require\(['"](node:)?(https?|http2|dns|tls|dgram)['"]\)/.test(code));
check('node:net is used only to find a free port on 127.0.0.1 (createServer, no connect)', /from 'node:net'/.test(code) && /import \{ createServer \} from 'node:net'/.test(code) && !/\.connect\(\s*\{?[^)]*host/.test(code.replace(/c\.connect\(\)/g, '')) && /listen\(0, '127\.0\.0\.1'/.test(code));
check('the environment allow-list names no secret-store variable', !/doppler|supabase|sendgrid|twilio|cloudflare|render_/i.test(code.slice(code.indexOf('export const ENV_ALLOW'), code.indexOf('const ENV_ALLOW_SET'))));
check('no secret-store or hosted-service tool is named in code', !/doppler|supabase\.co|pooler\.supabase|render\.com|api\.|https?:\/\//i.test(code));
check('every database host in code is 127.0.0.1', [...code.matchAll(/@([^:/'"`$]+)[:/]|host:\s*'([^']+)'/g)].every((m) => (m[1] ?? m[2]) === '127.0.0.1' || (m[1] ?? m[2]) === undefined));
check('cluster listens on 127.0.0.1 only', /listen_addresses=127\.0\.0\.1/.test(code) && !/listen_addresses=['"]?(\*|0\.0\.0\.0)/.test(code));
check('refuses non-loopback connection variables before creating anything', /nonLoopbackConnectionVars\(process\.env\)/.test(code) && code.indexOf('nonLoopbackConnectionVars(process.env)') < code.indexOf('mkdtempSync(join'));
check('children get a scrubbed environment', /const baseEnv = scrubbedEnv\(process\.env\);/.test(code));
// process.env is read in a few reviewed places only, and is never handed to a child.
check('process.env appears only in the reviewed places', [...code.matchAll(/process\.env(\.\w+|\))?/g)].every((m) => /^\.(PG_BIN|RDB_SUITES_\w+)$/.test(m[1] ?? '') || /(nonLoopbackConnectionVars|scrubbedEnv)\(process\.env\)/.test(code.slice(Math.max(0, m.index - 30), m.index + m[0].length))));
check('no spawn call is given process.env as env', !/env:\s*process\.env|\.\.\.process\.env/.test(code));

// ---- Cleanup.
const fin = code.match(/\}\s*finally\s*\{([\s\S]*?)\n  \}\n\}/);
check('a finally block exists and calls cleanup()', Boolean(fin) && /\bcleanup\(\)/.test(fin[1]));
check('cleanup stops only its own data folder (pg_ctl -D <dataDir> stop)', /\['-D', dataDir, 'stop', '-m', 'fast', '-w'\]/.test(code));
check('cleanup is idempotent and also runs on exit', /if \(cleaned\) return;/.test(code) && /process\.on\('exit', cleanup\)/.test(code));
check('signals are caught (SIGINT, SIGTERM, SIGBREAK, SIGHUP) and only set a flag', /\['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'\]/.test(code) && /const onSignal = \(\) => \{ interrupted = true; \};/.test(code));
check('deletes only a folder it made (isSafeToDelete guard, made by mkdtempSync in the temp folder)', /if \(isSafeToDelete\(dir, tmpdir\(\)\)\)/.test(code) && /mkdtempSync\(join\(tmpdir\(\), 'rdb-suites-'\)\)/.test(code));
check('app/dist is removed only when this run built it, and a pre-existing app/dist is refused', /if \(builtDist\)/.test(code) && /existsSync\(distDir\)\) \{\s*console\.error\('REFUSED/.test(code));
check('no process is killed or signalled (no kill, taskkill, pkill, Stop-Process)', !/\.kill\(|taskkill|pkill|Stop-Process|process\.kill|killSignal/i.test(code));
check('rmSync is applied only to the temp folder and app/dist', [...code.matchAll(/rmSync\(([^,]+),/g)].every((m) => ['dir', 'distDir'].includes(m[1].trim())));
check('passwords are written only under the temp folder', [...code.matchAll(/writeFileSync\(([^,]+),/g)].every((m) => m[1].trim() === 'join(dir'));
check('child processes are spawned without a shell', !/shell:\s*true/.test(code) && !/\bexec\(|execSync\(/.test(code));
check('test switches for a failing and a hanging suite exist', /RDB_SUITES_INJECT_FAIL/.test(code) && /RDB_SUITES_INJECT_HANG/.test(code));

// ---- Result handling (the behaviour is tested in run-real-db-suites.test.mjs; these lines check the wiring).
check('the exit code comes from summarize() and nothing sets it to 0 afterwards', /process\.exitCode = s\.exitCode;/.test(code) && !/process\.exitCode\s*=\s*0\b/.test(code));
check('every suite goes through executeSuite with the scrubbed base environment and a time limit', /executeSuite\(s, \{ sh, mask, baseEnv, timeoutMs, isInterrupted/.test(code));
check('executeSuite masks the output before classifying it', /const out = mask\(`\$\{r\.stdout \?\? ''\}\$\{r\.stderr \?\? ''\}`\);/.test(code) && /classifyOutcome\(\{ kind: s\.kind, r, out,/.test(code));
check('the summary counts the expected suites, so a missing one is a failure', /summarize\(results, \{ expectedIds: results\.length \? SUITE_IDS : \[\]/.test(code));
check('the logins are restored after every suite (roles are cluster-wide)', /try \{ await restoreLogins\(\); \}/.test(code));
check('vite and vitest write their caches under the temp folder, not node_modules', /'--fsModuleCachePath', join\(cacheDir, 'vitest'\)/.test(code) && (code.match(/'--configLoader', 'runner'/g) ?? []).length === 2);
check('the app suite turns the HTTP end-to-end tests on (RUN_HTTP_TESTS)', /id: 'app-vitest'[\s\S]*?env: \{ RUN_HTTP_TESTS: '1', /.test(code));
check('the prod-sql suites run last', /\{ id: 'prod-sql-stop-tables'[\s\S]*\{ id: 'prod-sql-a2-backouts'[\s\S]*\{ id: 'prod-sql', \.\.\.tsx\([^\n]*\n    \];/.test(code));

// ---- The suite list matches the real-PostgreSQL test files on disk.
const listed = new Set(SUITE_FILES.map((f) => f.file));
const excluded = new Set(EXCLUDED_FILES.map((f) => f.file));
check('every listed suite file exists', [...listed].every((f) => existsSync(resolve(root, f))));
check('every exclusion has a reason', EXCLUDED_FILES.every((f) => f.reason.length > 20) && EXCLUDED_FILES.every((f) => existsSync(resolve(root, f.file))));
check('no file is both listed and excluded', [...listed].every((f) => !excluded.has(f)));
const gated = [];
const GATE = /process\.env\.(?:[A-Z0-9_]*(?:ADMIN_URL|APP_URL|MAINT_URL|PG_URL|A3_RUN_ID)|ROLLBACK_TAG_TEST_URL)\b/;
const walk = (rel) => {
  for (const e of readdirSync(resolve(root, rel), { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const p = `${rel}/${e.name}`;
    if (e.isDirectory()) walk(p);
    else if (/\.test\.ts$/.test(e.name) && GATE.test(readFileSync(resolve(root, p), 'utf8'))) gated.push(p);
  }
};
for (const d of ['pipeline/src', 'app/server', 'app/src']) if (existsSync(resolve(root, d))) walk(d);
const unlisted = gated.filter((f) => !listed.has(f) && !excluded.has(f));
check(`every env-gated real-PostgreSQL test file is listed or excluded with a reason (unlisted: ${unlisted.join(', ') || 'none'})`, unlisted.length === 0);
check('the gate pattern finds the files this script is known to run', ['pipeline/src/ledger-preflight-a3.test.ts', 'pipeline/src/prod-sql-stop-tables-pg.test.ts', 'pipeline/src/role-matrix-a3.test.ts'].every((f) => gated.includes(f)));

// ---- Pure helpers.
const hosted = 'postgresql://u:p@db.example.supabase.co:5432/postgres';
check('hosted DATABASE_URL is refused', nonLoopbackConnectionVars({ DATABASE_URL: hosted }).includes('DATABASE_URL'));
check('hosted STAGING_DB_URL is refused', nonLoopbackConnectionVars({ STAGING_DB_URL: hosted }).includes('STAGING_DB_URL'));
check('hosted PGHOST is refused', nonLoopbackConnectionVars({ PGHOST: 'db.example.com' }).includes('PGHOST'));
check('PGSERVICE is refused', nonLoopbackConnectionVars({ PGSERVICE: 'prod' }).includes('PGSERVICE'));
check('an unparseable URL variable is refused', nonLoopbackConnectionVars({ ROLLBACK_TAG_DB_URL: 'not a url' }).length === 1);
check('a loopback URL with a ?host= query is refused', nonLoopbackConnectionVars({ DATABASE_URL: 'postgresql://u:p@127.0.0.1/x?host=db.example.com' }).length === 1);
check('loopback URLs and PGHOST are accepted', nonLoopbackConnectionVars({ DATABASE_URL: 'postgresql://u:p@127.0.0.1:5999/x', STAGING_DB_URL: 'postgres://localhost/x', PGHOST: '127.0.0.1', PGPORT: '5999' }).length === 0);
check('unrelated variables are ignored', nonLoopbackConnectionVars({ PATH: 'x', HOME: 'y' }).length === 0);
const scrubbed = scrubbedEnv({ PATH: 'x', DATABASE_URL: 'a', STAGING_DB_URL: 'b', PGDATA: 'c', PGPASSWORD: 'd', SUPABASE_ORG_TOKEN: 'e', DOPPLER_TOKEN: 'f', LEDGER_A3_ADMIN_URL: 'g', POSTGRES_URL: 'h' });
check('scrubbed environment keeps PATH and drops every connection and secret variable', Object.keys(scrubbed).join() === 'PATH');

if (failures.length) {
  console.error(`FAIL real-database suite runner contract: ${failures.length} check(s) failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(`PASS real-database suite runner contract: loopback-only, refuses non-loopback connection variables, no network or secret store, no process killed, cleanup in finally (cluster stopped by its own folder, temp folder and app/dist removed), allow-listed child environment, failures, skips and timeouts give a non-zero exit, suite list matches the ${gated.length} env-gated real-PostgreSQL test files on disk (${EXCLUDED_FILES.length} excluded with a reason)`);
