#!/usr/bin/env node
// Offline contract check for scripts/run-real-db-suites.mjs: loopback only, no network, no secret store, cleanup in a finally block.
// Text-level checks of the script source plus direct tests of its two pure helpers. It starts no database and opens no socket.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { nonLoopbackConnectionVars, scrubbedEnv } from './run-real-db-suites.mjs';

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
// The environment scrubber is the one place that names these services (to drop their variables); that line is excluded.
const codeNoScrubLine = code.split('\n').filter((l) => !l.includes('/^(DOPPLER|')).join('\n');
check('the scrubber drops secret-store variables', /\/\^\(DOPPLER\|/.test(code));
check('no secret-store or hosted-service tool is named in code', !/doppler|supabase\.co|pooler\.supabase|render\.com|api\.|https?:\/\//i.test(codeNoScrubLine));
check('every database host in code is 127.0.0.1', [...code.matchAll(/@([^:/'"`$]+)[:/]|host:\s*'([^']+)'/g)].every((m) => (m[1] ?? m[2]) === '127.0.0.1' || (m[1] ?? m[2]) === undefined));
check('cluster listens on 127.0.0.1 only', /listen_addresses=127\.0\.0\.1/.test(code) && !/listen_addresses=['"]?(\*|0\.0\.0\.0)/.test(code));
check('refuses non-loopback connection variables before creating anything', /nonLoopbackConnectionVars\(process\.env\)/.test(code) && code.indexOf('nonLoopbackConnectionVars(process.env)') < code.indexOf('mkdtempSync('));
check('children get a scrubbed environment', /scrubbedEnv\(process\.env\)/.test(code));

// ---- Cleanup.
const fin = code.match(/\}\s*finally\s*\{([\s\S]*?)\n  \}\n\}/);
check('a finally block exists and calls cleanup()', Boolean(fin) && /\bcleanup\(\)/.test(fin[1]));
check('cleanup stops only its own data folder (pg_ctl -D <dataDir> stop)', /\['-D', dataDir, 'stop', '-m', 'fast', '-w'\]/.test(code));
check('cleanup is idempotent and also runs on exit', /if \(cleaned\) return;/.test(code) && /process\.on\('exit', cleanup\)/.test(code));
check('signals are caught (SIGINT, SIGTERM, SIGBREAK, SIGHUP) and only set a flag', /\['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'\]/.test(code) && /const onSignal = \(\) => \{ interrupted = true; \};/.test(code));
check('deletes only a folder it made (under the temp dir, rdb-suites- prefix)', /startsWith\('rdb-suites-'\)/.test(code) && /startsWith\(resolve\(tmpdir\(\)\) \+ sep\)/.test(code) && /mkdtempSync\(join\(tmpdir\(\), 'rdb-suites-'\)\)/.test(code));
check('app/dist is removed only when this run built it, and a pre-existing app/dist is refused', /if \(builtDist\)/.test(code) && /existsSync\(distDir\)\) \{\s*console\.error\('REFUSED/.test(code));
check('no process is killed or signalled (no kill, taskkill, pkill, Stop-Process)', !/\.kill\(|taskkill|pkill|Stop-Process|process\.kill/i.test(code));
check('rmSync is applied only to the temp folder and app/dist', [...code.matchAll(/rmSync\(([^,]+),/g)].every((m) => ['dir', 'distDir'].includes(m[1].trim())));
check('passwords are written only under the temp folder', [...code.matchAll(/writeFileSync\(([^,]+),/g)].every((m) => m[1].trim() === 'join(dir'));
check('child processes are spawned without a shell', !/shell:\s*true/.test(code) && !/\bexec\(|execSync\(/.test(code));
check('exit code is non-zero for a failed or skipped suite and an interruption', /failed\.length \|\| interrupted/.test(code) && /skipped itself/.test(code) && /some tests were skipped/.test(code));
check('test switch for a failing suite exists', /RDB_SUITES_INJECT_FAIL/.test(code));

// ---- Pure helpers.
const hosted = 'postgresql://u:p@db.example.supabase.co:5432/postgres';
check('hosted DATABASE_URL is refused', nonLoopbackConnectionVars({ DATABASE_URL: hosted }).includes('DATABASE_URL'));
check('hosted STAGING_DB_URL is refused', nonLoopbackConnectionVars({ STAGING_DB_URL: hosted }).includes('STAGING_DB_URL'));
check('hosted PGHOST is refused', nonLoopbackConnectionVars({ PGHOST: 'db.example.com' }).includes('PGHOST'));
check('PGSERVICE is refused', nonLoopbackConnectionVars({ PGSERVICE: 'prod' }).includes('PGSERVICE'));
check('an unparseable URL variable is refused', nonLoopbackConnectionVars({ ROLLBACK_TAG_DB_URL: 'not a url' }).length === 1);
check('loopback URLs and PGHOST are accepted', nonLoopbackConnectionVars({ DATABASE_URL: 'postgresql://u:p@127.0.0.1:5999/x', STAGING_DB_URL: 'postgres://localhost/x', PGHOST: '127.0.0.1', PGPORT: '5999' }).length === 0);
check('unrelated variables are ignored', nonLoopbackConnectionVars({ PATH: 'x', HOME: 'y' }).length === 0);
const scrubbed = scrubbedEnv({ PATH: 'x', DATABASE_URL: 'a', STAGING_DB_URL: 'b', PGDATA: 'c', PGPASSWORD: 'd', SUPABASE_ORG_TOKEN: 'e', DOPPLER_TOKEN: 'f' });
check('scrubbed environment keeps PATH and drops every connection and secret variable', Object.keys(scrubbed).join() === 'PATH');

if (failures.length) {
  console.error(`FAIL real-database suite runner contract: ${failures.length} check(s) failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('PASS real-database suite runner contract: loopback-only, refuses non-loopback connection variables, no network or secret store, no process killed, cleanup in finally (cluster stopped by its own folder, temp folder and app/dist removed), failures and skips give a non-zero exit');
