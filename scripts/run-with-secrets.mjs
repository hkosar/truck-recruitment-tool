#!/usr/bin/env node
// Runs ONE command with secrets that are typed (or pasted) into a HIDDEN prompt. The secret never
// appears on a command line, in shell history, in a file, or on screen, and it exists only in this
// process and in the child process's environment. It is for the owner/operator steps in doc 16
// (the staging database URL, the Supabase service-role key, the fixture password).
//
//   node scripts/run-with-secrets.mjs [--cwd DIR] [--node-path DIR] --secret NAME [--secret NAME ...] -- node ARGS...
//
// - Only the names in ALLOWED can be requested. The command after `--` must start with the word `node`
//   (it is run with this same Node binary, without a shell, so no quoting or expansion applies).
// - The prompt needs an interactive terminal; it refuses piped or redirected input.
// - A name that is already set in the environment is refused (a literal in the shell is the leak this
//   tool exists to avoid): close that terminal window and open a new one.
// - What is shown from the child is a FIXED ALLOW-LIST (see allowListLine): known `staging-sql.*` JSON events with
//   fixed keys, short plain values and, for errors, only a known guard message or the error code; the seeding
//   script's progress lines. Every other line is withheld and only counted. The secret, its URL-encoded form and,
//   for a URL, its host, user and password are also replaced with <masked>, but that is defense in depth only: it
//   cannot catch fragments, re-encodings or values split across lines, and the owner procedure must not rely on it.
//   Report only PASS/FAIL, check names and counts.
//   Not a vault: the child's environment is readable by the child and by local tools with enough rights, and the
//   terminal window's own scrollback and any clipboard history are outside this tool.
// - Exit status is the child's.

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ALLOWED = ['STAGING_DB_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'TEST_USER_PASSWORD'];

/** Reads one line from a TTY without echoing it. Resolves to the text; rejects on Ctrl+C or end of input. */
export function readHidden(prompt, stdin, stdout) {
  return new Promise((done, fail) => {
    if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
      fail(new Error('refusing: a secret can only be entered at an interactive terminal prompt (input is not a terminal)'));
      return;
    }
    let buf = '';
    const finish = (fn) => {
      stdin.removeListener('data', onData);
      stdin.removeListener('end', onEnd);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
      fn();
    };
    const onEnd = () => finish(() => fail(new Error('input ended before a value was entered')));
    const onData = (chunk) => {
      const text = chunk.toString('utf8');
      for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (ch === '\r' || ch === '\n') return finish(() => done(buf));
        if (ch === '\u0003') return finish(() => fail(new Error('cancelled')));
        if (ch === '\u007f' || ch === '\b') { buf = buf.slice(0, -1); continue; }
        if (ch === '\u001b') { // escape sequence (arrow keys etc.): skip it
          i += 1;
          while (i < text.length && !/[A-Za-z~]/.test(text[i])) i += 1;
          continue;
        }
        if (ch < ' ') continue;
        buf += ch;
      }
    };
    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
    stdin.on('end', onEnd);
  });
}

/** Strings to hide in output for one secret value. */
export function maskTargets(value) {
  const out = new Set([value]);
  try { out.add(encodeURIComponent(value)); } catch { /* lone surrogate: skip */ }
  try {
    const u = new URL(value);
    for (const part of [u.hostname, u.username, u.password, safeDecode(u.username), safeDecode(u.password)]) if (part) out.add(part);
  } catch { /* not a URL */ }
  return [...out].filter((s) => s.length >= 4).sort((a, b) => b.length - a.length);
}
const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

export function scrub(line, targets) {
  let out = line;
  for (const t of targets) out = out.split(t).join('<masked>');
  return out;
}

// ---- What the owner's screen shows: a FIXED ALLOW-LIST, not a scrubbed copy of the child's output.
// A child line is shown only if it is (a) a JSON event whose `msg` is `staging-sql.<name>`, rebuilt from a fixed
// list of keys whose values are short plain words/numbers/booleans (anything else in a value is replaced by
// <withheld>), with a free-text `err` reduced to a known guard message from this repository or its trailing
// error code, or (b) one of the exact progress lines the fixture seeding script prints. Every other line, such as
// a driver error, a stack trace or a server message, is NOT shown; it is only counted. Masking (scrub) is still
// applied to what is shown, as defense in depth only: it replaces exact values and a few forms of them, and it
// cannot catch a fragment, a re-encoding or a value split across lines. The allow-list is what keeps output safe.
const EVENT_KEYS = ['msg', 'action', 'step', 'steps', 'target', 'check', 'ok', 'case', 'checks', 'failed', 'failed_checks', 'expected', 'found', 'exact_match', 'note', 'hint', 'detail', 'count', 'n',
  // environment-preflight (identifiers and booleans only)
  'name', 'event', 'enabled', 'function', 'enables_rls', 'role', 'tables_public', 'sequences_public', 'functions_public', 'tables_global', 'sequences_global', 'functions_global',
  'authenticator_exists', 'schema_list_entries', 'public_listed', 'api_roles_present'];
const SAFE_WORDS = /^[A-Za-z0-9_ .,;/()=+'<>-]{0,160}$/; // no colon or @: a URL, host:port or user@host never qualifies
const GUARD_MESSAGES = [
  /^ledger preflight: \d+ check\(s\) failed; (the replay must not run|refusing to replay)$/,
  /^re-apply M1c refused: .{0,260}$/,
  /^re-apply M1[bc]? refused: .{0,200}$/,
  /^public\.profiles already exists; the baseline replay only runs on an empty project$/,
  /^supabase_migrations\.schema_migrations is not empty; the baseline replay only runs on a clean ledger$/,
  /^migration ledger does not hold exactly the reviewed \(version, name\) pairs$/,
  /^Staging SQL runner requires --confirm="[A-Z0-9 ]{1,80}" for [a-z0-9-]{1,40}$/,
  /^Staging SQL runner (only targets the recorded (rebuilt )?staging project|refuses the production Carrier Recruiter project|requires a session connection on port 5432 \(not the 6543 transaction pooler\))$/,
  /^The rebuilt staging project ref is not recorded yet \(target-guard\.ts\); refusing every rebuilt action$/,
  /^STAGING_DB_URL is required$/,
  /^Unknown argument --[a-z-]{1,20}$/,
  /^Unknown rebuilt staging SQL action "[A-Za-z0-9-]{1,40}" (expected [A-Za-z0-9, -]{1,600})$/,
];
const ERROR_CODE = /\[([0-9A-Z]{5}|E[A-Z0-9_]{2,30})\]$/;
const SEED_LINES = [
  /^created [A-Za-z0-9 _.-]{1,40} fixture for run [A-Za-z0-9_-]{1,64}$/,
  /^created \d{1,3} fictional users; expires [0-9T:.+Z-]{10,40}$/,
  /^password generated or supplied at runtime and intentionally not printed$/,
];

function allowedValue(v) {
  if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) return v;
  if (typeof v === 'string') return SAFE_WORDS.test(v) ? v : '<withheld>';
  if (Array.isArray(v) && v.length <= 40) return v.map((x) => (typeof x === 'string' ? (SAFE_WORDS.test(x) ? x : '<withheld>') : typeof x === 'number' || typeof x === 'boolean' ? x : '<withheld>'));
  return '<withheld>';
}

/** Returns the line to show, or null when the line is not on the allow-list. */
export function allowListLine(raw) {
  const line = raw.replace(/\r?\n$/, '');
  if (SEED_LINES.some((re) => re.test(line))) return line;
  let obj;
  try { obj = JSON.parse(line); } catch { return null; }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj) || typeof obj.msg !== 'string' || !/^staging-sql\.[a-z0-9_]{1,60}$/.test(obj.msg)) return null;
  const out = {};
  for (const k of EVENT_KEYS) if (k in obj) out[k] = allowedValue(obj[k]);
  if (typeof obj.err === 'string') {
    const code = ERROR_CODE.exec(obj.err);
    const text = code ? obj.err.slice(0, code.index).trimEnd() : obj.err;
    if (GUARD_MESSAGES.some((re) => re.test(text))) out.err = text;
    else out.err = '<withheld>';
    if (code) out.err_code = code[1];
  }
  return JSON.stringify(out);
}

function filteringSink(sink, targets, counter) {
  let pending = '';
  const emit = (l) => {
    const shown = allowListLine(l);
    if (shown === null) { counter.withheld += 1; return; }
    sink.write(`${scrub(shown, targets)}\n`);
  };
  return {
    write(chunk) {
      pending += chunk.toString('utf8');
      let idx;
      while ((idx = pending.indexOf('\n')) >= 0) {
        emit(pending.slice(0, idx));
        pending = pending.slice(idx + 1);
      }
    },
    end() { if (pending) emit(pending); pending = ''; },
  };
}

export function parseArgs(argv) {
  const secrets = [];
  let cwd; let nodePath;
  let i = 0;
  for (; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') { i += 1; break; }
    if (a === '--secret') { secrets.push(argv[++i]); continue; }
    if (a === '--cwd') { cwd = argv[++i]; continue; }
    if (a === '--node-path') { nodePath = argv[++i]; continue; }
    throw new Error(`unknown option ${a}`);
  }
  const rest = argv.slice(i);
  if (secrets.length === 0 || rest.length < 2 || rest[0] !== 'node') {
    throw new Error('usage: node scripts/run-with-secrets.mjs [--cwd DIR] [--node-path DIR] --secret NAME [--secret NAME ...] -- node ARGS...');
  }
  for (const s of secrets) if (!ALLOWED.includes(s)) throw new Error(`refusing: ${String(s)} is not an allowed secret name (${ALLOWED.join(', ')})`);
  if (new Set(secrets).size !== secrets.length) throw new Error('refusing: a secret name was given twice');
  return { secrets, cwd, nodePath, childArgs: rest.slice(1) };
}

export async function main({ argv, env = process.env, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, nodeBinary = process.execPath }) {
  const { secrets, cwd, nodePath, childArgs } = parseArgs(argv);
  for (const name of secrets) {
    if (env[name] !== undefined && env[name] !== '') {
      throw new Error(`refusing: ${name} is already set in this terminal. Close this window, open a new one and run the command again (a value typed into a shell can stay in its history).`);
    }
  }
  const childEnv = { ...env };
  const targets = [];
  for (const name of secrets) {
    const value = (await readHidden(`Enter ${name} (typing is hidden; paste, then press Enter): `, stdin, stdout)).trim();
    if (!value) throw new Error(`no value entered for ${name}`);
    childEnv[name] = value;
    targets.push(...maskTargets(value));
  }
  if (nodePath) childEnv.NODE_PATH = resolve(nodePath);
  const sortedTargets = [...new Set(targets)].sort((a, b) => b.length - a.length);
  return new Promise((done, fail) => {
    const child = spawn(nodeBinary, childArgs, { cwd: cwd ? resolve(cwd) : process.cwd(), env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    const counter = { withheld: 0 };
    const out = filteringSink(stdout, sortedTargets, counter);
    const err = filteringSink(stderr, sortedTargets, counter);
    child.stdout.on('data', (c) => out.write(c));
    child.stderr.on('data', (c) => err.write(c));
    child.on('error', (e) => fail(new Error(scrub(String(e.message), sortedTargets))));
    child.on('close', (code) => {
      out.end(); err.end();
      // The only lines this tool adds itself: fixed text and two numbers.
      stdout.write(`run-with-secrets: exit code ${code ?? 1}; ${counter.withheld} output line(s) withheld (not on the allow-list)
`);
      done(code ?? 1);
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main({ argv: process.argv.slice(2) }).then((code) => { process.exitCode = code; }, (e) => { console.error(e.message); process.exitCode = 2; });
}
