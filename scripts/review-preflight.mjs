#!/usr/bin/env node
// LOCAL ONLY (TRUCKRECRU-158 / 163): the start-of-task and end-of-task check for a builder or reviewer. No network, installs nothing.
//
// Offline guard (163): scripts/net-guard.mjs is the reusable loopback-only guard: it blocks every connect to a non-loopback address and
// every lookup answered with one. Load it first, as a file:// URL on Windows, and keep it OUT of NODE_OPTIONS wherever a test checks the
// child environment:
//   node --import=file:///C:/path/to/repo/scripts/net-guard.mjs <script> [args]
// What it covers: a preload guards only the Node process it is loaded into. It has no hook that passes itself on to processes that
// process starts, and native children (git, bash, postgres) are never guarded by it. In particular:
//   - scripts/simulate-ci-jobs.mjs removes NODE_OPTIONS and runs each workflow step through bash with the plain node on PATH, so the
//     node commands of a simulated step are NOT guarded even when the simulator itself is. They need their own --import, or an offline
//     boundary enforced outside Node.
//   - scripts/combine-checks.mjs passes --import to each node step it starts itself; processes those steps start are covered only if
//     they load the guard themselves.
//   - --run below removes NODE_OPTIONS; pass --import=<guard url> to a node command yourself.
// Other limits: see the top of net-guard.mjs (dns.lookup called directly and UDP are not covered).
//
// Usage (from the repository root):
//   node scripts/review-preflight.mjs --expect <40-char sha> --record <file.jsonl> [--junction <worktree with node_modules>]
//       Prints the branch and HEAD next to the expected SHA and exits 2 if HEAD is different or a junction cannot be planned. A refusal
//       writes nothing at all (no record, no owner file, no junction). If it matches, the git PIDs are written first (this proves the
//       record is writable before anything is made), then a missing pipeline/ or app/ node_modules is made available as a directory
//       junction (the helpers of combine-checks.mjs: READ-ONLY use, a node_modules that exists is never touched).
//       Every junction made is written, with its file identity and a fresh random token, to the record AND to <record>.owner.
//   node scripts/review-preflight.mjs --cleanup --record <file.jsonl>
//       Removes the junctions this tool made and has not yet removed, then notes each removal in the record. Events are replayed in
//       order, so create -> remove -> create at one path leaves the latest creation to be removed.
//       Exact guarantee: a junction is removed only if (a) its creation line, with the same token, link, target and identity, is in both
//       the record and <record>.owner; (b) the token is a 128-bit random value, so a line written by hand or copied from another link
//       cannot match; (c) the path is still a link to the recorded target with the recorded file identity (see removeJunctions in
//       combine-checks.mjs, which also notes its check-then-remove race). Not defended: someone who deliberately edits BOTH files the same
//       way; anyone able to do that can remove the junction directly anyway.
//   node scripts/review-preflight.mjs --record <file.jsonl> --run -- <command> [args...]
//       Writes a run-start line first and refuses (exit 1, nothing started) if the record cannot be written. Then starts the command
//       (NODE_OPTIONS removed, output passed through), appends its PID when it starts and its exit when it ends, and exits with the
//       command's code (1 if a record line could not be written after the start; the child is still waited for). It never signals any process.
// The record is JSON lines: {"event":"pid"|"run-start"|"pid-exit"|"junction"|"junction-removed", ...}. It holds paths, PIDs and random
// tokens only, no secrets.
// Undo: delete this script and review-preflight.test.mjs.

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MODULE_DIRS, createJunctions, normPath, planJunction, removeJunctions } from './combine-checks.mjs';

const root = resolve(import.meta.dirname, '..');
const USAGE = 'usage: node scripts/review-preflight.mjs --expect <sha> --record <file.jsonl> [--junction <worktree>] | --cleanup --record <file.jsonl> | --record <file.jsonl> --run -- <command> [args...]';
const SHA = /^[0-9a-f]{40}$/i;

/** Reads the command line. { ok: true, options } or { ok: false, error }. Pure. */
export function parseArgs(argv) {
  const options = { expect: undefined, junction: undefined, record: undefined, cleanup: false, run: undefined };
  const valued = { '--expect': 'expect', '--junction': 'junction', '--record': 'record' };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') return { ok: false, error: '-- is only allowed after --run' };
    const eq = a.indexOf('=');
    const name = eq === -1 ? a : a.slice(0, eq);
    if (name === '--run' && eq === -1) {
      if (argv[i + 1] !== '--' || i + 2 >= argv.length) return { ok: false, error: '--run needs "-- <command> [args...]"' };
      options.run = argv.slice(i + 2);
      break;
    }
    if (name === '--cleanup' && eq === -1) { if (seen.has(name)) return { ok: false, error: '--cleanup given twice' }; seen.add(name); options.cleanup = true; continue; }
    if (!Object.hasOwn(valued, name)) return { ok: false, error: `unknown argument ${a}` };
    if (seen.has(name)) return { ok: false, error: `${name} given twice` };
    seen.add(name);
    const value = eq === -1 ? argv[++i] : a.slice(eq + 1);
    if (value === undefined || value === '' || value.startsWith('--')) return { ok: false, error: `${name} needs a value` };
    options[valued[name]] = value;
  }
  if (!options.record) return { ok: false, error: '--record <file.jsonl> is required' };
  if (options.run && (options.cleanup || options.expect || options.junction)) return { ok: false, error: '--run cannot be combined with --cleanup, --expect or --junction' };
  if (options.cleanup && (options.expect || options.junction)) return { ok: false, error: '--cleanup cannot be combined with --expect or --junction' };
  if (!options.run && !options.cleanup) {
    if (!options.expect) return { ok: false, error: '--expect <sha> is required' };
    if (!SHA.test(options.expect)) return { ok: false, error: '--expect must be the full 40-character sha' };
  }
  return { ok: true, options };
}

/** The owner file that sits next to a record: it repeats each junction creation line (see the header for why). */
export function ownerFile(record) {
  return `${record}.owner`;
}

/** Appends one JSON line to the record. */
export function appendRecord(file, entry) {
  appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

/** Reads the record back; a line that is not JSON is an error (a damaged record must not be trusted). */
export function readRecord(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l, i) => {
    try { return JSON.parse(l); } catch { throw new Error(`${file} line ${i + 1} is not JSON`); }
  });
}

const sameCreation = (a, b) => a.token === b.token && a.link === b.link && a.target === b.target && JSON.stringify(a.identity ?? null) === JSON.stringify(b.identity ?? null);

/**
 * The junctions this tool made and has not removed yet, in the shape removeJunctions takes (plus the token). Pure.
 * Replays `entries` in order: a creation replaces any earlier one at the same path; a removal ends the creation with the same token.
 * When `owned` (the owner file's lines) is given, a creation counts only if an identical line (token, link, target, identity) is in it
 * and its token is a 32-hex-digit value; a creation without that is returned in `refused` instead (it is never removed).
 */
export function outstandingJunctions(entries, owned) {
  const open = new Map();
  for (const e of entries) {
    if (e.event === 'junction') open.set(normPath(e.link), e);
    else if (e.event === 'junction-removed') {
      const key = normPath(e.link);
      if (open.get(key)?.token === e.token) open.delete(key);
    }
  }
  const all = [...open.values()].map(({ link, target, identity, token }) => ({ link, target, identity, token }));
  if (owned === undefined) return all;
  const ok = (j) => typeof j.token === 'string' && /^[0-9a-f]{32}$/.test(j.token) && owned.some((o) => o.event === 'junction' && sameCreation(o, j));
  const result = all.filter(ok);
  result.refused = all.filter((j) => !ok(j));
  return result;
}

function gitOut(repoRoot, pids, args) {
  const r = spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' });
  if (r.pid) pids.push({ event: 'pid', pid: r.pid, label: `git ${args[0]}` });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || r.error?.message || '').trim()}`);
  return r.stdout.trim();
}

/** Check HEAD, then make the junctions. Returns the exit code (0 ok, 2 refused). A refusal or a git failure writes nothing. */
export function preflight(options, { repoRoot = root, log = console.log, error = console.error } = {}) {
  const pids = []; // written only once HEAD matches and the plan is accepted
  const head = gitOut(repoRoot, pids, ['rev-parse', 'HEAD']);
  const branch = gitOut(repoRoot, pids, ['rev-parse', '--abbrev-ref', 'HEAD']);
  log(`branch:   ${branch}\nHEAD:     ${head}\nexpected: ${options.expect}`);
  if (head.toLowerCase() !== options.expect.toLowerCase()) { error('REFUSED: HEAD is not the expected sha; nothing was created or written'); return 2; }
  log('HEAD matches the expected sha');
  const plans = MODULE_DIRS.map((d) => planJunction(repoRoot, d, options.junction));
  for (const p of plans) log(`preflight: ${p.dir}/node_modules ${p.action}${p.reason ? ` (${p.reason})` : ''}${p.action === 'create' ? ` -> junction to ${p.target}` : ''}`);
  if (plans.some((p) => p.action === 'refuse')) { error('REFUSED: see the preflight lines above; nothing was created or written'); return 2; }
  if (plans.some((p) => p.action === 'missing')) log('preflight: a node_modules is missing and no --junction was given; steps that need it will fail');
  for (const p of pids) appendRecord(options.record, p); // throws (nothing made) if the record cannot be written
  if (!plans.some((p) => p.action === 'create')) return 0;
  appendFileSync(ownerFile(options.record), ''); // proves the owner file is writable before any junction is made
  const made = [];
  try { createJunctions(plans, made); } finally {
    for (const m of made) {
      const line = { event: 'junction', token: randomBytes(16).toString('hex'), link: m.link, target: m.target, identity: m.identity };
      appendRecord(ownerFile(options.record), line);
      appendRecord(options.record, line);
      log(`preflight: created junction ${m.link} -> ${m.target}`);
    }
  }
  return 0;
}

/** Removes the junctions this tool made (see the header for the exact guarantee). Returns 0 if each was removed or already gone, else 1. */
export function cleanup(options, { log = console.log } = {}) {
  const todo = outstandingJunctions(readRecord(options.record), readRecord(ownerFile(options.record)));
  let bad = 0;
  for (const j of todo.refused) { log(`cleanup: ${j.link}: NOT REMOVED: its creation is not confirmed by ${ownerFile(options.record)} (left untouched)`); bad++; }
  if (todo.length === 0 && bad === 0) log('cleanup: no junction of this record is outstanding');
  const results = removeJunctions(todo);
  results.forEach((x, i) => {
    log(`cleanup: ${x.link}: ${x.result}`);
    if (x.result === 'removed' || x.result === 'already gone') appendRecord(options.record, { event: 'junction-removed', token: todo[i].token, link: x.link, result: x.result }); else bad++;
  });
  return bad ? 1 : 0;
}

/**
 * Runs a command, recording its PID at start and its exit. Resolves to the exit code.
 * The record is written once before the spawn (if that throws, nothing is started). After the spawn the exit listeners are attached
 * first; a record line that then fails to write is reported, the child is still waited for, and the result is 1 instead of 0.
 */
export function runRecorded(options, { spawnFn = spawn, cwd = root, error = console.error } = {}) {
  const [cmd, ...args] = options.run;
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k.toUpperCase() !== 'NODE_OPTIONS') env[k] = v;
  appendRecord(options.record, { event: 'run-start', label: cmd });
  return new Promise((done) => {
    let recordFailed = false;
    let finished = false;
    const write = (entry) => {
      try { appendRecord(options.record, entry); } catch (e) { recordFailed = true; error(`record not written (${entry.event}): ${e.message}`); }
    };
    const finish = (code) => { if (finished) return; finished = true; done(recordFailed && code === 0 ? 1 : code); };
    const child = spawnFn(cmd, args, { cwd, env, stdio: 'inherit', windowsHide: true });
    child.on('error', (e) => {
      if (finished) return;
      if (child.pid) { write({ event: 'pid-error', pid: child.pid, error: e.message }); return; } // still running: wait for 'close'
      write({ event: 'pid-exit', pid: null, error: e.message }); // it never started; a later 'close' is not recorded again
      finish(1);
    });
    child.on('close', (code, signal) => {
      if (finished) return;
      write({ event: 'pid-exit', pid: child.pid, code, signal });
      finish(code ?? 1);
    });
    if (child.pid) write({ event: 'pid', pid: child.pid, label: cmd });
  });
}

export async function main(argv, deps = {}) {
  const error = deps.error ?? console.error;
  const parsed = parseArgs(argv);
  if (!parsed.ok) { error(`${parsed.error}\n${USAGE}`); return 2; }
  const { options } = parsed;
  try {
    if (options.run) return await runRecorded(options, deps);
    if (options.cleanup) return cleanup(options, deps);
    return preflight(options, deps);
  } catch (e) { error(String(e.message ?? e)); return 1; }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
