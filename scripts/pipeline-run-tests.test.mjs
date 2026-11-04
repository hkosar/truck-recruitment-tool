// Tests pipeline/scripts/run-tests.mjs (the `npm test` runner of the pipeline) and its list, pipeline/scripts/test-list.mjs.
// No network, no database: temporary folders hold tiny stand-in test files; the real tsx runs them.
// Run: node --test scripts/pipeline-run-tests.test.mjs

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const pipeline = join(root, 'pipeline');
const { REFUSAL_EXIT, checkLists, discoverTests, runAll } = await import(pathToFileURL(join(pipeline, 'scripts', 'run-tests.mjs')).href);
const { NOT_RUN, SMOKE, TESTS } = await import(pathToFileURL(join(pipeline, 'scripts', 'test-list.mjs')).href);
const tsxCli = join(pipeline, 'node_modules', 'tsx', 'dist', 'cli.mjs');

const tmp = mkdtempSync(join(tmpdir(), 'pipeline-run-tests-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
/** A temporary pipeline folder: files is { 'src/x.test.ts': 'source' }. */
function fixture(files) {
  const dir = join(tmp, `d${n++}`);
  for (const [f, src] of Object.entries(files)) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), src);
  }
  return dir;
}
const capture = () => { const out = []; const errs = []; return { out, errs, log: (s) => out.push(s), err: (s) => errs.push(s) }; };
const ok = 'process.exit(0);\n';

test('the real list matches the disk, and TESTS is exactly the 14 files npm test ran before (smoke + 13)', () => {
  assert.deepEqual(checkLists({ dir: pipeline, smoke: SMOKE, tests: TESTS, notRun: NOT_RUN, discovered: discoverTests(pipeline) }), []);
  assert.equal(SMOKE, 'src/smoke-tests.ts');
  assert.deepEqual([...TESTS].sort(), [
    'src/backout-rehearsal.test.ts', 'src/batch-delete-compare.test.ts', 'src/db-tls.test.ts', 'src/first-manager-bootstrap.test.ts',
    'src/loopback-fetch.test.ts', 'src/m1-check-ids.test.ts', 'src/prod-sql.test.ts', 'src/retention-secure-a3-pki-guard.test.ts', 'src/role-matrix-a3.test.ts',
    'src/role-password.test.ts', 'src/server-major.test.ts', 'src/staging2-pooler-guard.test.ts', 'src/target-guard-messages.test.ts',
  ]);
  assert.deepEqual([...TESTS], [...TESTS].sort(), 'TESTS is kept sorted');
  assert.deepEqual(NOT_RUN.map(([f]) => f), NOT_RUN.map(([f]) => f).sort(), 'NOT_RUN is kept sorted');
  assert.ok(NOT_RUN.every(([, why]) => why));
});

test('package.json test is the runner and nothing else', () => {
  assert.equal(JSON.parse(readFileSync(join(pipeline, 'package.json'), 'utf8')).scripts.test, 'node scripts/run-tests.mjs');
});

test('runs smoke first, then the listed files in sorted order, one line per file', () => {
  const dir = fixture({ 'src/smoke-tests.ts': ok, 'src/b.test.ts': ok, 'src/sub/a.test.ts': ok, 'src/z.test.ts': ok });
  const calls = [];
  const c = capture();
  const code = runAll({ dir, tests: ['src/z.test.ts', 'src/sub/a.test.ts', 'src/b.test.ts'], notRun: [], spawn: (f) => { calls.push(f); return 0; }, ...c });
  assert.equal(code, 0);
  assert.deepEqual(calls, ['src/smoke-tests.ts', 'src/b.test.ts', 'src/sub/a.test.ts', 'src/z.test.ts']);
  assert.equal(c.out.filter((l) => l.startsWith('ok   ')).length, 4);
});

test('the first failure stops the run and its exit code is returned (real tsx, temporary copy)', () => {
  const dir = fixture({ 'src/smoke-tests.ts': ok, 'src/a.test.ts': ok, 'src/b.test.ts': 'process.exit(7);\n', 'src/c.test.ts': 'throw new Error("must not run");\n' });
  const c = capture();
  const code = runAll({ dir, tests: ['src/a.test.ts', 'src/b.test.ts', 'src/c.test.ts'], notRun: [], tsxCli, ...c });
  assert.equal(code, 7);
  assert.ok(c.out.includes('ok   src/a.test.ts'));
  assert.ok(!c.out.some((l) => l.includes('c.test.ts')), 'c.test.ts never started');
  assert.ok(c.errs.some((l) => l.includes('FAIL src/b.test.ts (exit code 7)')));
});

test('a failing smoke test stops before any listed file', () => {
  const dir = fixture({ 'src/smoke-tests.ts': 'process.exit(3);\n', 'src/a.test.ts': ok });
  const calls = [];
  const code = runAll({ dir, tests: ['src/a.test.ts'], notRun: [], tsxCli, spawn: (f) => { calls.push(f); return f === 'src/smoke-tests.ts' ? 3 : 0; }, ...capture() });
  assert.equal(code, 3);
  assert.deepEqual(calls, ['src/smoke-tests.ts']);
});

test('refuses an unlisted new *.test.ts, before running anything', () => {
  const dir = fixture({ 'src/smoke-tests.ts': ok, 'src/a.test.ts': ok, 'src/sub/new.test.ts': ok });
  const calls = [];
  const c = capture();
  const code = runAll({ dir, tests: ['src/a.test.ts'], notRun: [], spawn: (f) => { calls.push(f); return 0; }, ...c });
  assert.equal(code, REFUSAL_EXIT);
  assert.deepEqual(calls, []);
  assert.ok(c.errs.some((l) => l.includes('src/sub/new.test.ts exists but is in neither TESTS nor NOT_RUN')));
  assert.ok(c.errs.some((l) => l.includes('found 2 test-like files, the lists name 1')));
});

test('refuses a listed file that is missing (renamed), before running anything', () => {
  const dir = fixture({ 'src/smoke-tests.ts': ok, 'src/a-renamed.test.ts': ok });
  const calls = [];
  const c = capture();
  const code = runAll({ dir, tests: ['src/a.test.ts'], notRun: [], spawn: (f) => { calls.push(f); return 0; }, ...c });
  assert.equal(code, REFUSAL_EXIT);
  assert.deepEqual(calls, []);
  assert.ok(c.errs.some((l) => l.includes('src/a.test.ts is listed but missing from disk')));
  assert.ok(c.errs.some((l) => l.includes('src/a-renamed.test.ts exists but is in neither')));
});

test('refuses a missing smoke file, a duplicate line and a NOT_RUN entry without a reason', () => {
  const dir = fixture({ 'src/a.test.ts': ok, 'src/b.test.ts': ok });
  const c = capture();
  const code = runAll({ dir, tests: ['src/a.test.ts', 'src/a.test.ts'], notRun: [['src/b.test.ts', '']], spawn: () => 0, ...c });
  assert.equal(code, REFUSAL_EXIT);
  assert.ok(c.errs.some((l) => l.includes('smoke tests) is missing')));
  assert.ok(c.errs.some((l) => l.includes('src/a.test.ts is listed more than once')));
  assert.ok(c.errs.some((l) => l.includes('src/b.test.ts is in NOT_RUN without a reason')));
});

test('a NOT_RUN file is neither run nor a refusal', () => {
  const dir = fixture({ 'src/smoke-tests.ts': ok, 'src/a.test.ts': ok, 'src/db-a3.test.ts': 'process.exit(9);\n' });
  const calls = [];
  const code = runAll({ dir, tests: ['src/a.test.ts'], notRun: [['src/db-a3.test.ts', 'real database']], spawn: (f) => { calls.push(f); return 0; }, ...capture() });
  assert.equal(code, 0);
  assert.deepEqual(calls, ['src/smoke-tests.ts', 'src/a.test.ts']);
});

test('discovery ignores node_modules and non-test files', () => {
  const dir = fixture({ 'src/a.test.ts': ok, 'src/a.ts': ok, 'src/a.test.d.ts': ok, 'src/latest.ts': ok, 'node_modules/x/src/y.test.ts': ok, 'src/node_modules/z.test.ts': ok });
  assert.deepEqual(discoverTests(dir), ['src/a.test.ts']);
});

for (const name of ['src/b.spec.ts', 'src/b.test.mts', 'src/b.test.cts', 'src/b.test.tsx', 'src/b.test.js', 'src/b.TEST.ts', 'src/B.Spec.TS']) {
  test(`refuses an unlisted test-like name: ${name}`, () => {
    const dir = fixture({ 'src/smoke-tests.ts': ok, 'src/a.test.ts': ok, [name]: ok });
    const calls = [];
    const c = capture();
    const code = runAll({ dir, tests: ['src/a.test.ts'], notRun: [], spawn: (f) => { calls.push(f); return 0; }, ...c });
    assert.equal(code, REFUSAL_EXIT);
    assert.deepEqual(calls, []);
    assert.ok(c.errs.some((l) => l.includes(`${name} exists but is in neither TESTS nor NOT_RUN`)), c.errs.join('\n'));
  });

  test(`a test-like name is accepted only in NOT_RUN with a reason: ${name}`, () => {
    const dir = fixture({ 'src/smoke-tests.ts': ok, 'src/a.test.ts': ok, [name]: ok });
    assert.equal(runAll({ dir, tests: ['src/a.test.ts'], notRun: [[name, 'runs elsewhere']], spawn: () => 0, ...capture() }), 0);
    const c = capture();
    assert.equal(runAll({ dir, tests: ['src/a.test.ts', name], notRun: [], spawn: () => 0, ...c }), REFUSAL_EXIT, 'listed in TESTS is still refused');
    assert.ok(c.errs.some((l) => l.includes(`${name} has a test-like name that npm test would never run`)), c.errs.join('\n'));
  });
}

test('a NOT_RUN reason of only spaces is refused', () => {
  const dir = fixture({ 'src/smoke-tests.ts': ok, 'src/a.test.ts': ok, 'src/b.test.ts': ok });
  for (const why of ['   ', '\t \n', undefined]) {
    const c = capture();
    assert.equal(runAll({ dir, tests: ['src/a.test.ts'], notRun: [['src/b.test.ts', why]], spawn: () => 0, ...c }), REFUSAL_EXIT);
    assert.ok(c.errs.some((l) => l.includes('src/b.test.ts is in NOT_RUN without a reason')));
  }
});

test('zero test files to run is a failure, never a pass', () => {
  const dir = fixture({ 'src/smoke-tests.ts': ok });
  const calls = [];
  const c = capture();
  const code = runAll({ dir, tests: [], notRun: [], spawn: (f) => { calls.push(f); return 0; }, ...c });
  assert.notEqual(code, 0);
  assert.ok(c.errs.some((l) => l.includes('no test files to run')));
  assert.ok(!c.out.some((l) => l.includes('passed')));
});

/** A link to a folder: a junction on Windows (no admin needed), a symlink elsewhere. Removes only the link itself. */
function link(target, path) {
  symlinkSync(target, path, 'junction');
  return () => { try { unlinkSync(path); } catch { rmdirSync(path); } };
}

test('a test inside a linked subfolder is found (so an unlisted one is refused), and a link back to a parent does not loop', () => {
  const outside = fixture({ 'x.test.ts': ok });
  const dir = fixture({ 'src/smoke-tests.ts': ok, 'src/a.test.ts': ok });
  const unlink = link(outside, join(dir, 'src', 'linked'));
  const unlinkLoop = link(join(dir, 'src'), join(dir, 'src', 'loop'));
  try {
    assert.deepEqual(discoverTests(dir), ['src/a.test.ts', 'src/linked/x.test.ts']);
    const c = capture();
    assert.equal(runAll({ dir, tests: ['src/a.test.ts'], notRun: [], spawn: () => 0, ...c }), REFUSAL_EXIT);
    assert.ok(c.errs.some((l) => l.includes('src/linked/x.test.ts exists but is in neither TESTS nor NOT_RUN')), c.errs.join('\n'));
  } finally { unlinkLoop(); unlink(); }
  assert.ok(existsSync(join(outside, 'x.test.ts')), 'the link target is untouched');
});

test('npm test style run through a junction/symlink to the pipeline folder runs the tests (real tsx, real path compare)', () => {
  const dir = fixture({
    'src/smoke-tests.ts': ok,
    'src/a.test.ts': ok,
    'scripts/run-tests.mjs': readFileSync(join(pipeline, 'scripts', 'run-tests.mjs'), 'utf8'),
    'scripts/test-list.mjs': "export const SMOKE = 'src/smoke-tests.ts';\nexport const TESTS = ['src/a.test.ts'];\nexport const NOT_RUN = [];\n",
  });
  const unlinkModules = link(join(pipeline, 'node_modules'), join(dir, 'node_modules'));
  const via = join(tmp, `via${n++}`);
  const unlinkVia = link(dir, via);
  try {
    for (const cwd of [dir, via]) {
      const r = spawnSync(process.execPath, [join(cwd, 'scripts', 'run-tests.mjs')], { cwd, encoding: 'utf8', env: process.env });
      assert.equal(r.status, 0, `${cwd}: ${r.stdout}${r.stderr}`);
      assert.match(r.stdout, /pipeline tests: all 2 files passed/, `${cwd}: ${r.stdout}${r.stderr}`);
    }
    // a failing test is reported as a failure through the link too
    writeFileSync(join(dir, 'src', 'a.test.ts'), 'process.exit(4);\n');
    const r = spawnSync(process.execPath, [join(via, 'scripts', 'run-tests.mjs')], { cwd: via, encoding: 'utf8', env: process.env });
    assert.equal(r.status, 4, `${r.stdout}${r.stderr}`);
  } finally { unlinkVia(); unlinkModules(); }
});
