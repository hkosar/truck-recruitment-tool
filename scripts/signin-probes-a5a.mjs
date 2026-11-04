#!/usr/bin/env node
// A5a driver: the stateless (class A) sign-in probes of doc 14 §8.1, aimed at the same-origin sign-in app on THIS computer.
// Doc: docs/build-plan/20-signin-probe-driver-a5a.md. Usage:
//
//   node scripts/signin-probes-a5a.mjs --origin http://127.0.0.1:8788 --app-origin <APP_ORIGIN of the app>
//
// What it does: sends 80 requests that can only be answered with a refusal, a redirect, a fixed page or an empty result:
// no login, no cookie sent, no key, no mail (it never calls /auth/request, which is what could start a mail), no write
// (every state-changing request is refused before the app reaches the database). Redirects: a Location must be a path on
// the app (one leading "/") or start with exactly --app-origin (optional, text comparison only, never connected to);
// any other host fails the probe with "location". Each request has a TOTAL time limit (10 s, body included) and a 256 KB body
// cap; a breach fails the probe ("network" / "body"). A run that executes nothing exits 3. It prints ONLY fixed JSON events:
//   {"event":"probe","id":"<fixed id>","result":"pass"}
//   {"event":"probe","id":"<fixed id>","result":"fail","reason":"status|location|body|header|cookie|leak|network"}
//   {"event":"summary","pass":N,"fail":M,"expected":N}
// Never printed: URLs, cookies, tokens, links, response bodies, header values, error texts. Exit 0 only if every probe passed
// and the expected number of probes ran.
//
// Refuses any origin that is not exactly http://localhost:<port> or http://127.0.0.1:<port> (no path, query, user or fragment),
// and always connects to 127.0.0.1 (a "localhost" name is never resolved), so it cannot reach another machine.
//
// Scope note (doc 14 §8.1): class A names GETs/RPCs on the hosted Supabase REST, GraphQL, Storage and Realtime surfaces with
// the public anon key. Those need the hosted project address and the anon key and are NOT done here (this driver refuses
// non-local origins and uses no key). This driver covers the same-origin app's own surface and checks that the app does not
// serve any Supabase-style route itself.

import { request } from 'node:http';
import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LOCAL_HOSTS = ['localhost', '127.0.0.1'];
export const CONNECT_HOST = '127.0.0.1';
export const REQUEST_TIMEOUT_MS = 10_000;
const MAX_BODY = 262_144;
const ZERO_UUID = '00000000-0000-4000-8000-000000000000';
const FOREIGN_ORIGIN = 'https://probe.example.invalid';
const SIGNED_OUT = { status: [401], json: 'signed_out' };

/** Throws a fixed message (no input echoed) unless `raw` is exactly a local http origin with a port. */
export function parseLocalOrigin(raw) {
  const refuse = () => { throw new Error('refusing: --origin must be exactly http://localhost:<port> or http://127.0.0.1:<port> (this computer only)'); };
  if (typeof raw !== 'string' || !/^http:\/\/(localhost|127\.0\.0\.1):\d{1,5}$/.test(raw)) refuse();
  let u;
  try { u = new URL(raw); } catch { return refuse(); }
  const port = Number(u.port);
  if (!LOCAL_HOSTS.includes(u.hostname) || !Number.isInteger(port) || port < 1 || port > 65535 || u.username || u.password || u.search || u.hash || u.pathname !== '/') refuse();
  return { hostHeader: `${u.hostname}:${port}`, port };
}

/** Throws a fixed message unless `raw` is exactly scheme://host[:port] (lower case, no path, query, user or fragment). Only compared as text, never connected to. */
export function parseAppOrigin(raw) {
  const refuse = () => { throw new Error('refusing: --app-origin must be exactly http(s)://<host>[:<port>] with no path, query or user'); };
  if (typeof raw !== 'string' || !/^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/.test(raw)) refuse();
  let u;
  try { u = new URL(raw); } catch { return refuse(); }
  if (u.origin !== raw) refuse();
  return raw;
}

const USAGE = 'usage: node scripts/signin-probes-a5a.mjs --origin http://127.0.0.1:<port> [--app-origin <origin>]';
export function parseArgs(argv) {
  let origin;
  let appOrigin;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--origin' && origin === undefined) origin = argv[++i];
    else if (argv[i] === '--app-origin' && appOrigin === undefined) appOrigin = argv[++i];
    else throw new Error(USAGE);
  }
  if (origin === undefined) throw new Error(USAGE);
  return appOrigin === undefined ? { origin } : { origin, appOrigin };
}

// One request with a TOTAL time limit (connect, headers and the whole body) and a body cap; either breach ends the exchange at once.
function send(target, { method = 'GET', path, headers = {}, body }, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    let req;
    const timer = setTimeout(() => finish({ ok: false }), timeoutMs);
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
      req?.destroy();
    };
    const h = { host: target.hostHeader, connection: 'close', ...headers };
    if (body !== undefined) h['content-length'] = String(Buffer.byteLength(body));
    // agent: false = a private agent, never the global one of Node, so NODE_USE_ENV_PROXY / --use-env-proxy with HTTP_PROXY cannot route a probe elsewhere.
    req = request({ host: CONNECT_HOST, port: target.port, method, path, headers: h, agent: false }, (res) => {
      const base = { ok: true, status: res.statusCode ?? 0, headers: res.headers, cookies: [].concat(res.headers['set-cookie'] ?? []) };
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) finish({ ...base, tooBig: true, body: '' });
        else chunks.push(c);
      });
      res.on('end', () => finish({ ...base, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', () => finish({ ok: false }));
      res.on('aborted', () => finish({ ok: false }));
    });
    req.on('error', () => finish({ ok: false }));
    req.end(body);
  });
}

// A cookie the app may set on a signed-out request: only one that clears (empty value, Max-Age=0).
const isClearing = (c) => /^[^=]+=;/.test(c) && /;\s*Max-Age=0(;|$)/i.test(c);
// Things that must never appear in any response here (header names, header values or body): a link token, a session/confirm
// cookie value, an email address, a UUID, a JWT, a bearer credential, or a long opaque string (32+ token characters with a digit).
const LEAK_SHAPES = [
  /token=[A-Za-z0-9_-]{16,}/,
  /__Host-tr_[a-z_]+=[A-Za-z0-9_-]{16,}/,
  /[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/,
  /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /(?=[A-Za-z0-9_-]*[0-9])(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}/,
];
// The sign-in page shows this fixed example address as the input placeholder; this exact attribute text is the one email
// allowed in a body, and only for a probe whose expectation sets `allowPlaceholder`.
const PLACEHOLDER_ATTR = 'placeholder="you@example.com"';
// Turns the encoded forms of "@" (percent, HTML entity, backslash escape, full-width) and zero-width characters into plain text,
// repeatedly so double encoding is undone too, so an encoded address is matched like a plain one.
function decodeAt(text) {
  let t = text;
  for (let i = 0; i < 4; i += 1) {
    const next = t.normalize('NFKC')
      .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
      .replace(/%25/g, '%')
      .replace(/%40/gi, '@')
      .replace(/&#0*64;|&#x0*40;|&commat;/gi, '@')
      .replace(/\\x40|\\u0040|\\u\{0*40\}/gi, '@');
    if (next === t) break;
    t = next;
  }
  return t;
}
// The --app-origin text is the one host name a redirect may name; a long host label (hyphens + a digit) must not trip the opaque-string rule.
// So the exact origin text is blanked out for the opaque-string rule (the last shape) ONLY. Every other shape (token=, cookie, email, UUID, JWT,
// bearer) is scanned on the raw text, so a secret that starts inside the origin text (for example "<origin>@evil.example") is still caught.
const withoutOrigin = (text, appOrigin) => (appOrigin === undefined ? text : text.split(appOrigin).join(' '));
const OPAQUE_SHAPE = LEAK_SHAPES[LEAK_SHAPES.length - 1];
const leaks = (text, appOrigin) => {
  const scan = (t) => LEAK_SHAPES.slice(0, -1).some((re) => re.test(t)) || OPAQUE_SHAPE.test(withoutOrigin(t, appOrigin));
  return scan(text) || scan(decodeAt(text));
};
const headerText = (headers) => Object.entries(headers ?? {}).map(([k, v]) => `${k}: ${[].concat(v).join(', ')}`).join('\n');

/** The path of a redirect target if it stays on the app (one leading "/", or exactly `appOrigin` + path), else null. */
function localPath(loc, appOrigin) {
  if (/^\/(?![/\\])/.test(loc)) return loc;
  if (appOrigin !== undefined && loc.startsWith(`${appOrigin}/`) && !/^\/[/\\]/.test(loc.slice(appOrigin.length))) return loc.slice(appOrigin.length);
  return null;
}

/** Returns null when the response meets the expectation, else a fixed reason word. `appOrigin` (optional) is the one origin a redirect may name. */
export function judge(res, exp, appOrigin) {
  if (!res.ok) return 'network';
  if (res.cookies.some((c) => !isClearing(c))) return 'cookie';
  const scanBody = exp.allowPlaceholder ? res.body.replaceAll(PLACEHOLDER_ATTR, '') : res.body;
  if (leaks(scanBody, appOrigin) || leaks(headerText(res.headers), appOrigin)) return 'leak';
  if (res.tooBig) return 'body';
  if (!exp.status.includes(res.status)) return 'status';
  if (exp.location !== undefined) {
    const loc = res.headers.location;
    const path = typeof loc === 'string' ? localPath(loc, appOrigin) : null;
    if (path === null || !exp.location.test(path)) return 'location';
  }
  if (exp.json !== undefined) {
    let parsed;
    try { parsed = JSON.parse(res.body); } catch { return 'body'; }
    if (!parsed || typeof parsed !== 'object' || parsed.error !== exp.json || Object.keys(parsed).length !== 1) return 'body';
  }
  if (exp.notJson && /json/i.test(String(res.headers['content-type'] ?? ''))) return 'body';
  for (const s of exp.bodyHas ?? []) if (!res.body.includes(s)) return 'body';
  for (const s of exp.bodyLacks ?? []) if (res.body.includes(s)) return 'body';
  if (exp.exactBody !== undefined && res.body !== exp.exactBody) return 'body';
  for (const [k, v] of Object.entries(exp.headers ?? {})) {
    const got = String(res.headers[k] ?? '');
    if (v instanceof RegExp ? !v.test(got) : got !== v) return 'header';
  }
  return null;
}

const JSON_POST = { 'content-type': 'application/json', origin: FOREIGN_ORIGIN };
const NAV = { accept: 'text/html', 'sec-fetch-mode': 'navigate' };
const toSignin = /^\/signin$/;
const toConfirm = /^\/auth\/confirm\?x=[A-Za-z0-9_-]+$/;
const PAGE_HEADERS = { 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'content-security-policy': /frame-ancestors 'none'/ };
const staleExp = { status: [200], bodyHas: ['/signin'], bodyLacks: ['name="csrf_token"', 'name="nonce"'], headers: PAGE_HEADERS };

function buildProbes() {
  const p = [];
  const add = (id, req, exp) => p.push({ id, req, exp });
  add('ready', { path: '/readyz' }, { status: [200], exactBody: 'ok', headers: { 'cache-control': 'no-store' } });
  add('signin-page', { path: '/signin' }, { status: [200], bodyHas: ['action="/auth/request"', 'type="email"'], bodyLacks: ['type="password"'], headers: PAGE_HEADERS, allowPlaceholder: true });
  for (const path of ['/login', '/register', '/forgot', '/reset', '/pending']) add(`legacy${path}`, { path }, { status: [303], location: toSignin });
  const apiGets = ['/api/session', '/api/dashboard', '/api/team', `/api/batches/${ZERO_UUID}`, `/api/batches/${ZERO_UUID}/activity`, `/api/batches/${ZERO_UUID}/sheet-header`, '/api/carriers/1/profile', '/api/batches', '/api/nonexistent'];
  for (const path of apiGets) add(`api-get${path.replace(ZERO_UUID, ':id')}`, { path }, SIGNED_OUT);
  const rpcs = ['search_carriers', 'count_carriers', 'facet_other_values', 'facet_suggested_keywords', 'facet_cargo_flags', 'search_carriers_map', 'batch_members', 'batch_members_map', 'batch_status_counts', 'dashboard_totals', 'is_contactable', 'generate_contact_sheet', 'create_batch', 'refresh_batch', 'bulk_set_status', 'set_do_not_contact', 'log_export'];
  for (const name of rpcs) add(`api-rpc/${name}`, { method: 'POST', path: `/api/rpc/${name}`, headers: JSON_POST, body: '{}' }, SIGNED_OUT);
  const apiPosts = ['/api/session/activity', '/api/contact-logs', '/api/dnc/lookup', '/api/team/add', '/api/team/edit', '/api/team/deactivate', '/api/team/reactivate', '/api/team/sign-everyone-out', '/api/batch-carriers/status', '/api/batch-carriers/promote', `/api/batches/${ZERO_UUID}/comments`];
  for (const path of apiPosts) add(`api-post${path.replace(ZERO_UUID, ':id')}`, { method: 'POST', path, headers: JSON_POST, body: '{}' }, SIGNED_OUT);
  add('api-post-no-origin', { method: 'POST', path: '/api/rpc/create_batch', headers: { 'content-type': 'application/json' }, body: '{}' }, SIGNED_OUT);
  for (const method of ['PUT', 'DELETE', 'PATCH', 'OPTIONS']) add(`api-${method.toLowerCase()}`, { method, path: '/api/team', headers: method === 'OPTIONS' ? {} : JSON_POST, body: method === 'OPTIONS' ? undefined : '{}' }, SIGNED_OUT);
  add('spa-root-navigate', { path: '/', headers: NAV }, { status: [303], location: toSignin });
  add('spa-deep-navigate', { path: '/batches/anything', headers: NAV }, { status: [303], location: toSignin });
  add('spa-root-non-navigate', { path: '/' }, { status: [404], notJson: true });
  const junk = 'A'.repeat(43);
  for (const [id, q] of [['verify-junk-long', `?token=${junk}`], ['verify-junk-short', '?token=x'], ['verify-missing', '']]) {
    add(id, { path: `/auth/verify${q}` }, { status: [303], location: toConfirm, headers: { 'referrer-policy': 'no-referrer' } });
  }
  add('confirm-no-cookie', { path: '/auth/confirm?x=abc' }, staleExp);
  add('confirm-no-query', { path: '/auth/confirm' }, staleExp);
  const form = { 'content-type': 'application/x-www-form-urlencoded' };
  for (const [id, origin] of [['no-origin', undefined], ['null-origin', 'null'], ['foreign-origin', FOREIGN_ORIGIN]]) {
    add(`confirm-post-${id}`, { method: 'POST', path: '/auth/confirm', headers: { ...form, ...(origin ? { origin } : {}) }, body: 'nonce=abc&csrf_token=abc' }, staleExp);
    add(`signout-post-${id}`, { method: 'POST', path: '/auth/signout', headers: { ...form, ...(origin ? { origin } : {}) }, body: 'csrf_token=abc' }, { status: [403], exactBody: 'Forbidden' });
  }
  const surface = ['/rest/v1/', '/rest/v1/carriers', '/rest/v1/profiles', '/graphql/v1', '/storage/v1/bucket', '/realtime/v1/websocket', '/auth/v1/token?grant_type=password', '/auth/v1/user'];
  for (const path of surface) add(`no-supabase-get${path.split('?')[0]}`, { path }, { status: [404], notJson: true });
  for (const path of ['/rest/v1/rpc/search_carriers', '/rest/v1/carriers', '/graphql/v1', '/auth/v1/token?grant_type=password', '/auth/v1/otp', '/auth/v1/recover', '/auth/v1/signup', '/storage/v1/object/list/x']) {
    add(`no-supabase-post${path.split('?')[0]}`, { method: 'POST', path, headers: { 'content-type': 'application/json', apikey: 'probe-not-a-key' }, body: '{}' }, { status: [405], notJson: true });
  }
  add('webhook-unsigned', { method: 'POST', path: '/webhooks/sendgrid', headers: { 'content-type': 'application/json' }, body: '[]' }, { status: [401, 404] });
  return p;
}

export const PROBES = buildProbes();
export const PROBE_COUNT = PROBES.length;

/** Runs every probe in order. `emit` receives each fixed event object. Returns { pass, fail, expected }. */
export async function runClassA(origin, emit = () => {}, { appOrigin, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const target = parseLocalOrigin(origin);
  if (appOrigin !== undefined) parseAppOrigin(appOrigin);
  let pass = 0;
  let fail = 0;
  for (const probe of PROBES) {
    const res = await send(target, probe.req, timeoutMs);
    const reason = judge(res, probe.exp, appOrigin);
    if (reason === null) { pass += 1; emit({ event: 'probe', id: probe.id, result: 'pass' }); }
    else { fail += 1; emit({ event: 'probe', id: probe.id, result: 'fail', reason }); }
  }
  emit({ event: 'summary', pass, fail, expected: PROBES.length });
  return { pass, fail, expected: PROBES.length };
}

/** 0 only when every expected probe ran and passed; 3 when nothing ran (never a silent success); 1 otherwise. */
export function exitCodeFor({ pass, fail, expected }) {
  if (pass + fail === 0) return 3;
  return fail === 0 && pass === expected ? 0 : 1;
}

async function main() {
  let origin;
  let appOrigin;
  try {
    ({ origin, appOrigin } = parseArgs(process.argv.slice(2)));
    parseLocalOrigin(origin);
    if (appOrigin !== undefined) parseAppOrigin(appOrigin);
  } catch (err) { process.stderr.write(`${err.message}\n`); return 2; }
  const code = exitCodeFor(await runClassA(origin, (e) => process.stdout.write(`${JSON.stringify(e)}\n`), { appOrigin }));
  if (code === 3) process.stderr.write('error: no probes were executed\n');
  return code;
}

// True when this file is the script node was started with, also through a linked folder (junction or symlink) or another path spelling.
function isEntryPoint() {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  try { if (realpathSync(entry).toLowerCase() === realpathSync(self).toLowerCase()) return true; } catch { /* fall back to the name */ }
  return basename(entry).toLowerCase() === basename(self).toLowerCase();
}

if (isEntryPoint()) {
  main().then((code) => { process.exitCode = code; }, () => { process.stderr.write('error: probe run failed\n'); process.exitCode = 3; });
}
