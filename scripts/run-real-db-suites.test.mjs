// Behaviour tests for the pure helpers of scripts/run-real-db-suites.mjs. No database, no network, no child process of its own.
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import { test } from 'node:test';
import {
  ADMIN_CONNECT_TIMEOUT_MS, CHILD_COLOR_OFF, DEFAULT_TIMEOUT_MS, ENV_ALLOW, EXCLUDED_FILES, SUITE_FILES, SUITE_IDS, adminClientConfig, classifyOutcome, describePkiFailure, endStrayOnPorts, executeSuite, formatLimit, findSkipLines, isSafeToDelete, makeSh, maskSecrets,
  nonLoopbackConnectionVars, orderNotice, orderSuites, pgServerOptions, resolveTimeoutMs, restoreStatements, runSuites, scrubbedEnv, stripAnsi, summarize, terminateStrayBackends, tlsClusterFiles, vitestArgs,
} from './run-real-db-suites.mjs';

const ok = { status: 0 };
const ESC = String.fromCharCode(27);
/** The real vitest 5 summary on Windows, with colour codes (shape copied from a captured run). */
const coloured = (passed, extra = '') => `${ESC}[2m Test Files ${ESC}[22m ${ESC}[1m${ESC}[32m3 passed${ESC}[39m${ESC}[22m${ESC}[90m (3)${ESC}[39m\n`
  + `${ESC}[2m      Tests ${ESC}[22m ${ESC}[1m${ESC}[32m${passed} passed${ESC}[39m${ESC}[22m${extra}${ESC}[90m (${passed})${ESC}[39m\n`;

test('environment: only the explicit allow-list reaches a child', () => {
  const parent = {
    PATH: 'p', Path: 'p2', SystemRoot: 'C:\\Windows', TEMP: 't',
    DATABASE_URL: 'postgresql://u:p@db.example.com/x', STAGING_DB_URL: 'a', LEDGER_A3_ADMIN_URL: 'postgresql://u:p@127.0.0.1:1/x', POSTGRES_URL: 'b',
    A3_ADMIN_URL: 'c', PGPASSWORD: 'd', PGPASSFILE: 'e', SUPABASE_ORG_TOKEN: 'f', DOPPLER_TOKEN: 'g', ANTHROPIC_API_KEY: 'h', NODE_OPTIONS: '--require x',
    GITHUB_TOKEN: 'i', SOME_NEW_VARIABLE: 'j', RUN_HTTP_TESTS: '1',
  };
  const out = scrubbedEnv(parent);
  assert.deepEqual(Object.keys(out).sort(), ['PATH', 'Path', 'SystemRoot', 'TEMP']);
  for (const k of Object.keys(out)) assert.ok(ENV_ALLOW.map((n) => n.toUpperCase()).includes(k.toUpperCase()));
});

test('environment: undefined values are dropped, the input is not changed', () => {
  const parent = { PATH: 'x', TEMP: undefined };
  assert.deepEqual(scrubbedEnv(parent), { PATH: 'x' });
  assert.deepEqual(parent, { PATH: 'x', TEMP: undefined });
});

test('loopback refusal: hosted URLs, hosts, service files and query strings are refused; loopback is accepted', () => {
  const hosted = 'postgresql://u:p@db.example.supabase.co:5432/postgres';
  assert.deepEqual(nonLoopbackConnectionVars({ DATABASE_URL: hosted, STAGING_DB_URL: hosted }), ['DATABASE_URL', 'STAGING_DB_URL']);
  assert.deepEqual(nonLoopbackConnectionVars({ PGHOST: 'db.example.com' }), ['PGHOST']);
  assert.deepEqual(nonLoopbackConnectionVars({ PGHOST: '127.0.0.1,db.example.invalid' }), ['PGHOST']);
  assert.deepEqual(nonLoopbackConnectionVars({ PGSERVICE: 'prod' }), ['PGSERVICE']);
  assert.deepEqual(nonLoopbackConnectionVars({ DATABASE_URL: 'postgresql://u:p@127.0.0.1/x?host=db.example.com' }), ['DATABASE_URL']);
  assert.deepEqual(nonLoopbackConnectionVars({ ROLLBACK_TAG_DB_URL: 'not a url' }), ['ROLLBACK_TAG_DB_URL']);
  assert.deepEqual(nonLoopbackConnectionVars({ DATABASE_URL: 'postgresql://u:p@127.0.0.1:5999/x', STAGING_DB_URL: 'postgres://localhost/x', PGHOST: '127.0.0.1', PGPORT: '5999', PATH: 'x' }), []);
});

test('masking: every secret is replaced everywhere; empty secrets are ignored', () => {
  assert.equal(maskSecrets('a SECRET1 b SECRET2 c SECRET1', ['SECRET1', 'SECRET2']), 'a <masked> b <masked> c <masked>');
  assert.equal(maskSecrets('abc', ['', undefined]), 'abc');
  assert.equal(maskSecrets('postgresql://u:SECRET1@127.0.0.1/x', ['SECRET1']).includes('SECRET1'), false);
});

test('skip detection: "skip x", "skip: x", "skip" and indented forms are found; prose and allowed lines are not', () => {
  assert.equal(findSkipLines('PASS a\nskip something (set X)').length, 1);
  assert.equal(findSkipLines('PASS a\nskip: something').length, 1);
  assert.equal(findSkipLines('PASS a\nSKIP: something').length, 1);
  assert.equal(findSkipLines('PASS a\n  skip').length, 1);
  assert.equal(findSkipLines('PASS a\r\nskip: crlf\r\n').length, 1);
  assert.equal(findSkipLines('PASS skipping nothing\nthe suite will skip: never at line start\nskipper\n').length, 0);
  const legit = 'skip: the roster control table does not allow a second row';
  assert.equal(findSkipLines(`PASS a\n${legit}`, [legit]).length, 0);
  assert.equal(findSkipLines(`PASS a\n${legit}\nskip: another`, [legit]).length, 1);
});

test('classification: tsx suites', () => {
  const t = (out, r = ok, extra = {}) => classifyOutcome({ kind: 'tsx', r, out, ...extra });
  assert.equal(t('PASS one\nPASS two').status, 'PASS');
  assert.equal(t('nothing printed').status, 'FAIL');
  assert.equal(t('PASS one\nskip: set X').status, 'FAIL');
  assert.equal(t('PASS one\nskip set X').status, 'FAIL');
  assert.equal(t('skip only').status, 'FAIL');
  assert.equal(t('PASS one\nskip: ok line', ok, { allowedSkips: ['skip: ok line'] }).status, 'PASS');
  assert.equal(t('PASS one', { status: 1 }).status, 'FAIL');
  assert.match(t('PASS one\nAssertionError boom', { status: 1 }).reason, /exit 1.*AssertionError/);
  assert.equal(t('PASS one', { status: null, signal: 'SIGTERM' }).status, 'FAIL');
  assert.equal(t('PASS one', { error: { code: 'ENOENT' } }).status, 'FAIL');
  assert.equal(t('PASS one', ok, { interrupted: true }).status, 'FAIL');
  assert.equal(classifyOutcome({ kind: 'mystery', r: ok, out: 'PASS' }).status, 'FAIL');
});

test('classification: vitest suites', () => {
  const v = (out, r = ok) => classifyOutcome({ kind: 'vitest', r, out });
  assert.equal(v(' Test Files  3 passed (3)\n      Tests  293 passed (293)').status, 'PASS');
  assert.equal(v(' Tests  5 passed | 2 skipped (7)').status, 'FAIL');
  assert.equal(v(' Test Files  1 passed | 1 skipped (2)\n Tests  5 passed (5)').status, 'FAIL');
  assert.equal(v(' Tests  5 passed | 1 todo (6)').status, 'FAIL');
  assert.equal(v('no summary').status, 'FAIL');
  assert.equal(v(' Tests  42 failed | 251 passed (293)', { status: 1 }).status, 'FAIL');
});

test('classification: a timed-out child is TIMEOUT with a clear reason', () => {
  const o = classifyOutcome({ kind: 'tsx', r: { error: { code: 'ETIMEDOUT' }, status: null }, out: 'PASS x', timeoutMs: 90000 });
  assert.equal(o.status, 'TIMEOUT');
  assert.match(o.reason, /90 s time limit/);
});

test('summary and exit code: skipped, missing and timed-out suites are failures; a prior non-zero code is kept', () => {
  const pass = (id) => ({ id, status: 'PASS' });
  const ids = ['a', 'b', 'c'];
  assert.deepEqual(summarize([pass('a'), pass('b'), pass('c')], { expectedIds: ids }), { line: 'SUMMARY: 3 of 3 suites passed, 0 failed, skipped or missing', exitCode: 0, failed: [] });
  assert.equal(summarize([pass('a'), pass('b'), { id: 'c', status: 'FAIL' }], { expectedIds: ids }).exitCode, 1);
  assert.equal(summarize([pass('a'), pass('b'), { id: 'c', status: 'SKIP' }], { expectedIds: ids }).exitCode, 1);
  assert.equal(summarize([pass('a'), pass('b'), { id: 'c', status: 'TIMEOUT' }], { expectedIds: ids }).exitCode, 1);
  const missing = summarize([pass('a'), pass('b')], { expectedIds: ids });
  assert.equal(missing.exitCode, 1);
  assert.deepEqual(missing.failed, ['c']);
  assert.match(missing.line, /2 of 3 suites passed, 1 failed/);
  assert.equal(summarize([pass('a'), pass('b'), pass('c')], { expectedIds: ids, interrupted: true }).exitCode, 130);
  assert.equal(summarize([pass('a'), pass('b'), pass('c')], { expectedIds: ids, priorExitCode: 1 }).exitCode, 1);
  assert.equal(summarize([pass('a'), pass('b'), { id: 'c', status: 'FAIL' }], { expectedIds: ids, priorExitCode: 2 }).exitCode, 2);
  assert.deepEqual(summarize([], { expectedIds: [], priorExitCode: 2 }), { line: '', exitCode: 2, failed: [] });
  assert.ok(SUITE_IDS.length >= 15);
  assert.ok(SUITE_IDS.includes('role-password'));
  assert.ok(SUITE_IDS.includes('retention-secure'));
});

test('server options: loopback only, own port; only the role-password cluster preloads pg_stat_statements and logs failed statements', () => {
  assert.equal(pgServerOptions(5999), '-p 5999 -c listen_addresses=127.0.0.1');
  assert.equal(pgServerOptions('6001', { rolePassword: false }), '-p 6001 -c listen_addresses=127.0.0.1');
  const rp = pgServerOptions(5999, { rolePassword: true });
  assert.equal(rp, '-p 5999 -c listen_addresses=127.0.0.1 -c shared_preload_libraries=pg_stat_statements -c log_min_error_statement=error -c logging_collector=off');
  // A port that is not a number cannot smuggle in another option.
  assert.equal(pgServerOptions('1 -c listen_addresses=*'), '-p NaN -c listen_addresses=127.0.0.1');
});

test('folder-deletion guard: only a direct rdb-suites-* child of the temp folder', () => {
  const tmp = tmpdir();
  assert.equal(isSafeToDelete(join(tmp, 'rdb-suites-abc123'), tmp), true);
  assert.equal(isSafeToDelete(tmp, tmp), false);
  assert.equal(isSafeToDelete(join(tmp, 'other-abc'), tmp), false);
  assert.equal(isSafeToDelete(join(tmp, 'rdb-suites-abc', 'data'), tmp), false);
  assert.equal(isSafeToDelete(join(tmp, '..', 'rdb-suites-abc'), tmp), false);
  assert.equal(isSafeToDelete(join(tmp, 'x', '..', '..', 'rdb-suites-abc'), tmp), false);
  assert.equal(isSafeToDelete(parse(tmp).root, tmp), false);
  assert.equal(isSafeToDelete(undefined, tmp), false);
  assert.equal(isSafeToDelete(join(tmp, 'rdb-suites-abc'), undefined), false);
  // a drive-root temp folder: the old "resolve(tmp) + sep" check refused everything; the new one still accepts a direct child and nothing else
  const rootDir = parse(tmp).root;
  assert.equal(isSafeToDelete(join(rootDir, 'rdb-suites-abc'), rootDir), true);
  assert.equal(isSafeToDelete(rootDir, rootDir), false);
  assert.equal(isSafeToDelete(join(rootDir, 'Windows'), rootDir), false);
});

test('executeSuite: the child gets only the allow-listed environment plus the suite variables, and its output is masked', () => {
  const seen = [];
  const sh = (cmd, args, opts) => {
    seen.push(opts);
    return { status: 1, stdout: 'Error: login failed for postgresql://u:SECRETPW@127.0.0.1/x\n', stderr: '' };
  };
  const baseEnv = scrubbedEnv({ PATH: 'x', DATABASE_URL: 'postgresql://u:p@db.example.com/x', PGPASSWORD: 'pw', DOPPLER_TOKEN: 't' });
  const o = executeSuite(
    { cmd: 'node', args: [], cwd: '.', kind: 'tsx', env: { LEDGER_A3_ADMIN_URL: 'postgresql://u:SECRETPW@127.0.0.1/x' } },
    { sh, mask: (t) => maskSecrets(t, ['SECRETPW']), baseEnv, timeoutMs: 1234, isInterrupted: () => false },
  );
  assert.equal(o.status, 'FAIL');
  assert.equal(o.reason.includes('SECRETPW'), false);
  assert.match(o.reason, /<masked>/);
  assert.deepEqual(Object.keys(seen[0].env).sort(), ['LEDGER_A3_ADMIN_URL', 'PATH']);
  assert.equal(seen[0].timeout, 1234, 'every suite has a time limit');
});

test('colour: stripAnsi removes escape codes; coloured vitest output is classified like plain output', () => {
  assert.equal(stripAnsi(`${ESC}[1m${ESC}[32m293 passed${ESC}[39m${ESC}[22m`), '293 passed');
  assert.equal(stripAnsi('plain'), 'plain');
  assert.notEqual(classifyOutcome({ kind: 'vitest', r: ok, out: coloured(293) }).status, 'PASS', 'raw colour codes defeat the parser (why stripping is needed)');
  const run = (stdout) => executeSuite({ kind: 'vitest', env: {} }, { sh: () => ({ status: 0, stdout, stderr: '' }), mask: (t) => t, baseEnv: {}, timeoutMs: 1, isInterrupted: () => false });
  assert.equal(run(coloured(293)).status, 'PASS');
  assert.equal(run(coloured(293, `${ESC}[2m | ${ESC}[22m${ESC}[33m2 skipped${ESC}[39m`)).status, 'FAIL', 'a coloured "2 skipped" is still seen');
  assert.equal(run(coloured(293, ` | ${ESC}[33m1 todo${ESC}[39m`)).status, 'FAIL');
  const tsx = (stdout) => executeSuite({ kind: 'tsx', env: {} }, { sh: () => ({ status: 0, stdout, stderr: '' }), mask: (t) => t, baseEnv: {}, timeoutMs: 1, isInterrupted: () => false });
  assert.equal(tsx(`${ESC}[32mPASS${ESC}[39m one`).status, 'PASS', 'a coloured PASS line is seen once colour is removed');
  assert.equal(tsx(`PASS one\n${ESC}[33mskip: x${ESC}[39m`).status, 'FAIL');
});

test('colour: children are always told not to colour; an exit-0 failure shows the last output lines', () => {
  assert.deepEqual(CHILD_COLOR_OFF, { NO_COLOR: '1', FORCE_COLOR: '0' });
  assert.equal(ENV_ALLOW.includes('NO_COLOR'), false, 'NO_COLOR is set by the script, not inherited');
  const o = classifyOutcome({ kind: 'vitest', r: ok, out: 'a\nb\nlast line one\nlast line two\nlast line three\n' });
  assert.match(o.reason, /last lines: last line one \| last line two \| last line three/);
});

test('time limit: never zero, never unlimited', () => {
  assert.ok(DEFAULT_TIMEOUT_MS > 0 && Number.isFinite(DEFAULT_TIMEOUT_MS));
  for (const bad of [undefined, '', '0', '-5', 'abc', 'NaN', 'Infinity']) assert.equal(resolveTimeoutMs(bad), DEFAULT_TIMEOUT_MS, String(bad));
  assert.equal(resolveTimeoutMs('4000'), 4000);
});

test('environment: makeSh gives every child baseEnv unless the caller passes its own; the allow-list names no connection or secret variable', () => {
  const calls = [];
  const sh = makeSh({ PATH: 'x', NO_COLOR: '1' }, (cmd, args, opts) => { calls.push(opts); return { status: 0 }; });
  sh('a', []);
  sh('b', [], { stdio: 'ignore' });
  sh('c', [], { env: { ONLY: '1' }, timeout: 5 });
  assert.deepEqual(calls[0].env, { PATH: 'x', NO_COLOR: '1' });
  assert.deepEqual(calls[1].env, { PATH: 'x', NO_COLOR: '1' });
  assert.equal(calls[1].stdio, 'ignore');
  assert.deepEqual(calls[2].env, { ONLY: '1' });
  assert.equal(calls[2].timeout, 5);
  for (const n of ENV_ALLOW) assert.equal(/^PG|URL|TOKEN|KEY|SECRET|PASSW|DATABASE|NODE_OPTIONS|DOPPLER|SUPABASE/i.test(n), false, n);
});

test('loopback refusal: PGHOSTADDR, PGSERVICEFILE and PGSYSCONFDIR are refused', () => {
  assert.deepEqual(nonLoopbackConnectionVars({ PGHOSTADDR: '10.0.0.5' }), ['PGHOSTADDR']);
  assert.deepEqual(nonLoopbackConnectionVars({ PGSERVICEFILE: 'x' }), ['PGSERVICEFILE']);
  assert.deepEqual(nonLoopbackConnectionVars({ PGSYSCONFDIR: 'x' }), ['PGSYSCONFDIR']);
  assert.deepEqual(nonLoopbackConnectionVars({ PGHOSTADDR: '127.0.0.1' }), []);
});

test('vitest arguments: no results cache, module cache and config loader under the temp folder', () => {
  const a = vitestArgs('/v/vitest.mjs', '/tmp/rdb/caches');
  assert.equal(a[0], '/v/vitest.mjs');
  assert.ok(a.includes('run') && a.includes('--no-cache'));
  assert.equal(a[a.indexOf('--fsModuleCachePath') + 1].replace(/\\/g, '/'), '/tmp/rdb/caches/vitest');
  assert.equal(a[a.indexOf('--configLoader') + 1], 'runner');
});

test('role restore: login, password and the recruiter_api membership are all given back; quotes are escaped', () => {
  const sql = restoreStatements({ maintPw: "m'w", appPw: 'apw' });
  assert.deepEqual(sql, [
    "alter role recruiter_maintenance login password 'm''w'",
    "alter role recruiter_app login password 'apw'",
    'grant recruiter_api to recruiter_app',
  ]);
});

test('suite order: RDB_SUITES_FIRST moves one suite to the front and changes nothing else', () => {
  const s = ['a', 'b', 'c', 'd'].map((id) => ({ id }));
  assert.equal(orderSuites(s, undefined), s);
  assert.deepEqual(orderSuites(s, 'c').map((x) => x.id), ['c', 'a', 'b', 'd']);
  assert.deepEqual(orderSuites(s, 'a').map((x) => x.id), ['a', 'b', 'c', 'd']);
});

const fakeSuites = (ids) => ids.map((id) => ({ id, kind: 'tsx', cmd: 'node', args: [id], cwd: '.', env: { V: id } }));
const loopOpts = (over = {}) => {
  const calls = [];
  const events = [];
  const o = {
    results: [], log: (l) => events.push(l), mask: (t) => t, baseEnv: { PATH: 'p' }, timeoutMs: 777, isInterrupted: () => false,
    sh: (cmd, args, opts) => { calls.push({ args, opts }); return { status: 0, stdout: 'PASS x', stderr: '' }; },
    restore: async () => { events.push('restore'); },
    ...over,
  };
  return { o, calls, events };
};

test('suite loop: RDB_SUITES_ONLY skips are SKIP (not PASS) and the run exits non-zero; skipped suites are not started or restored', async () => {
  const { o, calls, events } = loopOpts({ only: ['a'] });
  await runSuites(fakeSuites(['a', 'b', 'c']), o);
  assert.deepEqual(o.results.map((r) => r.status), ['PASS', 'SKIP', 'SKIP']);
  assert.equal(calls.length, 1);
  assert.equal(events.filter((e) => e === 'restore').length, 1);
  assert.ok(events.some((e) => /^SKIP b/.test(e)));
  assert.equal(summarize(o.results, { expectedIds: ['a', 'b', 'c'] }).exitCode, 1);
});

test('suite loop: every suite is run with the time limit, in the given order, and the logins are restored after every suite (also after a FAIL)', async () => {
  const { o, calls, events } = loopOpts({ sh: (cmd, args, opts) => { calls.push({ args, opts }); return args[0] === 'b' ? { status: 1, stdout: 'Error x', stderr: '' } : { status: 0, stdout: 'PASS x', stderr: '' }; } });
  await runSuites(fakeSuites(['a', 'b', 'c']), o);
  assert.deepEqual(o.results.map((r) => r.status), ['PASS', 'FAIL', 'PASS']);
  assert.deepEqual(calls.map((c) => c.args[0]), ['a', 'b', 'c']);
  assert.ok(calls.every((c) => c.opts.timeout === 777 && c.opts.env.PATH === 'p'));
  assert.deepEqual(events.filter((e) => e === 'restore').length, 3);
  assert.deepEqual(events.filter((e) => e !== 'restore'), ['PASS a', 'FAIL b: exit 1: Error x | Error x', 'PASS c']);
});

test('suite loop: after an interrupt no further suite is started', async () => {
  let stop = false;
  const { o, calls } = loopOpts({ isInterrupted: () => stop, sh: (cmd, args, opts) => { calls.push({ args, opts }); stop = true; return { status: 0, stdout: 'PASS x', stderr: '' }; } });
  await runSuites(fakeSuites(['a', 'b', 'c']), o);
  assert.equal(calls.length, 1);
  assert.deepEqual(o.results.map((r) => [r.id, r.status]), [['a', 'FAIL'], ['b', 'FAIL'], ['c', 'FAIL']]);
});

test('suite loop: a failed restore stops the run with a clear error and keeps the results so far', async () => {
  const { o } = loopOpts({ restore: async () => { throw new Error('boom'); } });
  await assert.rejects(runSuites(fakeSuites(['a', 'b']), o), /could not restore the throwaway logins after a: boom/);
  assert.deepEqual(o.results.map((r) => r.id), ['a']);
});

test('suite loop: injected failure and injected hang', async () => {
  const f = loopOpts({ injectedFail: 'b', sh: (cmd, args, opts) => ({ status: args[0] === '-e' ? 1 : 0, stdout: 'PASS x', stderr: '' }) });
  await runSuites(fakeSuites(['a', 'b']), f.o);
  assert.deepEqual(f.o.results.map((r) => r.status), ['PASS', 'FAIL']);
  const seen = [];
  const h = loopOpts({ injectedHang: 'a', sh: (cmd, args, opts) => { seen.push(opts); return { error: { code: 'ETIMEDOUT' }, status: null }; } });
  await runSuites(fakeSuites(['a']), h.o);
  assert.equal(h.o.results[0].status, 'TIMEOUT');
  assert.equal(seen[0].timeout, 777);
  const noTimeout = loopOpts({ injectedHang: 'a', sh: () => ({ status: 0 }) });
  await runSuites(fakeSuites(['a']), noTimeout.o);
  assert.equal(noTimeout.o.results[0].status, 'FAIL');
});

test('executeSuite: a failing "before" step is a FAIL and the suite is not started; a skip is not a pass', () => {
  let ran = false;
  const sh = () => { ran = true; return { status: 0, stdout: 'PASS a\nskip: x', stderr: '' }; };
  const common = { sh, mask: (t) => t, baseEnv: {}, timeoutMs: 1, isInterrupted: () => false };
  assert.equal(executeSuite({ kind: 'tsx', before: () => 'vite build failed', env: {} }, common).status, 'FAIL');
  assert.equal(ran, false);
  assert.equal(executeSuite({ kind: 'tsx', env: {} }, common).status, 'FAIL');
});

test('TLS cluster files: ssl on with the throwaway certificate; recruiter_maintenance only over TLS + scram; admin over scram; loopback only', () => {
  const f = tlsClusterFiles({ certFile: 'C:\\Temp\\rdb-suites-x\\tls-pki\\server.crt', keyFile: '/tmp/rdb-suites-x/tls-pki/server.key' });
  assert.match(f.conf, /\nssl = on\n/);
  assert.ok(f.conf.includes("ssl_cert_file = 'C:/Temp/rdb-suites-x/tls-pki/server.crt'"));
  assert.ok(f.conf.includes("ssl_key_file = '/tmp/rdb-suites-x/tls-pki/server.key'"));
  assert.deepEqual(f.hba.split('\n').filter(Boolean).map((l) => l.split(/\s+/)), [
    ['hostssl', 'all', 'recruiter_maintenance', '127.0.0.1/32', 'scram-sha-256'],
    ['hostnossl', 'all', 'recruiter_maintenance', '127.0.0.1/32', 'reject'],
    ['host', 'all', 'tr_test_admin', '127.0.0.1/32', 'scram-sha-256'],
  ]);
  assert.doesNotMatch(f.hba, /trust|md5|password\b|0\.0\.0\.0|::/);
  for (const bad of ["C:\\a'b\\server.crt", 'C:\\a\nssl = off', '']) {
    assert.throws(() => tlsClusterFiles({ certFile: bad, keyFile: 'k' }), /refusing/, JSON.stringify(bad));
    assert.throws(() => tlsClusterFiles({ certFile: 'c', keyFile: bad }), /refusing/, JSON.stringify(bad));
  }
});

test('suite list: every SUITE_FILES entry is a real file; the retention-secure test and its PKI-guard test are both on disk', () => {
  const root = resolve(import.meta.dirname, '..');
  const src = readdirSync(join(root, 'pipeline', 'src'));
  for (const f of SUITE_FILES) assert.ok(readdirSync(join(root, ...f.file.split('/').slice(0, -1))).includes(f.file.split('/').pop()), f.file);
  assert.ok(SUITE_FILES.some((f) => f.id === 'retention-secure' && f.file === 'pipeline/src/retention-secure-a3.test.ts'));
  assert.ok(src.includes('retention-secure-a3-pki-guard.test.ts') && !SUITE_FILES.some((f) => /pki-guard/.test(f.file)), 'the PKI-guard test needs no database: it runs in pipeline npm test, not here');
  assert.ok(EXCLUDED_FILES.every((f) => !/retention-secure/.test(f.file)));
});
test('makeSh: a caller env that is undefined or null still gets baseEnv, never the whole parent environment', () => {
  const calls = [];
  const sh = makeSh({ PATH: 'x' }, (cmd, args, opts) => { calls.push(opts); return { status: 0 }; });
  sh('a', [], { env: undefined });
  sh('b', [], { env: null, timeout: 3 });
  sh('c', [], { env: {} });
  assert.deepEqual(calls[0].env, { PATH: 'x' });
  assert.deepEqual(calls[1].env, { PATH: 'x' });
  assert.equal(calls[1].timeout, 3);
  assert.deepEqual(calls[2].env, {}, 'an explicitly empty env stays empty');
});

test('after a TIMEOUT the leftover sessions are ended (afterTimeout runs before restore), and only after a TIMEOUT', async () => {
  const t = loopOpts({ sh: (cmd, args) => (args[0] === 'a' ? { error: { code: 'ETIMEDOUT' }, status: null } : { status: 0, stdout: 'PASS x', stderr: '' }) });
  t.o.afterTimeout = async (id) => { t.events.push(`stray ${id}`); };
  await runSuites(fakeSuites(['a', 'b']), t.o);
  assert.deepEqual(t.events.filter((e) => /^(restore|stray)/.test(e)), ['stray a', 'restore', 'restore']);
  const failing = loopOpts({ sh: () => ({ status: 1, stdout: 'Error x', stderr: '' }) });
  failing.o.afterTimeout = async () => { throw new Error('must not run'); };
  await runSuites(fakeSuites(['a']), failing.o);
  const broken = loopOpts({ sh: () => ({ error: { code: 'ETIMEDOUT' }, status: null }) });
  broken.o.afterTimeout = async () => { throw new Error('boom'); };
  await assert.rejects(runSuites(fakeSuites(['a']), broken.o), /could not end the leftover database sessions after a timed out: boom/);
});

test('terminateStrayBackends: ends the sessions of the cluster it is given and polls until none are left; reports what is still open', async () => {
  const sqls = [];
  let left = 3;
  const query = async (sql) => { sqls.push(sql); if (/pg_terminate_backend/.test(sql)) return []; return [{ n: left-- > 1 ? 2 : 0 }]; };
  assert.equal(await terminateStrayBackends(query, { sleep: async () => {} }), 0);
  assert.ok(sqls.every((s) => /backend_type = 'client backend' and pid <> pg_backend_pid\(\)/.test(s)), 'only client sessions, never its own');
  assert.ok(sqls.filter((s) => /pg_terminate_backend/.test(s)).length >= 2);
  assert.equal(await terminateStrayBackends(async (sql) => (/count/.test(sql) ? [{ n: 1 }] : []), { tries: 3, sleep: async () => {} }), 1);
});

test('order notice: names the suite RDB_SUITES_FIRST moved; nothing when it is not set', () => {
  assert.equal(orderNotice('prod-sql'), 'order: prod-sql moved first (RDB_SUITES_FIRST)');
  assert.equal(orderNotice(undefined), undefined);
  assert.equal(orderNotice(''), undefined);
});

test('certificate step failure: the helper\'s own refusing/usage line is shown, the time limit is named, other output keeps its last lines', () => {
  const trace = 'refusing: the directory is not empty\n    at a (x.ts:1)\n    at b (x.ts:2)\n    at c (x.ts:3)\n    at d (x.ts:4)\nNode.js v24';
  assert.equal(describePkiFailure({ r: { status: 1 }, out: trace, timeoutMs: 1000 }), 'refusing: the directory is not empty');
  assert.match(describePkiFailure({ r: { status: 1 }, out: 'usage: make-pki <dir>\nx', timeoutMs: 1000 }), /^usage: make-pki/);
  assert.match(describePkiFailure({ r: { error: { code: 'ETIMEDOUT' }, status: null }, out: '', timeoutMs: 90000 }), /exceeded the 90 s time limit/);
  assert.match(describePkiFailure({ r: { error: { code: 'ENOENT' } }, out: '', timeoutMs: 1 }), /could not start: ENOENT/);
  assert.equal(describePkiFailure({ r: { status: 1 }, out: '1\n2\n3\n4\n5\n6', timeoutMs: 1 }), '3 | 4 | 5 | 6');
});

test('endStrayOnPorts: visits every port through withAdmin, and FAILS when sessions cannot be cleared (T53 item 1)', async () => {
  const seen = [];
  const withAdmin = async (fn, { onPort }) => { seen.push(onPort); await fn({ query: async () => ({ rows: [] }) }); };
  await endStrayOnPorts([1, 2, 3], withAdmin, async () => 0);
  assert.deepEqual(seen, [1, 2, 3]);
  await assert.rejects(endStrayOnPorts([1, 2], withAdmin, async () => 2), /2 session\(s\) still open on port 1/);
  seen.length = 0;
  await assert.rejects(endStrayOnPorts([1, 2, 3], withAdmin, async () => (seen.length === 2 ? 1 : 0)), /1 session\(s\) still open on port 2/);
});

test('admin client settings: loopback host, the admin user, and a finite connect time limit (T53 item 3)', () => {
  const c = adminClientConfig({ port: 5555, password: 'pw', database: 'd' });
  assert.deepEqual({ host: c.host, port: c.port, database: c.database, user: c.user }, { host: '127.0.0.1', port: 5555, database: 'd', user: 'tr_test_admin' });
  assert.equal(c.connectionTimeoutMillis, ADMIN_CONNECT_TIMEOUT_MS);
  assert.ok(Number.isFinite(c.connectionTimeoutMillis) && c.connectionTimeoutMillis > 0 && c.connectionTimeoutMillis <= 120000);
  assert.equal(adminClientConfig({ port: 1, password: 'x' }).database, 'postgres');
});

test('certificate step failure: tsx prints the helper\'s source line too; only the Error/refusing line is shown (T53 item 4)', () => {
  const out = "C:\\x\\make-pki.ts:56\n  if (bad) throw new Error('refusing: a path segment ends in a dot or a space');\n                 ^\n\nError: refusing: a path segment ends in a dot or a space\n    at assertOutsideRepository (x.ts:56:3)\n\nNode.js v24";
  const msg = describePkiFailure({ r: { status: 1 }, out, timeoutMs: 1000 });
  assert.equal(msg, 'Error: refusing: a path segment ends in a dot or a space');
  assert.ok(!/throw new Error|\bif \(/.test(msg), 'no line of source code');
  assert.equal(describePkiFailure({ r: { status: 1 }, out: "if (x) throw new Error('usage: make-pki <dir>');\nError: usage: make-pki <dir>", timeoutMs: 1 }), 'Error: usage: make-pki <dir>');
});

test('time limit text: under 1 second is shown in ms, never "0 s" (T53 item 5)', () => {
  assert.equal(formatLimit(50), '50 ms');
  assert.equal(formatLimit(999), '999 ms');
  assert.equal(formatLimit(1000), '1 s');
  assert.equal(formatLimit(90000), '90 s');
  assert.equal(formatLimit(1500), '1.5 s');
  assert.match(describePkiFailure({ r: { error: { code: 'ETIMEDOUT' }, status: null }, out: '', timeoutMs: 50 }), /exceeded the 50 ms time limit/);
  const o = classifyOutcome({ kind: 'tsx', r: { error: { code: 'ETIMEDOUT' }, status: null }, out: '', timeoutMs: 50 });
  assert.match(o.reason, /exceeded the 50 ms time limit/);
  assert.ok(!/\b0 s\b/.test(o.reason));
});