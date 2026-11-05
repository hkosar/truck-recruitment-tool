#!/usr/bin/env node
// LOCAL ONLY (TRUCKRECRU-158 / 163): the start-of-task and end-of-task check for a builder or reviewer. No network, installs nothing.
//
// Offline guard (163): nothing new is needed. scripts/net-guard.mjs already is the reusable loopback-only guard: it blocks every connect to a
// non-loopback address and every lookup answered with one, and native children (git, bash, postgres) run normally because it only loads into
// Node. Load it first, as a file:// URL on Windows, and keep it OUT of NODE_OPTIONS wherever a test checks the child environment:
//   node --import=file:///C:/path/to/repo/scripts/net-guard.mjs <script> [args]
// A shim like guarded-node.sh is not needed: scripts/simulate-ci-jobs.mjs removes NODE_OPTIONS from its steps and is itself run as above;
// scripts/combine-checks.mjs passes the same --import to each node step. Limits: see the top of net-guard.mjs (dns.lookup called directly and UDP are not covered).
//
// Usage (from the repository root):
//   node scripts/review-preflight.mjs --expect <40-char sha> --record <file.jsonl> [--junction <worktree with node_modules>]
//       Prints the branch and HEAD next to the expected SHA and exits 2 (nothing created) if HEAD is different. If it matches, a missing
//       pipeline/ or app/ node_modules is made available as a directory junction (the helpers of combine-checks.mjs: READ-ONLY use, a
//       node_modules that exists is never touched). Every junction made is appended to the record with its file identity.
//   node scripts/review-preflight.mjs --cleanup --record <file.jsonl>
//       Removes exactly the junctions that file says this tool made (only while each is still the same link it made), then notes it in the record.
//   node scripts/review-preflight.mjs --record <file.jsonl> --run -- <command> [args...]
//       Starts the command (NODE_OPTIONS removed, output passed through), appends its PID to the record when it starts and its exit when it ends,
//       and exits with the command's code. It never signals any process. Pass --import=<guard url> to a node command yourself.
// The record is JSON lines: {"event":"pid"|"pid-exit"|"junction"|"junction-removed", ...}. It holds paths and PIDs only, no secrets.
// Undo: delete this script and review-preflight.test.mjs.

import { spawn, spawnSync } from 'node:child_process';
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

/** The junctions the record says were made and not yet removed, in the shape removeJunctions takes. Pure. */
export function outstandingJunctions(entries) {
  const gone = new Set(entries.filter((e) => e.event === 'junction-removed').map((e) => normPath(e.link)));
  return entries.filter((e) => e.event === 'junction' && !gone.has(normPath(e.link))).map(({ link, target, identity }) => ({ link, target, identity }));
}

function gitOut(repoRoot, record, args) {
  const r = spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' });
  if (r.pid) appendRecord(record, { event: 'pid', pid: r.pid, label: `git ${args[0]}` });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || r.error?.message || '').trim()}`);
  return r.stdout.trim();
}

/** Check HEAD, then make the junctions. Returns the exit code (0 ok, 2 refused). */
export function preflight(options, { repoRoot = root, log = console.log, error = console.error } = {}) {
  const head = gitOut(repoRoot, options.record, ['rev-parse', 'HEAD']);
  const branch = gitOut(repoRoot, options.record, ['rev-parse', '--abbrev-ref', 'HEAD']);
  log(`branch:   ${branch}\nHEAD:     ${head}\nexpected: ${options.expect}`);
  if (head.toLowerCase() !== options.expect.toLowerCase()) { error('REFUSED: HEAD is not the expected sha; nothing was created'); return 2; }
  log('HEAD matches the expected sha');
  const plans = MODULE_DIRS.map((d) => planJunction(repoRoot, d, options.junction));
  for (const p of plans) log(`preflight: ${p.dir}/node_modules ${p.action}${p.reason ? ` (${p.reason})` : ''}${p.action === 'create' ? ` -> junction to ${p.target}` : ''}`);
  if (plans.some((p) => p.action === 'refuse')) { error('REFUSED: see the preflight lines above; nothing was created'); return 2; }
  if (plans.some((p) => p.action === 'missing')) log('preflight: a node_modules is missing and no --junction was given; steps that need it will fail');
  const made = [];
  try { createJunctions(plans, made); } finally {
    for (const m of made) { appendRecord(options.record, { event: 'junction', link: m.link, target: m.target, identity: m.identity }); log(`preflight: created junction ${m.link} -> ${m.target}`); }
  }
  return 0;
}

/** Removes the junctions the record lists. Returns 0 if each was removed or already gone, else 1. */
export function cleanup(options, { log = console.log } = {}) {
  const todo = outstandingJunctions(readRecord(options.record));
  if (todo.length === 0) log('cleanup: no junction of this record is outstanding');
  let bad = 0;
  for (const x of removeJunctions(todo)) {
    log(`cleanup: ${x.link}: ${x.result}`);
    if (x.result === 'removed' || x.result === 'already gone') appendRecord(options.record, { event: 'junction-removed', link: x.link, result: x.result }); else bad++;
  }
  return bad ? 1 : 0;
}

/** Runs a command, recording its PID at start and its exit. Resolves to the exit code. */
export function runRecorded(options, { spawnFn = spawn, cwd = root } = {}) {
  const [cmd, ...args] = options.run;
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k.toUpperCase() !== 'NODE_OPTIONS') env[k] = v;
  return new Promise((done) => {
    const child = spawnFn(cmd, args, { cwd, env, stdio: 'inherit', windowsHide: true });
    if (child.pid) appendRecord(options.record, { event: 'pid', pid: child.pid, label: cmd });
    child.on('error', (e) => { appendRecord(options.record, { event: 'pid-exit', pid: child.pid ?? null, error: e.message }); done(1); });
    child.on('close', (code, signal) => { appendRecord(options.record, { event: 'pid-exit', pid: child.pid, code, signal }); done(code ?? 1); });
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
