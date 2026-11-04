// Tests scripts/simulate-ci-jobs.mjs (the fresh-clone CI job simulator). No network; the --run test builds a tiny temp git repo.
// Run: node --test scripts/simulate-ci-jobs.test.mjs

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { analyze, expandToken, findBash, fsSource, gitSource, main, memSource, parseArgs, parseWorkflow, parseYaml, readCommands, splitSegments } from './simulate-ci-jobs.mjs';

const root = resolve(import.meta.dirname, '..');
const wf = (jobs) => `name: CI\non:\n  push:\njobs:\n${jobs}`;
const job = (steps, extra = '') => `  j:\n    name: j\n    runs-on: ubuntu-latest\n${extra}    steps:\n${steps}`;
const REPO_FILES = { 'app/package.json': '{"scripts":{"test":"vitest run","lint":"eslint ."}}', 'pipeline/package.json': '{"scripts":{"test":"node scripts/run-tests.mjs"}}' };
const flagsOf = (files, yml) => analyze(memSource({ ...REPO_FILES, ...files }), parseWorkflow(yml));

test('parseYaml: mappings, sequences of mappings, block scalars, comments, quotes', () => {
  const d = parseYaml('a:\n  # comment\n  b: "x y"\n  c:\n    - name: one\n      run: |\n        echo 1\n\n        # kept\n      with:\n        k: v\n    - plain\nd:\n');
  assert.deepEqual(d, { a: { b: 'x y', c: [{ name: 'one', run: 'echo 1\n\n# kept\n', with: { k: 'v' } }, 'plain'] }, d: null });
});

test('parseYaml refuses shapes it does not understand', () => {
  for (const bad of ['a: [1, 2]\n', 'a: {b: 1}\n', 'a: &x 1\n', 'a: *x\n', 'a: >\n  folded\n', 'a:\n\tb: 1\n', 'a: 1\na: 2\n', 'a: b # trailing\n', 'a:\n- x\n', 'just text\n', '']) {
    assert.throws(() => parseYaml(bad), /line|empty/, JSON.stringify(bad));
  }
});

test('parseWorkflow reads the repository ci.yml and every job has the expected shape', () => {
  const jobs = parseWorkflow(fsSource(root).read('.github/workflows/ci.yml'));
  assert.deepEqual(jobs.map((j) => j.id), ['app', 'pipeline', 'pipeline-node24', 'repo-checks']);
  const rc = jobs.find((j) => j.id === 'repo-checks');
  assert.equal(rc.defaultCwd, null);
  assert.ok(rc.steps.every((s) => s.cwd === '.' || s.cwd === 'pipeline'));
  assert.equal(jobs.find((j) => j.id === 'app').steps.at(-1).cwd, 'app');
});

test('parseWorkflow throws on job or step keys it does not know', () => {
  const step = '      - name: x\n        run: echo hi\n';
  assert.throws(() => parseWorkflow(wf(job(step, '    needs: other\n'))), /key not understood: needs/);
  assert.throws(() => parseWorkflow(wf(job(step, '    strategy:\n      matrix:\n        n: 1\n'))), /key not understood: strategy/);
  assert.throws(() => parseWorkflow(wf(job('      - name: x\n        run: echo hi\n        env:\n          A: b\n'))), /key not understood: env/);
  assert.throws(() => parseWorkflow(wf(job('      - name: x\n        if: always()\n        run: echo hi\n'))), /key not understood: if/);
  assert.throws(() => parseWorkflow(wf(job('      - name: x\n        uses: a/b@v1\n        run: echo hi\n'))), /exactly one of uses \/ run/);
  assert.throws(() => parseWorkflow('name: x\nenv:\n  A: b\njobs:\n  j:\n    steps:\n      - run: echo\n'), /top-level key not understood: env/);
  assert.throws(() => parseWorkflow(wf('  j:\n    runs-on: x\n')), /no steps/);
});

test('splitSegments and readCommands', () => {
  assert.deepEqual(splitSegments('for f in scripts/verify-*.mjs; do'), [['for', 'f', 'in', 'scripts/verify-*.mjs'], ['do']]);
  assert.deepEqual(splitSegments('echo "a; b && c" && node "x y.mjs"'), [['echo', 'a; b && c'], ['node', 'x y.mjs']]);
  const cmds = readCommands('if [ -f package-lock.json ]; then\n  npm ci\nelse\n  echo "x \'npm install\'"\n  npm install\nfi\nnode --test scripts/*.test.mjs\nnode -e "require(1)" a.mjs\nCI=1 npm run lint', 'app');
  assert.deepEqual(cmds.map((c) => c.kind), ['install', 'install', 'files', 'files', 'npm-run']);
  assert.equal(cmds[0].dir, 'app');
  assert.deepEqual(cmds[3].tokens, ['a.mjs']);
  assert.equal(readCommands('npm install --prefix pipeline', '.')[0].dir, 'pipeline');
  assert.equal(readCommands('npm test', 'app')[0].script, 'test');
  assert.throws(() => readCommands('cd pipeline && npm ci', '.'), /changes the working folder/);
  assert.throws(() => readCommands('curl http://x', '.'), /command not understood: curl/);
  assert.throws(() => readCommands('npm publish', '.'), /npm sub-command not understood/);
  assert.throws(() => readCommands('while true; do', '.'), /unsupported shell condition/);
  assert.deepEqual(readCommands('eslint .', 'app', true), []);
});

test('expandToken: exact files, globs, misses', () => {
  const src = memSource({ 'scripts/a.test.mjs': '', 'scripts/b.test.mjs': '', 'scripts/c.mjs': '', 'scripts/notes.txt': '' });
  assert.deepEqual(expandToken(src, '.', 'scripts/*.test.mjs').sort(), ['scripts/a.test.mjs', 'scripts/b.test.mjs']);
  assert.deepEqual(expandToken(src, 'scripts', 'c.mjs'), ['scripts/c.mjs']);
  assert.deepEqual(expandToken(src, '.', '$f'), []);
  assert.deepEqual(expandToken(src, '.', 'scripts'), []);
  assert.throws(() => expandToken(src, '.', 'scripts/*.spec.mjs'), /matches no script file/);
  assert.throws(() => expandToken(src, '.', 'scripts/missing.mjs'), /does not exist/);
  assert.throws(() => expandToken(src, '.', 'scripts/**/x.mjs'), /not understood/);
});

// The fixtures spell the folder name in pieces so that this file is not itself flagged when the simulator scans scripts/*.test.mjs.
const NM = ['node', 'modules'].join('_');
const TSX_TEST = `const tsx = join(pipeline, '${NM}', 'tsx', 'dist', 'cli.mjs');\n`;
const STEPS_NODE = '      - name: Tests\n        run: node --test scripts/*.test.mjs\n';
const INSTALL = (dir) => `      - name: Install\n        working-directory: ${dir}\n        run: npm ci\n`;

test('static: a job that runs a script using pipeline/node_modules without installing pipeline is flagged', () => {
  const r = flagsOf({ 'scripts/x.test.mjs': TSX_TEST }, wf(job(STEPS_NODE)));
  assert.equal(r[0].flagged, true);
  assert.equal(r[0].steps[0].flags[0].pkg, 'pipeline');
  assert.match(r[0].steps[0].flags[0].why, /pipeline\/node_modules/);
  assert.equal(r[0].steps[0].flags[0].file, 'scripts/x.test.mjs');
});

test('static: installing that package before the step clears the flag; installing after does not', () => {
  assert.equal(flagsOf({ 'scripts/x.test.mjs': TSX_TEST }, wf(job(INSTALL('pipeline') + STEPS_NODE)))[0].flagged, false);
  assert.equal(flagsOf({ 'scripts/x.test.mjs': TSX_TEST }, wf(job(STEPS_NODE + INSTALL('pipeline'))))[0].flagged, true);
  assert.equal(flagsOf({ 'scripts/x.test.mjs': TSX_TEST }, wf(job(INSTALL('app') + STEPS_NODE)))[0].flagged, true, 'the wrong package does not help');
});

test('static: path styles for app/pipeline node_modules, comments ignored', () => {
  const run = (code) => flagsOf({ 'scripts/x.test.mjs': code }, wf(job(STEPS_NODE)))[0].flagged;
  assert.equal(run(`join(root, 'app', '${NM}', 'vite')`), true);
  assert.equal(run(`const p = 'x/pipeline/${NM}/tsx';`), true);
  assert.equal(run(`join(pipelineDir, '${NM}')`), true);
  assert.equal(run(`// join(pipeline, '${NM}')\n * app/${NM}\n`), false);
  assert.equal(run("const t = 'node_modules/tsx/dist/cli.mjs'; // text only"), false);
  assert.equal(run("check(/join\\(root, 'app', 'node_modules'/.test(code));"), false);
});

test('static: bare imports resolve from the nearest package folder, the repository root is never installed', () => {
  assert.equal(flagsOf({ 'scripts/x.test.mjs': "import { join } from 'node:path';\nimport fs from 'fs';\n" }, wf(job(STEPS_NODE)))[0].flagged, false);
  const r = flagsOf({ 'scripts/x.test.mjs': "import pg from 'pg';\n" }, wf(job(INSTALL('pipeline') + STEPS_NODE)));
  assert.equal(r[0].flagged, true);
  assert.equal(r[0].steps.at(-1).flags[0].pkg, '.');
  const inPkg = { 'pipeline/scripts/y.mjs': "import pg from 'pg';\n" };
  const yml = (pre) => wf(job(`${pre}      - name: Y\n        working-directory: pipeline\n        run: node scripts/y.mjs\n`));
  assert.equal(flagsOf(inPkg, yml(''))[0].flagged, true);
  assert.equal(flagsOf(inPkg, yml(INSTALL('pipeline')))[0].flagged, false);
});

test('static: relative imports are followed only with follow: true', () => {
  const files = { 'scripts/x.test.mjs': "import { a } from './lib.mjs';\n", 'scripts/lib.mjs': TSX_TEST };
  const model = parseWorkflow(wf(job(STEPS_NODE)));
  assert.equal(analyze(memSource({ ...REPO_FILES, ...files }), model)[0].flagged, false);
  assert.equal(analyze(memSource({ ...REPO_FILES, ...files }), model, { follow: true })[0].flagged, true);
});

test('static: npm run / npm test / npx need the working folder; script bodies are read', () => {
  const run = (cmd, dir, pre = '') => flagsOf({}, wf(job(`${pre}      - name: S\n        working-directory: ${dir}\n        run: ${cmd}\n`)))[0];
  assert.equal(run('npm test', 'app').flagged, true);
  assert.equal(run('npm test', 'app', INSTALL('app')).flagged, false);
  assert.equal(run('npx tsc --noEmit', 'app').flagged, true);
  assert.equal(run('npm run lint', 'app', INSTALL('app')).flagged, false);
  assert.throws(() => run('npm run nope', 'app', INSTALL('app')), /no script "nope"/);
  assert.throws(() => run('npm test', '.'), /no package.json/);
  assert.throws(() => run('npm ci', 'docs'), /no package.json/);
  // a script body that runs a node script using the other package is followed
  const files = { 'app/package.json': '{"scripts":{"test":"node ../scripts/z.mjs"}}', 'scripts/z.mjs': TSX_TEST };
  const r = flagsOf(files, wf(job(`${INSTALL('app')}      - name: S\n        working-directory: app\n        run: npm test\n`)));
  assert.equal(r[0].steps.at(-1).flags.some((f) => f.pkg === 'pipeline'), true);
});

test('static: both branches of an install fallback count once; --prefix installs another folder', () => {
  const yml = wf(job('      - name: I\n        run: |\n          if [ -f package-lock.json ]; then\n            npm ci --prefix pipeline\n          else\n            npm install --prefix pipeline\n          fi\n'));
  const r = flagsOf({}, yml);
  assert.deepEqual(r[0].installs, [{ pkg: 'pipeline', step: 'I' }]);
});

test('the repository ci.yml is clean at HEAD; the commit before the CI fix flags repo-checks (needs git history)', (t) => {
  const here = main(['--job', 'repo-checks'], root, { out: () => {} });
  assert.equal(here, 0);
  const has = (sha) => spawnSync('git', ['-C', root, 'cat-file', '-e', `${sha}^{commit}`]).status === 0;
  if (!has('7350186') || !has('a166235')) { t.skip('7350186 / a166235 not in this clone'); return; }
  const lines = [];
  assert.equal(main(['--ref', '7350186', '--job', 'repo-checks'], root, { out: (s) => lines.push(s) }), 1);
  assert.match(lines.join('\n'), /FLAG: needs pipeline\/node_modules .*pipeline-run-tests\.test\.mjs:17/);
  assert.equal(main(['--ref', 'a166235'], root, { out: () => {} }), 0);
  assert.equal(gitSource(root, 'a166235').has('.github/workflows/ci.yml'), true);
});

test('parseArgs', () => {
  assert.deepEqual(parseArgs(['--job', 'x', '--follow-imports']).job, 'x');
  assert.equal(parseArgs(['--run', '--borrow', 'b', '--node', '24=n']).node['24'], 'n');
  assert.throws(() => parseArgs(['--run']), /needs --borrow/);
  assert.throws(() => parseArgs(['--run', '--ref', 'x', '--borrow', 'b', '--node', '1=n']), /drop --ref/);
  assert.throws(() => parseArgs(['--bogus']), /unknown argument/);
  assert.throws(() => parseArgs(['--node', 'x']), /--node takes/);
});

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

test('--run: fresh clone, only installed packages are junctioned, steps run, clone is deleted', (t) => {
  let bash;
  try { bash = findBash(); } catch { t.skip('no bash'); return; }
  if (process.platform === 'win32' && !existsSync(bash)) { t.skip('no bash'); return; }
  const tmp = mkdtempSync(join(tmpdir(), 'ci-sim-test-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const repo = join(tmp, 'repo');
  const borrow = join(tmp, 'borrow');
  for (const p of ['pipeline', 'app']) mkdirSync(join(borrow, p, 'node_modules', 'marker'), { recursive: true });
  const put = (rel, text) => { mkdirSync(join(repo, rel, '..'), { recursive: true }); writeFileSync(join(repo, rel), text); };
  put('.github/workflows/ci.yml', wf(`  ok:\n    steps:\n      - name: Checkout\n        uses: actions/checkout@v4\n      - name: Install\n        working-directory: pipeline\n        run: npm ci\n      - name: Check\n        run: |\n          node scripts/check.mjs\n  bad:\n    steps:\n      - name: Check\n        run: |\n          node scripts/check.mjs\n`));
  put('pipeline/package.json', '{"scripts":{}}');
  put('scripts/check.mjs', "import { existsSync } from 'node:fs';\nimport { join } from 'node:path';\nconst root = join(import.meta.dirname, '..');\nif (existsSync(join(root, 'node_modules'))) process.exit(3);\nif (existsSync(join(root, 'app', 'node' + '_modules'))) process.exit(4);\nif (process.env.NODE_OPTIONS) process.exit(5);\nprocess.exit(existsSync(join(root, 'pipeline', 'node_modules', 'marker')) ? 0 : 1);\n");
  spawnSync('git', ['init', '-q', repo]);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'x');
  const before = readdirSync(tmpdir()).filter((n) => n.startsWith('ci-sim-ok-') || n.startsWith('ci-sim-bad-'));
  const lines = [];
  const code = main(['--run', '--borrow', borrow, '--node', `${process.versions.node.split('.')[0]}=${process.execPath}`], repo, { out: (s) => lines.push(s) });
  const text = lines.join('\n');
  assert.equal(code, 1, text);
  assert.match(text, /=== job ok on Node \d+: PASS \(junctions: pipeline\)/);
  assert.match(text, /=== job bad on Node \d+: FAIL \(junctions: none\)/);
  assert.match(text, /Install: skipped \(install replaced by junction\)/);
  assert.match(text, /Checkout: skipped \(uses: action\)/);
  assert.deepEqual(readdirSync(tmpdir()).filter((n) => n.startsWith('ci-sim-ok-') || n.startsWith('ci-sim-bad-')), before, 'clones are deleted');
  assert.ok(existsSync(join(borrow, 'pipeline', 'node_modules', 'marker')), 'the borrowed folder is untouched');
});
