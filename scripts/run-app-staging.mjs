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
// secrets, DOPPLER_TOKEN, SENDGRID_*) is dropped. Output: only the app's own structured log lines ({"at","event",...}; flat, short
// values) and fixed config-error lines pass, with the secrets masked (same masking as run-with-secrets.mjs); everything else is withheld
// and counted. Environment values are never printed. Exit status is the child's.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RECORDED_PROJECT_REFS, parseSupabaseDbTarget } from '../pipeline/src/target-guard.ts';
import { maskTargets, scrub } from './run-with-secrets.mjs';

export const APP_STAGING_PROJECT = 'truck-recruitment-tool';
export const APP_STAGING_CONFIG = 'stg';
/** The only Doppler names the app needs (app/server/config.ts). Nothing else is read from the environment. */
export const APP_SECRET_NAMES = ['DATABASE_URL', 'KEY_LINKS', 'KEY_SESSIONS', 'KEY_RATE'];
export const APP_BASE_NAMES = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'];
export const APP_ROLE = 'recruiter_app';
export const APP_DB_PORT = 5432;
export const DEFAULT_PORT = 8788;
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

const CONFIG_ERROR = /^(?:ConfigError: )?[A-Z][A-Z0-9_]{2,40}: (?:is required|must [^=\n]{1,120}|the three keys must differ)$/;
const MAX_VALUE = 200;

/**
 * Returns the line to show or null (withheld). Accepts the app's structured log line: a flat JSON object with an ISO `at`,
 * an `event` of lowercase words, and primitive values only (strings capped); or a fixed config-error line.
 */
export function appLogLine(raw, counter = { fields: 0 }) {
  const line = raw.replace(/\r?\n$/, '');
  if (CONFIG_ERROR.test(line)) return line;
  let obj;
  try { obj = JSON.parse(line); } catch { return null; }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (typeof obj.at !== 'string' || Number.isNaN(Date.parse(obj.at)) || typeof obj.event !== 'string' || !/^[a-z][a-z0-9_]{0,60}$/.test(obj.event)) return null;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(k)) { counter.fields += 1; continue; }
    if (typeof v === 'string' ? v.length <= MAX_VALUE : (typeof v === 'number' || typeof v === 'boolean' || v === null)) out[k] = v;
    else { out[k] = '<withheld>'; counter.fields += 1; }
  }
  return JSON.stringify(out);
}

function sinkFor(sink, targets, counter) {
  let pending = '';
  const emit = (l) => {
    const shown = appLogLine(l, counter);
    if (shown === null) { counter.lines += 1; return; }
    sink.write(`${scrub(shown, targets)}\n`);
  };
  return {
    write(chunk) {
      pending += chunk.toString('utf8');
      let idx;
      while ((idx = pending.indexOf('\n')) >= 0) { emit(pending.slice(0, idx)); pending = pending.slice(idx + 1); }
    },
    end() { if (pending) emit(pending); pending = ''; },
  };
}

/** `entry` and `nodeBinary` are for tests only (a fake app); the command line cannot change them. */
export async function main({ argv, env = process.env, stdout = process.stdout, stderr = process.stderr, nodeBinary = process.execPath, appDir = resolve(REPO_ROOT, 'app'), entry = 'dist-server/main.js', onChild }) {
  const { port } = parseAppArgs(argv);
  const childEnv = buildAppEnv(env, port);
  if (!existsSync(resolve(appDir, entry))) throw new Error('refusing: app/dist-server/main.js is not built (run `npm run build:server` in app first; this launcher builds and installs nothing)');
  const targets = [...new Set(APP_SECRET_NAMES.flatMap((n) => maskTargets(childEnv[n])))].sort((a, b) => b.length - a.length);
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
