// Behaviour tests for scripts/pg17-probe.mjs. The pure helpers need no database, network or child process. The lifecycle test starts
// the probe as its own child (local PostgreSQL 17 on 127.0.0.1 only; skipped if PG17 is not installed), interrupts that child only and
// checks that the server it owned is gone and its folder deleted. A preload given to this test process (--import / --require, e.g. a
// network guard) is passed on to the child as an argument, never through NODE_OPTIONS.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { DEFAULT_PG17_BIN, DIR_PREFIX, INTERRUPT_SIGNALS, PROBES, interruptExitCode, isOwnProbeDir, psqlArgs, psqlEnv } from './pg17-probe.mjs';

const base = resolve(import.meta.dirname, '..');
const probePath = join(import.meta.dirname, 'pg17-probe.mjs');
const pgBin = process.env.PG_BIN || DEFAULT_PG17_BIN;
const havePg17 = existsSync(join(pgBin, 'pg_ctl.exe')) || existsSync(join(pgBin, 'pg_ctl'));

/** The --import / --require preloads of execArgv, in order, as standalone arguments. */
function preloadArgs(execArgv) {
  const out = [];
  for (let i = 0; i < execArgv.length; i++) {
    const a = execArgv[i];
    if (/^--(import|require)=/.test(a)) out.push(a);
    else if ((a === '--import' || a === '--require' || a === '-r') && i + 1 < execArgv.length) out.push(a, execArgv[++i]);
  }
  return out;
}

/** True if something accepts a TCP connection on 127.0.0.1:port within 3 s. */
function portAccepts(port) {
  return new Promise((ok) => {
    const s = connect({ host: '127.0.0.1', port });
    const end = (v) => { s.destroy(); ok(v); };
    s.setTimeout(3000, () => end(false));
    s.once('connect', () => end(true));
    s.once('error', () => end(false));
  });
}

test('cleanup only deletes a direct child of the repository root named .pg17-probe-*', () => {
  assert.equal(isOwnProbeDir(join(base, `${DIR_PREFIX}abc123`), base), true);
  assert.equal(isOwnProbeDir(base, base), false);
  assert.equal(isOwnProbeDir(join(base, '..'), base), false);
  assert.equal(isOwnProbeDir(join(base, '..', `${DIR_PREFIX}x`), base), false);
  assert.equal(isOwnProbeDir(join(base, 'scripts'), base), false);
  assert.equal(isOwnProbeDir(join(base, `${DIR_PREFIX}x`, 'data'), base), false);
  assert.equal(isOwnProbeDir(parse(base).root, base), false);
  assert.equal(isOwnProbeDir('', base), false);
  assert.equal(isOwnProbeDir(join(base, `${DIR_PREFIX}x`), ''), false);
});

test('psql: loopback only, no psqlrc, stops on error, port is a number', () => {
  const args = psqlArgs({ port: '5433', sql: 'select 1' });
  assert.deepEqual(args.slice(args.indexOf('-h'), args.indexOf('-h') + 4), ['-h', '127.0.0.1', '-p', '5433']);
  assert.ok(args.includes('-X'));
  assert.ok(args.includes('ON_ERROR_STOP=1'));
  assert.equal(args.at(-1), 'select 1');
  assert.equal(psqlArgs({ port: 'x', sql: '' })[args.indexOf('-p') + 1], 'NaN');
});

test('psql environment: read-only default, password only from the run, base environment kept, input unchanged', () => {
  const baseEnv = { PATH: 'p' };
  const env = psqlEnv(baseEnv, 'pw');
  assert.equal(env.PGOPTIONS, '-c default_transaction_read_only=on');
  assert.equal(env.PGPASSWORD, 'pw');
  assert.equal(env.PATH, 'p');
  assert.deepEqual(baseEnv, { PATH: 'p' });
});

test('probes: the five reported topics, each one read-only statement', () => {
  const ids = PROBES.map((p) => p.id).join('\n');
  for (const want of ['server_version_num', 'pg_auth_members', 'maintain_privilege_exists', 'maintain_grants', 'transaction_timeout', 'createrole_self_grant']) assert.match(ids, new RegExp(want));
  for (const p of PROBES) {
    assert.match(p.sql.trim(), /^(select|show) /i);
    assert.doesNotMatch(p.sql, /;|\b(insert|update|delete|create|alter|drop|grant|revoke|truncate|set_config)\b/i);
  }
  const members = PROBES.find((p) => p.id.includes('pg_auth_members')).sql;
  for (const col of ['admin_option', 'inherit_option', 'set_option', 'grantor']) assert.match(members, new RegExp(col));
});

test('the default-ACL MAINTAIN count leaves out sequences (they have no MAINTAIN privilege)', () => {
  const sql = PROBES.find((p) => p.id.startsWith('maintain_default_acl_relations')).sql;
  const kinds = sql.match(/relkind in \(([^)]*)\)/)[1];
  assert.doesNotMatch(kinds, /'S'/);
  for (const k of ['r', 'p', 'm', 'v', 'f']) assert.match(kinds, new RegExp(`'${k}'`));
});

test('interruption exit codes: 128 + signal number, never 0', () => {
  assert.deepEqual(INTERRUPT_SIGNALS, ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']);
  assert.equal(interruptExitCode('SIGINT'), 130);
  assert.equal(interruptExitCode('SIGTERM'), 143);
  assert.equal(interruptExitCode('SIGHUP'), 129);
  for (const s of INTERRUPT_SIGNALS) assert.ok(interruptExitCode(s) > 0);
  assert.equal(interruptExitCode('NOT_A_SIGNAL'), 1);
});

test('preloads are passed on as arguments only', () => {
  assert.deepEqual(preloadArgs(['--require', 'g.cjs', '--test-reporter=spec', '--import=file:///C:/g.mjs', '-r', 'h.cjs']), ['--require', 'g.cjs', '--import=file:///C:/g.mjs', '-r', 'h.cjs']);
  assert.deepEqual(preloadArgs(['--test', '--import']), []);
});

test('lifecycle: SIGINT while a query runs stops the owned server, deletes its folder, exits 130 at once', { skip: havePg17 ? false : `no PostgreSQL 17 in ${pgBin}`, timeout: 240000 }, async (t) => {
  const env = { ...process.env, PG17_PROBE_TEST_HOOK: 'interrupt' };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  const child = spawn(process.execPath, [...preloadArgs(process.execArgv), probePath], { cwd: base, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  t.diagnostic(`probe child pid ${child.pid}`);
  let out = '';
  child.stdout.setEncoding('utf8').on('data', (d) => { out += d; });
  child.stderr.setEncoding('utf8').on('data', (d) => { out += d; });
  const closed = new Promise((ok) => child.once('close', (code, signal) => ok({ code, signal })));
  const started = await Promise.race([
    new Promise((ok) => child.once('message', ok)),
    closed.then(({ code }) => { throw new Error(`probe exited (code ${code}) before its cluster started:\n${out}`); }),
  ]);
  t.diagnostic(`owned postmaster pid ${started.postmasterPid}, port ${started.port}, folder ${started.dir}`);
  assert.equal(started.event, 'started');
  assert.ok(isOwnProbeDir(started.dir, base), started.dir);
  assert.ok(existsSync(join(started.dir, 'data', 'postmaster.pid')));
  assert.equal(await portAccepts(started.port), true, 'the owned server listens before the interruption');

  // Interrupt our own child only. On Windows Node cannot send a catchable signal to a child, so the child raises it on request (IPC).
  const t0 = Date.now();
  if (process.platform === 'win32') child.send({ raise: 'SIGINT' });
  else child.kill('SIGINT');
  const { code, signal } = await closed;
  const took = Date.now() - t0;
  t.diagnostic(`child exit code ${code}, signal ${signal}, ${took} ms after the interruption\n${out}`);

  assert.equal(signal, null, out);
  assert.equal(code, 130, out);
  assert.ok(took < 40000, `cleanup waited for the 60 s query instead of reacting at once (${took} ms)`);
  assert.match(out, /INTERRUPTED \(SIGINT\)/);
  assert.match(out, /CLEANUP OK: cluster stopped with pg_ctl -D <own folder>, folder deleted/);
  assert.match(out, /RESULT: FAILED \(interrupted by SIGINT\)/);
  assert.doesNotMatch(out, /RESULT: OK/);
  assert.equal(existsSync(started.dir), false, 'the owned folder is deleted');
  assert.equal(await portAccepts(started.port), false, 'the owned server no longer listens');
  if (process.platform === 'win32') {
    const list = spawnSync('tasklist', ['/FI', `PID eq ${started.postmasterPid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
    assert.equal(list.status, 0, list.stderr);
    assert.doesNotMatch(list.stdout, new RegExp(`"${started.postmasterPid}"`), `postmaster ${started.postmasterPid} still listed`);
  }
});

// ---- Exit while a setup step (initdb, pg_ctl start) still runs. A --require preload written by this test replaces only that one child
// of the probe with a harmless Node stand-in that this test owns (it launches no server, waits a few seconds, then records whether the
// probe folder still exists). Once the stand-in is running, the preload makes the probe leave: process.exit(23) or an uncaught error.
const STANDIN = `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const [dataDir, result, ms] = process.argv.slice(2);
fs.writeFileSync(result + '.ready', JSON.stringify({ pid: process.pid, dataDir }));
setTimeout(() => fs.writeFileSync(result, JSON.stringify({ pid: process.pid, dataDir, folderExistsAtEnd: fs.existsSync(path.dirname(dataDir)) })), Number(ms));
`;
const PRELOAD = `'use strict';
const cp = require('node:child_process');
const fs = require('node:fs');
const { basename } = require('node:path');
const { syncBuiltinESMExports } = require('node:module');
const cfg = JSON.parse(process.env.PG17_PROBE_TEST_STANDIN);
const original = cp.spawn;
cp.spawn = function (cmd, args, opts) {
  const name = basename(String(cmd)).toLowerCase().replace(/\\.exe$/, '');
  if (!(cfg.step === 'initdb' ? name === 'initdb' : name === 'pg_ctl' && args.includes('start'))) return original.call(this, cmd, args, opts);
  const dataDir = args[args.indexOf('-D') + 1];
  // detached: on Windows a non-detached child is ended together with the probe, which would hide what the probe left behind.
  const child = original.call(this, process.execPath, [...cfg.preloads, cfg.standin, dataDir, cfg.result, String(cfg.ms)], { ...opts, detached: true });
  console.error('TEST STAND-IN: ' + cfg.step + ' replaced by owned Node child pid ' + child.pid + '; no server is launched');
  const timer = setInterval(() => {
    if (!fs.existsSync(cfg.result + '.ready')) return;
    clearInterval(timer);
    if (cfg.mode === 'exit') process.exit(23);
    throw new Error('test: unexpected error during ' + cfg.step);
  }, 10);
  return child;
};
syncBuiltinESMExports();
`;

/** Runs the probe with the stand-in preload; returns its exit, output and the stand-in's record (after waiting for the stand-in to end). */
async function runWithStandIn(t, { step, mode }) {
  const work = mkdtempSync(join(tmpdir(), 'pg17-probe-test-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const preload = join(work, 'preload.cjs');
  const standin = join(work, 'standin.cjs');
  const result = join(work, 'result.json');
  writeFileSync(preload, PRELOAD);
  writeFileSync(standin, STANDIN);
  const cfg = { step, mode, standin, result, ms: 3000, preloads: preloadArgs(process.execArgv) };
  const env = { ...process.env, PG17_PROBE_TEST_STANDIN: JSON.stringify(cfg) };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  delete env.PG17_PROBE_TEST_HOOK;
  const child = spawn(process.execPath, [...cfg.preloads, '--require', preload, probePath], { cwd: base, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  t.diagnostic(`probe child pid ${child.pid}`);
  let out = '';
  child.stdout.setEncoding('utf8').on('data', (d) => { out += d; });
  child.stderr.setEncoding('utf8').on('data', (d) => { out += d; });
  const { code, signal } = await new Promise((ok) => child.once('close', (c, s) => ok({ code: c, signal: s })));
  const ready = existsSync(result + '.ready') ? JSON.parse(readFileSync(result + '.ready', 'utf8')) : {};
  const standinPid = ready.pid;
  const dir = ready.dataDir ? dirname(ready.dataDir) : null;
  removeLeftover(t, dir);
  for (let i = 0; i < 300 && !existsSync(result); i++) await sleep(100); // the stand-in ends on its own about 3 s after it started
  const record = existsSync(result) ? JSON.parse(readFileSync(result, 'utf8')) : null;
  t.diagnostic(`probe exit code ${code}, signal ${signal}; stand-in pid ${standinPid}; record ${JSON.stringify(record)}\n${out}`);
  return { code, signal, out, standinPid, record, dir };
}

/** Deletes a probe folder the stand-in run left behind, only if it is ours and holds no server (no postmaster.pid). */
function removeLeftover(t, dir) {
  t.after(() => {
    if (dir && isOwnProbeDir(dir, base) && existsSync(dir) && !existsSync(join(dir, 'data', 'postmaster.pid'))) rmSync(dir, { recursive: true, force: true });
  });
}

for (const step of ['initdb', 'pg_ctl start']) {
  test(`exit during ${step}: the folder is kept, the pending pid is named, exit is nonzero, never CLEANUP OK`, { skip: havePg17 ? false : `no PostgreSQL 17 in ${pgBin}`, timeout: 120000 }, async (t) => {
    const r = await runWithStandIn(t, { step, mode: 'exit' });
    assert.ok(r.record, `the stand-in did not finish:\n${r.out}`);
    assert.ok(isOwnProbeDir(r.dir, base), r.dir);
    assert.equal(r.signal, null, r.out);
    assert.equal(r.code, 23, r.out);
    assert.match(r.out, new RegExp(`TEST STAND-IN: ${step} replaced by owned Node child pid ${r.standinPid};`));
    assert.ok(r.out.includes(`CLEANUP (at exit) INCOMPLETE: setup step still running: ${step} (pid ${r.standinPid})`), r.out);
    assert.ok(r.out.includes(`Folder kept, because a server may still start in it: ${r.dir}`), r.out);
    assert.doesNotMatch(r.out, /CLEANUP (\(at exit\) )?OK/);
    assert.doesNotMatch(r.out, /RESULT: OK/);
    assert.equal(r.record.folderExistsAtEnd, true, 'the folder was deleted while the setup step still ran');
    assert.equal(existsSync(r.dir), true, 'the folder is kept after the exit');
    if (step === 'pg_ctl start') assert.equal(existsSync(join(r.dir, 'data', 'postmaster.pid')), false, 'the stand-in started no server');
  });
}

test('an uncaught error during initdb waits for initdb, then cleans up: folder deleted, exit 1', { skip: havePg17 ? false : `no PostgreSQL 17 in ${pgBin}`, timeout: 120000 }, async (t) => {
  const r = await runWithStandIn(t, { step: 'initdb', mode: 'throw' });
  assert.ok(r.record, `the stand-in did not finish:\n${r.out}`);
  assert.equal(r.signal, null, r.out);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /ERROR: unexpected error: test: unexpected error during initdb/);
  assert.match(r.out, /\nCLEANUP OK: cluster stopped with pg_ctl -D <own folder>, folder deleted/);
  assert.match(r.out, /RESULT: FAILED/);
  assert.doesNotMatch(r.out, /CLEANUP \(at exit\)/);
  assert.equal(r.record.folderExistsAtEnd, true, 'the folder was deleted while initdb still ran');
  assert.equal(existsSync(r.dir), false, 'the folder is deleted once initdb has ended');
});

// ---- Crashes, exits and signals at real setup steps. Unlike the stand-in tests above, initdb, pg_ctl start and psql run for real (local
// PostgreSQL 17, 127.0.0.1 only). A --require preload written by this test lets the real child be spawned unchanged, then acts on the probe
// itself: it throws, rejects, exits or raises signals (twice, like a repeated Ctrl+C). The probe is our own child and the only thing acted on.
const INJECT = `'use strict';
const cp = require('node:child_process');
const fs = require('node:fs');
const { basename } = require('node:path');
const { syncBuiltinESMExports } = require('node:module');
const cfg = JSON.parse(process.env.PG17_PROBE_TEST_INJECT);
const stageOf = (name, args) => (name === 'initdb' ? 'initdb' : name === 'pg_ctl' && args.includes('start') ? 'start' : name === 'psql' ? 'query' : '');
const original = cp.spawn;
let injected = false;
cp.spawn = function (cmd, args, opts) {
  const name = basename(String(cmd)).toLowerCase().replace(/\\.exe$/, '');
  if (injected || stageOf(name, args) !== cfg.step) return original.call(this, cmd, args, opts);
  injected = true;
  // The two failure cases change the real command (an invalid initdb option, a query that cannot run) and then leave the probe alone.
  if (cfg.action === 'bad-option') return original.call(this, cmd, [...args, '--test-invalid-option'], opts);
  if (cfg.action === 'bad-query') {
    const bad = [...args];
    bad[bad.indexOf('-c') + 1] = 'select pg_catalog.test_missing_function()';
    return original.call(this, cmd, bad, opts);
  }
  const child = original.call(this, cmd, args, opts);
  const act = () => {
    console.error('TEST INJECT: ' + cfg.step + ':' + cfg.action + ', owned child pid ' + child.pid);
    if (cfg.action === 'exit' || cfg.action === 'exit-signal') process.exit(0);
    else if (cfg.action === 'throw') throw new Error('test crash during ' + cfg.step);
    else if (cfg.action === 'reject') Promise.reject(new Error('test rejection during ' + cfg.step));
    else { process.emit(cfg.action, cfg.action); process.emit(cfg.action, cfg.action); }
  };
  if (cfg.after === 'close') child.once('close', () => setImmediate(act));
  else setImmediate(act);
  return child;
};
const sync = cp.spawnSync;
cp.spawnSync = function (cmd, args, opts) {
  if (cfg.action === 'exit-signal' && args.includes('stop')) {
    console.error('TEST INJECT: duplicate SIGINT events during the synchronous exit cleanup');
    process.emit('SIGINT', 'SIGINT');
    process.emit('SIGINT', 'SIGINT');
  }
  return sync.call(this, cmd, args, opts);
};
syncBuiltinESMExports();
`;

const probeFolders = () => readdirSync(base).filter((n) => n.startsWith(DIR_PREFIX));

/** Runs the probe with the injecting preload; returns exit, output, the cluster port (if one started) and the probe folders it left. */
async function runInjected(t, { step, action, after }) {
  const work = mkdtempSync(join(tmpdir(), 'pg17-probe-inject-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const preload = join(work, 'inject.cjs');
  writeFileSync(preload, INJECT);
  const env = { ...process.env, PG17_PROBE_TEST_INJECT: JSON.stringify({ step, action, after }) };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  delete env.PG17_PROBE_TEST_HOOK;
  delete env.PG17_PROBE_TEST_STANDIN;
  const before = new Set(probeFolders());
  const child = spawn(process.execPath, [...preloadArgs(process.execArgv), '--require', preload, probePath], { cwd: base, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  t.diagnostic(`probe child pid ${child.pid}`);
  let out = '';
  child.stdout.setEncoding('utf8').on('data', (d) => { out += d; });
  child.stderr.setEncoding('utf8').on('data', (d) => { out += d; });
  const { code, signal } = await new Promise((ok) => child.once('close', (c, s) => ok({ code: c, signal: s })));
  const left = probeFolders().filter((n) => !before.has(n));
  const port = /cluster: 127\.0\.0\.1:(\d+),/.exec(out)?.[1];
  t.diagnostic(`probe exit code ${code}, signal ${signal}; folders left ${JSON.stringify(left)}\n${out}`);
  return { code, signal, out, port, left };
}

const INJECT_CASES = [
  // [label, step, action, after, exit code, cleanup line, result line, cluster started]
  ['an uncaught error while pg_ctl start runs waits for it, stops the server it started, deletes the folder, exits 1', 'start', 'throw', undefined, 1, /\nCLEANUP OK: /, /RESULT: FAILED\n/, true, /ERROR: unexpected error: test crash during start/],
  ['an unhandled rejection while pg_ctl start runs waits for it, stops the server it started, deletes the folder, exits 1', 'start', 'reject', undefined, 1, /\nCLEANUP OK: /, /RESULT: FAILED\n/, true, /ERROR: unexpected error: test rejection during start/],
  ['process.exit right after pg_ctl start ended: the exit handler stops the server and deletes the folder, exit is nonzero', 'start', 'exit', 'close', 1, /CLEANUP \(at exit\) OK: cluster stopped with pg_ctl -D <own folder>, folder deleted/, null, true],
  ['SIGINT (twice) right after pg_ctl start ended: one cleanup, folder deleted, exit 130', 'start', 'SIGINT', 'close', 130, /\nCLEANUP OK: /, /RESULT: FAILED \(interrupted by SIGINT\)/, true, /SIGINT again: cleanup of this run's own cluster is already running/],
  ['SIGINT (twice) during the synchronous exit cleanup: the server is still stopped, folder deleted, exit nonzero', 'query', 'exit-signal', undefined, 1, /CLEANUP \(at exit\) OK: cluster stopped with pg_ctl -D <own folder>, folder deleted/, null, true, /SIGINT again: cleanup of this run's own cluster is already running/],
  ['SIGINT (twice) while initdb runs: folder deleted, exit 130', 'initdb', 'SIGINT', undefined, 130, /\nCLEANUP OK: /, /RESULT: FAILED \(interrupted by SIGINT\)/, false, /SIGINT again: /],
  ['SIGINT (twice) while pg_ctl start runs: the server is stopped, folder deleted, exit 130', 'start', 'SIGINT', undefined, 130, /\nCLEANUP OK: /, /RESULT: FAILED \(interrupted by SIGINT\)/, undefined, /SIGINT again: /],
  ['SIGTERM (twice) while pg_ctl start runs: the server is stopped, folder deleted, exit 143', 'start', 'SIGTERM', undefined, 143, /\nCLEANUP OK: /, /RESULT: FAILED \(interrupted by SIGTERM\)/, undefined, /SIGTERM again: /],
  ['SIGBREAK (twice) while pg_ctl start runs: the server is stopped, folder deleted, exit 149', 'start', 'SIGBREAK', undefined, 149, /\nCLEANUP OK: /, /RESULT: FAILED \(interrupted by SIGBREAK\)/, undefined, /SIGBREAK again: /],
  ['SIGHUP (twice) while pg_ctl start runs: the server is stopped, folder deleted, exit 129', 'start', 'SIGHUP', undefined, 129, /\nCLEANUP OK: /, /RESULT: FAILED \(interrupted by SIGHUP\)/, undefined, /SIGHUP again: /],
];

for (const [label, step, action, after, wantCode, cleanupLine, resultLine, clusterStarted, extra] of INJECT_CASES) {
  test(label, { skip: havePg17 ? false : `no PostgreSQL 17 in ${pgBin}`, timeout: 120000 }, async (t) => {
    const r = await runInjected(t, { step, action, after });
    assert.equal(r.signal, null, r.out);
    assert.equal(r.code, wantCode, r.out);
    assert.match(r.out, new RegExp(`TEST INJECT: ${step}:${action}, owned child pid \\d+`), r.out);
    assert.match(r.out, cleanupLine, r.out);
    if (resultLine) assert.match(r.out, resultLine, r.out);
    if (extra) assert.match(r.out, extra, r.out);
    assert.doesNotMatch(r.out, /RESULT: OK/);
    assert.doesNotMatch(r.out, /CLEANUP (\(at exit\) )?INCOMPLETE/, r.out);
    assert.deepEqual(r.left, [], 'the probe folder is deleted');
    if (clusterStarted === true) assert.ok(r.port, `the cluster should have started:\n${r.out}`);
    if (clusterStarted === false) assert.equal(r.port, undefined, 'no cluster was started');
    if (r.port) assert.equal(await portAccepts(Number(r.port)), false, 'the owned server no longer listens');
  });
}

test('a failing initdb is reported, the folder is deleted, exit 1', { skip: havePg17 ? false : `no PostgreSQL 17 in ${pgBin}`, timeout: 120000 }, async (t) => {
  const r = await runInjected(t, { step: 'initdb', action: 'bad-option' });
  assert.equal(r.signal, null, r.out);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /ERROR: initdb failed: /);
  assert.match(r.out, /\nCLEANUP OK: cluster stopped with pg_ctl -D <own folder>, folder deleted/);
  assert.match(r.out, /RESULT: FAILED\n/);
  assert.equal(r.port, undefined, 'no cluster was started');
  assert.deepEqual(r.left, [], 'the probe folder is deleted');
});

test('a failing query after the server started is reported, the later probes still run, the server is stopped, the folder deleted, exit 1', { skip: havePg17 ? false : `no PostgreSQL 17 in ${pgBin}`, timeout: 120000 }, async (t) => {
  const r = await runInjected(t, { step: 'query', action: 'bad-query' });
  assert.equal(r.signal, null, r.out);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /ERROR: probe server_version_num failed \(status 1\): .*test_missing_function/s);
  assert.match(r.out, /== createrole_self_grant/);
  assert.match(r.out, /\nCLEANUP OK: cluster stopped with pg_ctl -D <own folder>, folder deleted/);
  assert.match(r.out, /RESULT: FAILED\n/);
  assert.deepEqual(r.left, [], 'the probe folder is deleted');
  assert.ok(r.port, r.out);
  assert.equal(await portAccepts(Number(r.port)), false, 'the owned server no longer listens');
});
