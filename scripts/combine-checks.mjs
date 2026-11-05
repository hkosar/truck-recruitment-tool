#!/usr/bin/env node
// LOCAL ONLY (TRUCKRECRU-156 / 151): one command that runs the checks a combined branch needs, offline, and prints one summary table.
// It contacts no hosted or staging database, reads no secret store, installs nothing and uses no network except loopback.
//
// How to run (from the repository root):
//   node scripts/combine-checks.mjs --runbook <runbook.md> [--junction <worktree that has the node_modules>] [--pg17-bin <dir>]
//
// What it does, in order:
//   1. Preflight: reports whether pipeline/node_modules and app/node_modules exist. With --junction <worktree>, a missing one is
//      made available as a directory junction to <worktree>/pipeline/node_modules (or app/...). A junction is READ-ONLY use: nothing
//      is installed or written through it. The script removes exactly the junctions it created, at the end (also after Ctrl+C or an
//      unexpected error), and only after checking that the path is still a link to the target it made. It never deletes a real
//      folder; a node_modules that already exists is used as it is and never touched; a path that exists as a plain file is refused.
//   2. Every step below runs with scripts/net-guard.mjs loaded (--import, as a file:// URL; never put in a child's NODE_OPTIONS):
//        scripts tests, normal TEMP         node --test scripts/*.test.mjs
//        scripts tests, TEMP with a space   the same, with TEMP/TMP set to a fresh folder whose path contains a space (deleted after)
//        real-DB suites PG16                node scripts/run-real-db-suites.mjs (PG_BIN unset: the runner finds PostgreSQL 16 itself)
//        real-DB suites PG17                node scripts/run-real-db-suites.mjs with PG_BIN = --pg17-bin (default C:\Users\hunte\.bb\tools\pg17\bin)
//        runbook check                      node scripts/check-runbook-vs-code.mjs <runbook>
//      The scripts tests must not see NODE_OPTIONS (one test asserts the child environment), so it is removed from every child.
//   3. Prints a summary table. Exit code 0 only if every step passed; 1 if a step failed or was skipped/interrupted; 2 for bad usage or
//      a refused preflight (nothing was run).
// The guard stops connects to non-loopback addresses and lookups answered with one; it does not stop dns.lookup itself (see net-guard.mjs).
// It never signals or stops a process it did not start: each step is waited for (Ctrl+C reaches the step through the console; this
// script then skips the remaining steps and cleans up).
// Undo: delete this script and combine-checks.test.mjs.

import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readdirSync, readlinkSync, rmSync, rmdirSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
export const DEFAULT_PG17_BIN = 'C:\\Users\\hunte\\.bb\\tools\\pg17\\bin';
export const MODULE_DIRS = ['pipeline', 'app'];
const USAGE = 'usage: node scripts/combine-checks.mjs --runbook <runbook.md> [--junction <worktree with node_modules>] [--pg17-bin <dir>]';

/** Reads the command line. Returns { ok: true, options } or { ok: false, error }. Pure. */
export function parseArgs(argv) {
  const options = { runbook: undefined, junction: undefined, pg17Bin: DEFAULT_PG17_BIN };
  const flags = { '--runbook': 'runbook', '--junction': 'junction', '--pg17-bin': 'pg17Bin' };
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

/** Makes the junctions of a plan. Returns the list of junctions it created ({ link, target }); nothing else is touched. */
export function createJunctions(plans) {
  const made = [];
  for (const p of plans) {
    if (p.action !== 'create') continue;
    symlinkSync(p.target, p.link, 'junction');
    made.push({ link: p.link, target: p.target });
  }
  return made;
}

/**
 * Removes exactly the junctions in `made`. A path is removed only if it is still a link whose target is the one recorded; anything
 * else (a real folder, a link to somewhere else, already gone) is left alone and reported. Returns [{ link, result }].
 */
export function removeJunctions(made) {
  const out = [];
  for (const { link, target } of made) {
    let st;
    try { st = lstatSync(link); } catch { out.push({ link, result: 'already gone' }); continue; }
    if (!st.isSymbolicLink()) { out.push({ link, result: 'NOT REMOVED: not a link (left untouched)' }); continue; }
    let now;
    try { now = readlinkSync(link); } catch { out.push({ link, result: 'NOT REMOVED: cannot read the link (left untouched)' }); continue; }
    if (normPath(now) !== normPath(target)) { out.push({ link, result: 'NOT REMOVED: points somewhere else (left untouched)' }); continue; }
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

const runStep = (step, cwd) => new Promise((done) => {
  const started = Date.now();
  const env = stepEnv(process.env, step);
  const child = spawn(step.cmd, step.args, { cwd, env, stdio: 'inherit', windowsHide: true });
  child.on('error', (e) => done({ code: null, error: e.message, seconds: (Date.now() - started) / 1000 }));
  child.on('close', (code, signal) => done({ code, signal, seconds: (Date.now() - started) / 1000 }));
});

async function main(argv) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) { console.error(`${parsed.error}\n${USAGE}`); return 2; }
  const { options } = parsed;
  if (!existsSync(options.runbook)) { console.error('the runbook file does not exist'); return 2; }

  const plans = MODULE_DIRS.map((d) => planJunction(root, d, options.junction));
  for (const p of plans) console.log(`preflight: ${p.dir}/node_modules ${p.action}${p.reason ? ` (${p.reason})` : ''}${p.action === 'create' ? ` -> junction to ${p.target}` : ''}`);
  if (plans.some((p) => p.action === 'refuse')) { console.error('REFUSED: see the preflight lines above; nothing was run and nothing was created'); return 2; }
  if (plans.some((p) => p.action === 'missing')) console.log('preflight: a node_modules is missing and no --junction was given; steps that need it will fail');

  let made = [];
  let tempWithSpace;
  let aborted = false;
  const onSignal = () => { aborted = true; };
  for (const s of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(s, onSignal);
  const rows = [];
  try {
    made = createJunctions(plans);
    for (const m of made) console.log(`preflight: created junction ${m.link} -> ${m.target}`);
    tempWithSpace = mkdtempSync(join(tmpdir(), 'combine checks '));
    const guard = pathToFileURL(join(root, 'scripts', 'net-guard.mjs')).href;
    for (const step of buildSteps({ options, guard, tempWithSpace })) {
      if (aborted) { rows.push({ name: step.name, result: 'SKIPPED', detail: 'interrupted before it started' }); continue; }
      console.log(`\n===== ${step.name} =====`);
      const r = await runStep(step, root);
      const pass = r.code === 0;
      rows.push({ name: step.name, result: pass ? 'PASS' : 'FAIL', detail: `${r.error ? `could not start: ${r.error}; ` : ''}exit ${r.code ?? r.signal}, ${r.seconds.toFixed(1)} s` });
    }
  } catch (e) {
    rows.push({ name: 'combine-checks itself', result: 'FAIL', detail: String(e.stack ?? e) });
  } finally {
    if (tempWithSpace) {
      try { rmSync(tempWithSpace, { recursive: true, force: true }); } catch (e) { rows.push({ name: 'cleanup: TEMP with a space', result: 'FAIL', detail: String(e.message) }); }
      if (existsSync(tempWithSpace)) rows.push({ name: 'cleanup: TEMP with a space', result: 'FAIL', detail: `${tempWithSpace} still exists` });
    }
    for (const x of removeJunctions(made)) rows.push({ name: 'cleanup: junction', result: x.result === 'removed' ? 'PASS' : 'FAIL', detail: `${x.link}: ${x.result}` });
    for (const s of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.off(s, onSignal);
  }
  console.log(`\n${formatSummary(rows)}`);
  const bad = rows.filter((x) => x.result !== 'PASS');
  console.log(bad.length ? `\nRESULT: FAIL (${bad.length} of ${rows.length} rows not PASS)` : `\nRESULT: PASS (${rows.length} rows)`);
  return bad.length ? 1 : 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.error(e); process.exitCode = 1; });
}
