#!/usr/bin/env node
// Runs the built sign-in app (app/dist-server/main.js) LOCALLY against the rebuilt staging project (staging-2) with settings
// from Doppler `truck-recruitment-tool`/`stg`. It is a separate, small launcher (not part of scripts/run-with-secrets.mjs, whose
// allow-list is for the short owner steps). Doc: docs/build-plan/19-local-app-staging-launcher.md.
//
//   (scoped staging token prefix; see docs/build-plan/19) ... run --no-fallback --project truck-recruitment-tool --config stg -- node scripts/run-app-staging.mjs [--port N]
//
// Refuses (fixed messages, no values) unless ALL of these hold:
//  - DOPPLER_PROJECT is truck-recruitment-tool and DOPPLER_CONFIG is stg (a guard against a wrong command, not a security boundary;
//    the boundary is a Doppler token bound to stg);
//  - exactly the four names DATABASE_URL, KEY_LINKS, KEY_SESSIONS, KEY_RATE are present and non-empty;
//  - DATABASE_URL targets the recorded staging-2 project (pipeline/src/target-guard.ts parseSupabaseDbTarget + RECORDED_PROJECT_REFS),
//    as the least-privilege login recruiter_app on the session-mode port 5432 (never production, never the old staging project,
//    never the runner or maintenance login);
//  - EMAIL_MODE is unset or `test`, HOST is unset or 127.0.0.1, and no SENDGRID_* name is present.
// The child gets ONLY: the base names below, the four secrets, and values this launcher forces (APP_ORIGIN=http://localhost:<port>,
// EMAIL_MODE=test, HOST=127.0.0.1, PORT, TRUSTED_PROXY_HOPS=0, STAGING_BANNER=true). Every other parent variable (all other Doppler
// secrets, DOPPLER_TOKEN, SENDGRID_*) is dropped. Output is an ALLOW-LIST, not a scrubbed copy: a line passes only if it is JSON with a
// known app event name, only that event's own fields, and every value an enum, a bounded whole number or a tight id/route shape
// (APP_LOG_EVENTS; no free text), or one of the exact fixed config-error messages of app/server/config.ts (complete lines only).
// Secret masking (plain, URL-encoded in any hex case, JSON-escaped) is a second layer; a database password under 8 characters is
// refused at start. Everything else is withheld and counted. Environment values are never printed. Exit status is the child's.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { RECORDED_PROJECT_REFS, parseSupabaseDbTarget } from '../pipeline/src/target-guard.ts';
import { scrub } from './run-with-secrets.mjs';

export const APP_STAGING_PROJECT = 'truck-recruitment-tool';
export const APP_STAGING_CONFIG = 'stg';
/** The only Doppler names the app needs (app/server/config.ts). Nothing else is read from the environment. */
export const APP_SECRET_NAMES = ['DATABASE_URL', 'KEY_LINKS', 'KEY_SESSIONS', 'KEY_RATE'];
export const APP_BASE_NAMES = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'];
export const APP_ROLE = 'recruiter_app';
export const APP_DB_PORT = 5432;
export const DEFAULT_PORT = 8788;
/** A database password shorter than this (raw or decoded) is refused: masking a few characters would hide nothing and would break every line that contains them. */
export const MIN_MASKABLE_LENGTH = 8;
export const BIND_HOST = '127.0.0.1';
const REPO_ROOT = resolve(import.meta.dirname, '..');

export function parseAppArgs(argv) {
  let port = DEFAULT_PORT;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--port') {
      const v = argv[++i];
      port = Number(v);
      if (!/^\d+$/.test(String(v)) || port < 1024 || port > 65535) throw new Error('refusing: --port must be a whole number from 1024 to 65535');
    } else throw new Error('usage: node scripts/run-app-staging.mjs [--port N]  (run through the scoped staging-token doppler prefix in docs/build-plan/19)');
  }
  return { port };
}

/** Throws a fixed refusal unless every guard holds; returns the child environment (never logged). */
export function buildAppEnv(env, port) {
  if (env.DOPPLER_PROJECT !== APP_STAGING_PROJECT || env.DOPPLER_CONFIG !== APP_STAGING_CONFIG) {
    throw new Error(`refusing: only the staging Doppler scope is allowed (project ${APP_STAGING_PROJECT}, config ${APP_STAGING_CONFIG}); run it through doppler run with exactly that project and config`);
  }
  for (const name of APP_SECRET_NAMES) {
    if (typeof env[name] !== 'string' || env[name].trim() === '') throw new Error(`refusing: ${name} is missing or empty in the environment`);
  }
  const upper = (k) => k.toUpperCase();
  if (Object.keys(env).some((k) => upper(k).startsWith('SENDGRID_') && env[k] !== undefined && env[k] !== '')) {
    throw new Error('refusing: a SendGrid setting is present; this launcher never sends real mail (EMAIL_MODE=test only)');
  }
  const setValue = (name) => { const k = Object.keys(env).find((x) => upper(x) === name && env[x] !== undefined && env[x] !== ''); return k === undefined ? undefined : env[k]; };
  const mode = setValue('EMAIL_MODE');
  if (mode !== undefined && mode !== 'test') throw new Error('refusing: EMAIL_MODE must be test (or unset); real mail is not allowed here');
  const host = setValue('HOST');
  if (host !== undefined && host !== BIND_HOST) throw new Error(`refusing: HOST must be ${BIND_HOST} (or unset); the app binds to this computer only`);
  let target;
  try { target = parseSupabaseDbTarget(env.DATABASE_URL); } catch { throw new Error('refusing: DATABASE_URL is not a valid Supabase database URL (checked without printing it)'); }
  const pw = (() => { try { const u = new URL(env.DATABASE_URL); return [u.password, safeDecode(u.password)]; } catch { return ['', '']; } })();
  if (pw.some((p) => p.length < MIN_MASKABLE_LENGTH)) throw new Error(`refusing: the DATABASE_URL password is shorter than ${MIN_MASKABLE_LENGTH} characters, too short to mask safely in output (rotate it to a longer password)`);
  const recorded = RECORDED_PROJECT_REFS.stagingRebuilt;
  if (target.projectRef === RECORDED_PROJECT_REFS.production) throw new Error('refusing: DATABASE_URL targets the production project');
  if (recorded === null || target.projectRef !== recorded) throw new Error('refusing: DATABASE_URL does not target the recorded staging-2 project');
  if (target.user.slice(0, target.user.lastIndexOf('.')) !== APP_ROLE) throw new Error(`refusing: DATABASE_URL must use the ${APP_ROLE} login (<role>.<project-ref>), not another login`);
  if (target.port !== APP_DB_PORT) throw new Error(`refusing: DATABASE_URL must use the session-mode port ${APP_DB_PORT}`);
  const child = {};
  for (const [k, v] of Object.entries(env)) if (APP_BASE_NAMES.includes(upper(k)) && typeof v === 'string') child[k] = v;
  for (const name of APP_SECRET_NAMES) child[name] = env[name];
  Object.assign(child, {
    APP_ORIGIN: `http://localhost:${port}`,
    EMAIL_MODE: 'test',
    HOST: BIND_HOST,
    PORT: String(port),
    TRUSTED_PROXY_HOPS: '0',
    STAGING_BANNER: 'true',
  });
  return child;
}

const safeDecode = (x) => { try { return decodeURIComponent(x); } catch { return x; } };
const jsonEscaped = (x) => JSON.stringify(x).slice(1, -1);
const unicodeEscaped = (x) => x.replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

/**
 * Every string to hide for one secret value, with NO minimum length (the shared maskTargets in run-with-secrets.mjs drops
 * anything under 4 characters, which suits the owner steps but not this launcher; buildAppEnv refuses a database password
 * under MIN_MASKABLE_LENGTH instead). For each base form (the value; for a URL also host, user, password and their decoded
 * forms): the plain text, the URL-encoded text (upper and lower case hex) and the JSON-escaped text (quote, backslash,
 * control characters, an escaped slash, non-ASCII characters as \uXXXX), so a child that logs the value inside JSON,
 * raw or re-serialised, still matches.
 */
export function launcherMaskTargets(value) {
  const bases = new Set([value]);
  try {
    const u = new URL(value);
    for (const part of [u.hostname, u.username, u.password]) if (part) { bases.add(part); bases.add(safeDecode(part)); }
  } catch { /* not a URL */ }
  const forms = new Set();
  for (const b of bases) {
    if (!b) continue;
    forms.add(b);
    try { const enc = encodeURIComponent(b); forms.add(enc); forms.add(enc.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase())); } catch { /* lone surrogate */ }
  }
  for (const f of [...forms]) {
    const j = jsonEscaped(f);
    for (const v of [j, j.replace(/\//g, '\\/'), unicodeEscaped(j), unicodeEscaped(j).replace(/\//g, '\\/'), unicodeEscaped(f)]) forms.add(v);
  }
  return [...forms].filter((x) => x.length > 0);
}

/**
 * The only non-JSON lines the app prints: ConfigError messages, enumerated from app/server/config.ts (scripts/verify-app-staging-contract.mjs
 * checks that every ConfigError literal there is on this list). Shown only as an exact match, with or without the "ConfigError: " prefix.
 * The two SendGrid "is required" messages are left off on purpose: they exist only for EMAIL_MODE=production, which this launcher never allows.
 */
export const CONFIG_ERROR_MESSAGES = [
  ...['APP_ORIGIN', 'KEY_LINKS', 'KEY_SESSIONS', 'KEY_RATE', 'DATABASE_URL'].map((n) => `${n}: is required`),
  'APP_ORIGIN: must be an exact origin',
  'APP_ORIGIN: must be an exact https origin (http only for localhost), no path or trailing slash',
  ...['KEY_LINKS', 'KEY_SESSIONS', 'KEY_RATE'].map((n) => `${n}: must be at least 43 base64url characters (256-bit key)`),
  'KEY_LINKS: the three keys must differ',
  'DATABASE_URL: must be a postgres:// URL',
  "EMAIL_MODE: must be 'test' or 'production'",
  'TRUSTED_PROXY_HOPS: must be an integer 0-5',
  'DB_ACQUIRE_TIMEOUT_MS: must be an integer number of milliseconds, 500-30000',
  'PORT: must be a port number',
];
const CONFIG_ERROR_LINES = new Set([...CONFIG_ERROR_MESSAGES, ...CONFIG_ERROR_MESSAGES.map((m) => `ConfigError: ${m}`)]);
/**
 * ALLOW-LIST of every structured log event the app server can print (enumerated from the log(...) calls under app/server:
 * main.ts, app.ts, batch/routes.ts, http/node-adapter.ts; scripts/verify-app-staging-contract.mjs re-derives the list from the
 * source and fails on any difference). A field spec is DATA, one of: { enum: [...] } fixed category strings, { int: max } a whole
 * number 0..max, { pattern: <name in FIELD_PATTERNS> } a tight id/route shape. There is no free-text kind, by design.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROUTE = /^(?:session|\/api(?:\/(?:[a-z]{1,20}(?:-[a-z]{1,20})?|:id)){0,5})$/;
export const FIELD_PATTERNS = { uuid: UUID, route: ROUTE };
const POOL = { enum: ['auth', 'data'] };
export const APP_LOG_EVENTS = {
  listening: { port: { int: 65535 } },
  db_warmup: { pool: POOL, open: { int: 1000 }, ms: { int: 3_600_000 } },
  operator_alert: {
    category: { enum: ['db_pool_acquire_failed', 'db_unavailable_at_start', 'client_ip_unavailable', 'signin_admission_unavailable', 'signin_identity_work_failed', 'provider_rate_limited', 'provider_configuration', 'provider_unreachable'] },
    pool: POOL,
  },
  server_error: { route: { pattern: 'route' } },
  signin_admission_failed: {},
  signin_identity_work_failed: {},
  signout_revoke_failed: { outcome: { enum: ['unknown', 'failed'] } },
  touch_failed: {},
  unhandled_request_error: {},
  shutdown_started: { accepted: { int: 1_000_000 }, continuations: { int: 1_000_000 }, budgetMs: { int: 3_600_000 } },
  shutdown: { abandoned: { int: 1_000_000 } },
  batch_renamed: { batch: { pattern: 'uuid' }, actor: { pattern: 'uuid' } },
  batch_deleted: { batch: { pattern: 'uuid' }, actor: { pattern: 'uuid' } },
};
const AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function fieldOk(spec, v) {
  if (has(spec, 'enum')) return typeof v === 'string' && spec.enum.includes(v);
  if (has(spec, 'int')) return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= spec.int;
  if (has(spec, 'pattern')) return typeof v === 'string' && v.length <= 80 && FIELD_PATTERNS[spec.pattern].test(v);
  return false;
}

/** Masks each target, and also every URL-encoded target in any mix of upper/lower-case hex digits. A second layer; the allow-list is the gate. */
export function maskLine(text, targets) {
  let out = scrub(text, targets);
  for (const t of targets) {
    if (!/%[0-9A-Fa-f]{2}/.test(t)) continue;
    const re = t.split(/(%[0-9A-Fa-f]{2})/).map((part, i) => (i % 2 === 1
      ? part.replace(/[0-9A-Fa-f]/g, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`)
      : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('');
    out = out.replace(new RegExp(re, 'g'), '<masked>');
  }
  return out;
}

/**
 * Returns the line to show or null (withheld). A line is shown only if it is a JSON object whose `at` is a strict UTC timestamp,
 * whose `event` is on APP_LOG_EVENTS, whose every field is on that event's list and whose every value fits that field's strict
 * spec; it is then rebuilt from the checked values (fixed key order). Anything else, including any extra field, is withheld whole
 * (`counter.fields` counts the offending fields). The only non-JSON lines are the exact fixed config-error messages.
 * `targets` (launcherMaskTargets of every secret) are masked in the raw line before parsing and in the final line as a second layer.
 */
export function appLogLine(raw, counter = { fields: 0 }, targets = []) {
  const line = raw.replace(/\r?\n$/, '');
  if (CONFIG_ERROR_LINES.has(line)) return line;
  let obj;
  try { obj = JSON.parse(maskLine(line, targets)); } catch { return null; }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (typeof obj.at !== 'string' || !AT.test(obj.at) || Number.isNaN(Date.parse(obj.at)) || typeof obj.event !== 'string' || !has(APP_LOG_EVENTS, obj.event)) return null;
  const spec = APP_LOG_EVENTS[obj.event];
  const out = { at: obj.at, event: obj.event };
  let bad = 0;
  for (const k of Object.keys(obj)) {
    if (k === 'at' || k === 'event') continue;
    if (!has(spec, k) || !fieldOk(spec[k], obj[k])) { bad += 1; continue; }
  }
  if (bad > 0) { counter.fields += bad; return null; }
  for (const k of Object.keys(spec)) if (has(obj, k)) out[k] = obj[k];
  return maskLine(JSON.stringify(out), targets);
}

const MAX_PENDING = 65_536;

function sinkFor(sink, targets, counter) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let overflow = false;
  const emit = (l) => {
    const shown = appLogLine(l, counter, targets);
    if (shown === null) { counter.lines += 1; return; }
    sink.write(`${shown}\n`);
  };
  return {
    write(chunk) {
      pending += decoder.write(chunk);
      let idx;
      while ((idx = pending.indexOf('\n')) >= 0) {
        const l = pending.slice(0, idx);
        pending = pending.slice(idx + 1);
        if (overflow) overflow = false; else emit(l);
      }
      if (pending.length > MAX_PENDING) { if (!overflow) counter.lines += 1; overflow = true; pending = ''; }
    },
    end() { pending += decoder.end(); if (pending && !overflow) emit(pending); pending = ''; },
  };
}

/** `entry` and `nodeBinary` are for tests only (a fake app); the command line cannot change them. */
export async function main({ argv, env = process.env, stdout = process.stdout, stderr = process.stderr, nodeBinary = process.execPath, appDir = resolve(REPO_ROOT, 'app'), entry = 'dist-server/main.js', onChild }) {
  const { port } = parseAppArgs(argv);
  const childEnv = buildAppEnv(env, port);
  if (!existsSync(resolve(appDir, entry))) throw new Error('refusing: app/dist-server/main.js is not built (run `npm run build:server` in app first; this launcher builds and installs nothing)');
  const targets = [...new Set(APP_SECRET_NAMES.flatMap((n) => launcherMaskTargets(childEnv[n])))].sort((a, b) => b.length - a.length);
  const counter = { lines: 0, fields: 0 };
  return new Promise((done, fail) => {
    const child = spawn(nodeBinary, [entry], { cwd: appDir, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    if (onChild) onChild(child);
    stdout.write(`run-app-staging: starting app on http://localhost:${port} (target checked: staging-2, ${APP_ROLE}; EMAIL_MODE=test; bound to ${BIND_HOST})\n`);
    const out = sinkFor(stdout, targets, counter);
    const err = sinkFor(stderr, targets, counter);
    child.stdout.on('data', (c) => out.write(c));
    child.stderr.on('data', (c) => err.write(c));
    child.on('error', (e) => fail(new Error(scrub(String(e.message), targets))));
    child.on('close', (code) => {
      out.end(); err.end();
      stdout.write(`run-app-staging: exit code ${code ?? 1}; ${counter.lines} output line(s) withheld; ${counter.fields} field(s) withheld\n`);
      done(code ?? 1);
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let child;
  const forward = (sig) => () => { if (child) child.kill(sig); };
  process.on('SIGINT', forward('SIGINT'));
  process.on('SIGTERM', forward('SIGTERM'));
  main({ argv: process.argv.slice(2), onChild: (c) => { child = c; } }).then((code) => { process.exitCode = code; }, (e) => { console.error(e.message); process.exitCode = 2; });
}
