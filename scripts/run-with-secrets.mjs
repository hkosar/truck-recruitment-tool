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
// - The child's output is scrubbed line by line: the secret, its URL-encoded form and, for a URL, its
//   host, user and password are replaced with <masked>. This is best effort. Do not rely on it to make
//   raw output safe to paste anywhere; report only event names, counts and pass/fail.
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

function lineScrubber(sink, targets) {
  let pending = '';
  return {
    write(chunk) {
      pending += chunk.toString('utf8');
      let idx;
      while ((idx = pending.indexOf('\n')) >= 0) {
        sink.write(scrub(pending.slice(0, idx + 1), targets));
        pending = pending.slice(idx + 1);
      }
    },
    end() { if (pending) sink.write(scrub(pending, targets)); pending = ''; },
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
    const out = lineScrubber(stdout, sortedTargets);
    const err = lineScrubber(stderr, sortedTargets);
    child.stdout.on('data', (c) => out.write(c));
    child.stderr.on('data', (c) => err.write(c));
    child.on('error', (e) => fail(new Error(scrub(String(e.message), sortedTargets))));
    child.on('close', (code) => { out.end(); err.end(); done(code ?? 1); });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main({ argv: process.argv.slice(2) }).then((code) => { process.exitCode = code; }, (e) => { console.error(e.message); process.exitCode = 2; });
}
