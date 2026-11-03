#!/usr/bin/env node
// Class A hosted probes (doc 14 section 8.1, approval A5a): stateless, read-only, public anon key only,
// against the recorded staging-2 project ONLY.
//
//   node scripts/signin-probes-hosted-a5a.mjs                          plan only (no key needed, no network)
//   node scripts/signin-probes-hosted-a5a.mjs --execute [--phase=after|before] [--realtime-seconds=N]
//
// Future command (NOT RUN; blocked until M1 is applied on staging-2 and Hunter says go):
//   doppler --config-dir "$env:USERPROFILE\.doppler-truck-stg" --no-read-env --no-check-version --scope "<this checkout's absolute path>" run --no-fallback --project truck-recruitment-tool --config stg -- node scripts/signin-probes-hosted-a5a.mjs --execute --phase=after
//
// Reads from the environment: VITE_SUPABASE_ANON_KEY (required to execute; never printed) and optionally
// VITE_SUPABASE_URL (must equal the staging-2 URL if set). The target URL is always derived from the staging-2
// ref recorded in pipeline/src/target-guard.ts; the production and old-staging refs are refused.
//
// Requests: GET, plus POST only to the read-only RPCs listed below, /graphql/v1 and the Storage list endpoint.
// Output: fixed event lines only (probe name, expected class, observed class, result). No response bodies,
// headers, keys or key-carrying URLs are ever printed.
//
// Key control: the FIRST request is GET /auth/v1/health with the anon key. It must answer 200; otherwise the run
// aborts (ABORTED reason=key_rejected) before any data probe is sent. Result classes:
//   denied        = the database itself refused the anon role (PostgREST 42501, or a Storage/GraphQL permission error)
//   key-rejected  = the key was refused (gateway "Invalid API key", PGRST300-302, 401/403 without 42501): FAIL, reason=key_rejected
//   unexpected    = a 3xx redirect (never followed): FAIL
//
// GraphQL / PostGIS triage rule (decide BEFORE the first run; never loosen a check on the spot): the introspection
// probe FAILs if any OBJECT type is exposed. If the only exposed types are PostGIS reference tables (for example
// spatial_ref_sys, from "create extension postgis" in public), that is a known false failure: report it as
// FAIL-known-postgis in the written run report, do not edit this tool during the run, and fix the grant (revoke on
// spatial_ref_sys from anon) or record the owner's decision in doc 14 section 8.1 before re-running. Any other
// exposed type is a real failure.
//
// --phase=after  (default): PASS = denied, empty or absent everywhere and no Realtime event (doc 14 8.1).
// --phase=before: records today's classes; result is RECORDED unless the request itself failed (transport/5xx).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REF_PATTERN = /^[a-z]{20}$/;
export const PRODUCTION_REF = 'ejrfobddnojbijzrjbii';
export const OLD_STAGING_REF = 'yhyoxhtguyturgdhwywc';

/** Staging-2 ref: read from the recorded constant in target-guard.ts (single source of truth). */
export function recordedStagingRef(root = join(HERE, '..')) {
  const text = readFileSync(join(root, 'pipeline', 'src', 'target-guard.ts'), 'utf8');
  const m = /const REBUILT_STAGING_PROJECT_REF[^=]*=\s*'([a-z]{20})'/.exec(text);
  if (!m) throw new Error('target-guard.ts: REBUILT_STAGING_PROJECT_REF literal not found');
  return m[1];
}

// Every public table (migrations/*.sql) and view; internal.* and the M1 tables are not exposed.
export const PROBE_TABLES = [
  'batch_activity', 'batch_carriers', 'batch_zones', 'batches', 'cargo_other_values', 'carrier_inspections',
  'carrier_insurance', 'carrier_insurance_filings', 'carrier_qc_snapshots', 'carrier_safety', 'carriers',
  'city_centroids', 'contact_logs', 'contact_suppressions', 'data_quality_reports', 'pipeline_config',
  'pipeline_runs', 'profiles', 'sync_runs', 'zip_centroids', 'batch_dashboard', 'carrier_warnings',
];

// Read-only (STABLE) RPCs from doc 14 8.1. Arguments are inert placeholders.
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
export const READ_ONLY_RPCS = {
  search_carriers: { p_definition: {}, p_page: 1, p_page_size: 1 },
  count_carriers: { p_definition: {} },
  facet_other_values: { p_definition: {}, p_keyword: null, p_limit: 1, p_offset: 0 },
  facet_suggested_keywords: { p_definition: {} },
  facet_cargo_flags: { p_definition: {} },
  dashboard_totals: {},
  batch_status_counts: { p_batch_id: NIL_UUID },
  is_contactable: { p_dot: 0, p_channel: 'call' },
  search_carriers_map: { p_definition: {}, p_limit: 1 },
  batch_members: { p_batch_id: NIL_UUID, p_page: 1, p_page_size: 1 },
  batch_members_map: { p_batch_id: NIL_UUID },
  generate_contact_sheet: { p_batch_id: NIL_UUID },
  // Added by pending M1 (404 before M1 = absent):
  team_list: {},
  recovery_batches: {},
  recovery_batch_members: { p_batch_id: NIL_UUID, p_limit: 1, p_offset: 0 },
};

// Tables in the supabase_realtime publication (20260720001300_realtime.sql).
export const REALTIME_TABLES = ['batches', 'batch_zones', 'batch_carriers', 'batch_activity', 'contact_logs', 'profiles'];

const PASS_CLASSES = new Set(['denied', 'empty', 'absent']);
const HARD_FAIL_CLASSES = new Set(['transport-error', 'server-error', 'key-rejected', 'unexpected']);
const KEY_ERROR_TEXT = /invalid api key|jwt|token|signature|apikey|api key/i;
export const REALTIME_CONNECT_TIMEOUT_MS = 15000;
const BUCKET_NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** The only requests this tool may ever send. */
export function isAllowedRequest(method, path) {
  if (method === 'GET') return /^\/(rest\/v1\/[a-z_]+\?select=\*&limit=1|storage\/v1\/bucket|auth\/v1\/health)$/.test(path);
  if (method !== 'POST') return false;
  const rpc = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(path);
  if (rpc) return Object.prototype.hasOwnProperty.call(READ_ONLY_RPCS, rpc[1]);
  if (path === '/graphql/v1') return true;
  return /^\/storage\/v1\/object\/list\/[A-Za-z0-9._-]{1,100}$/.test(path);
}

export function checkTarget({ ref, env = {}, flagRef, stagingRef }) {
  const failures = [];
  if (!REF_PATTERN.test(ref ?? '')) failures.push('the recorded staging-2 ref is not a 20-letter project ref');
  if (ref === PRODUCTION_REF) failures.push('the target is the production project; refusing');
  if (ref === OLD_STAGING_REF) failures.push('the target is the old staging project; refusing');
  if (flagRef !== undefined && flagRef !== stagingRef) failures.push('--project-ref is not the recorded staging-2 project; refusing');
  if (env.VITE_SUPABASE_URL !== undefined && env.VITE_SUPABASE_URL !== `https://${stagingRef}.supabase.co`) {
    failures.push('VITE_SUPABASE_URL is not exactly the recorded staging-2 URL; refusing');
  }
  return failures;
}

function jwtClaims(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/** Failure strings (never containing the key) for the anon key in the environment. */
export function checkAnonKey(key, stagingRef) {
  if (!key) return ['VITE_SUPABASE_ANON_KEY is missing'];
  if (/^sb_secret_/.test(key)) return ['VITE_SUPABASE_ANON_KEY is a secret key; only the public anon key may be used'];
  if (/\s/.test(key)) return ['VITE_SUPABASE_ANON_KEY contains whitespace'];
  if (key.startsWith('sb_publishable_')) return [];
  const claims = jwtClaims(key);
  if (!claims) return ['VITE_SUPABASE_ANON_KEY is neither a publishable key nor a JWT'];
  const failures = [];
  if (claims.role !== 'anon') failures.push('VITE_SUPABASE_ANON_KEY does not carry the anon role');
  if (claims.ref !== stagingRef) failures.push('VITE_SUPABASE_ANON_KEY does not carry the staging-2 project ref');
  return failures;
}

/** Refuse any setting that weakens certificate verification (doppler run could inject one). */
export function checkTls(env = {}) {
  if (String(env.NODE_TLS_REJECT_UNAUTHORIZED ?? '').trim() === '0') return 'NODE_TLS_REJECT_UNAUTHORIZED=0 disables certificate verification; refusing';
  if (/--insecure|--tls-/i.test(String(env.NODE_OPTIONS ?? ''))) return 'NODE_OPTIONS changes TLS settings; refusing';
  return undefined;
}

export function buildPlan(phase, realtimeSeconds) {
  const plan = [{ name: 'control:key-accepted', method: 'GET', path: '/auth/v1/health', expected: 'accepted (200); otherwise the run aborts' }];
  for (const t of PROBE_TABLES) plan.push({ name: `rest-get:${t}`, method: 'GET', path: `/rest/v1/${t}?select=*&limit=1` });
  for (const r of Object.keys(READ_ONLY_RPCS)) plan.push({ name: `rpc:${r}`, method: 'POST', path: `/rest/v1/rpc/${r}` });
  plan.push({ name: 'graphql:introspection', method: 'POST', path: '/graphql/v1' });
  plan.push({ name: 'graphql:read-query', method: 'POST', path: '/graphql/v1' });
  plan.push({ name: 'storage:bucket-list', method: 'GET', path: '/storage/v1/bucket' });
  plan.push({ name: 'storage:object-list', method: 'POST', path: '/storage/v1/object/list/<each bucket found>' });
  for (const t of REALTIME_TABLES) plan.push({ name: `realtime:${t}`, method: 'WS', path: `/realtime/v1/websocket (${realtimeSeconds} s)` });
  return plan.map((p) => ({ ...p, expected: p.expected ?? (phase === 'after' ? 'denied|empty|absent (no event)' : 'recorded') }));
}

/** Classify an HTTP answer without ever returning or printing the body. */
export function classifyHttp(status, text) {
  if (status >= 300 && status < 400) return 'unexpected';
  if (status >= 500) return 'server-error';
  let body;
  try { body = text === '' ? undefined : JSON.parse(text); } catch { body = undefined; if (status >= 200 && status < 300 && text !== '') return 'data'; }
  if (status >= 400) {
    const obj = body && typeof body === 'object' ? body : {};
    const code = String(obj.code ?? '');
    const message = typeof obj.message === 'string' ? obj.message : '';
    const storageStatus = String(obj.statusCode ?? '');
    // Only the database refusing the anon role is "denied".
    if (code === '42501') return 'denied';
    if (code === '42883' || code === '42P01' || /^PGRST20[0-9]$/.test(code)) return 'absent';
    if (/^PGRST30[0-9]$/.test(code)) return 'key-rejected';
    const errorName = typeof obj.error === 'string' ? obj.error : '';
    if (code === '' && KEY_ERROR_TEXT.test(`${message} ${errorName}`)) return 'key-rejected';
    // Storage answers { statusCode: "403" | "404" } with no code.
    if (code === '' && storageStatus === '403') return 'denied';
    if (code === '' && storageStatus === '404') return 'absent';
    if (status === 401 || status === 403) return 'key-rejected';
    if (status === 404) return 'absent';
    return 'client-error';
  }
  if (status === 204 || body === undefined || body === null) return 'empty';
  if (Array.isArray(body)) return body.length === 0 ? 'empty' : 'data';
  if (typeof body === 'object') return Object.keys(body).length === 0 ? 'empty' : 'data';
  return 'data';
}

function classifyGraphql(status, text, mode) {
  const base = classifyHttp(status, text);
  // A 4xx that is not a database refusal (no errors list) is never a pass.
  if (base !== 'data' && base !== 'empty') return base;
  let body;
  try { body = JSON.parse(text); } catch { return 'data'; }
  if (!body || typeof body !== 'object') return 'empty';
  if (Array.isArray(body.errors) && body.errors.length > 0 && !body.data) return 'denied';
  const data = body.data;
  if (!data || typeof data !== 'object') return 'empty';
  if (mode === 'introspection') {
    const types = data.__schema?.types;
    if (!Array.isArray(types)) return 'empty';
    const exposed = types.filter((t) => t && t.kind === 'OBJECT' && typeof t.name === 'string' && !t.name.startsWith('__') && !['Query', 'Mutation', 'PageInfo'].includes(t.name));
    return exposed.length === 0 ? 'empty' : 'data';
  }
  const edges = data.carriersCollection?.edges;
  if (Array.isArray(edges)) return edges.length === 0 ? 'empty' : 'data';
  return 'empty';
}

/** Run every class A probe. `emit` receives fixed event strings only. Returns { pass, fail }. */
export async function runProbes({ baseUrl, key, phase = 'after', realtimeSeconds = 60, emit, fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket, connectTimeoutMs = REALTIME_CONNECT_TIMEOUT_MS }) {
  let pass = 0;
  let fail = 0;
  const record = (name, observed) => {
    let result;
    if (phase === 'after') result = PASS_CLASSES.has(observed) ? 'PASS' : 'FAIL';
    else result = HARD_FAIL_CLASSES.has(observed) ? 'FAIL' : 'RECORDED';
    if (result === 'FAIL') fail += 1; else pass += 1;
    emit(`EVENT probe=${name} expected=${phase === 'after' ? 'denied|empty|absent' : 'recorded'} observed=${observed} result=${result}${observed === 'key-rejected' ? ' reason=key_rejected' : ''}`);
  };

  const send = async (method, path, payload) => {
    if (!isAllowedRequest(method, path)) throw new Error('internal guard: request not on the read-only allow-list');
    const headers = { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' };
    const init = { method, headers, redirect: 'manual', signal: AbortSignal.timeout(20000) };
    if (payload !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(payload); }
    try {
      const res = await fetchImpl(baseUrl + path, init);
      return { status: res.status, text: await res.text() };
    } catch {
      return { status: 0, text: '' };
    }
  };
  const classify = (r, mode) => (r.status === 0 ? 'transport-error' : mode ? classifyGraphql(r.status, r.text, mode) : classifyHttp(r.status, r.text));

  // Mandatory first control: the anon key must be accepted by the gateway, or nothing else means anything.
  const control = await send('GET', '/auth/v1/health');
  if (control.status !== 200) {
    const observed = control.status === 0 ? 'transport-error' : control.status >= 500 ? 'server-error' : control.status >= 300 && control.status < 400 ? 'unexpected' : 'key-rejected';
    emit(`EVENT probe=control:key-accepted expected=accepted observed=${observed} result=FAIL${observed === 'key-rejected' ? ' reason=key_rejected' : ''}`);
    return { pass: 0, fail: 1, aborted: true, reason: observed === 'key-rejected' ? 'key_rejected' : 'control_failed' };
  }
  emit('EVENT probe=control:key-accepted expected=accepted observed=accepted result=PASS');
  pass += 1;

  for (const t of PROBE_TABLES) record(`rest-get:${t}`, classify(await send('GET', `/rest/v1/${t}?select=*&limit=1`)));
  for (const [r, args] of Object.entries(READ_ONLY_RPCS)) record(`rpc:${r}`, classify(await send('POST', `/rest/v1/rpc/${r}`, args)));
  record('graphql:introspection', classify(await send('POST', '/graphql/v1', { query: '{ __schema { queryType { name } types { name kind } } }' }), 'introspection'));
  record('graphql:read-query', classify(await send('POST', '/graphql/v1', { query: '{ carriersCollection(first: 1) { edges { node { dot_number } } } }' }), 'read'));

  const buckets = await send('GET', '/storage/v1/bucket');
  record('storage:bucket-list', classify(buckets));
  let names = [];
  if (buckets.status === 200) {
    try {
      const parsed = JSON.parse(buckets.text);
      if (Array.isArray(parsed)) names = parsed.map((b) => b && b.name).filter((n) => typeof n === 'string' && BUCKET_NAME.test(n));
    } catch { /* classified above */ }
  }
  if (names.length === 0) {
    emit('EVENT probe=storage:object-list expected=n/a observed=no-buckets-found result=SKIPPED');
  } else {
    let worst = 'empty';
    for (const n of names) {
      const o = classify(await send('POST', `/storage/v1/object/list/${n}`, { prefix: '', limit: 1, offset: 0 }));
      if (!PASS_CLASSES.has(o)) { worst = o; break; }
    }
    record('storage:object-list', worst);
  }

  const rt = await realtimeProbe({ baseUrl, key, seconds: realtimeSeconds, WebSocketImpl, connectTimeoutMs });
  for (const t of REALTIME_TABLES) record(`realtime:${t}`, rt[t]);
  return { pass, fail };
}

/** A Realtime error that complains about the token is a rejected key, not a refusal by the database. */
function errorClass(payload) {
  const text = [payload?.response?.reason, payload?.message, payload?.response?.message].filter((x) => typeof x === 'string').join(' ');
  return KEY_ERROR_TEXT.test(text) ? 'key-rejected' : 'denied';
}

/** One socket, one channel per published table; reports denied / quiet / event per table. */
function realtimeProbe({ baseUrl, key, seconds, WebSocketImpl, connectTimeoutMs }) {
  const result = Object.fromEntries(REALTIME_TABLES.map((t) => [t, 'transport-error']));
  if (typeof WebSocketImpl !== 'function') return Promise.resolve(result);
  return new Promise((resolve) => {
    let ws;
    let timer;
    let beat;
    let guard;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(guard);
      clearInterval(beat);
      try { ws.close(); } catch { /* ignore */ }
      resolve(result);
    };
    try {
      ws = new WebSocketImpl(`${baseUrl.replace(/^http/, 'ws')}/realtime/v1/websocket?apikey=${encodeURIComponent(key)}&vsn=1.0.0`);
    } catch {
      resolve(result);
      return;
    }
    // Hard limit from construction: connect window plus the listening window; the socket is closed when it expires.
    guard = setTimeout(finish, connectTimeoutMs + seconds * 1000);
    const topicToTable = new Map(REALTIME_TABLES.map((t) => [`realtime:a5a-probe-${t}`, t]));
    let ref = 0;
    ws.onopen = () => {
      if (done) return;
      for (const [topic, table] of topicToTable) {
        ref += 1;
        ws.send(JSON.stringify({
          topic, event: 'phx_join', ref: String(ref), join_ref: String(ref),
          payload: { config: { broadcast: { self: false }, presence: { key: '' }, postgres_changes: [{ event: '*', schema: 'public', table }], private: false }, access_token: key },
        }));
        result[table] = 'transport-error';
      }
      beat = setInterval(() => { try { ref += 1; ws.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: String(ref) })); } catch { /* ignore */ } }, 25000);
      timer = setTimeout(finish, seconds * 1000);
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')); } catch { return; }
      const table = topicToTable.get(msg.topic);
      if (!table) return;
      if (msg.event === 'postgres_changes') result[table] = 'event';
      else if (result[table] === 'event') return;
      else if (msg.event === 'phx_reply') result[table] = msg.payload?.status === 'ok' ? 'empty' : errorClass(msg.payload);
      else if (msg.event === 'system' && msg.payload?.status === 'error') result[table] = errorClass(msg.payload);
      else if (msg.event === 'phx_error') result[table] = 'channel-error';
    };
    ws.onerror = () => { /* result stays transport-error unless a reply arrived */ };
    ws.onclose = () => { if (!timer) finish(); };
  });
}

function parseArgs(argv) {
  const opts = { execute: false, phase: 'after', realtimeSeconds: 60, flagRef: undefined, errors: [] };
  for (const a of argv) {
    let m;
    if (a === '--execute') opts.execute = true;
    else if ((m = /^--phase=(before|after)$/.exec(a))) opts.phase = m[1];
    else if ((m = /^--realtime-seconds=(\d+)$/.exec(a))) opts.realtimeSeconds = Number(m[1]);
    else if ((m = /^--project-ref=(.*)$/.exec(a))) opts.flagRef = m[1];
    else opts.errors.push('unknown argument');
  }
  if (!(opts.realtimeSeconds >= 1 && opts.realtimeSeconds <= 60)) opts.errors.push('--realtime-seconds must be 1 to 60');
  return opts;
}

/**
 * CLI entry. `testBaseUrl` exists for the offline tests only (a loopback http URL); the CLI never passes it.
 * Returns the exit code.
 */
export async function main(argv, env, io = { out: (s) => process.stdout.write(`${s}\n`) }, testHooks = {}) {
  const out = io.out;
  const opts = parseArgs(argv);
  if (opts.errors.length) { out(`REFUSED reason=${opts.errors[0]}`); return 2; }
  const tlsFailure = checkTls(env);
  if (tlsFailure) { out(`REFUSED reason=${tlsFailure}`); return 2; }
  let stagingRef;
  try { stagingRef = testHooks.stagingRef ?? recordedStagingRef(); } catch (e) { out(`REFUSED reason=${e.message}`); return 2; }
  const targetFailures = checkTarget({ ref: stagingRef, env, flagRef: opts.flagRef, stagingRef });
  if (targetFailures.length) { for (const f of targetFailures) out(`REFUSED reason=${f}`); return 2; }

  let baseUrl = `https://${stagingRef}.supabase.co`;
  if (testHooks.testBaseUrl !== undefined) {
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(testHooks.testBaseUrl)) { out('REFUSED reason=test base URL must be loopback'); return 2; }
    baseUrl = testHooks.testBaseUrl;
  }

  if (!opts.execute) {
    out(`PLAN-ONLY target=staging-2 phase=${opts.phase} nothing is sent (add --execute to run)`);
    for (const p of buildPlan(opts.phase, opts.realtimeSeconds)) out(`PLAN probe=${p.name} method=${p.method} path=${p.path} expected=${p.expected}`);
    out('NOT RUN');
    return 0;
  }

  const key = env.VITE_SUPABASE_ANON_KEY;
  const keyFailures = checkAnonKey(key, stagingRef);
  if (keyFailures.length) { for (const f of keyFailures) out(`REFUSED reason=${f}`); return 2; }

  out(`RUN target=staging-2 phase=${opts.phase} realtime_window_s=${opts.realtimeSeconds}${opts.realtimeSeconds < 60 ? ' (shorter than the 60 s in doc 14)' : ''}`);
  const { pass, fail, aborted, reason } = await runProbes({ baseUrl, key, phase: opts.phase, realtimeSeconds: opts.realtimeSeconds, emit: out, ...(testHooks.runHooks ?? {}) });
  if (aborted) { out(`ABORTED reason=${reason} no data probe was sent`); return 1; }
  out(`SUMMARY ok=${pass} failed=${fail}`);
  return fail === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), process.env).then((code) => { process.exitCode = code; });
}
