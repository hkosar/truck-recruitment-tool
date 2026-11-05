#!/usr/bin/env node
// LOCAL ONLY (TRUCKRECRU-144): starts a throwaway PostgreSQL 17 cluster on 127.0.0.1 from the portable install, runs read-only probe
// queries against it, stops it with pg_ctl -D <its own folder> and deletes the folder. It reports what hosted staging-2 (PostgreSQL 17)
// behaviour depends on: server_version_num, every pg_auth_members row (admin/inherit/set options, grantor), whether the MAINTAIN
// privilege exists and on which relations it is explicitly granted (to anyone other than the owner: listed; the owner's own entries:
// counted), transaction_timeout and createrole_self_grant (quoted, so the empty default shows as '').
// It contacts no hosted or staging database, reads no secret store, installs nothing and needs no node_modules (it uses psql).
//
// How to run (from the repository root):
//   node --import ./scripts/net-guard.mjs scripts/pg17-probe.mjs                 (Windows: --import=file:///C:/.../scripts/net-guard.mjs)
//   PG_BIN="<PostgreSQL 17 folder>\bin" node scripts/pg17-probe.mjs              (default bin: C:\Users\hunte\.bb\tools\pg17\bin)
// Only a pg_ctl reporting major 17 is accepted (the version gate of run-real-db-suites.mjs). The cluster folder is
// <repository root>/.pg17-probe-<random>; nothing outside it is written. Every query runs with default_transaction_read_only=on.
// Exit code 0 only if every step succeeded and cleanup is complete; any error is printed and the exit code is 1 (2 = refused before start).
// Interruption (Ctrl+C = SIGINT, SIGTERM, Ctrl+Break = SIGBREAK, closing the window = SIGHUP): the run stops only its own cluster with
// pg_ctl -D <its own folder>, deletes the folder and exits with 128 + the signal number (130 for Ctrl+C). Every child process started
// after the folder exists runs asynchronously, so a signal is handled at once instead of after the child ends. A process 'exit' handler
// is the last resort for any other way out. Nothing can clean up after SIGKILL / Task Manager "End task": delete .pg17-probe-* by hand
// after stopping it with pg_ctl -D <folder>\data stop.
// Undo: delete this script and pg17-probe.test.mjs.

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { constants } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeSh, maskSecrets, nonLoopbackConnectionVars, scrubbedEnv, supportedPgMajor } from './run-real-db-suites.mjs';

const root = resolve(import.meta.dirname, '..');
export const DEFAULT_PG17_BIN = 'C:\\Users\\hunte\\.bb\\tools\\pg17\\bin';
export const DIR_PREFIX = '.pg17-probe-';
const ADMIN_USER = 'tr_probe_admin';

/** The probes, in output order. Each is one read-only statement; psql prints its rows unaligned with a header line. */
export const PROBES = [
  { id: 'server_version_num', sql: 'show server_version_num' },
  {
    id: 'role_membership (pg_auth_members)',
    sql: `select r.rolname as role, m.rolname as member, g.rolname as grantor, am.admin_option, am.inherit_option, am.set_option
from pg_catalog.pg_auth_members am
join pg_catalog.pg_roles r on r.oid = am.roleid
join pg_catalog.pg_roles m on m.oid = am.member
left join pg_catalog.pg_roles g on g.oid = am.grantor
order by 1, 2, 3`,
  },
  {
    id: 'maintain_privilege_exists',
    sql: `select exists (select 1 from pg_catalog.pg_roles where rolname = 'pg_maintain') as pg_maintain_role_exists,
  pg_catalog.has_table_privilege(current_user, 'pg_catalog.pg_class', 'MAINTAIN') as maintain_privilege_accepted`,
  },
  {
    id: 'maintain_grants (explicit relacl entries to a grantee other than the relation owner)',
    sql: `select n.nspname as schema, c.relname as relation, c.relkind, coalesce(gr.rolname, 'PUBLIC') as grantee, gt.rolname as grantor, a.is_grantable
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
cross join lateral pg_catalog.aclexplode(c.relacl) a
left join pg_catalog.pg_roles gr on gr.oid = a.grantee
left join pg_catalog.pg_roles gt on gt.oid = a.grantor
where a.privilege_type = 'MAINTAIN' and a.grantee <> c.relowner
order by 1, 2, 4`,
  },
  {
    id: 'maintain_owner_entries (explicit relacl entries where the owner holds its own MAINTAIN)',
    sql: `select count(*) as relations, count(distinct c.relnamespace) as schemas
from pg_catalog.pg_class c
cross join lateral pg_catalog.aclexplode(c.relacl) a
where a.privilege_type = 'MAINTAIN' and a.grantee = c.relowner`,
  },
  {
    id: 'maintain_default_acl_relations (relacl null: owner holds MAINTAIN by default; sequences have no MAINTAIN and are not counted)',
    sql: `select count(*) as relations_with_default_acl from pg_catalog.pg_class where relacl is null and relkind in ('r', 'p', 'm', 'v', 'f')`,
  },
  { id: 'transaction_timeout', sql: 'show transaction_timeout' },
  { id: 'createrole_self_grant', sql: `select pg_catalog.quote_literal(pg_catalog.current_setting('createrole_self_grant')) as createrole_self_grant_quoted` },
];

/** True only if dir is a direct child of base whose name starts with DIR_PREFIX. A drive root, base itself, a parent, a sibling or a
 *  relative-escape path is refused. Pure. */
export function isOwnProbeDir(dir, base) {
  if (!dir || !base) return false;
  const rel = relative(resolve(base), resolve(dir));
  if (rel === '' || isAbsolute(rel) || rel.split(/[\\/]/).length !== 1 || rel === '..') return false;
  return rel.startsWith(DIR_PREFIX) && basename(resolve(dir)) === rel;
}

/** The psql arguments of one probe: loopback host, no psqlrc, stop on the first error, unaligned output with headers. Pure. */
export function psqlArgs({ port, sql }) {
  return ['-X', '-q', '-w', '-h', '127.0.0.1', '-p', String(Number(port)), '-U', ADMIN_USER, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1',
    '-A', '-F', ' | ', '-P', 'footer=off', '-P', 'null=NULL', '-c', sql];
}

/** The child environment of psql: the scrubbed allow-list plus the throwaway password and a read-only default. Pure. */
export function psqlEnv(baseEnv, password) {
  return { ...baseEnv, PGPASSWORD: password, PGOPTIONS: '-c default_transaction_read_only=on', PGCONNECT_TIMEOUT: '15' };
}

const exe = (bin, name) => (existsSync(join(bin, name + '.exe')) ? join(bin, name + '.exe') : join(bin, name));

/** The signals that mean "the user interrupted the run" (SIGBREAK = Ctrl+Break and SIGHUP = console window closed, on Windows). */
export const INTERRUPT_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'];

/** Exit code after an interruption by sig: 128 + its number (SIGINT 130, SIGTERM 143); 1 if the number is unknown. Never 0. Pure. */
export function interruptExitCode(sig) {
  const n = constants.signals[sig];
  return Number.isInteger(n) && n > 0 ? 128 + n : 1;
}

/** Runs one child without blocking the event loop, so a signal handler runs while the child works. Never rejects; resolves with
 *  { status, signal, stdout, stderr, error }. capture false: stdio ignored (pg_ctl start: the server would inherit the pipes). */
function runAsync(cmd, args, { env, timeout = 0, capture = true }) {
  return new Promise((done) => {
    let child;
    try {
      child = spawn(cmd, args, { env, windowsHide: true, timeout, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'ignore' });
    } catch (error) {
      done({ status: null, signal: null, stdout: '', stderr: '', error });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8').on('data', (d) => { stdout += d; });
    child.stderr?.setEncoding('utf8').on('data', (d) => { stderr += d; });
    child.once('error', (error) => done({ status: null, signal: null, stdout, stderr, error }));
    child.once('close', (status, signal) => done({ status, signal, stdout, stderr }));
  });
}

function freePort() {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
}

async function run() {
  const pgBin = process.env.PG_BIN || DEFAULT_PG17_BIN;
  const baseEnv = scrubbedEnv(process.env);
  const sh = makeSh(baseEnv);
  const password = randomBytes(24).toString('base64url').replace(/[^A-Za-z0-9]/g, 'x');
  const mask = (text) => maskSecrets(String(text ?? ''), [password]);
  let failed = false;
  const fail = (msg) => { failed = true; console.error(`ERROR: ${mask(msg)}`); };

  const bad = nonLoopbackConnectionVars(process.env);
  if (bad.length) {
    console.error(`REFUSED: these environment variables point somewhere other than loopback (values not shown): ${bad.join(', ')}. Unset them and run again.`);
    return 2;
  }
  if (!existsSync(exe(pgBin, 'initdb')) || !existsSync(exe(pgBin, 'pg_ctl')) || !existsSync(exe(pgBin, 'psql'))) {
    console.error(`REFUSED: initdb, pg_ctl or psql not found in ${pgBin}. Set PG_BIN to a PostgreSQL 17 bin folder.`);
    return 2;
  }
  const ver = sh(exe(pgBin, 'pg_ctl'), ['--version']);
  if (supportedPgMajor(ver) !== 17) {
    console.error(`REFUSED: ${pgBin} is not PostgreSQL 17 (pg_ctl --version: ${String(ver.stdout ?? '').trim().slice(0, 80) || 'no output'}).`);
    return 2;
  }
  console.log(`PostgreSQL major 17 (bin folder ${pgBin})`);

  // ---- From here on this run owns a folder (and later a server). Every child below runs asynchronously, so a signal is handled at once.
  const pgCtl = exe(pgBin, 'pg_ctl');
  const psqlBin = exe(pgBin, 'psql');
  const testHook = process.env.PG17_PROBE_TEST_HOOK === 'interrupt' && typeof process.send === 'function';
  let dir;
  let dataDir;
  let startTried = false; // from then on, cleanup tries pg_ctl stop on our own folder
  let interrupted = null; // the name of the first interrupting signal
  let cleaning = null; // the one cleanup promise: cleanup runs once however often it is asked for
  let cleanedUp = false;
  let exitCode = null; // fixed by the first finish()
  const setupChildren = new Set(); // initdb, pg_ctl start: cleanup waits for them, so it never deletes under a server that is starting
  const queryChildren = new Set(); // psql: they end once the server is stopped
  const stopArgs = () => ['-D', dataDir, 'stop', '-m', 'fast', '-w'];

  /** Starts one child unless cleanup has begun; after that nothing new may start. */
  const launch = (set, cmd, args, opts = {}) => {
    if (cleaning) throw new Error('cleanup has begun: no new step is started');
    const p = runAsync(cmd, args, { env: baseEnv, ...opts });
    set.add(p);
    p.then(() => set.delete(p));
    return p;
  };
  const stopIfInterrupted = () => { if (interrupted) throw new Error(`interrupted by ${interrupted}`); };

  /** Stops this run's own server (pg_ctl -D <own data folder>) and deletes its own folder. Idempotent; resolves with the problems. */
  function cleanup() {
    cleaning ??= (async () => {
      await Promise.all([...setupChildren]);
      const problems = [];
      let stopped = true;
      if (startTried && existsSync(join(dataDir, 'postmaster.pid'))) {
        const stop = await runAsync(pgCtl, stopArgs(), { env: baseEnv, capture: false });
        if (stop.error || stop.status !== 0) {
          // pg_ctl status exits 3 when no server runs on this folder (a stale postmaster.pid): then the folder is safe to delete.
          const st = await runAsync(pgCtl, ['-D', dataDir, 'status'], { env: baseEnv, capture: false });
          if (st.status !== 3) {
            stopped = false;
            problems.push(`pg_ctl stop did not report success (status ${stop.status})`);
          }
        }
      }
      await Promise.all([...queryChildren]);
      if (dir) {
        if (!isOwnProbeDir(dir, root)) problems.push('refused to delete a folder this run did not create');
        else if (stopped) {
          try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { problems.push('could not delete the cluster folder'); }
          if (existsSync(dir)) problems.push(`cluster folder still exists: ${dir}`);
        } else problems.push(`cluster folder kept because the server may still be running: ${dir}`);
      }
      cleanedUp = true;
      return problems;
    })();
    return cleaning;
  }

  /** Last resort when the process exits before cleanup finished (only synchronous work is possible in an 'exit' handler). */
  function cleanupOnExit() {
    if (cleanedUp || !dir) return;
    let stopped = true;
    if (startTried && existsSync(join(dataDir, 'postmaster.pid'))) {
      const stop = spawnSync(pgCtl, stopArgs(), { env: baseEnv, stdio: 'ignore', windowsHide: true });
      stopped = stop.status === 0 || spawnSync(pgCtl, ['-D', dataDir, 'status'], { env: baseEnv, stdio: 'ignore', windowsHide: true }).status === 3;
    }
    if (stopped && isOwnProbeDir(dir, root)) {
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* reported below */ }
    }
    const ok = stopped && !existsSync(dir);
    console.error(ok ? 'CLEANUP (at exit) OK: cluster stopped with pg_ctl -D <own folder>, folder deleted' : `CLEANUP (at exit) INCOMPLETE: ${dir}`);
    if (!process.exitCode) process.exitCode = 1; // exiting before cleanup finished is never a success
  }

  /** Prints the cleanup line and the result once, and fixes the exit code. */
  function finish(problems) {
    if (exitCode !== null) return exitCode;
    for (const s of INTERRUPT_SIGNALS) process.off(s, onSignal);
    process.off('exit', cleanupOnExit);
    if (testHook && process.connected) process.disconnect();
    console.log(problems.length ? `\nCLEANUP INCOMPLETE: ${problems.join('; ')}` : '\nCLEANUP OK: cluster stopped with pg_ctl -D <own folder>, folder deleted');
    if (problems.length) failed = true;
    console.log(interrupted ? `RESULT: FAILED (interrupted by ${interrupted})` : failed ? 'RESULT: FAILED' : 'RESULT: OK');
    exitCode = interrupted ? interruptExitCode(interrupted) : failed ? 1 : 0;
    return exitCode;
  }

  function onSignal(sig) {
    if (interrupted) {
      console.error(`${sig} again: cleanup of this run's own cluster is already running, please wait`);
      return;
    }
    interrupted = sig;
    console.error(`\nINTERRUPTED (${sig}): stopping this run's own cluster with pg_ctl -D <own folder> and deleting its folder`);
    cleanup().then((problems) => process.exit(finish(problems)));
  }

  for (const s of INTERRUPT_SIGNALS) process.on(s, onSignal);
  process.on('exit', cleanupOnExit);

  try {
    dir = mkdtempSync(join(root, DIR_PREFIX));
    dataDir = join(dir, 'data');
    const pwFile = join(dir, 'pw.txt');
    writeFileSync(pwFile, password);
    const init = await launch(setupChildren, exe(pgBin, 'initdb'), ['-D', dataDir, '-U', ADMIN_USER, '-A', 'scram-sha-256', `--pwfile=${pwFile}`, '-E', 'UTF8']);
    rmSync(pwFile, { force: true });
    stopIfInterrupted();
    if (init.error || init.status !== 0) throw new Error('initdb failed: ' + `${init.error ?? ''}${init.stdout ?? ''}${init.stderr ?? ''}`.split('\n').slice(-6).join(' | '));
    let port = await freePort();
    while (port === 5432 || port === 6543) port = await freePort();
    stopIfInterrupted();
    const logFile = join(dir, 'server.log');
    startTried = true;
    const start = await launch(setupChildren, pgCtl, ['-D', dataDir, '-l', logFile, '-o', `-p ${port} -c listen_addresses=127.0.0.1`, '-w', 'start'], { capture: false });
    stopIfInterrupted();
    if (start.error || start.status !== 0) {
      let tail = '';
      try { tail = readFileSync(logFile, 'utf8').split('\n').filter(Boolean).slice(-4).join(' | '); } catch { /* no log */ }
      throw new Error(`pg_ctl start failed (status ${start.status}): ${tail}`);
    }
    let pid = '?';
    try { pid = readFileSync(join(dataDir, 'postmaster.pid'), 'utf8').split('\n')[0]; } catch { /* reported as ? */ }
    console.log(`cluster: 127.0.0.1:${port}, postmaster pid ${pid}, folder ${dataDir}`);

    // Test hook (scripts/pg17-probe.test.mjs only; needs an IPC channel): one slow read-only query starts, then the parent is told the
    // cluster is up and interrupts this process while that query still runs. On Windows Node cannot deliver a catchable signal to a
    // child, so the parent asks over IPC and the signal is raised here through the same listeners.
    if (testHook) {
      process.on('message', (m) => { if (INTERRUPT_SIGNALS.includes(m?.raise)) process.emit(m.raise, m.raise); });
      const slow = launch(queryChildren, psqlBin, psqlArgs({ port, sql: 'select pg_catalog.pg_sleep(60)' }), { env: psqlEnv(baseEnv, password), timeout: 90000 });
      process.send({ event: 'started', port, postmasterPid: pid, dir });
      await slow;
      stopIfInterrupted();
    }

    for (const p of PROBES) {
      const r = await launch(queryChildren, psqlBin, psqlArgs({ port, sql: p.sql }), { env: psqlEnv(baseEnv, password), timeout: 60000 });
      stopIfInterrupted();
      console.log(`\n== ${p.id}`);
      if (r.error || r.status !== 0 || r.signal) {
        fail(`probe ${p.id} failed (status ${r.status}${r.signal ? `, signal ${r.signal}` : ''}): ${`${r.error ?? ''}${r.stderr ?? ''}${r.stdout ?? ''}`.trim()}`);
        continue;
      }
      process.stdout.write(mask(r.stdout));
      if (r.stderr && r.stderr.trim()) fail(`probe ${p.id} wrote to stderr: ${r.stderr.trim()}`);
    }
  } catch (e) {
    if (!interrupted) fail(e?.message ?? String(e));
  }
  return finish(await cleanup());
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run().then((code) => { process.exitCode = code; }, (e) => { console.error(`ERROR: ${e?.message ?? e}`); process.exitCode = 1; });
}
