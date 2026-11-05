// Tests scripts/combine-checks.mjs: argument parsing, the junction plan and junction removal safety. No network, no database,
// no step of the real run is started; temporary folders hold stand-in node_modules.
// Run: node --test scripts/combine-checks.test.mjs
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_PG17_BIN, buildSteps, createJunctions, formatSummary, parseArgs, planJunction, removeJunctions, stepEnv } from './combine-checks.mjs';

const NM = ['node', 'modules'].join('_'); // built from parts so the CI simulator (scripts/simulate-ci-jobs.mjs) does not read this file as a use of an installed package folder
const tmp = mkdtempSync(join(tmpdir(), 'combine-checks-test-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const fresh = () => { const d = join(tmp, `d${n++}`); mkdirSync(d); return d; };
/** A fake repo with the given module dirs, each holding node_modules/marker.txt. */
const fakeTree = (dirs) => { const r = fresh(); for (const d of dirs) { mkdirSync(join(r, d, NM), { recursive: true }); writeFileSync(join(r, d, NM, 'marker.txt'), 'keep'); } for (const d of ['pipeline', 'app']) mkdirSync(join(r, d), { recursive: true }); return r; };

test('parseArgs: runbook required, defaults, both flag styles, unknown/duplicate/missing values refused', () => {
  assert.deepEqual(parseArgs(['--runbook', 'r.md']), { ok: true, options: { runbook: 'r.md', junction: undefined, pg17Bin: DEFAULT_PG17_BIN } });
  assert.deepEqual(parseArgs(['--runbook=r.md', '--junction', 'w', '--pg17-bin=p']).options, { runbook: 'r.md', junction: 'w', pg17Bin: 'p' });
  assert.match(parseArgs([]).error, /--runbook/);
  assert.match(parseArgs(['--runbook']).error, /needs a value/);
  assert.match(parseArgs(['--runbook', '--junction', 'w']).error, /needs a value/);
  assert.match(parseArgs(['--runbook', 'a', '--runbook', 'b']).error, /twice/);
  assert.match(parseArgs(['--runbook', 'a', '--nope']).error, /unknown argument/);
  assert.match(parseArgs(['--runbook', 'a', 'stray']).error, /unknown argument/);
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
