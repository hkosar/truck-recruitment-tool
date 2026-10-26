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
// - What is shown from the child is a FIXED ALLOW-LIST (see allowListLine): JSON events whose `msg` is one of an enumerated
//   list of `staging-sql.*` names, each with a fixed set of keys whose values must fit that key's own pattern or
//   enumerated list (a failure is only ever a fixed refusal identifier plus a validated code; no message text is
//   forwarded, whatever it starts with), and the seeding script's exact progress lines. Everything else is withheld:
//   a whole line is counted as an "output line", and a key or value that is not allowed inside an accepted line is
//   counted as a "field". Both counts are printed at the end; the owner procedure continues only when both are 0.
//   The secret, its URL-encoded form and, for a URL, its host, user and password are also replaced with <masked>, but
//   that is defense in depth only: it cannot catch fragments, re-encodings or values split across lines.
//   Report only PASS/FAIL, check names and counts.
//   Not a vault: the child's environment is readable by the child and by local tools with enough rights. The hidden
//   prompt is meant not to echo, but the terminal window itself, a clipboard manager and anything the operating
//   system records are outside this tool.
// - Exit status is the child's.

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ALLOWED = ['STAGING_DB_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'TEST_USER_PASSWORD', 'OWNER_STAGING_PASSWORD'];

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
// A child line is shown only if it is (a) a JSON object whose `msg` is on the enumerated EVENTS list below, rebuilt
// from that event's own fixed keys, each value checked against the pattern or enumerated list for that key (anything
// else is replaced by <withheld> and counted; unknown keys are dropped and counted), or (b) one of the exact progress
// lines the fixture seeding script prints. Every other line, such as a driver error, a stack trace or a server message,
// is NOT shown; it is only counted. A failure is shown only as a refusal identifier from the runner's own fixed list
// (pipeline/src/refusals.ts; scripts/run-with-secrets.test.mjs keeps the two lists equal) and a validated code; the
// runner never forwards message text, so there is nothing for a forged prefix to ride on. Masking (scrub) is still
// applied to what is shown, as defense in depth only.

/** Keep equal to pipeline/src/refusals.ts REFUSAL_IDS (a test compares them). */
export const REFUSAL_IDS = [
  'plan_refused', 'ref_not_recorded', 'ref_invalid', 'db_url_required', 'production_refused', 'target_not_recorded_staging',
  'port_must_be_5432', 'confirmation_required', 'unknown_action', 'unknown_argument', 'bad_project_option', 'ledger_preflight_failed',
  'profiles_already_exist', 'ledger_not_empty', 'ledger_not_exact', 'm1c_state_unrecognised', 'm1c_postcondition_failed',
  'retention_dry_run_failed', 'reapply_m1_not_backed_out', 'reapply_m1_still_applied', 'reapply_m1b_not_backed_out',
  'reapply_m1b_still_applied', 'reapply_m1c_not_backed_out', 'reapply_m1c_still_applied', 'owner_email_invalid',
  'owner_password_too_short', 'owner_auth_not_created', 'owner_auth_unknown_result', 'owner_promotion_refused',
  'owner_bootstrap_target_refused', 'server_or_driver_error',
];

const PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN', 'USAGE', 'EXECUTE', 'CREATE', 'OTHER'];
const bool = (v) => typeof v === 'boolean';
const int = (v) => Number.isSafeInteger(v) && v >= -1 && v <= 1_000_000_000;
const pat = (re) => (v) => typeof v === 'string' && re.test(v);
const oneOf = (list) => (v) => typeof v === 'string' && list.includes(v);
const listOf = (item, max) => (v) => Array.isArray(v) && v.length <= max && v.every(item);
const ident = pat(/^[A-Za-z0-9_]{1,63}$/);
const action = pat(/^[a-z0-9-]{1,40}$/);
const word = pat(/^[a-z_]{1,24}$/);
const step = pat(/^[A-Za-z0-9_./-]{1,100}( \((precheck|idempotent re-apply|restore fresh-apply grants)\))?$/);
const code = pat(/^([0-9A-Z]{5}|E[A-Z0-9_]{2,30})$/);
const detail = pat(/^(\d{1,9}|unreadable)$/);
const privs = listOf(oneOf(PRIVILEGES), 12);
const phase = oneOf(['before', 'after']);

const EVENTS = {
  'staging-sql.selftest': { ok: bool },
  'staging-sql.verified': { action, steps: int, target: oneOf(['recorded rebuilt staging project', 'recorded staging project']) },
  'staging-sql.plan_only': { hint: oneOf(['add --execute to run']) },
  'staging-sql.done': { action },
  'staging-sql.refused': { refusal: oneOf(REFUSAL_IDS), err_code: code },
  'staging-sql.step_done': { step },
  'staging-sql.step_failed': { step },
  'staging-sql.ledger_verified': { expected: int, found: int, exact_match: bool },
  'staging-sql.ledger_preflight_check': { check: ident, ok: bool, detail },
  'staging-sql.ledger_preflight': { case: ident, ok: bool, checks: int, failed: int },
  'staging-sql.retention_dry_run': { ok: bool },
  'staging-sql.m1c_interrupted_run_detected': {},
  'staging-sql.m1c_partial_state_refused': { failed_checks: listOf(ident, 40) },
  'staging-sql.m1c_postcondition_ok': {},
  'staging-sql.m1c_postcondition_failed': {},
  'staging-sql.environment_event_triggers': { count: int, listed: int, truncated: bool },
  'staging-sql.environment_event_trigger': { name: ident, event: ident, enabled: ident, function: ident },
  'staging-sql.environment_default_acl': {
    role: oneOf(['anon', 'authenticated', 'service_role', 'PUBLIC']), role_present: bool,
    tables_public: privs, sequences_public: privs, functions_public: privs, tables_global: privs, sequences_global: privs, functions_global: privs, grant_option: bool,
  },
  'staging-sql.environment_default_acl_total': { entries: int, outside_these_cells: int, scope: oneOf(['explicit_default_acl_entries_of_this_login_only']) },
  'staging-sql.environment_authenticator_setting': {
    authenticator_exists: bool, role_wide_entries: int, this_database_entries: int, names_public: (v) => bool(v) || v === 'unknown', is_the_data_api_switch: bool,
  },
  'staging-sql.environment_preflight': { scope: oneOf(['catalogue_facts_only_owner_checks_the_three_dashboard_switches']) },
  'staging-sql.owner_auth_create': { result: oneOf(['created', 'not_created', 'unknown']), http_status: int, email_matches: bool, id_present: bool },
  'staging-sql.owner_state': {
    state: oneOf(['ready_to_promote', 'promoted', 'no_owner_login', 'other']), marker_ok: bool, owner_auth_users: int, owner_has_password: bool, owner_email_confirmed: bool,
    password_users: int, auth_users_total: int, owner_profiles: int, owner_profile_role: word, owner_profile_status: word, fixture_profiles: int, other_profiles: int, owner_manager_approved: int,
  },
  'staging-sql.owner_check': { phase, check: ident, ok: bool },
  'staging-sql.owner_checks': { phase, ok: bool, checks: int, failed: int },
  'staging-sql.owner_promote_result': { result: oneOf(['committed', 'rolled_back', 'rollback_not_confirmed', 'unknown']) },
};

const SEED_LINES = [
  /^created (manager|editor|viewer|pending|guest|disabled) fixture for run [a-z0-9-]{1,40}$/,
  /^created \d{1,3} fictional users; expires \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
  /^password generated or supplied at runtime and intentionally not printed$/,
];

/**
 * Returns the line to show, or null when the whole line is not on the allow-list. `counter.fields` (optional) is
 * increased for every key dropped and every value replaced inside an accepted line.
 */
export function allowListLine(raw, counter = { fields: 0 }) {
  const line = raw.replace(/\r?\n$/, '');
  if (SEED_LINES.some((re) => re.test(line))) return line;
  let obj;
  try { obj = JSON.parse(line); } catch { return null; }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj) || typeof obj.msg !== 'string' || !Object.prototype.hasOwnProperty.call(EVENTS, obj.msg)) return null;
  const spec = EVENTS[obj.msg];
  const out = { msg: obj.msg };
  for (const key of Object.keys(obj)) {
    if (key === 'msg') continue;
    if (!Object.prototype.hasOwnProperty.call(spec, key)) { counter.fields += 1; continue; }
    if (spec[key](obj[key])) out[key] = obj[key];
    else { out[key] = '<withheld>'; counter.fields += 1; }
  }
  return JSON.stringify(out);
}

function filteringSink(sink, targets, counter) {
  let pending = '';
  const emit = (l) => {
    const shown = allowListLine(l, counter);
    if (shown === null) { counter.lines += 1; return; }
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
    const counter = { lines: 0, fields: 0 };
    const out = filteringSink(stdout, sortedTargets, counter);
    const err = filteringSink(stderr, sortedTargets, counter);
    child.stdout.on('data', (c) => out.write(c));
    child.stderr.on('data', (c) => err.write(c));
    child.on('error', (e) => fail(new Error(scrub(String(e.message), sortedTargets))));
    child.on('close', (code) => {
      out.end(); err.end();
      // The only lines this tool adds itself: fixed text and three numbers.
      stdout.write(`run-with-secrets: exit code ${code ?? 1}; ${counter.lines} output line(s) withheld; ${counter.fields} field(s) withheld (not on the allow-list)
`);
      done(code ?? 1);
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main({ argv: process.argv.slice(2) }).then((code) => { process.exitCode = code; }, (e) => { console.error(e.message); process.exitCode = 2; });
}
