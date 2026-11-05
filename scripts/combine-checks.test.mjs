// Tests scripts/combine-checks.mjs: argument parsing, the junction plan and junction removal safety. No network, no database,
// no step of the real run is started; temporary folders hold stand-in node_modules.
// Run: node --test scripts/combine-checks.test.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { DEFAULT_PG17_BIN, GIT_READ_OPTIONS, MAX_TIMER_MS, buildSteps, createJunctions, formatSummary, gitEnv, main, parseArgs, planJunction, removeJunctions, stagingCheck, stepEnv } from './combine-checks.mjs';

const NM = ['node', 'modules'].join('_'); // built from parts so the CI simulator (scripts/simulate-ci-jobs.mjs) does not read this file as a use of an installed package folder
const tmp = mkdtempSync(join(tmpdir(), 'combine-checks-test-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const fresh = () => { const d = join(tmp, `d${n++}`); mkdirSync(d); return d; };
/** A fake repo with the given module dirs, each holding node_modules/marker.txt. */
const fakeTree = (dirs) => { const r = fresh(); for (const d of dirs) { mkdirSync(join(r, d, NM), { recursive: true }); writeFileSync(join(r, d, NM, 'marker.txt'), 'keep'); } for (const d of ['pipeline', 'app']) mkdirSync(join(r, d), { recursive: true }); return r; };

test('parseArgs: runbook required, defaults, both flag styles, unknown/duplicate/missing values refused', () => {
  assert.deepEqual(parseArgs(['--runbook', 'r.md']), { ok: true, options: { runbook: 'r.md', junction: undefined, pg17Bin: DEFAULT_PG17_BIN, timeoutMinutes: undefined, stagingCheck: undefined } });
  assert.deepEqual(parseArgs(['--runbook=r.md', '--junction', 'w', '--pg17-bin=p', '--timeout', '1.5', '--staging-check=s']).options, { runbook: 'r.md', junction: 'w', pg17Bin: 'p', timeoutMinutes: 1.5, stagingCheck: 's' });
  for (const bad of ['0', '-1', 'abc', 'Infinity']) assert.match(parseArgs(['--runbook', 'a', '--timeout', bad]).error, /greater than 0|needs a value/, bad);
  assert.match(parseArgs([]).error, /--runbook/);
  assert.match(parseArgs(['--runbook']).error, /needs a value/);
  assert.match(parseArgs(['--runbook', '--junction', 'w']).error, /needs a value/);
  assert.match(parseArgs(['--runbook', 'a', '--runbook', 'b']).error, /twice/);
  assert.match(parseArgs(['--runbook', 'a', '--nope']).error, /unknown argument/);
  assert.match(parseArgs(['--runbook', 'a', 'stray']).error, /unknown argument/);
  assert.deepEqual(parseArgs(['--help']), { ok: true, help: true });
  assert.deepEqual(parseArgs(['-h']), { ok: true, help: true });
});

test('regression (cc minor): --timeout beyond Node\'s timer range is refused, not turned into a 1 ms timer', () => {
  assert.equal(MAX_TIMER_MS, 2147483647);
  assert.equal(parseArgs(['--runbook', 'a', '--timeout', '35791']).options.timeoutMinutes, 35791); // 2,147,460,000 ms: fits
  for (const bad of ['35792', '36000', '1e9']) assert.match(parseArgs(['--runbook', 'a', '--timeout', bad]).error, /too long: at most 35791 minutes/, bad);
});

test('planJunction: present is left alone, missing without a source is reported, a source gives create', () => {
  const have = fakeTree(['pipeline']);
  const src = fakeTree(['pipeline', 'app']);
  assert.equal(planJunction(have, 'pipeline', src).action, 'present');
  assert.equal(planJunction(have, 'app', undefined).action, 'missing');
  const p = planJunction(have, 'app', src);
  assert.equal(p.action, 'create');
  assert.equal(p.target, join(src, 'app', NM));
});

test('planJunction refuses: a plain file in the way, a source without the folder, the checkout itself as the source', () => {
  const r = fakeTree([]);
  writeFileSync(join(r, 'app', NM), 'a file');
  assert.equal(planJunction(r, 'app', fakeTree(['app'])).action, 'refuse');
  const bare = fakeTree([]);
  assert.match(planJunction(bare, 'pipeline', fakeTree([])).reason, /not a folder/);
  const empty = fakeTree([]);
  assert.match(planJunction(empty, 'pipeline', empty).reason, /itself/);
});

test('createJunctions + removeJunctions: the link is made, readable, and removed without touching the target', () => {
  const src = fakeTree(['pipeline', 'app']);
  const r = fakeTree([]);
  const plans = ['pipeline', 'app'].map((d) => planJunction(r, d, src));
  const made = createJunctions(plans);
  assert.equal(made.length, 2);
  for (const m of made) { assert.ok(lstatSync(m.link).isSymbolicLink()); assert.equal(readFileSync(join(m.link, 'marker.txt'), 'utf8'), 'keep'); }
  assert.deepEqual(removeJunctions(made).map((x) => x.result), ['removed', 'removed']);
  for (const m of made) assert.equal(existsSync(m.link), false);
  assert.equal(readFileSync(join(src, 'pipeline', NM, 'marker.txt'), 'utf8'), 'keep');
  assert.equal(readFileSync(join(src, 'app', NM, 'marker.txt'), 'utf8'), 'keep');
  assert.deepEqual(removeJunctions(made).map((x) => x.result), ['already gone', 'already gone']);
});

test('removeJunctions never deletes a real folder, a file, or a link that points somewhere else', () => {
  const real = fakeTree(['pipeline']);
  const link = join(real, 'pipeline', NM);
  assert.match(removeJunctions([{ link, target: 'C:/x' }])[0].result, /NOT REMOVED: not a link/);
  assert.equal(readFileSync(join(link, 'marker.txt'), 'utf8'), 'keep');

  const a = fakeTree(['pipeline']);
  const b = fakeTree(['pipeline']);
  const r = fakeTree([]);
  const [made] = [createJunctions([planJunction(r, 'pipeline', a)])];
  assert.match(removeJunctions([{ link: made[0].link, target: join(b, 'pipeline', NM) }])[0].result, /points somewhere else/);
  assert.ok(lstatSync(made[0].link).isSymbolicLink());
  assert.equal(removeJunctions(made)[0].result, 'removed');
});

test('regression: when the second junction cannot be made, the first one is still in the caller\'s list and is removed', () => {
  const src = fakeTree(['pipeline', 'app']);
  const r = fakeTree([]);
  const plans = ['pipeline', 'app'].map((d) => planJunction(r, d, src));
  assert.deepEqual(plans.map((p) => p.action), ['create', 'create']);
  writeFileSync(plans[1].link, 'another owner'); // appears after the preflight
  const made = [];
  assert.throws(() => createJunctions(plans, made), { code: 'EEXIST' });
  assert.equal(made.length, 1);
  assert.ok(lstatSync(plans[0].link).isSymbolicLink());
  assert.deepEqual(removeJunctions(made).map((x) => x.result), ['removed']);
  assert.equal(existsSync(plans[0].link), false);
  assert.equal(readFileSync(plans[1].link, 'utf8'), 'another owner');
  assert.equal(readFileSync(join(src, 'pipeline', NM, 'marker.txt'), 'utf8'), 'keep');
});

test('regression: a replacement junction to the SAME target (made by someone else) is not removed by a stale record', () => {
  const src = fakeTree(['pipeline']);
  const r = fakeTree([]);
  const made = createJunctions([planJunction(r, 'pipeline', src)]);
  assert.ok(made[0].identity);
  assert.deepEqual(removeJunctions(made).map((x) => x.result), ['removed']);
  symlinkSync(made[0].target, made[0].link, 'junction'); // stand-in for another tool
  assert.match(removeJunctions(made)[0].result, /NOT REMOVED: not the junction this run made/);
  assert.ok(lstatSync(made[0].link).isSymbolicLink());
  assert.match(removeJunctions([{ link: made[0].link, target: made[0].target }])[0].result, /NOT REMOVED: its identity was not recorded/);
  assert.ok(lstatSync(made[0].link).isSymbolicLink());
  rmdirSync(made[0].link); // this test made the stand-in, so it removes it
  assert.equal(readFileSync(join(src, 'pipeline', NM, 'marker.txt'), 'utf8'), 'keep');
});

/** Runs main() in a throwaway repo with a fake step starter: every step "exits" with codes[i] (default 0) on the next tick;
 *  before step `signalAt` (1-based) exits, `signal` is emitted on a private emitter. Nothing real is started or signalled. */
async function fakeRun({ codes = [], signalAt = 0, signal = 'SIGINT', hangAt = 0, delays = [], extraArgs = [], deps = {}, junction = false } = {}) {
  const src = junction ? fakeTree(['pipeline', 'app']) : null;
  const r = fakeTree(junction ? [] : ['pipeline', 'app']);
  mkdirSync(join(r, 'scripts'));
  const runbook = join(r, 'runbook.md');
  writeFileSync(runbook, 'stand-in');
  const signals = new EventEmitter();
  let started = 0;
  const killed = [];
  const spawn = () => {
    const child = new EventEmitter();
    const i = ++started;
    let closed = false;
    const close = (...a) => { if (!closed) { closed = true; child.emit('close', ...a); } };
    child.kill = () => { killed.push(i); process.nextTick(() => close(null, 'SIGTERM')); return true; };
    const end = () => { if (i === signalAt) signals.emit(signal, signal); close(codes[i - 1] ?? 0, null); };
    if (i !== hangAt) { if (delays[i - 1]) setTimeout(end, delays[i - 1]); else process.nextTick(end); }
    return child; // step `hangAt` never ends by itself: only child.kill() (a timeout) ends it; delays[i-1] ms makes step i slow
  };
  const out = [];
  const args = ['--runbook', runbook, ...(junction ? ['--junction', src] : []), ...extraArgs];
  const code = await main(args, { spawn, repoRoot: r, signals, log: (s) => out.push(s), error: (s) => out.push(s), ...deps });
  return { code, started, killed, root: r, src, text: out.join('\n'), listeners: SIGNALS.map((s) => signals.listenerCount(s)) };
}
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'];

test('main: all five steps exit 0 and no interruption gives RESULT: PASS and exit 0; a failing step gives exit 1', async () => {
  const ok = await fakeRun();
  assert.equal(ok.code, 0);
  assert.equal(ok.started, 5);
  assert.match(ok.text, /RESULT: PASS \(5 rows\)/);
  assert.deepEqual(ok.listeners, [0, 0, 0, 0]);
  const bad = await fakeRun({ codes: [0, 0, 0, 0, 1] });
  assert.equal(bad.code, 1);
  assert.doesNotMatch(bad.text, /RESULT: PASS/);
});

test('regression: an interruption during the LAST step that then exits 0 is never a pass', async () => {
  for (const signal of SIGNALS) {
    const x = await fakeRun({ signalAt: 5, signal });
    assert.equal(x.code, 1, signal);
    assert.equal(x.started, 5);
    assert.doesNotMatch(x.text, /RESULT: PASS/);
    assert.match(x.text, /runbook vs code\s+INTERRUPTED/);
    assert.match(x.text, new RegExp(`interruption\\s+FAIL\\s+${signal} received during runbook vs code`));
    assert.match(x.text, /RESULT: FAIL/);
    assert.deepEqual(x.listeners, [0, 0, 0, 0]);
  }
});

test('an interruption during an earlier step skips the rest and fails', async () => {
  const x = await fakeRun({ signalAt: 2 });
  assert.equal(x.code, 1);
  assert.equal(x.started, 2);
  assert.match(x.text, /scripts tests \(TEMP with a space\)\s+INTERRUPTED/);
  assert.equal((x.text.match(/SKIPPED/g) ?? []).length, 3);
  assert.doesNotMatch(x.text, /RESULT: PASS/);
});

test('regression: when the identity of a junction cannot be read at cleanup, the junction is kept and the run FAILs (never deleted)', async () => {
  const x = await fakeRun({ junction: true, deps: { readIdentity: () => { throw Object.assign(new Error('simulated EPERM'), { code: 'EPERM' }); } } });
  const links = ['pipeline', 'app'].map((d) => join(x.root, d, NM));
  try {
    assert.equal(x.code, 1);
    assert.equal((x.text.match(/cleanup: junction\s+FAIL.*NOT REMOVED: cannot read its identity/g) ?? []).length, 2);
    assert.match(x.text, /RESULT: FAIL/);
    for (const l of links) { assert.ok(lstatSync(l).isSymbolicLink()); assert.equal(readFileSync(join(l, 'marker.txt'), 'utf8'), 'keep'); }
    const made = createJunctions([planJunction(fakeTree([]), 'pipeline', fakeTree(['pipeline']))]);
    try {
      assert.match(removeJunctions(made, () => { throw new Error('boom'); })[0].result, /NOT REMOVED: cannot read its identity/);
      assert.ok(lstatSync(made[0].link).isSymbolicLink());
    } finally { rmdirSync(made[0].link); } // this test made it
  } finally {
    for (const l of links) { try { if (lstatSync(l).isSymbolicLink()) rmdirSync(l); } catch { /* already gone */ } } // this test made them
  }
  for (const d of ['pipeline', 'app']) assert.equal(readFileSync(join(x.src, d, NM, 'marker.txt'), 'utf8'), 'keep');
});

test('progress: a START and an END line per step; --timeout stops only the hung runbook child, marks TIMEOUT and fails; no timeout by default', async () => {
  const ok = await fakeRun();
  assert.equal((ok.text.match(/\[progress\] START /g) ?? []).length, 5);
  assert.equal((ok.text.match(/\[progress\] END .* -> PASS, \d+\.\d s/g) ?? []).length, 5);
  assert.doesNotMatch(ok.text, /timeout \d/);
  const t = await fakeRun({ hangAt: 5, extraArgs: ['--timeout', '0.0005'] });
  assert.deepEqual(t.killed, [5]);
  assert.equal(t.code, 1);
  assert.match(t.text, /runbook vs code\s+TIMEOUT.*stopped after 0\.0005 min/);
  assert.match(t.text, /\[progress\] START runbook vs code \(.*timeout 0\.0005 min\)/);
  assert.match(t.text, /\[progress\] END runbook vs code -> TIMEOUT/);
  assert.doesNotMatch(t.text, /RESULT: PASS/);
  const fast = await fakeRun({ extraArgs: ['--timeout', '5'] });
  assert.deepEqual(fast.killed, []);
  assert.equal(fast.code, 0);
});

test('regression (cc P1): --timeout is never applied to a step that starts PostgreSQL; a slow one is waited for and the run says so', async () => {
  const steps = buildSteps({ options: { runbook: 'r.md', pg17Bin: 'P17' }, guard: 'file:///g.mjs', tempWithSpace: 'C:/t t' });
  assert.deepEqual(steps.map((s) => !!s.ownsPostgres), [true, true, true, true, false]); // scripts tests include PostgreSQL lifecycle tests
  // 0.0005 min = 30 ms; each of the four PostgreSQL steps takes 120 ms, four times the limit, and must still end by itself.
  const t = await fakeRun({ delays: [120, 120, 120, 120], extraArgs: ['--timeout', '0.0005'] });
  assert.deepEqual(t.killed, []);
  assert.equal(t.code, 0);
  assert.match(t.text, /RESULT: PASS \(5 rows\)/);
  assert.match(t.text, /--timeout 0\.0005 min: applied only to steps that start no PostgreSQL/);
  for (const name of ['scripts tests \\(normal TEMP\\)', 'scripts tests \\(TEMP with a space\\)', 'real-DB suites PG16', 'real-DB suites PG17']) {
    assert.match(t.text, new RegExp(`\\[progress\\] START ${name} \\(.*no timeout: this step starts PostgreSQL and must stop it itself\\)`));
    assert.match(t.text, new RegExp(`${name}\\s+PASS\\s+exit 0, .*; --timeout not applied \\(starts PostgreSQL\\)`));
  }
  assert.doesNotMatch(t.text, /TIMEOUT/);
  // a PostgreSQL step that never ends by itself is not killed either (the run waits; here the test ends it after 300 ms)
  let release;
  const hung = fakeRun({ hangAt: 3, extraArgs: ['--timeout', '0.0005'], deps: { spawn: (() => { let i = 0; return () => { const c = new EventEmitter(); const me = ++i; c.kill = () => { throw new Error(`step ${me} was killed`); }; if (me === 3) release = () => c.emit('close', 0, null); else process.nextTick(() => c.emit('close', 0, null)); return c; }; })() } });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(typeof release, 'function');
  release();
  const h = await hung;
  assert.equal(h.code, 0);
  assert.match(h.text, /real-DB suites PG16\s+PASS.*--timeout not applied/);
});

test('--help prints the usage and the PostgreSQL timeout limit; exit 0, nothing run', async () => {
  const out = [];
  let spawned = 0;
  assert.equal(await main(['--help'], { log: (s) => out.push(s), error: (s) => out.push(s), spawn: () => { spawned++; } }), 0);
  assert.equal(spawned, 0);
  assert.match(out.join('\n'), /usage: node scripts\/combine-checks\.mjs/);
  assert.match(out.join('\n'), /NOT applied to\s+steps that start PostgreSQL/);
  assert.match(out.join('\n'), /no fsmonitor/i);
});

/** A fake git for stagingCheck: answers by command; `over` replaces single answers (key = the joined args). Records the calls. */
const fakeGit = (over = {}, calls = []) => (p, a, input) => {
  const key = a.join(' ');
  calls.push(input === undefined ? key : `${key} <stdin>`);
  if (Object.hasOwn(over, key)) return over[key];
  if (key === 'rev-parse --show-toplevel') return { status: 0, out: p };
  if (key === 'rev-parse HEAD') return { status: 0, out: 'abc123' };
  if (key === 'symbolic-ref -q HEAD') return { status: 1, out: '' };
  if (key === 'ls-files -s -z') return { status: 0, out: '100644 e69d 0\ta.txt\0' };
  if (key === 'check-attr -z --stdin filter') return { status: 0, out: 'a.txt\0filter\0unspecified\0' };
  if (key.startsWith('config --get ')) return { status: 1, out: '' };
  return { status: 0, out: '' }; // status --porcelain: clean
};

test('stagingCheck: PASS only if top folder, detached and clean; reads only these git facts; failures are FAIL', () => {
  const calls = [];
  const pass = stagingCheck('S', fakeGit({}, calls));
  assert.equal(pass.result, 'PASS');
  assert.match(pass.detail, /HEAD abc123; detached; clean/);
  assert.deepEqual(calls, ['rev-parse --show-toplevel', 'rev-parse HEAD', 'symbolic-ref -q HEAD', 'ls-files -s -z', 'check-attr -z --stdin filter <stdin>', 'status --porcelain']);
  assert.match(stagingCheck('S', fakeGit({ 'symbolic-ref -q HEAD': { status: 0, out: 'refs/heads/x' } })).detail, /on branch refs\/heads\/x.*needs detached and clean/);
  const dirty = stagingCheck('S', fakeGit({ 'status --porcelain': { status: 0, out: ' M a\n?? b' } }));
  assert.equal(dirty.result, 'FAIL');
  assert.match(dirty.detail, /2 changed path/);
  for (const key of ['rev-parse --show-toplevel', 'rev-parse HEAD', 'symbolic-ref -q HEAD', 'ls-files -s -z', 'check-attr -z --stdin filter', 'status --porcelain']) {
    assert.equal(stagingCheck('S', fakeGit({ [key]: { status: 128, out: '', error: 'x' } })).result, 'FAIL', key);
  }
  assert.match(stagingCheck('S', fakeGit({ 'rev-parse --show-toplevel': { status: 0, out: 'C:/elsewhere' } })).detail, /git reads the checkout at C:\/elsewhere, not this folder/);
  // submodules and filter drivers with a configured command are refused before git status runs
  const c1 = [];
  assert.match(stagingCheck('S', fakeGit({ 'ls-files -s -z': { status: 0, out: '160000 abcd 0\tsub\0' } }, c1)).detail, /refused before git status: the folder has submodules/);
  assert.ok(!c1.includes('status --porcelain'));
  const lfs = { 'check-attr -z --stdin filter': { status: 0, out: 'a.txt\0filter\0lfs\0' } };
  const c2 = [];
  assert.match(stagingCheck('S', fakeGit({ ...lfs, 'config --get filter.lfs.clean': { status: 0, out: 'git-lfs clean -- %f' } }, c2)).detail, /filter driver "lfs" whose clean command git status could run/);
  assert.ok(!c2.includes('status --porcelain'));
  assert.match(stagingCheck('S', fakeGit({ ...lfs, 'config --get filter.lfs.process': { status: 0, out: 'git-lfs filter-process' } })).detail, /filter driver "lfs" whose process command/);
  assert.equal(stagingCheck('S', fakeGit(lfs)).result, 'PASS'); // attribute names a driver with no command: git runs nothing
  assert.equal(stagingCheck('S', fakeGit({ 'check-attr -z --stdin filter': { status: 0, out: 'a.txt\0filter\0set\0' } })).result, 'PASS');
});

/** A throwaway repo with one committed file, HEAD detached (or on its branch when attached). Returns [dir, git]. */
const throwawayRepo = (attached = false) => {
  const d = fresh();
  const git = (...a) => execFileSync('git', ['-C', d, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8', env: gitEnv(process.env) }).trim();
  git('init', '-q');
  writeFileSync(join(d, 'f.txt'), 'x');
  git('add', 'f.txt');
  git('commit', '-q', '-m', 'one');
  if (!attached) git('checkout', '-q', '--detach');
  return [d, git];
};
const indexSnapshot = (d) => { const f = join(d, '.git', 'index'); return { sha256: createHash('sha256').update(readFileSync(f)).digest('hex'), mtimeMs: lstatSync(f).mtimeMs, size: lstatSync(f).size }; };
/** A hook command (git runs it through its shell) that appends one line to `marker` when started. Quoted: TEMP may contain a space. */
const markerHook = (marker) => {
  const hook = join(fresh(), 'marker-hook.cjs'); // outside the repo, so it is not an untracked file there
  writeFileSync(hook, `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'invoked\\n');\n`);
  return `"${process.execPath.replace(/\\/g, '/')}" "${hook.replace(/\\/g, '/')}"`;
};

test('stagingCheck on a real throwaway repo (read-only: HEAD, index bytes and mtime, and files unchanged)', () => {
  const [d, git] = throwawayRepo(true);
  assert.equal(stagingCheck(d).result, 'FAIL'); // on a branch
  git('checkout', '-q', '--detach');
  writeFileSync(join(d, 'f.txt'), 'x'); // same content, newer mtime: a status that may refresh the index would want to write it
  const before = git('rev-parse', 'HEAD');
  const index = indexSnapshot(d);
  const row = stagingCheck(d);
  assert.equal(row.result, 'PASS');
  assert.ok(row.detail.includes(before));
  writeFileSync(join(d, 'g.txt'), 'new');
  assert.equal(stagingCheck(d).result, 'FAIL'); // untracked file
  assert.deepEqual(indexSnapshot(d), index);
  assert.equal(git('rev-parse', 'HEAD'), before);
  assert.equal(readFileSync(join(d, 'g.txt'), 'utf8'), 'new');
});

test('regression (cc P2): a configured fsmonitor hook is never started by stagingCheck (and every git read disables it)', () => {
  assert.deepEqual(GIT_READ_OPTIONS, ['--no-optional-locks', '-c', 'core.fsmonitor=false']);
  const [d, git] = throwawayRepo();
  const marker = join(fresh(), 'fsmonitor-marker.txt');
  git('config', 'core.fsmonitor', markerHook(marker));
  writeFileSync(join(d, 'f.txt'), 'x');
  // control: plain git status in this repo does start the hook, so the check below can see it
  git('status', '--porcelain');
  assert.equal(existsSync(marker), true, 'the harmless hook must work for this test to mean anything');
  rmSync(marker);
  const index = indexSnapshot(d);
  const row = stagingCheck(d);
  assert.equal(row.result, 'PASS');
  assert.equal(existsSync(marker), false, 'stagingCheck started the fsmonitor hook');
  assert.deepEqual(indexSnapshot(d), index);
  writeFileSync(join(d, 'g.txt'), 'new');
  assert.equal(stagingCheck(d).result, 'FAIL');
  assert.equal(existsSync(marker), false);
});

test('regression (cc P2): a filter driver with a configured command is refused before git status, and never started', () => {
  const [d, git] = throwawayRepo();
  writeFileSync(join(d, '.gitattributes'), '*.txt filter=probe\n');
  git('add', '.gitattributes');
  git('commit', '-q', '-m', 'attr');
  git('checkout', '-q', '--detach');
  const marker = join(fresh(), 'filter-marker.txt');
  git('config', 'filter.probe.clean', markerHook(marker));
  writeFileSync(join(d, 'f.txt'), 'y'); // same size, new content and mtime: git status compares content and so runs the clean filter
  git('status', '--porcelain'); // control: the filter really is started by plain git status
  assert.equal(existsSync(marker), true, 'the harmless filter must work for this test to mean anything');
  rmSync(marker);
  const row = stagingCheck(d);
  assert.equal(row.result, 'FAIL');
  assert.match(row.detail, /refused before git status: tracked files use filter driver "probe" whose clean command/);
  assert.equal(existsSync(marker), false, 'stagingCheck started the filter');
});

test('regression (cc P3): inherited GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE / ... cannot make the check describe another folder', () => {
  const [target] = throwawayRepo(true);
  writeFileSync(join(target, 'untracked.txt'), 'dirty');
  const [unrelated] = throwawayRepo(); // detached and clean: would PASS if git read it instead
  const want = /on branch refs\/heads\/\w+; 1 changed path\(s\) \(needs detached and clean\)/;
  assert.match(stagingCheck(target).detail, want);
  const vars = { GIT_DIR: join(unrelated, '.git'), GIT_WORK_TREE: unrelated, GIT_INDEX_FILE: join(unrelated, '.git', 'index'), GIT_COMMON_DIR: join(unrelated, '.git'), GIT_OBJECT_DIRECTORY: join(unrelated, '.git', 'objects'), GIT_CEILING_DIRECTORIES: tmp, GIT_CONFIG_PARAMETERS: "'core.fsmonitor'='true'" };
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  let row;
  try { Object.assign(process.env, vars); row = stagingCheck(target); }
  finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  assert.equal(row.result, 'FAIL');
  assert.match(row.detail, want);
  assert.ok(row.detail.startsWith(target));
  assert.deepEqual(gitEnv({ PATH: 'a', git_dir: 'x', GIT_WORK_TREE: 'y', GIT_INDEX_FILE: 'z', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'k', Node_Options: 'n', GITHUB_X: 'kept' }), { PATH: 'a', GITHUB_X: 'kept' });
});

test('main --staging-check adds a row that fails the run when the folder is not detached and clean', async () => {
  const good = await fakeRun({ extraArgs: ['--staging-check', 'S'], deps: { git: fakeGit() } });
  assert.equal(good.code, 0);
  assert.match(good.text, /staging check \(read-only\)\s+PASS/);
  assert.match(good.text, /RESULT: PASS \(6 rows\)/);
  const bad = await fakeRun({ extraArgs: ['--staging-check', 'S'], deps: { git: () => ({ status: 128, out: '', error: 'nope' }) } });
  assert.equal(bad.code, 1);
  assert.match(bad.text, /staging check \(read-only\)\s+FAIL/);
});

test('stepEnv drops NODE_OPTIONS (any case) and dropEnv, then adds the step env; buildSteps loads the guard as an --import file URL', () => {
  const env = stepEnv({ Node_Options: '--x', PG_BIN: 'p', PATH: 'a', TEMP: 't' }, { env: { TEMP: 'u' }, dropEnv: ['pg_bin'] });
  assert.deepEqual(env, { PATH: 'a', TEMP: 'u' });
  const steps = buildSteps({ options: { runbook: 'r.md', pg17Bin: 'P17' }, guard: 'file:///g.mjs', tempWithSpace: 'C:/t t' });
  assert.deepEqual(steps.map((s) => s.name), ['scripts tests (normal TEMP)', 'scripts tests (TEMP with a space)', 'real-DB suites PG16', 'real-DB suites PG17', 'runbook vs code']);
  for (const s of steps) assert.equal(s.args[0], '--import=file:///g.mjs');
  assert.equal(steps[3].env.PG_BIN, 'P17');
  assert.deepEqual(steps[1].env, { TEMP: 'C:/t t', TMP: 'C:/t t' });
  assert.ok(steps[0].args.includes('scripts/combine-checks.test.mjs'));
});

test('formatSummary is one aligned table', () => {
  const t = formatSummary([{ name: 'a', result: 'PASS', detail: 'ok' }, { name: 'long name', result: 'FAIL', detail: 'exit 1' }]).split('\n');
  assert.equal(t.length, 4);
  assert.match(t[2], /^a {9}\s*PASS/);
});
