#!/usr/bin/env node
// LOCAL ONLY (TRUCKRECRU-144): starts a throwaway PostgreSQL 17 cluster on 127.0.0.1 from the portable install, runs read-only probe
// queries against it, stops it with pg_ctl -D <its own folder> and deletes the folder. It reports what hosted staging-2 (PostgreSQL 17)
// behaviour depends on: server_version_num, every pg_auth_members row (admin/inherit/set options, grantor), whether the MAINTAIN
// privilege exists and on which relations it is explicitly granted (to anyone other than the owner: listed; the owner's own entries:
// counted), every default ACL (pg_default_acl), every per-role/per-database setting (pg_db_role_setting), transaction_timeout and
// createrole_self_grant (quoted, so the empty default shows as '').
// It contacts no hosted or staging database, reads no secret store, installs nothing and needs no node_modules (it uses psql).
//
// --apply-m1 (TRUCKRECRU-149): on the same kind of throwaway cluster (bootstrap superuser tr_test_admin, the login
// a3-build-test-db.mjs uses; the folder also holds that tool's A3_TASK_OWNED token), it builds one baseline database tr_probe_m1 the
// way run-real-db-suites.mjs builds the m1-supabase-runner ones (a3-build-test-db.mjs --no-m1 --no-m1b --no-m1c, PostGIS in public),
// runs every probe there (BEFORE), applies M1 the way that suite's case 2 does (pipeline/src/pg17-probe-apply-m1.ts: the shared
// NOSUPERUSER CREATEROLE runner setup, then the staging runner's real apply-m1 plan and executor logged in as that runner; no SQL file
// is changed), runs every probe again (AFTER) and prints, per probe, the rows only BEFORE (-) and only AFTER (+). The probes stay
// read-only; the build and M1 write only into this run's own cluster. Needs app/node_modules (pg) and pipeline/node_modules (pg, tsx);
// the build and M1 children get this process's --import/--require preloads (e.g. the network guard) as arguments, never NODE_OPTIONS.
//   node --import=file:///C:/.../scripts/net-guard.mjs scripts/pg17-probe.mjs --apply-m1
//
// How to run (from the repository root):
//   node --import ./scripts/net-guard.mjs scripts/pg17-probe.mjs                 (Windows: --import=file:///C:/.../scripts/net-guard.mjs)
//   PG_BIN="<PostgreSQL 17 folder>\bin" node scripts/pg17-probe.mjs              (default bin: C:\Users\hunte\.bb\tools\pg17\bin)
// Only a pg_ctl reporting major 17 is accepted (the version gate of run-real-db-suites.mjs). The cluster folder is
// <repository root>/.pg17-probe-<random>; nothing outside it is written. Every query runs with default_transaction_read_only=on.
// Exit code 0 only if every step succeeded and cleanup is complete; any error is printed and the exit code is 1 (2 = refused before start).
// Interruption (Ctrl+C = SIGINT, SIGTERM, Ctrl+Break = SIGBREAK, closing the window = SIGHUP): the run stops only its own cluster with
// pg_ctl -D <its own folder>, deletes the folder and exits with 128 + the signal number (130 for Ctrl+C). Every child process started
// after the folder exists runs asynchronously, so a signal is handled at once instead of after the child ends. An unexpected error takes
// the same cleanup path (exit 1). A process 'exit' handler is the last resort for any other way out; if initdb or pg_ctl start is still
// running then, it keeps the folder, names it and the pending process id, and exits nonzero. Nothing can clean up after SIGKILL /
// Task Manager "End task": delete .pg17-probe-* by hand after stopping it with pg_ctl -D <folder>\data stop.
// Undo: delete this script and pg17-probe.test.mjs (and, for --apply-m1, pipeline/src/pg17-probe-apply-m1.ts).

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
/** --apply-m1: the bootstrap superuser a3-build-test-db.mjs connects as, and the baseline database M1 is applied to. */
export const A3_ADMIN_USER = 'tr_test_admin';
export const M1_DB = 'tr_probe_m1';
const TSX_LOADER = join(root, 'pipeline', 'node_modules', 'tsx', 'dist', 'loader.mjs');
const APPLY_M1_HELPER = join(root, 'pipeline', 'src', 'pg17-probe-apply-m1.ts');
const BUILD_DB = join(root, 'scripts', 'a3-build-test-db.mjs');

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
  {
    id: 'default_acls (pg_default_acl)',
    sql: `select pg_catalog.pg_get_userbyid(d.defaclrole) as role, coalesce(n.nspname, '(every schema)') as schema, d.defaclobjtype as objtype, d.defaclacl::text as acl
from pg_catalog.pg_default_acl d
left join pg_catalog.pg_namespace n on n.oid = d.defaclnamespace
order by 1, 2, 3`,
  },
  {
    id: 'role_settings (pg_db_role_setting)',
    sql: `select coalesce(r.rolname, '(every role)') as role, coalesce(db.datname, '(every database)') as database, s.setconfig::text as settings
from pg_catalog.pg_db_role_setting s
left join pg_catalog.pg_roles r on r.oid = s.setrole
left join pg_catalog.pg_database db on db.oid = s.setdatabase
order by 1, 2`,
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
export function psqlArgs({ port, sql, user = ADMIN_USER, database = 'postgres' }) {
  return ['-X', '-q', '-w', '-h', '127.0.0.1', '-p', String(Number(port)), '-U', user, '-d', database, '-v', 'ON_ERROR_STOP=1',
    '-A', '-F', ' | ', '-P', 'footer=off', '-P', 'null=NULL', '-c', sql];
}

/** The command line options: none, or --apply-m1. Anything else is an error (the run refuses before it starts). Pure. */
export function parseProbeArgs(argv) {
  const unknown = argv.filter((a) => a !== '--apply-m1');
  return unknown.length ? { error: `unknown option(s): ${unknown.join(' ')} (the only option is --apply-m1)` } : { applyM1: argv.includes('--apply-m1') };
}

/** The --import / --require preloads of execArgv (e.g. the network guard), in order, as standalone arguments for a node child. Pure. */
export function preloadArgs(execArgv) {
  const out = [];
  for (let i = 0; i < execArgv.length; i++) {
    const a = execArgv[i];
    if (/^--(import|require)=/.test(a)) out.push(a);
    else if ((a === '--import' || a === '--require' || a === '-r') && i + 1 < execArgv.length) out.push(a, execArgv[++i]);
  }
  return out;
}

/** The header and data rows of one probe's psql output (unaligned, header first, no footer); blank lines dropped. Pure. */
export function probeRows(text) {
  const lines = String(text ?? '').split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
  return { header: lines[0] ?? '', rows: lines.slice(1) };
}

/** Per probe id (in the order of ids): the rows only in before (removed) and only in after (added), counted as multisets so a
 *  duplicated row is not lost; a probe missing on either side is not comparable. Pure. */
export function diffProbes(before, after, ids = PROBES.map((p) => p.id)) {
  return ids.map((id) => {
    if (!before.has(id) || !after.has(id)) return { id, comparable: false, removed: [], added: [] };
    const b = probeRows(before.get(id));
    const a = probeRows(after.get(id));
    const minus = (xs, ys) => {
      const left = new Map();
      for (const y of ys) left.set(y, (left.get(y) ?? 0) + 1);
      return xs.filter((x) => { const n = left.get(x) ?? 0; if (n > 0) { left.set(x, n - 1); return false; } return true; });
    };
    return { id, comparable: true, headerBefore: b.header, headerAfter: a.header, removed: minus(b.rows, a.rows), added: minus(a.rows, b.rows) };
  });
}

/** The printed lines of a diffProbes result. Pure. */
export function formatDiff(diff) {
  const out = [];
  for (const d of diff) {
    out.push(`\n== diff ${d.id}`);
    if (!d.comparable) { out.push('  NOT COMPARABLE: the probe failed before or after M1'); continue; }
    if (d.headerBefore !== d.headerAfter) out.push(`  header before: ${d.headerBefore}`, `  header after:  ${d.headerAfter}`);
    else out.push(`  (${d.headerBefore})`);
    if (!d.removed.length && !d.added.length) out.push('  no change');
    for (const r of d.removed) out.push(`  - ${r}`);
    for (const r of d.added) out.push(`  + ${r}`);
  }
  return out;
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
 *  { status, signal, stdout, stderr, error }. capture false: stdio ignored (pg_ctl start: the server would inherit the pipes).
 *  onStart(pid) runs right after the spawn and onEnd() once the child has ended, both synchronously (an 'exit' handler can rely on them). */
function runAsync(cmd, args, { env, cwd, timeout = 0, capture = true, onStart, onEnd }) {
  return new Promise((resolveRun) => {
    let ended = false;
    const done = (r) => { if (ended) return; ended = true; onEnd?.(); resolveRun(r); };
    let child;
    try {
      child = spawn(cmd, args, { env, cwd, windowsHide: true, timeout, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'ignore' });
    } catch (error) {
      done({ status: null, signal: null, stdout: '', stderr: '', error });
      return;
    }
    onStart?.(child.pid);
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
  const runnerPw = randomBytes(24).toString('base64url').replace(/[^A-Za-z0-9]/g, 'x'); // --apply-m1: the runner login's throwaway password
  const mask = (text) => maskSecrets(String(text ?? ''), [password, runnerPw]);
  let failed = false;
  const fail = (msg) => { failed = true; console.error(`ERROR: ${mask(msg)}`); };

  const opts = parseProbeArgs(process.argv.slice(2));
  if (opts.error) {
    console.error(`REFUSED: ${opts.error}`);
    return 2;
  }
  const { applyM1 } = opts;
  const adminUser = applyM1 ? A3_ADMIN_USER : ADMIN_USER;
  if (applyM1) {
    const missing = [join(root, 'app', 'node_modules', 'pg'), join(root, 'pipeline', 'node_modules', 'pg'), TSX_LOADER].filter((p) => !existsSync(p));
    if (missing.length) {
      console.error(`REFUSED: --apply-m1 needs the installed packages; missing: ${missing.join(', ')}`);
      return 2;
    }
  }

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
  const pendingSetup = new Map(); // the same setup children by step name -> pid, kept up to date synchronously for the 'exit' handler
  const queryChildren = new Set(); // psql: they end once the server is stopped
  const stopArgs = () => ['-D', dataDir, 'stop', '-m', 'fast', '-w'];

  /** Starts one child unless cleanup has begun; after that nothing new may start. step names a setup child (tracked in pendingSetup). */
  const launch = (set, cmd, args, opts = {}, step = null) => {
    if (cleaning) throw new Error('cleanup has begun: no new step is started');
    const track = step ? { onStart: (pid) => pendingSetup.set(step, pid ?? '?'), onEnd: () => pendingSetup.delete(step) } : {};
    if (step) pendingSetup.set(step, '?');
    const p = runAsync(cmd, args, { env: baseEnv, ...opts, ...track });
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

  /** Last resort when the process exits before cleanup finished (only synchronous work is possible in an 'exit' handler). While initdb or
   *  pg_ctl start still runs, nothing proves that no server will appear in the folder (pg_ctl start may not have written postmaster.pid
   *  yet), so the folder is kept and the exit code is nonzero. */
  function cleanupOnExit() {
    if (cleanedUp || !dir) return;
    if (!process.exitCode) process.exitCode = 1; // exiting before cleanup finished is never a success
    if (pendingSetup.size) {
      const steps = [...pendingSetup].map(([step, pid]) => `${step} (pid ${pid})`).join(', ');
      console.error(`CLEANUP (at exit) INCOMPLETE: setup step still running: ${steps}. Folder kept, because a server may still start in it: ${dir}`);
      console.error(`  Once that process has ended: pg_ctl -D "${dataDir}" stop, then delete the folder.`);
      return;
    }
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
  }

  /** Prints the cleanup line and the result once, and fixes the exit code. */
  function finish(problems) {
    if (exitCode !== null) return exitCode;
    for (const s of INTERRUPT_SIGNALS) process.off(s, onSignal);
    process.off('uncaughtException', onFatal);
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

  /** An unexpected error (also an unhandled rejection) goes through the same cleanup as a signal instead of exiting while setup runs. */
  function onFatal(e) {
    fail(`unexpected error: ${e?.message ?? e}`);
    if (cleaning) return; // cleanup is already running; whoever started it exits afterwards
    cleanup().then((problems) => process.exit(finish(problems)));
  }

  for (const s of INTERRUPT_SIGNALS) process.on(s, onSignal);
  process.on('uncaughtException', onFatal);
  process.on('exit', cleanupOnExit);

  try {
    dir = mkdtempSync(join(root, DIR_PREFIX));
    dataDir = join(dir, 'data');
    const pwFile = join(dir, 'pw.txt');
    writeFileSync(pwFile, password);
    if (applyM1) writeFileSync(join(dir, 'A3_TASK_OWNED'), randomBytes(24).toString('base64url')); // a3-build-test-db.mjs's ownership token
    const init = await launch(setupChildren, exe(pgBin, 'initdb'), ['-D', dataDir, '-U', adminUser, '-A', 'scram-sha-256', `--pwfile=${pwFile}`, '-E', 'UTF8'], {}, 'initdb');
    rmSync(pwFile, { force: true });
    stopIfInterrupted();
    if (init.error || init.status !== 0) throw new Error('initdb failed: ' + `${init.error ?? ''}${init.stdout ?? ''}${init.stderr ?? ''}`.split('\n').slice(-6).join(' | '));
    let port = await freePort();
    while (port === 5432 || port === 6543) port = await freePort();
    stopIfInterrupted();
    const logFile = join(dir, 'server.log');
    startTried = true;
    const start = await launch(setupChildren, pgCtl, ['-D', dataDir, '-l', logFile, '-o', `-p ${port} -c listen_addresses=127.0.0.1`, '-w', 'start'], { capture: false }, 'pg_ctl start');
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

    /** Runs every probe (read-only) on one database and prints it; returns probe id -> raw output for the probes that succeeded. */
    const probeAll = async (database) => {
      const outputs = new Map();
      for (const p of PROBES) {
        const r = await launch(queryChildren, psqlBin, psqlArgs({ port, sql: p.sql, user: adminUser, database }), { env: psqlEnv(baseEnv, password), timeout: 60000 });
        stopIfInterrupted();
        console.log(`\n== ${p.id}`);
        if (r.error || r.status !== 0 || r.signal) {
          fail(`probe ${p.id} failed (status ${r.status}${r.signal ? `, signal ${r.signal}` : ''}): ${`${r.error ?? ''}${r.stderr ?? ''}${r.stdout ?? ''}`.trim()}`);
          continue;
        }
        process.stdout.write(mask(r.stdout));
        if (r.stderr && r.stderr.trim()) fail(`probe ${p.id} wrote to stderr: ${r.stderr.trim()}`);
        else outputs.set(p.id, r.stdout);
      }
      return outputs;
    };

    if (!applyM1) await probeAll('postgres');
    else {
      // The build and M1 children are node processes; they get this process's preloads (the network guard) as arguments.
      const preloads = preloadArgs(process.execArgv);
      const tail = (r, n) => mask(`${r.error ?? ''}${r.stdout ?? ''}${r.stderr ?? ''}`).split('\n').map((l) => l.trim()).filter(Boolean).slice(-n).join(' | ');
      console.log(`\n#### building baseline database ${M1_DB} (scripts/a3-build-test-db.mjs --no-m1 --no-m1b --no-m1c, PostGIS in public)`);
      const build = await launch(queryChildren, process.execPath, [...preloads, BUILD_DB, '--owner-dir', dir, '--port', String(port), '--db', M1_DB, '--no-m1', '--no-m1b', '--no-m1c'],
        { env: { ...baseEnv, A3_PGPASSWORD: password }, timeout: 600000 });
      stopIfInterrupted();
      if (build.error || build.status !== 0 || build.signal) throw new Error(`building ${M1_DB} failed (status ${build.status}${build.signal ? `, signal ${build.signal}` : ''}): ${tail(build, 8)}`);
      console.log(`built ${M1_DB} (a3-build-test-db.mjs exit 0)`);

      console.log(`\n#### BEFORE M1 (database ${M1_DB}, as ${adminUser})`);
      const before = await probeAll(M1_DB);

      console.log(`\n#### applying M1 as a NOSUPERUSER CREATEROLE runner (pipeline/src/pg17-probe-apply-m1.ts: real apply-m1 plan and executor)`);
      const adminUrl = `postgresql://${adminUser}:${encodeURIComponent(password)}@127.0.0.1:${port}/${M1_DB}`;
      const apply = await launch(queryChildren, process.execPath, [...preloads, '--import', pathToFileURL(TSX_LOADER).href, APPLY_M1_HELPER],
        { env: { ...baseEnv, PG17_PROBE_ADMIN_URL: adminUrl, PG17_PROBE_RUNNER_PW: runnerPw }, timeout: 600000 });
      stopIfInterrupted();
      process.stdout.write(mask(apply.stdout));
      if (apply.stderr && apply.stderr.trim()) console.error(mask(apply.stderr.trimEnd()));
      if (apply.error || apply.status !== 0 || apply.signal) fail(`the M1 step failed (status ${apply.status}${apply.signal ? `, signal ${apply.signal}` : ''})${apply.error ? `: ${apply.error}` : ''}`);

      console.log(`\n#### AFTER M1 (database ${M1_DB}, as ${adminUser})`);
      const after = await probeAll(M1_DB);

      console.log('\n#### DIFF (- only before M1, + only after M1)');
      const diff = diffProbes(before, after);
      for (const line of formatDiff(diff)) console.log(mask(line));
      if (diff.some((d) => !d.comparable)) fail('at least one probe could not be compared (see NOT COMPARABLE above)');
    }
  } catch (e) {
    if (!interrupted) fail(e?.message ?? String(e));
  }
  return finish(await cleanup());
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run().then((code) => { process.exitCode = code; }, (e) => { console.error(`ERROR: ${e?.message ?? e}`); process.exitCode = 1; });
}
