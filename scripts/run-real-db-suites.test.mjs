// Behaviour tests for the pure helpers of scripts/run-real-db-suites.mjs. No database, no network, no child process of its own.
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { test } from 'node:test';
import {
  ENV_ALLOW, SUITE_IDS, classifyOutcome, executeSuite, findSkipLines, isSafeToDelete, maskSecrets, nonLoopbackConnectionVars, scrubbedEnv, summarize,
} from './run-real-db-suites.mjs';

const ok = { status: 0 };

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
  assert.ok(SUITE_IDS.length >= 13);
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

test('executeSuite: a failing "before" step is a FAIL and the suite is not started; a skip is not a pass', () => {
  let ran = false;
  const sh = () => { ran = true; return { status: 0, stdout: 'PASS a\nskip: x', stderr: '' }; };
  const common = { sh, mask: (t) => t, baseEnv: {}, timeoutMs: 1, isInterrupted: () => false };
  assert.equal(executeSuite({ kind: 'tsx', before: () => 'vite build failed', env: {} }, common).status, 'FAIL');
  assert.equal(ran, false);
  assert.equal(executeSuite({ kind: 'tsx', env: {} }, common).status, 'FAIL');
});
