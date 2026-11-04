#!/usr/bin/env node
// Offline contract check for scripts/run-real-db-suites.mjs: loopback only, no network, no secret store, cleanup in a finally block.
// Text-level checks of the script source, a comparison of its suite list with the test files on disk, and a few direct tests of the pure
// helpers (their behaviour is tested in depth by scripts/run-real-db-suites.test.mjs). It starts no database and opens no socket.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EXCLUDED_FILES, SUITE_FILES, SUITE_IDS, nonLoopbackConnectionVars, pgServerOptions, scrubbedEnv, tlsClusterFiles } from './run-real-db-suites.mjs';

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
check('children get a scrubbed environment with colour off', /const baseEnv = \{ \.\.\.scrubbedEnv\(process\.env\), \.\.\.CHILD_COLOR_OFF \};/.test(code) && /const sh = makeSh\(baseEnv\);/.test(code) && /NO_COLOR: '1', FORCE_COLOR: '0'/.test(code));
check('spawnSync is called in exactly one place (makeSh), which defaults to env: baseEnv', (code.match(/\bspawnSync\(/g) ?? []).length === 0 && /spawn = spawnSync\)/.test(code) && (code.match(/\bspawn\(/g) ?? []).length === 1 && /spawn\(cmd, args, \{ encoding: 'utf8', windowsHide: true, maxBuffer: 256 \* 1024 \* 1024, \.\.\.opts, env: opts\.env \?\? baseEnv \}\)/.test(code));
// process.env is read in a few reviewed places only, and is never handed to a child.
check('process.env appears only in the reviewed places', [...code.matchAll(/process\.env(\.\w+|\))?/g)].every((m) => /^\.(PG_BIN|RDB_SUITES_\w+)$/.test(m[1] ?? '') || /(nonLoopbackConnectionVars|scrubbedEnv)\(process\.env\)/.test(code.slice(Math.max(0, m.index - 30), m.index + m[0].length))));
check('no spawn call is given process.env as env', !/env:\s*process\.env|\.\.\.process\.env/.test(code));

// ---- Cleanup.
const fin = code.match(/\}\s*finally\s*\{([\s\S]*?)\n  \}\n\}/);
check('a finally block exists and calls cleanup()', Boolean(fin) && /\bcleanup\(\)/.test(fin[1]));
check('cleanup stops only its own data folders (pg_ctl -D <dataDir> stop, for every cluster this run started)', /\['-D', dataDir, 'stop', '-m', 'fast', '-w'\]/.test(code) && /for \(const dataDir of dataDirs\) \{/.test(code) && /clusterTouched = true;\n\s*dataDirs\.push\(clusterDir\);\n\s*const start = sh\(/.test(code));
check('all three clusters are made inside the temp folder and started through pgServerOptions (loopback only)', /const dataDir = join\(dir, 'data'\);/.test(code) && /const rpDataDir = join\(dir, 'rp-data'\);/.test(code) && /const rpLog = join\(dir, 'rp-server\.log'\);/.test(code)
  && /const tlsDir = join\(dir, 'tls'\);/.test(code) && /const tlsDataDir = join\(tlsDir, 'data'\);/.test(code) && /startCluster\(tlsDataDir, join\(dir, 'tls-server\.log'\), \{\}, 'tls', \(\) => \{/.test(code)
  && /'-o', pgServerOptions\(p, opts\)/.test(code) && (code.match(/'-o',/g) ?? []).length === 1 && /startCluster\(dataDir, join\(dir, 'server\.log'\), \{\}, 'main'\)/.test(code) && /startCluster\(rpDataDir, rpLog, \{ rolePassword: true \}, 'role-password'\)/.test(code));
check('role-password runs on its own cluster with its owned database, its server log and pg_stat_statements', /id: 'role-password', \.\.\.tsx\('src\/role-password\.test\.ts', \{ ROLE_PASSWORD_PG_URL: url\(ADMIN_USER, adminPw, 'tr_role_password', rpPort\), ROLE_PASSWORD_PG_LOG: rpLog \}\) \}/.test(code)
  && /comment on database tr_role_password is 'role-password-owned:\$\{ownerToken\}'/.test(code) && /c\.query\('create extension pg_stat_statements'\), \{ onPort: rpPort, database: 'tr_role_password' \}/.test(code));
check('retention-secure runs BOTH scenarios: the plain one on the main cluster and the TLS one on the TLS cluster with the throwaway root', /id: 'retention-secure', \.\.\.tsx\('src\/retention-secure-a3\.test\.ts', \{\n\s*RETENTION_SECURE_A3_ADMIN_URL: admin\('tr_ret_sec'\), RETENTION_SECURE_A3_MAINT_URL: maint\('tr_ret_sec'\),\n\s*RETENTION_SECURE_A3_TLS_ADMIN_URL: url\(ADMIN_USER, adminPw, 'tr_ret', tlsPort\), RETENTION_SECURE_A3_TLS_MAINT_URL: url\('recruiter_maintenance', maintPw, 'tr_ret', tlsPort\),\n\s*RETENTION_SECURE_A3_TLS_ROOT_CRT: tlsRootCrt,\n\s*\}\),/.test(code)
  && /\['tr_ret', 'm1', \{ ownerDir: tlsDir, onPort: tlsPort \}\]/.test(code) && /\['tr_ret_sec', 'm1'\]/.test(code));
check('the TLS cluster: certificates made by the repository helper into the temp folder, its files from tlsClusterFiles, written only inside its own data folder', /const tlsPkiDir = join\(dir, 'tls-pki'\);/.test(code)
  && /'src\/retention-secure-a3-make-pki\.ts', tlsPkiDir\], \{ cwd: join\(root, 'pipeline'\), timeout: timeoutMs \}\)/.test(code)
  && /describePkiFailure\(\{ r: pki, out: mask\(/.test(code) && code.indexOf('const timeoutMs = resolveTimeoutMs') < code.indexOf('retention-secure-a3-make-pki.ts') && /const tlsRootCrt = join\(tlsPkiDir, 'root\.crt'\);/.test(code)
  && /tlsClusterFiles\(\{ certFile: join\(tlsPkiDir, 'server\.crt'\), keyFile: join\(tlsPkiDir, 'server\.key'\) \}\)/.test(code)
  && /writeFileSync\(join\(dir, 'tls', 'data', 'postgresql\.conf'\), /.test(code) && /writeFileSync\(join\(dir, 'tls', 'data', 'pg_hba\.conf'\), files\.hba\);/.test(code)
  && /writeFileSync\(join\(dir, 'tls', 'A3_TASK_OWNED'\), ownerToken\);/.test(code) && /if \(configure\) configure\(\);\n\s*let p = await freePort\(\);/.test(code));
check('the TLS cluster\'s recruiter_maintenance login is given back after every suite too', /restoreStatements\(\{ maintPw, appPw \}\)\.filter\(\(s\) => s\.startsWith\('alter role recruiter_maintenance '\)\)\) await c\.query\(sql\);\n\s*\}, \{ onPort: tlsPort \}\);/.test(code));
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
check('every suite goes through executeSuite with the scrubbed base environment and a time limit', /executeSuite\(s, \{ sh, mask, baseEnv, timeoutMs, isInterrupted \}\)/.test(code) && /await runSuites\(orderSuites\(SUITES, first\), \{ results, only, injectedFail, injectedHang, sh, mask, baseEnv, timeoutMs, isInterrupted: \(\) => interrupted, restore: restoreLogins, afterTimeout: endStraySessions \}\);/.test(code));
check('after a TIMEOUT the leftover sessions of all three own clusters are ended by SQL (no process is signalled), and RDB_SUITES_FIRST prints which suite moved',
  /const endStraySessions = \(\) => endStrayOnPorts\(\[port, rpPort, tlsPort\], withAdmin\);/.test(code) && /export async function endStrayOnPorts\(ports, withAdmin, terminate = terminateStrayBackends\) \{/.test(code) && /for \(const onPort of ports\) \{/.test(code) && /terminate\(async \(sql\) => \(await c\.query\(sql\)\)\.rows\)/.test(code) && /\{ onPort \}\);/.test(code)
  && /if \(left\) throw new Error\(`\$\{left\} session\(s\) still open on port \$\{onPort\}`\);/.test(code)
  && /if \(orderNotice\(first\)\) console\.log\(orderNotice\(first\)\);/.test(code) && /if \(outcome\.status === 'TIMEOUT' && afterTimeout\)/.test(code));
check('the runner\'s own admin client has a connect time limit and loopback host (adminClientConfig)', /new pg\.Client\(adminClientConfig\(\{ port: onPort, password: adminPw, database \}\)\)/.test(code) && /connectionTimeoutMillis: ADMIN_CONNECT_TIMEOUT_MS/.test(code) && /host: '127\.0\.0\.1', port, user: ADMIN_USER/.test(code));
check('the stray-session SQL touches only client sessions other than its own', /where backend_type = 'client backend' and pid <> pg_backend_pid\(\)"/.test(code) && (code.match(/pg_terminate_backend/g) ?? []).length === 1);
// The PKI-guard test needs no database, so it is not run here; it must stay in the pipeline npm test chain (review t40, N5).
const pipelineTest = JSON.parse(readFileSync(resolve(root, 'pipeline/package.json'), 'utf8')).scripts?.test ?? '';
const pipelineList = await import(pathToFileURL(resolve(root, 'pipeline/scripts/test-list.mjs')).href);
check('the PKI-guard test stays in the pipeline npm test chain', pipelineTest === 'node scripts/run-tests.mjs' && pipelineList.TESTS.includes('src/retention-secure-a3-pki-guard.test.ts'));
check('the PKI guard refuses a folder name ending in a dot or a space', /hasTrailingDotOrSpaceSegment\(dir\)/.test(readFileSync(resolve(root, 'pipeline/src/retention-secure-a3-pki-guard.ts'), 'utf8')));
check('executeSuite removes colour codes, then masks, then classifies', /const out = mask\(stripAnsi\(`\$\{r\.stdout \?\? ''\}\$\{r\.stderr \?\? ''\}`\)\);/.test(code) && /classifyOutcome\(\{ kind: s\.kind, r, out,/.test(code));
check('the time limit comes from resolveTimeoutMs, and the vite build has one too', /const timeoutMs = resolveTimeoutMs\(process\.env\.RDB_SUITES_TIMEOUT_MS\);/.test(code) && /'build', '--configLoader', 'runner'\], \{ cwd: join\(root, 'app'\), timeout: timeoutMs \}\)/.test(code));
check('RDB_SUITES_ONLY skips are recorded as SKIP', /status: 'SKIP', reason: 'not selected'/.test(code) && !/status: 'PASS', reason: 'not selected'/.test(code));
check('an interrupt stops the suite loop from starting more suites', /for \(const s of suites\) \{\n    if \(isInterrupted\(\)\) \{ results\.push\(\{ id: s\.id, status: 'FAIL', reason: 'not run: interrupted' \}\); continue; \}/.test(code));
check('all three run passwords are masked, also in the harness error line', /secrets\.push\(adminPw, maintPw, appPw\);/.test(code) && /console\.error\(`ERROR: \$\{mask\(String\(err\?\.message \?\? err\)\)\}`\);/.test(code));
check('only first-manager may print a skip line (a single allowedSkips entry)', (code.match(/allowedSkips: \[/g) ?? []).length === 1 && /id: 'first-manager', \.\.\.tsx\([^\n]*allowedSkips: \['skip: the roster control table does not allow a second row'\]/.test(code));
check('app/dist counts as this run\'s from before the build starts', /builtDist = true;[^\n]*\n\s*const r = sh\(process\.execPath, \[join\(root, 'app', 'node_modules', 'vite'/.test(code));
check('the vitest run uses vitestArgs (tested in the unit tests) and the cache folder is under the temp folder', /args: vitestArgs\(join\(root, 'app', 'node_modules', 'vitest', 'vitest\.mjs'\), cacheDir\)/.test(code) && /const cacheDir = join\(dir, 'caches'\);/.test(code));
check('the summary counts the expected suites, so a missing one is a failure', /summarize\(results, \{ expectedIds: results\.length \? SUITE_IDS : \[\]/.test(code));
check('the logins are restored after every suite that ran (roles are cluster-wide), and a failed restore stops the run', /try \{ await restore\(\); \} catch \(e\) \{ throw new Error\(`could not restore the throwaway logins/.test(code) && /for \(const sql of restoreStatements\(\{ maintPw, appPw \}\)\) await c\.query\(sql\);/.test(code));
check('vite and vitest write their caches under the temp folder, not node_modules', /'--fsModuleCachePath', join\(cacheDir, 'vitest'\)/.test(code) && /'--no-cache'/.test(code) && (code.match(/'--configLoader', 'runner'/g) ?? []).length === 2);
check('the app suite turns the HTTP end-to-end tests on (RUN_HTTP_TESTS)', /id: 'app-vitest'[\s\S]*?env: \{ RUN_HTTP_TESTS: '1', /.test(code));
check('the prod-sql suites run last', /\{ id: 'prod-sql-stop-tables'[\s\S]*\{ id: 'prod-sql-a2-backouts'[\s\S]*\{ id: 'prod-sql', \.\.\.tsx\([^\n]*\n    \];/.test(code));

const suitesBlock = code.slice(code.indexOf('const SUITES = ['), code.indexOf('const suiteIds = SUITES.map'));
check('the SUITES in the script are exactly SUITE_IDS, and the script checks that itself', [...suitesBlock.matchAll(/\bid: '([a-z0-9-]+)'/g)].map((m) => m[1]).join() === SUITE_IDS.join() && /if \(suiteIds\.join\(\) !== SUITE_IDS\.join\(\)\) throw new Error\('internal: SUITES and SUITE_FILES list different suites'\);/.test(code));

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
check('server options: loopback only; only the role-password cluster preloads pg_stat_statements', pgServerOptions(5999) === '-p 5999 -c listen_addresses=127.0.0.1'
  && pgServerOptions(5999, { rolePassword: true }).startsWith('-p 5999 -c listen_addresses=127.0.0.1 ') && /shared_preload_libraries=pg_stat_statements/.test(pgServerOptions(5999, { rolePassword: true })) && !/\*|0\.0\.0\.0/.test(pgServerOptions(5999, { rolePassword: true })));

const tlsf = tlsClusterFiles({ certFile: 'C:\\t\\tls-pki\\server.crt', keyFile: 'C:\\t\\tls-pki\\server.key' });
const hbaLines = tlsf.hba.split('\n').filter(Boolean);
check('TLS cluster files: ssl on, forward-slash quoted key paths; recruiter_maintenance only over hostssl + scram (plain rejected); loopback only; no trust',
  /\nssl = on\n/.test(tlsf.conf) && tlsf.conf.includes("ssl_cert_file = 'C:/t/tls-pki/server.crt'") && tlsf.conf.includes("ssl_key_file = 'C:/t/tls-pki/server.key'")
  && hbaLines.length === 3 && hbaLines.every((l) => / 127\.0\.0\.1\/32 /.test(l)) && !/trust|0\.0\.0\.0|::|samenet|samehost|all\s+all/.test(tlsf.hba)
  && /^hostssl\s+all recruiter_maintenance 127\.0\.0\.1\/32 scram-sha-256$/.test(hbaLines[0]) && /^hostnossl all recruiter_maintenance 127\.0\.0\.1\/32 reject$/.test(hbaLines[1])
  && (() => { try { tlsClusterFiles({ certFile: "C:\\x'y", keyFile: 'k' }); return false; } catch { return true; } })());

if (failures.length) {
  console.error(`FAIL real-database suite runner contract: ${failures.length} check(s) failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(`PASS real-database suite runner contract: loopback-only, refuses non-loopback connection variables, no network or secret store, no process killed, cleanup in finally (each of the three clusters stopped by its own folder, temp folder with the throwaway TLS key and app/dist removed), retention-secure runs its TLS scenario, allow-listed child environment, failures, skips and timeouts give a non-zero exit, suite list matches the ${gated.length} env-gated real-PostgreSQL test files on disk (${EXCLUDED_FILES.length} excluded with a reason)`);
