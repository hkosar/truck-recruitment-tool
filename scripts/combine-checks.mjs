#!/usr/bin/env node
// LOCAL ONLY (TRUCKRECRU-156 / 151): one command that runs the checks a combined branch needs, offline, and prints one summary table.
// It contacts no hosted or staging database, reads no secret store, installs nothing and uses no network except loopback.
//
// How to run (from the repository root):
//   node scripts/combine-checks.mjs --runbook <runbook.md> [--junction <worktree that has the node_modules>] [--pg17-bin <dir>]
//                                   [--timeout <minutes>] [--staging-check <path>]
//
// What it does, in order:
//   1. Preflight: reports whether pipeline/node_modules and app/node_modules exist. With --junction <worktree>, a missing one is
//      made available as a directory junction to <worktree>/pipeline/node_modules (or app/...). A junction is READ-ONLY use: nothing
//      is installed or written through it. The script removes exactly the junctions it created, at the end (also after Ctrl+C, an
//      unexpected error, or a failure part-way through making them), and only after checking that the path is still a link to the
//      target it made AND is the same link it made (file id, volume, creation time); a replacement link is left alone. It never deletes a real
//      folder; a node_modules that already exists is used as it is and never touched; a path that exists as a plain file is refused.
//   2. Every step below runs with scripts/net-guard.mjs loaded (--import, as a file:// URL; never put in a child's NODE_OPTIONS):
//        scripts tests, normal TEMP         node --test scripts/*.test.mjs
//        scripts tests, TEMP with a space   the same, with TEMP/TMP set to a fresh folder whose path contains a space (deleted after)
//        real-DB suites PG16                node scripts/run-real-db-suites.mjs (PG_BIN unset: the runner finds PostgreSQL 16 itself)
//        real-DB suites PG17                node scripts/run-real-db-suites.mjs with PG_BIN = --pg17-bin (default C:\Users\hunte\.bb\tools\pg17\bin)
//        runbook check                      node scripts/check-runbook-vs-code.mjs <runbook>
//      The scripts tests must not see NODE_OPTIONS (one test asserts the child environment), so it is removed from every child.
//   3. Prints a summary table. Exit code 0 only if every step passed and no interruption arrived; 1 if a step failed or was
//      skipped/interrupted (an interruption during a step that then exits 0 still counts: that step is INTERRUPTED and an
//      "interruption" FAIL row is added); 2 for bad usage or a refused preflight (nothing was run).
// Progress: a line is printed when each step starts and when it ends (name, result, elapsed seconds).
// --timeout <minutes> (default none) applies to each step: when it runs out, ONLY the child this run started for that step is stopped
//   (child.kill on our own handle; a grandchild that child started is not signalled), the step is marked TIMEOUT and the run FAILs.
// --staging-check <path> adds one row that only reads three git facts of that folder (git -C <path> rev-parse HEAD, symbolic-ref -q HEAD,
//   status --porcelain; --no-optional-locks so even git's index refresh writes nothing). PASS only if HEAD is detached and the tree is clean.
// The guard stops connects to non-loopback addresses and lookups answered with one; it does not stop dns.lookup itself (see net-guard.mjs).
// It never signals or stops a process it did not start: each step is waited for (Ctrl+C reaches the step through the console; this
// script then skips the remaining steps and cleans up).
// Undo: delete this script and combine-checks.test.mjs.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readdirSync, readlinkSync, rmSync, rmdirSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
export const DEFAULT_PG17_BIN = 'C:\\Users\\hunte\\.bb\\tools\\pg17\\bin';
export const MODULE_DIRS = ['pipeline', 'app'];
const USAGE = 'usage: node scripts/combine-checks.mjs --runbook <runbook.md> [--junction <worktree with node_modules>] [--pg17-bin <dir>] [--timeout <minutes>] [--staging-check <path>]';

/** Reads the command line. Returns { ok: true, options } or { ok: false, error }. Pure. */
export function parseArgs(argv) {
  const options = { runbook: undefined, junction: undefined, pg17Bin: DEFAULT_PG17_BIN, timeoutMinutes: undefined, stagingCheck: undefined };
  const flags = { '--runbook': 'runbook', '--junction': 'junction', '--pg17-bin': 'pg17Bin', '--timeout': 'timeoutMinutes', '--staging-check': 'stagingCheck' };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const name = eq === -1 ? a : a.slice(0, eq);
    if (!Object.hasOwn(flags, name)) return { ok: false, error: `unknown argument ${a}` };
    if (seen.has(name)) return { ok: false, error: `${name} given twice` };
    seen.add(name);
    const value = eq === -1 ? argv[++i] : a.slice(eq + 1);
    if (value === undefined || value === '' || value.startsWith('--')) return { ok: false, error: `${name} needs a value` };
    options[flags[name]] = value;
  }
  if (!options.runbook) return { ok: false, error: '--runbook <path> is required' };
  if (options.timeoutMinutes !== undefined) {
    const m = Number(options.timeoutMinutes);
    if (!Number.isFinite(m) || m <= 0) return { ok: false, error: '--timeout needs a number of minutes greater than 0' };
    options.timeoutMinutes = m;
  }
  return { ok: true, options };
}

/** The same path for comparison: absolute, forward slashes, no trailing slash, lower case (Windows paths are case-insensitive). Pure. */
export function normPath(p) {
  return resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * Decides what to do for one node_modules. Reads the disk only (lstat/stat), changes nothing.
 *   present  : the path exists as a folder (real or a link): used as it is, never created, never removed.
 *   create   : it is missing and the source exists as a folder: a junction will be made.
 *   missing  : it is missing and no usable source was given (reported; the steps that need it will fail).
 *   refuse   : it exists but is not a folder, or the source is this checkout's own node_modules path.
 */
export function planJunction(repoRoot, dir, junctionRoot) {
  const link = join(repoRoot, dir, 'node_modules');
  let st = null;
  try { st = lstatSync(link); } catch { st = null; }
  if (st) {
    let isDir = false;
    try { isDir = statSync(link).isDirectory(); } catch { isDir = false; }
    return isDir ? { dir, link, action: 'present' } : { dir, link, action: 'refuse', reason: `${link} exists and is not a folder` };
  }
  if (!junctionRoot) return { dir, link, action: 'missing' };
  const target = join(resolve(junctionRoot), dir, 'node_modules');
  if (normPath(target) === normPath(link)) return { dir, link, action: 'refuse', reason: 'the junction source is this checkout itself' };
  let ok = false;
  try { ok = statSync(target).isDirectory(); } catch { ok = false; }
  return ok ? { dir, link, target, action: 'create' } : { dir, link, target, action: 'refuse', reason: `${target} is not a folder` };
}

/** The filesystem identity of the link itself (not its target): file id, volume and creation time, as exact bigint strings. */
export function linkIdentity(link) {
  const st = lstatSync(link, { bigint: true });
  return { ino: String(st.ino), dev: String(st.dev), birthtimeNs: String(st.birthtimeNs) };
}

/**
 * Makes the junctions of a plan. Each junction is added to `made` ({ link, target, identity }) the moment it exists, so a caller
 * that passes its own array can remove the ones already made even if a later one fails (the error is then rethrown).
 * Nothing else is touched. Returns `made`.
 */
export function createJunctions(plans, made = []) {
  for (const p of plans) {
    if (p.action !== 'create') continue;
    symlinkSync(p.target, p.link, 'junction');
    const rec = { link: p.link, target: p.target, identity: null };
    made.push(rec);
    rec.identity = linkIdentity(p.link); // if this fails, the record stays without identity and cleanup refuses (and reports) it
  }
  return made;
}

/**
 * Removes exactly the junctions in `made`. A path is removed only if it is still a link whose target is the one recorded AND whose
 * own identity (file id, volume, creation time) is the one recorded when this run made it, so a junction another tool put in its
 * place, even to the same target, is left alone. Anything else (a real folder, a link to somewhere else, a replacement link, no
 * recorded identity, already gone) is left alone and reported. Returns [{ link, result }].
 * `readIdentity` exists for the tests (to simulate an identity read that fails); any failure to read it keeps the link and reports it.
 * Limit: the check and the removal are two steps; a replacement made in the moment between them is not detected.
 */
export function removeJunctions(made, readIdentity = linkIdentity) {
  const out = [];
  for (const { link, target, identity } of made) {
    let st;
    try { st = lstatSync(link); } catch { out.push({ link, result: 'already gone' }); continue; }
    if (!st.isSymbolicLink()) { out.push({ link, result: 'NOT REMOVED: not a link (left untouched)' }); continue; }
    let now;
    try { now = readlinkSync(link); } catch { out.push({ link, result: 'NOT REMOVED: cannot read the link (left untouched)' }); continue; }
    if (normPath(now) !== normPath(target)) { out.push({ link, result: 'NOT REMOVED: points somewhere else (left untouched)' }); continue; }
    if (!identity) { out.push({ link, result: 'NOT REMOVED: its identity was not recorded when it was made (left untouched)' }); continue; }
    let id;
    try { id = readIdentity(link); } catch { out.push({ link, result: 'NOT REMOVED: cannot read its identity (left untouched)' }); continue; }
    if (id.ino !== identity.ino || id.dev !== identity.dev || id.birthtimeNs !== identity.birthtimeNs) {
      out.push({ link, result: 'NOT REMOVED: not the junction this run made (replaced by another link; left untouched)' });
      continue;
    }
    try {
      rmdirSync(link); // removes the junction itself; fails (and removes nothing) on a folder that has content
      out.push({ link, result: 'removed' });
    } catch (e) {
      out.push({ link, result: `NOT REMOVED: ${e.code ?? e.message}` });
    }
  }
  return out;
}

/** The steps, in order. Pure: only builds descriptions. `guard` is the file:// URL of net-guard.mjs. */
export function buildSteps({ options, guard, tempWithSpace }) {
  const node = process.execPath;
  const guarded = (...rest) => [`--import=${guard}`, ...rest];
  return [
    { name: 'scripts tests (normal TEMP)', cmd: node, args: guarded('--test', ...scriptTestFiles()), env: {} },
    { name: 'scripts tests (TEMP with a space)', cmd: node, args: guarded('--test', ...scriptTestFiles()), env: { TEMP: tempWithSpace, TMP: tempWithSpace } },
    { name: 'real-DB suites PG16', cmd: node, args: guarded('scripts/run-real-db-suites.mjs'), env: {}, dropEnv: ['PG_BIN'] },
    { name: 'real-DB suites PG17', cmd: node, args: guarded('scripts/run-real-db-suites.mjs'), env: { PG_BIN: options.pg17Bin } },
    { name: 'runbook vs code', cmd: node, args: guarded('scripts/check-runbook-vs-code.mjs', options.runbook), env: {} },
  ];
}

/** scripts/*.test.mjs, sorted, as paths relative to the repository root (the shell is not used, so no glob is expanded for us). */
export function scriptTestFiles(dir = join(root, 'scripts')) {
  return readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => `scripts/${f}`);
}

/** The environment of one step: the parent environment, NODE_OPTIONS removed, dropEnv removed, env added. Pure. */
export function stepEnv(parent, step) {
  const out = {};
  for (const [k, v] of Object.entries(parent)) {
    if (v === undefined) continue;
    const up = k.toUpperCase();
    if (up === 'NODE_OPTIONS' || (step.dropEnv ?? []).some((d) => d.toUpperCase() === up)) continue;
    out[k] = v;
  }
  return { ...out, ...step.env };
}

/** One summary table (plain text). rows: [{ name, result, detail }]. Pure. */
export function formatSummary(rows) {
  const w = Math.max(4, ...rows.map((r) => r.name.length));
  const r = Math.max(6, ...rows.map((x) => x.result.length));
  const line = (a, b, c) => `${a.padEnd(w)}  ${b.padEnd(r)}  ${c}`;
  return [line('STEP', 'RESULT', 'DETAIL'), line('-'.repeat(w), '-'.repeat(r), '-'.repeat(6)), ...rows.map((x) => line(x.name, x.result, x.detail ?? ''))].join('\n');
}

const runStep = (spawnFn, step, cwd, timeoutMs) => new Promise((done) => {
  const started = Date.now();
  const env = stepEnv(process.env, step);
  const child = spawnFn(step.cmd, step.args, { cwd, env, stdio: 'inherit', windowsHide: true });
  let timedOut = false;
  const timer = timeoutMs ? setTimeout(() => { timedOut = true; try { child.kill(); } catch { /* already gone */ } }, timeoutMs) : null; // our own child handle only
  const finish = (r) => { if (timer) clearTimeout(timer); done({ ...r, timedOut, seconds: (Date.now() - started) / 1000 }); };
  child.on('error', (e) => finish({ code: null, error: e.message }));
  child.on('close', (code, signal) => finish({ code, signal }));
});

const STAGING_ROW = 'staging check (read-only)';

/** Runs `git --no-optional-locks -C <path> <args>`; returns { status, out, error }. Read-only commands only (see stagingCheck). */
const gitRead = (path, args) => {
  const env = stepEnv(process.env, {});
  try { return { status: 0, out: execFileSync('git', ['--no-optional-locks', '-C', path, ...args], { env, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim() }; }
  catch (e) { return { status: e.status ?? null, out: String(e.stdout ?? '').trim(), error: String(e.stderr || e.message).trim() }; }
};

/**
 * The --staging-check row: reads three facts from the folder with git and writes nothing. PASS only if HEAD is detached and the
 * tree is clean. `git` is injectable for the tests: (path, args) => { status, out, error }.
 */
export function stagingCheck(path, git = gitRead) {
  const fail = (what, r) => ({ name: STAGING_ROW, result: 'FAIL', detail: `cannot read ${what} of ${path}: ${r.error ?? `git exit ${r.status}`}` });
  const head = git(path, ['rev-parse', 'HEAD']);
  if (head.status !== 0) return fail('HEAD', head);
  const sym = git(path, ['symbolic-ref', '-q', 'HEAD']); // exit 1 and no output when HEAD is detached
  const detached = sym.status === 1 && sym.out === '';
  if (!detached && sym.status !== 0) return fail('the branch state', sym);
  const st = git(path, ['status', '--porcelain']);
  if (st.status !== 0) return fail('the status', st);
  const changed = st.out === '' ? 0 : st.out.split('\n').length;
  const detail = `${path}: HEAD ${head.out}; ${detached ? 'detached' : `on branch ${sym.out}`}; ${changed ? `${changed} changed path(s)` : 'clean'}`;
  const pass = detached && !changed;
  return { name: STAGING_ROW, result: pass ? 'PASS' : 'FAIL', detail: pass ? detail : `${detail} (needs detached and clean)` };
}

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'];

/**
 * The whole run; returns the exit code. `deps` exists for the tests only: spawn (the step starter), repoRoot, signals (the emitter
 * whose SIGINT/SIGTERM/SIGBREAK/SIGHUP events mean "interrupted"), log/error (output), readIdentity (the identity read used when removing junctions), git (the staging-check reader).
 * Any interruption seen from the start of the run until the result line is printed makes the result FAIL (exit 1), even if the
 * step that was running when it arrived exits 0.
 */
export async function main(argv, deps = {}) {
  const { spawn: spawnFn = spawn, repoRoot = root, signals = process, log = console.log, error = console.error, readIdentity = linkIdentity, git = gitRead } = deps;
  const parsed = parseArgs(argv);
  if (!parsed.ok) { error(`${parsed.error}\n${USAGE}`); return 2; }
  const { options } = parsed;
  if (!existsSync(options.runbook)) { error('the runbook file does not exist'); return 2; }

  const plans = MODULE_DIRS.map((d) => planJunction(repoRoot, d, options.junction));
  for (const p of plans) log(`preflight: ${p.dir}/node_modules ${p.action}${p.reason ? ` (${p.reason})` : ''}${p.action === 'create' ? ` -> junction to ${p.target}` : ''}`);
  if (plans.some((p) => p.action === 'refuse')) { error('REFUSED: see the preflight lines above; nothing was run and nothing was created'); return 2; }
  if (plans.some((p) => p.action === 'missing')) log('preflight: a node_modules is missing and no --junction was given; steps that need it will fail');

  const made = []; // filled by createJunctions one junction at a time, so the finally below also removes a partial set
  let tempWithSpace;
  let aborted = null; // the first signal seen, and the step that was running then
  let current = 'setup';
  const onSignal = (s) => { if (!aborted) aborted = { signal: typeof s === 'string' ? s : 'signal', during: current }; };
  for (const s of SIGNALS) signals.on(s, onSignal);
  const rows = [];
  let code;
  try {
    try {
      createJunctions(plans, made);
      for (const m of made) log(`preflight: created junction ${m.link} -> ${m.target}`);
      tempWithSpace = mkdtempSync(join(tmpdir(), 'combine checks '));
      const guard = pathToFileURL(join(repoRoot, 'scripts', 'net-guard.mjs')).href;
      const runStarted = Date.now();
      const elapsed = () => `${((Date.now() - runStarted) / 1000).toFixed(1)} s into the run`;
      const timeoutMs = options.timeoutMinutes ? options.timeoutMinutes * 60000 : undefined;
      for (const step of buildSteps({ options, guard, tempWithSpace })) {
        if (aborted) { rows.push({ name: step.name, result: 'SKIPPED', detail: 'interrupted before it started' }); continue; }
        log(`\n===== ${step.name} =====`);
        log(`[progress] START ${step.name} (${elapsed()}${timeoutMs ? `, timeout ${options.timeoutMinutes} min` : ''})`);
        current = step.name;
        const r = await runStep(spawnFn, step, repoRoot, timeoutMs);
        const interrupted = aborted && aborted.during === step.name;
        const result = interrupted ? 'INTERRUPTED' : r.timedOut ? 'TIMEOUT' : r.code === 0 ? 'PASS' : 'FAIL';
        rows.push({ name: step.name, result, detail: `${r.error ? `could not start: ${r.error}; ` : ''}exit ${r.code ?? r.signal}, ${r.seconds.toFixed(1)} s${r.timedOut ? `; stopped after ${options.timeoutMinutes} min (timeout)` : ''}${interrupted ? `; ${aborted.signal} arrived while it ran` : ''}` });
        log(`[progress] END ${step.name} -> ${result}, ${r.seconds.toFixed(1)} s (${elapsed()})`);
      }
      if (options.stagingCheck) {
        log('\n[progress] START staging check (read-only)');
        const row = stagingCheck(options.stagingCheck, git);
        rows.push(row);
        log(`[progress] END staging check (read-only) -> ${row.result}`);
      }
    } catch (e) {
      rows.push({ name: 'combine-checks itself', result: 'FAIL', detail: String(e.stack ?? e) });
    } finally {
      current = 'cleanup';
      if (tempWithSpace) {
        try { rmSync(tempWithSpace, { recursive: true, force: true }); } catch (e) { rows.push({ name: 'cleanup: TEMP with a space', result: 'FAIL', detail: String(e.message) }); }
        if (existsSync(tempWithSpace)) rows.push({ name: 'cleanup: TEMP with a space', result: 'FAIL', detail: `${tempWithSpace} still exists` });
      }
      for (const x of removeJunctions(made, readIdentity)) rows.push({ name: 'cleanup: junction', result: x.result === 'removed' ? 'PASS' : 'FAIL', detail: `${x.link}: ${x.result}` });
    }
    current = 'summary';
    if (aborted) rows.push({ name: 'interruption', result: 'FAIL', detail: `${aborted.signal} received during ${aborted.during}; the run is not a pass` });
    log(`\n${formatSummary(rows)}`);
    const bad = rows.filter((x) => x.result !== 'PASS');
    code = bad.length ? 1 : 0;
    log(code ? `\nRESULT: FAIL (${bad.length} of ${rows.length} rows not PASS)` : `\nRESULT: PASS (${rows.length} rows)`);
  } finally {
    for (const s of SIGNALS) signals.off(s, onSignal); // only after the result line, so no interruption can slip in unseen before it
  }
  return code;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.error(e); process.exitCode = 1; });
}
