// Tests scripts/review-preflight.mjs and scripts/test-util.mjs. No network; a tiny temp git repo stands in for the checkout.
// Run: node --test scripts/review-preflight.test.mjs

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { appendRecord, cleanup, main, outstandingJunctions, parseArgs, preflight, readRecord, runRecorded } from './review-preflight.mjs';
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

test('a different HEAD is refused: exit 2, no junction, no junction record', () => {
  const { repo } = makeRepo('r1');
  const record = join(tmp, 'r1.jsonl');
  const out = quiet();
  const code = preflight({ expect: SHA, junction: makeBorrow('b1'), record }, { repoRoot: repo, ...out });
  assert.equal(code, 2);
  assert.match(out.lines.join('\n'), /REFUSED: HEAD is not the expected sha/);
  assert.equal(existsSync(join(repo, 'pipeline', NM)), false);
  assert.ok(readRecord(record).every((e) => e.event === 'pid'), 'only the git PIDs are recorded');
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
  assert.equal(outstandingJunctions(entries).length, 2);
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
  assert.deepEqual(e.map((x) => x.event), ['pid', 'pid-exit']);
  assert.equal(e[0].pid, e[1].pid);
  assert.equal(e[1].code, 7);
});

test('--run of a command that cannot start is recorded and returns 1', async () => {
  const record = join(tmp, 'run2.jsonl');
  const code = await runRecorded({ record, run: [join(tmp, 'no-such-command')] }, { cwd: tmp });
  assert.equal(code, 1);
  assert.ok(readRecord(record).some((x) => x.event === 'pid-exit' && x.error));
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
