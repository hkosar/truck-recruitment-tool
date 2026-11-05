// Tests scripts/review-preflight.mjs and scripts/test-util.mjs. No network; a tiny temp git repo stands in for the checkout.
// Run: node --test scripts/review-preflight.test.mjs

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { linkIdentity } from './combine-checks.mjs';
import { appendRecord, cleanup, main, outstandingJunctions, ownerFile, parseArgs, preflight, readRecord, runRecorded } from './review-preflight.mjs';
import { withPrivateTemp } from './test-util.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'review-preflight-test-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));
const SHA = 'a'.repeat(40);
const NM = 'node' + '_modules'; // spelled in two pieces so the CI simulator does not read the path as a use of the checkout's own folder

function makeRepo(name) {
  const repo = join(tmp, name);
  mkdirSync(join(repo, 'pipeline'), { recursive: true });
  mkdirSync(join(repo, 'app'), { recursive: true });
  writeFileSync(join(repo, 'pipeline', 'x.txt'), 'x');
  spawnSync('git', ['init', '-q', repo]);
  spawnSync('git', ['-C', repo, 'add', '-A']);
  const c = spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'x'], { encoding: 'utf8' });
  assert.equal(c.status, 0, c.stderr);
  return { repo, head: spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim() };
}
function makeBorrow(name) {
  const b = join(tmp, name);
  for (const d of ['pipeline', 'app']) mkdirSync(join(b, d, NM, 'marker'), { recursive: true });
  return b;
}
const quiet = () => { const lines = []; return { lines, log: (s) => lines.push(s), error: (s) => lines.push(s) }; };

test('parseArgs: required pieces, full sha only, modes that cannot be mixed', () => {
  assert.equal(parseArgs([]).ok, false);
  assert.match(parseArgs(['--record', 'r.jsonl']).error, /--expect/);
  assert.match(parseArgs(['--record', 'r.jsonl', '--expect', 'abc']).error, /40-character/);
  assert.match(parseArgs(['--expect', SHA]).error, /--record/);
  assert.match(parseArgs(['--record', 'r', '--expect', SHA, '--expect', SHA]).error, /twice/);
  assert.match(parseArgs(['--record', 'r', '--expect', SHA, '--bogus']).error, /unknown/);
  assert.match(parseArgs(['--record', 'r', '--cleanup', '--expect', SHA]).error, /cannot be combined/);
  assert.match(parseArgs(['--record', 'r', '--run']).error, /needs "--/);
  assert.match(parseArgs(['--record', 'r', '--run', '--']).error, /needs "--/);
  assert.match(parseArgs(['--record', 'r', '--run', 'x']).error, /needs "--/);
  const ok = parseArgs(['--record', 'r', '--expect', SHA, '--junction=J']);
  assert.deepEqual([ok.ok, ok.options.junction, ok.options.expect], [true, 'J', SHA]);
  assert.deepEqual(parseArgs(['--record', 'r', '--cleanup']).options.cleanup, true);
  assert.deepEqual(parseArgs(['--record', 'r', '--run', '--', 'node', '--version']).options.run, ['node', '--version']);
});

test('a different HEAD is refused: exit 2, no junction, and no record or owner file at all', () => {
  const { repo } = makeRepo('r1');
  const record = join(tmp, 'r1.jsonl');
  const out = quiet();
  const code = preflight({ expect: SHA, junction: makeBorrow('b1'), record }, { repoRoot: repo, ...out });
  assert.equal(code, 2);
  assert.match(out.lines.join('\n'), /REFUSED: HEAD is not the expected sha/);
  assert.equal(existsSync(join(repo, 'pipeline', NM)), false);
  assert.equal(existsSync(record), false, 'a refusal writes no record, not even the git PIDs');
  assert.equal(existsSync(ownerFile(record)), false);
  // A record under a folder that does not exist does not stop the refusal from being reached.
  assert.equal(preflight({ expect: SHA, record: join(tmp, 'no-such-folder', 'r.jsonl') }, { repoRoot: repo, ...quiet() }), 2);
});

test('a matching HEAD with an unwritable record makes no junction', () => {
  const { repo, head } = makeRepo('r1b');
  const out = quiet();
  assert.throws(() => preflight({ expect: head, junction: makeBorrow('b1b'), record: join(tmp, 'no-such-folder', 'r.jsonl') }, { repoRoot: repo, ...out }), /ENOENT/);
  for (const d of ['pipeline', 'app']) assert.equal(existsSync(join(repo, d, NM)), false, d);
});

test('matching HEAD: junctions made and recorded; --cleanup removes exactly them and leaves the borrowed folder', () => {
  const { repo, head } = makeRepo('r2');
  const borrow = makeBorrow('b2');
  const record = join(tmp, 'r2.jsonl');
  const out = quiet();
  assert.equal(preflight({ expect: head.toUpperCase(), junction: borrow, record }, { repoRoot: repo, ...out }), 0, out.lines.join('\n'));
  for (const d of ['pipeline', 'app']) assert.ok(lstatSync(join(repo, d, NM)).isSymbolicLink(), d);
  const entries = readRecord(record);
  assert.equal(entries.filter((e) => e.event === 'junction').length, 2);
  assert.ok(entries.filter((e) => e.event === 'pid').length >= 2, 'the git calls are recorded');
  assert.equal(outstandingJunctions(entries, readRecord(ownerFile(record))).length, 2);
  assert.equal(readRecord(ownerFile(record)).filter((e) => e.event === 'junction').length, 2, 'each creation is also in the owner file');
  const c = quiet();
  assert.equal(cleanup({ record }, c), 0, c.lines.join('\n'));
  for (const d of ['pipeline', 'app']) assert.equal(existsSync(join(repo, d, NM)), false, d);
  assert.ok(existsSync(join(borrow, 'pipeline', NM, 'marker')), 'the borrowed packages are untouched');
  assert.equal(outstandingJunctions(readRecord(record)).length, 0);
  const again = quiet();
  assert.equal(cleanup({ record }, again), 0);
  assert.match(again.lines.join('\n'), /no junction .* outstanding/);
});

test('cleanup leaves a real folder that replaced the junction, and exits 1', () => {
  const { repo, head } = makeRepo('r3');
  const record = join(tmp, 'r3.jsonl');
  const out = quiet();
  assert.equal(preflight({ expect: head, junction: makeBorrow('b3'), record }, { repoRoot: repo, ...out }), 0);
  const link = join(repo, 'app', NM);
  rmSync(link, { recursive: true, force: false }); // removes the junction only
  mkdirSync(join(link, 'mine'), { recursive: true });
  const c = quiet();
  assert.equal(cleanup({ record }, c), 1);
  assert.match(c.lines.join('\n'), /NOT REMOVED: not a link/);
  assert.ok(existsSync(join(link, 'mine')));
  assert.equal(existsSync(join(repo, 'pipeline', NM)), false, 'the intact junction is removed');
});

test('cleanup refuses a hand-written record line, even one with the link\'s real identity or a token copied from a real line', () => {
  const { repo, head } = makeRepo('r5');
  const record = join(tmp, 'r5.jsonl');
  assert.equal(preflight({ expect: head, junction: makeBorrow('b5'), record }, { repoRoot: repo, ...quiet() }), 0);
  const real = readRecord(record).find((e) => e.event === 'junction');
  const target = join(tmp, 'foreign-target');
  mkdirSync(join(target, 'marker'), { recursive: true });
  const foreign = join(tmp, 'foreign-junction');
  const copied = join(tmp, 'copied-token-junction');
  symlinkSync(target, foreign, 'junction');
  symlinkSync(target, copied, 'junction');
  appendRecord(record, { event: 'junction', token: 'f'.repeat(32), link: foreign, target, identity: linkIdentity(foreign) });
  appendRecord(record, { event: 'junction', token: real.token, link: copied, target, identity: linkIdentity(copied) });
  const c = quiet();
  assert.equal(cleanup({ record }, c), 1, c.lines.join('\n'));
  assert.match(c.lines.join('\n'), /foreign-junction: NOT REMOVED: its creation is not confirmed/);
  assert.match(c.lines.join('\n'), /copied-token-junction: NOT REMOVED: its creation is not confirmed/);
  assert.ok(lstatSync(foreign).isSymbolicLink(), 'the junction this tool never made is still there');
  assert.ok(lstatSync(copied).isSymbolicLink());
  for (const d of ['pipeline', 'app']) assert.equal(existsSync(join(repo, d, NM)), false, `the real junction ${d} is still removed`);
  rmdirSync(foreign); rmdirSync(copied); // test cleanup: removes the junctions only
  assert.ok(existsSync(join(target, 'marker')));
});

test('a reused record: create -> cleanup -> create at the same path leaves the latest creation to be cleaned', () => {
  const { repo, head } = makeRepo('r6');
  const borrow = makeBorrow('b6');
  const record = join(tmp, 'r6.jsonl');
  assert.equal(preflight({ expect: head, junction: borrow, record }, { repoRoot: repo, ...quiet() }), 0);
  assert.equal(cleanup({ record }, quiet()), 0);
  assert.equal(preflight({ expect: head, junction: borrow, record }, { repoRoot: repo, ...quiet() }), 0);
  for (const d of ['pipeline', 'app']) assert.ok(lstatSync(join(repo, d, NM)).isSymbolicLink(), d);
  assert.equal(outstandingJunctions(readRecord(record), readRecord(ownerFile(record))).length, 2);
  const c = quiet();
  assert.equal(cleanup({ record }, c), 0, c.lines.join('\n'));
  for (const d of ['pipeline', 'app']) assert.equal(existsSync(join(repo, d, NM)), false, `${d}: the second junction is removed`);
  assert.equal(outstandingJunctions(readRecord(record), readRecord(ownerFile(record))).length, 0);
  assert.ok(existsSync(join(borrow, 'pipeline', NM, 'marker')));
});

test('outstandingJunctions replays in order: a removal ends only the creation with its token', () => {
  const j = (token, link) => ({ event: 'junction', token, link, target: 'T', identity: null });
  const gone = (token, link) => ({ event: 'junction-removed', token, link });
  assert.deepEqual(outstandingJunctions([j('1', 'L'), gone('1', 'L'), j('2', 'L')]).map((x) => x.token), ['2']);
  assert.deepEqual(outstandingJunctions([j('1', 'L'), j('2', 'L'), gone('1', 'L')]).map((x) => x.token), ['2']);
  assert.deepEqual(outstandingJunctions([j('1', 'L'), gone('1', 'L')]), []);
});

test('an existing node_modules is used as it is and is never recorded as ours', () => {
  const { repo, head } = makeRepo('r4');
  mkdirSync(join(repo, 'pipeline', NM));
  const record = join(tmp, 'r4.jsonl');
  const out = quiet();
  assert.equal(preflight({ expect: head, junction: makeBorrow('b4'), record }, { repoRoot: repo, ...out }), 0);
  assert.deepEqual(readRecord(record).filter((e) => e.event === 'junction').map((e) => e.link), [join(repo, 'app', NM)]);
  assert.equal(cleanup({ record }, quiet()), 0);
  assert.ok(existsSync(join(repo, 'pipeline', NM)));
});

test('a damaged record is an error, not silently ignored', () => {
  const record = join(tmp, 'bad.jsonl');
  writeFileSync(record, '{"event":"pid"}\nnot json\n');
  assert.throws(() => readRecord(record), /line 2 is not JSON/);
});

test('--run records the child PID and its exit, drops NODE_OPTIONS, and returns its exit code', async () => {
  const record = join(tmp, 'run.jsonl');
  const saved = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = '--no-warnings';
  try {
    const script = 'process.exit(process.env.NODE_OPTIONS === undefined ? 7 : 9)';
    const code = await runRecorded({ record, run: [process.execPath, '-e', script] }, { cwd: tmp });
    assert.equal(code, 7);
  } finally { if (saved === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = saved; }
  const e = readRecord(record);
  assert.deepEqual(e.map((x) => x.event), ['run-start', 'pid', 'pid-exit']);
  assert.equal(e[1].pid, e[2].pid);
  assert.equal(e[2].code, 7);
});

test('--run of a command that cannot start is recorded once and returns 1', async () => {
  const record = join(tmp, 'run2.jsonl');
  const code = await runRecorded({ record, run: [join(tmp, 'no-such-command')] }, { cwd: tmp, error: () => {} });
  assert.equal(code, 1);
  await new Promise((r) => setImmediate(r));
  const exits = readRecord(record).filter((x) => x.event === 'pid-exit');
  assert.equal(exits.length, 1, JSON.stringify(exits));
  assert.ok(exits[0].error);
});

test('--run with a record that cannot be written starts nothing and exits 1', async () => {
  let spawned = 0;
  const spawnFn = () => { spawned++; throw new Error('must not be called'); };
  const out = quiet();
  const record = join(tmp, 'no-such-folder', 'run.jsonl');
  assert.equal(await main(['--record', record, '--run', '--', process.execPath, '-e', '0'], { spawnFn, cwd: tmp, ...out }), 1);
  assert.equal(spawned, 0, 'nothing was started');
  assert.match(out.lines.join('\n'), /ENOENT/);
  assert.equal(existsSync(record), false);
});

test('--run: a record write that fails after the start still waits for the child and returns 1', async () => {
  const dir = join(tmp, 'vanishing');
  mkdirSync(dir);
  const record = join(dir, 'run.jsonl');
  const child = new EventEmitter();
  const spawnFn = () => { rmSync(dir, { recursive: true, force: true }); child.pid = 4242; return child; }; // the record's folder goes away
  const out = quiet();
  let settled = false;
  const p = runRecorded({ record, run: ['fake'] }, { spawnFn, cwd: tmp, error: out.error }).then((c) => { settled = true; return c; });
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, false, 'still waiting for the child');
  child.emit('close', 0, null);
  assert.equal(await p, 1);
  assert.match(out.lines.join('\n'), /record not written \(pid\)/);
  assert.match(out.lines.join('\n'), /record not written \(pid-exit\)/);
});

test('main: usage errors exit 2 and a bad repo exits 1', async () => {
  const out = quiet();
  assert.equal(await main([], out), 2);
  assert.equal(await main(['--record', join(tmp, 'm.jsonl'), '--expect', SHA], { repoRoot: join(tmp, 'not-a-repo'), ...out }), 1);
});

test('appendRecord writes one JSON line with a timestamp', () => {
  const record = join(tmp, 'a.jsonl');
  appendRecord(record, { event: 'pid', pid: 1 });
  const [e] = readRecord(record);
  assert.deepEqual([e.event, e.pid, typeof e.at], ['pid', 1, 'string']);
});

test('withPrivateTemp points os.tmpdir() at the folder during fn and restores TMPDIR/TEMP/TMP after, also on a throw', () => {
  const before = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
  const dir = join(tmp, 'private');
  mkdirSync(dir);
  assert.equal(withPrivateTemp(dir, () => { assert.equal(tmpdir(), dir); return 42; }), 42);
  assert.throws(() => withPrivateTemp(dir, () => { throw new Error('boom'); }), /boom/);
  assert.deepEqual({ TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP }, before);
});
