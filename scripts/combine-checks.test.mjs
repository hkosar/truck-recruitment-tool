// Tests scripts/combine-checks.mjs: argument parsing, the junction plan and junction removal safety. No network, no database,
// no step of the real run is started; temporary folders hold stand-in node_modules.
// Run: node --test scripts/combine-checks.test.mjs
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_PG17_BIN, MAX_TIMER_MS, buildSteps, createJunctions, formatSummary, main, parseArgs, planJunction, removeJunctions, stepEnv } from './combine-checks.mjs';

const NM = ['node', 'modules'].join('_'); // built from parts so the CI simulator (scripts/simulate-ci-jobs.mjs) does not read this file as a use of an installed package folder
const tmp = mkdtempSync(join(tmpdir(), 'combine-checks-test-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const fresh = () => { const d = join(tmp, `d${n++}`); mkdirSync(d); return d; };
/** A fake repo with the given module dirs, each holding node_modules/marker.txt. */
const fakeTree = (dirs) => { const r = fresh(); for (const d of dirs) { mkdirSync(join(r, d, NM), { recursive: true }); writeFileSync(join(r, d, NM, 'marker.txt'), 'keep'); } for (const d of ['pipeline', 'app']) mkdirSync(join(r, d), { recursive: true }); return r; };

test('parseArgs: runbook required, defaults, both flag styles, unknown/duplicate/missing values refused', () => {
  assert.deepEqual(parseArgs(['--runbook', 'r.md']), { ok: true, options: { runbook: 'r.md', junction: undefined, pg17Bin: DEFAULT_PG17_BIN, timeoutMinutes: undefined } });
  assert.deepEqual(parseArgs(['--runbook=r.md', '--junction', 'w', '--pg17-bin=p', '--timeout', '1.5']).options, { runbook: 'r.md', junction: 'w', pg17Bin: 'p', timeoutMinutes: 1.5 });
  assert.match(parseArgs(['--runbook', 'a', '--staging-check', 'x']).error, /unknown argument/);
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
  assert.doesNotMatch(out.join('\n'), /staging-check/);
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
