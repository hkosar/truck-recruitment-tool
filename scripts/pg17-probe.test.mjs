// Behaviour tests for scripts/pg17-probe.mjs. The pure helpers need no database, network or child process. The lifecycle test starts
// the probe as its own child (local PostgreSQL 17 on 127.0.0.1 only; skipped if PG17 is not installed), interrupts that child only and
// checks that the server it owned is gone and its folder deleted. A preload given to this test process (--import / --require, e.g. a
// network guard) is passed on to the child as an argument, never through NODE_OPTIONS.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import { join, parse, resolve } from 'node:path';
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
