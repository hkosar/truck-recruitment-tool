// Offline tests for scripts/signin-probes-hosted-a5a.mjs. Run: node --test scripts/signin-probes-hosted-a5a.test.mjs
// A local fake server on 127.0.0.1 mimics PostgREST, GraphQL, Storage and Realtime. No hosted contact, no real key.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import {
  OLD_STAGING_REF, PRODUCTION_REF, PROBE_TABLES, READ_ONLY_RPCS, REALTIME_TABLES,
  buildPlan, checkAnonKey, checkTarget, classifyHttp, isAllowedRequest, main, recordedStagingRef, runProbes,
} from './signin-probes-hosted-a5a.mjs';

const STG = recordedStagingRef();
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const KEY = `${b64({ alg: 'HS256' })}.${b64({ role: 'anon', ref: STG })}.SIGNATURE-CANARY-9f31`;
const GOOD_ENV = { VITE_SUPABASE_ANON_KEY: KEY };

/** mode: locked (denied/empty), denied (401 42501 + realtime errors), open (data + realtime event + buckets),
 *  badkey / badjwt / redirect (the key is rejected or redirected on every request, including the control). */
async function fakeServer(mode) {
  const seen = [];
  const sockets = new Set();
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, path: req.url, apikey: req.headers.apikey, auth: req.headers.authorization, body });
      const send = (status, payload) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(payload === undefined ? '' : JSON.stringify(payload)); };
      if (mode === 'badkey') return send(401, { message: 'Invalid API key', hint: 'Double check your Supabase anon or service_role API key.' });
      if (mode === 'badjwt') return send(401, { code: 'PGRST301', message: 'JWSError JWSInvalidSignature' });
      if (mode === 'redirect') { res.writeHead(302, { location: 'https://example.invalid/' }); return res.end(''); }
      if (req.url === '/auth/v1/health') return send(200, { name: 'GoTrue' });
      if (mode === 'denied') return send(401, { code: '42501', message: 'permission denied' });
      if (req.url.startsWith('/graphql/v1')) {
        const q = JSON.parse(body).query;
        if (q.includes('__schema')) return send(200, { data: { __schema: { queryType: { name: 'Query' }, types: mode === 'open' ? [{ name: 'carriers', kind: 'OBJECT' }, { name: 'Query', kind: 'OBJECT' }] : [{ name: 'Query', kind: 'OBJECT' }, { name: 'String', kind: 'SCALAR' }] } } });
        return send(200, mode === 'open' ? { data: { carriersCollection: { edges: [{ node: { dot_number: 1 } }] } } } : { errors: [{ message: 'unknown field' }] });
      }
      if (req.url === '/storage/v1/bucket') return send(200, mode === 'open' ? [{ name: 'docs' }, { name: '../evil' }] : []);
      if (req.url.startsWith('/storage/v1/object/list/')) return send(200, mode === 'open' ? [{ name: 'a.pdf' }] : []);
      if (req.url.startsWith('/rest/v1/rpc/')) return mode === 'open' ? send(200, [{ n: 1 }]) : send(403, { code: '42501', message: 'permission denied for function' });
      if (req.url.startsWith('/rest/v1/')) return mode === 'open' ? send(200, [{ secret_row: 1 }]) : send(200, []);
      return send(404, { message: 'not found' });
    });
  });
  server.on('upgrade', (req, socket) => {
    sockets.add(socket);
    seen.push({ method: 'WS', path: req.url.split('?')[0], apikeyInUrl: /apikey=/.test(req.url) });
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const frame = (obj) => {
      const p = Buffer.from(JSON.stringify(obj));
      const h = p.length < 126 ? Buffer.from([0x81, p.length]) : Buffer.from([0x81, 126, p.length >> 8, p.length & 255]);
      socket.write(Buffer.concat([h, p]));
    };
    let buf = Buffer.alloc(0);
    socket.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (buf.length < 2) return;
        const op = buf[0] & 15;
        let len = buf[1] & 127;
        let off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        if (buf.length < off + 4 + len) return;
        const mask = buf.subarray(off, off + 4);
        const data = Buffer.from(buf.subarray(off + 4, off + 4 + len).map((b, i) => b ^ mask[i % 4]));
        buf = buf.subarray(off + 4 + len);
        if (op === 8) { socket.end(); return; }
        if (op !== 1) continue;
        const msg = JSON.parse(data.toString('utf8'));
        if (msg.event !== 'phx_join') continue;
        frame({ topic: msg.topic, event: 'phx_reply', ref: msg.ref, payload: { status: mode === 'denied' ? 'error' : 'ok', response: {} } });
        if (mode === 'open' && msg.topic.endsWith('batches')) {
          setTimeout(() => frame({ topic: msg.topic, event: 'postgres_changes', payload: { data: { table: 'batches' } } }), 50);
        }
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    seen,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(r); }),
  };
}

async function runCli(args, env, hooks = {}) {
  const lines = [];
  const code = await main(args, env, { out: (s) => lines.push(s) }, hooks);
  return { code, text: lines.join('\n'), lines };
}

test('plan-only is the default: prints the plan, sends nothing, needs no key', async () => {
  const srv = await fakeServer('locked');
  try {
    const r = await runCli([], {}, { testBaseUrl: srv.url });
    assert.equal(r.code, 0);
    assert.match(r.text, /^PLAN-ONLY /);
    assert.match(r.text, /NOT RUN$/);
    assert.equal(r.lines.filter((l) => l.startsWith('PLAN probe=')).length, buildPlan('after', 60).length);
    assert.equal(srv.seen.length, 0);
  } finally { await srv.close(); }
});

test('locked-down project: every probe passes, only allowed requests sent, nothing sensitive printed', async () => {
  const srv = await fakeServer('locked');
  try {
    const r = await runCli(['--execute', '--realtime-seconds=1'], GOOD_ENV, { testBaseUrl: srv.url });
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /SUMMARY ok=\d+ failed=0$/);
    assert.ok(!r.text.includes(KEY) && !r.text.includes('SIGNATURE-CANARY') && !r.text.includes('127.0.0.1') && !r.text.includes('apikey'));
    for (const t of PROBE_TABLES) assert.ok(r.text.includes(`probe=rest-get:${t} expected=denied|empty|absent observed=empty result=PASS`), t);
    for (const rpc of Object.keys(READ_ONLY_RPCS)) assert.ok(r.text.includes(`probe=rpc:${rpc} expected=denied|empty|absent observed=denied result=PASS`), rpc);
    for (const t of REALTIME_TABLES) assert.ok(r.text.includes(`probe=realtime:${t} `) && r.text.includes(`probe=realtime:${t} expected=denied|empty|absent observed=empty result=PASS`), t);
    const http = srv.seen.filter((s) => s.method !== 'WS');
    assert.ok(http.length > 30);
    for (const s of http) {
      assert.ok(['GET', 'POST'].includes(s.method));
      assert.ok(isAllowedRequest(s.method, s.path), `${s.method} ${s.path}`);
      assert.equal(s.apikey, KEY);
      assert.equal(s.auth, `Bearer ${KEY}`);
    }
    assert.equal(srv.seen.filter((s) => s.method === 'WS').length, 1);
    assert.ok(srv.seen.some((s) => s.path === '/graphql/v1'));
  } finally { await srv.close(); }
});

test('all-denied project (401 everywhere, realtime join errors) passes', async () => {
  const srv = await fakeServer('denied');
  try {
    const r = await runCli(['--execute', '--realtime-seconds=1'], GOOD_ENV, { testBaseUrl: srv.url });
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /probe=rest-get:carriers expected=denied\|empty\|absent observed=denied result=PASS/);
    assert.match(r.text, /probe=realtime:profiles expected=denied\|empty\|absent observed=denied result=PASS/);
  } finally { await srv.close(); }
});

test('exposed project: data, GraphQL schema, buckets and a Realtime event all FAIL; exit code 1; no body printed', async () => {
  const srv = await fakeServer('open');
  try {
    const r = await runCli(['--execute', '--realtime-seconds=1'], GOOD_ENV, { testBaseUrl: srv.url });
    assert.equal(r.code, 1);
    assert.match(r.text, /probe=rest-get:carriers expected=denied\|empty\|absent observed=data result=FAIL/);
    assert.match(r.text, /probe=rpc:search_carriers expected=denied\|empty\|absent observed=data result=FAIL/);
    assert.match(r.text, /probe=graphql:introspection expected=denied\|empty\|absent observed=data result=FAIL/);
    assert.match(r.text, /probe=graphql:read-query expected=denied\|empty\|absent observed=data result=FAIL/);
    assert.match(r.text, /probe=storage:bucket-list expected=denied\|empty\|absent observed=data result=FAIL/);
    assert.match(r.text, /probe=storage:object-list expected=denied\|empty\|absent observed=data result=FAIL/);
    assert.match(r.text, /probe=realtime:batches expected=denied\|empty\|absent observed=event result=FAIL/);
    assert.match(r.text, /probe=realtime:profiles expected=denied\|empty\|absent observed=empty result=PASS/);
    assert.ok(!r.text.includes('secret_row') && !r.text.includes('a.pdf') && !r.text.includes('docs') && !r.text.includes('evil'));
    // a bucket name with path characters is never requested
    assert.ok(!srv.seen.some((s) => s.path.includes('evil')));
    assert.ok(srv.seen.some((s) => s.path === '/storage/v1/object/list/docs'));
  } finally { await srv.close(); }
});

test('phase=before records classes instead of failing on data', async () => {
  const srv = await fakeServer('open');
  try {
    const r = await runCli(['--execute', '--phase=before', '--realtime-seconds=1'], GOOD_ENV, { testBaseUrl: srv.url });
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /probe=rest-get:carriers expected=recorded observed=data result=RECORDED/);
    assert.match(r.text, /probe=realtime:batches expected=recorded observed=event result=RECORDED/);
  } finally { await srv.close(); }
});

test('unreachable server: transport-error FAILs in both phases', async () => {
  const srv = await fakeServer('locked');
  const url = srv.url;
  await srv.close();
  for (const phase of ['before', 'after']) {
    const r = await runCli(['--execute', `--phase=${phase}`, '--realtime-seconds=1'], GOOD_ENV, { testBaseUrl: url });
    assert.equal(r.code, 1);
    assert.match(r.text, /observed=transport-error result=FAIL/);
  }
});

for (const mode of ['badkey', 'badjwt', 'redirect']) {
  test(`rejected key (${mode}): the control probe fails and the run aborts before any data probe`, async () => {
    const srv = await fakeServer(mode);
    try {
      for (const phase of ['after', 'before']) {
        const r = await runCli(['--execute', `--phase=${phase}`, '--realtime-seconds=1'], GOOD_ENV, { testBaseUrl: srv.url });
        assert.equal(r.code, 1, r.text);
        assert.match(r.text, mode === 'redirect' ? /probe=control:key-accepted expected=accepted observed=unexpected result=FAIL/ : /probe=control:key-accepted expected=accepted observed=key-rejected result=FAIL reason=key_rejected/);
        assert.match(r.text, /ABORTED reason=(key_rejected|control_failed)/);
        assert.ok(!/probe=rest-get/.test(r.text) && !/result=PASS/.test(r.text) && !/SUMMARY/.test(r.text));
      }
      assert.deepEqual([...new Set(srv.seen.map((x) => x.path))], ['/auth/v1/health']);
    } finally { await srv.close(); }
  });
}

test('regression (reviewer repro): a rejected key on every probe never yields PASS, even if the control were skipped', async () => {
  const respond = (status, body) => async () => ({ status, text: async () => JSON.stringify(body) });
  const ws = class {
    constructor() { setTimeout(() => this.onopen && this.onopen(), 5); }
    send(d) { const m = JSON.parse(d); if (m.event === 'phx_join') setTimeout(() => this.onmessage({ data: JSON.stringify({ topic: m.topic, event: 'phx_reply', ref: m.ref, payload: { status: 'error', response: { reason: 'Invalid token' } } }) }), 5); }
    close() {}
  };
  for (const [fetchImpl, label] of [
    [respond(401, { message: 'Invalid API key' }), 'gateway'],
    [respond(401, { code: 'PGRST301', message: 'JWSError JWSInvalidSignature' }), 'pgrst301'],
    [async () => ({ status: 302, text: async () => '' }), 'redirect'],
    // control accepted, every later request rejected: each data probe must FAIL on its own
    [async (url) => (url.endsWith('/auth/v1/health') ? { status: 200, text: async () => '{}' } : { status: 401, text: async () => JSON.stringify({ message: 'Invalid API key' }) }), 'control-ok-then-rejected'],
  ]) {
    const lines = [];
    const r = await runProbes({ baseUrl: 'http://127.0.0.1:9', key: 'k', phase: 'after', realtimeSeconds: 1, emit: (l) => lines.push(l), fetchImpl, WebSocketImpl: ws });
    assert.ok(r.fail > 0, label);
    if (label === 'control-ok-then-rejected') {
      assert.equal(lines.filter((l) => l.includes('result=PASS')).length, 1, 'only the control passes');
      assert.ok(lines.filter((l) => l.startsWith('EVENT probe=realtime:')).every((l) => l.includes('observed=key-rejected result=FAIL')));
    }
  }
});

test('classification: 42501 is the only denied; key rejection and redirects fail; storage statusCode shapes', () => {
  assert.equal(classifyHttp(401, '{"code":"42501","message":"permission denied"}'), 'denied');
  assert.equal(classifyHttp(403, '{"code":"42501"}'), 'denied');
  assert.equal(classifyHttp(401, '{"message":"Invalid API key"}'), 'key-rejected');
  assert.equal(classifyHttp(401, ''), 'key-rejected');
  assert.equal(classifyHttp(403, '{}'), 'key-rejected');
  for (const c of ['PGRST300', 'PGRST301', 'PGRST302']) assert.equal(classifyHttp(401, JSON.stringify({ code: c })), 'key-rejected');
  assert.equal(classifyHttp(400, '{"statusCode":"403","error":"Unauthorized","message":"new row violates row-level security policy"}'), 'denied');
  assert.equal(classifyHttp(400, '{"statusCode":"404","message":"Bucket not found"}'), 'absent');
  assert.equal(classifyHttp(400, '{"statusCode":"403","message":"invalid JWT: signature"}'), 'key-rejected');
  for (const st of [301, 302, 303, 307, 308]) assert.equal(classifyHttp(st, st === 301 ? '<html>moved</html>' : ''), 'unexpected');
  assert.deepEqual(checkAnonKey(`${b64({})}.${b64({ role: 'anon' })}.x`, STG), ['VITE_SUPABASE_ANON_KEY does not carry the staging-2 project ref']);
});

test('Realtime has a hard time limit even if the socket never opens or never closes', async () => {
  const hang = class { constructor() { this.closed = false; } send() {} close() { this.closed = true; } };
  const lines = [];
  const t0 = Date.now();
  const r = await runProbes({
    baseUrl: 'http://127.0.0.1:9', key: 'k', phase: 'after', realtimeSeconds: 1, connectTimeoutMs: 100, emit: (l) => lines.push(l),
    fetchImpl: async () => ({ status: 200, text: async () => '[]' }), WebSocketImpl: hang,
  });
  assert.ok(Date.now() - t0 < 5000);
  assert.ok(lines.filter((l) => l.startsWith('EVENT probe=realtime:')).every((l) => l.includes('observed=transport-error result=FAIL')));
  assert.ok(r.fail >= REALTIME_TABLES.length);
});

test('refusals: production, old staging, other refs, foreign URL, missing or wrong key', async () => {
  const srv = await fakeServer('locked');
  try {
    const hooks = { testBaseUrl: srv.url };
    let r = await runCli(['--execute', `--project-ref=${PRODUCTION_REF}`], GOOD_ENV, hooks);
    assert.equal(r.code, 2); assert.match(r.text, /REFUSED .*--project-ref/);
    r = await runCli(['--execute', `--project-ref=${OLD_STAGING_REF}`], GOOD_ENV, hooks);
    assert.equal(r.code, 2);
    r = await runCli(['--execute', '--project-ref=abcdefghijklmnopqrst'], GOOD_ENV, hooks);
    assert.equal(r.code, 2);
    for (const url of [`https://${PRODUCTION_REF}.supabase.co`, `https://${OLD_STAGING_REF}.supabase.co`, 'https://example.com', `https://${STG}.supabase.co.evil.example`]) {
      r = await runCli(['--execute'], { ...GOOD_ENV, VITE_SUPABASE_URL: url }, hooks);
      assert.equal(r.code, 2, url); assert.match(r.text, /VITE_SUPABASE_URL/);
      assert.ok(!r.text.includes(url));
    }
    r = await runCli(['--execute', '--realtime-seconds=1'], { VITE_SUPABASE_URL: `https://${STG}.supabase.co`, VITE_SUPABASE_ANON_KEY: KEY }, hooks);
    assert.equal(r.code, 0 /* the matching URL is accepted */, r.text);
    r = await runCli(['--execute'], {}, hooks);
    assert.equal(r.code, 2); assert.match(r.text, /ANON_KEY is missing/);
    r = await runCli(['--execute'], { VITE_SUPABASE_ANON_KEY: 'sb_secret_abcdefghijklmnop' }, hooks);
    assert.equal(r.code, 2); assert.ok(!r.text.includes('sb_secret_abcdefghijklmnop'));
    r = await runCli(['--execute'], { VITE_SUPABASE_ANON_KEY: `${b64({})}.${b64({ role: 'service_role' })}.sig` }, hooks);
    assert.equal(r.code, 2); assert.match(r.text, /anon role/);
    r = await runCli(['--execute'], { VITE_SUPABASE_ANON_KEY: `${b64({})}.${b64({ role: 'anon', ref: PRODUCTION_REF })}.sig` }, hooks);
    assert.equal(r.code, 2); assert.match(r.text, /staging-2 project ref/);
    r = await runCli(['--bogus'], {}, hooks);
    assert.equal(r.code, 2);
    r = await runCli(['--realtime-seconds=61'], {}, hooks);
    assert.equal(r.code, 2);
    assert.deepEqual(srv.seen.filter((s) => s.method !== 'WS' && !s.path.startsWith('/rest/') && !s.path.startsWith('/graphql') && !s.path.startsWith('/storage') && s.path !== '/auth/v1/health'), []);
  } finally { await srv.close(); }
});

test('CLI never accepts a non-loopback test URL, and the real URL is derived from the recorded ref only', async () => {
  const r = await runCli(['--execute'], GOOD_ENV, { testBaseUrl: 'https://example.com' });
  assert.equal(r.code, 2);
  const plan = await runCli([], {}, {});
  assert.equal(plan.code, 0);
  assert.ok(!plan.text.includes(STG) && !plan.text.includes('supabase.co'));
});

test('target-guard.ts records staging-2 and it is neither production nor the old staging project', () => {
  assert.match(STG, /^[a-z]{20}$/);
  assert.notEqual(STG, PRODUCTION_REF);
  assert.notEqual(STG, OLD_STAGING_REF);
  assert.deepEqual(checkTarget({ ref: PRODUCTION_REF, stagingRef: STG }).length > 0, true);
  assert.deepEqual(checkTarget({ ref: OLD_STAGING_REF, stagingRef: STG }).length > 0, true);
  assert.deepEqual(checkTarget({ ref: STG, stagingRef: STG }), []);
});

test('request allow-list: reads only; every write verb, rpc outside the list and other paths are refused', () => {
  for (const m of ['PUT', 'PATCH', 'DELETE', 'HEAD']) assert.equal(isAllowedRequest(m, '/rest/v1/carriers?select=*&limit=1'), false);
  assert.equal(isAllowedRequest('POST', '/rest/v1/carriers'), false);
  for (const w of ['create_batch', 'refresh_batch', 'bulk_set_status', 'set_do_not_contact', 'log_export']) assert.equal(isAllowedRequest('POST', `/rest/v1/rpc/${w}`), false, w);
  for (const p of ['/auth/v1/token?grant_type=password', '/auth/v1/otp', '/auth/v1/signup', '/auth/v1/user', '/auth/v1/recover', '/storage/v1/object/upload/x']) {
    assert.equal(isAllowedRequest('GET', p), false, p);
    assert.equal(isAllowedRequest('POST', p), false, p);
  }
  assert.equal(isAllowedRequest('POST', '/rest/v1/rpc/search_carriers'), true);
  assert.equal(isAllowedRequest('POST', '/storage/v1/object/list/../x'), false);
});

/** Every `create [or replace] function public.X(` in the app migrations and pending M1*, with its header (up to `as $`). */
function publicFunctions() {
  const out = new Map();
  for (const rel of ['../supabase/migrations/', '../supabase/pending/']) {
    const dir = new URL(rel, import.meta.url);
    for (const file of readdirSync(dir).filter((x) => x.endsWith('.sql'))) {
      const sql = readFileSync(new URL(file, dir), 'utf8');
      for (const m of sql.matchAll(/create (?:or replace )?function public\.([a-z_]+)\(([\s\S]*?)\n\s*as\s+\$[a-z_]*\$/gi)) {
        out.set(m[1], (out.get(m[1]) ?? []).concat(m[2]));
      }
    }
  }
  return out;
}

test('read-only RPC list holds only STABLE functions; every read-only (STABLE) public RPC is probed; probe tables cover every public table and view', () => {
  const fns = publicFunctions();
  const stable = (headers) => headers.every((h) => /\bstable\b/i.test(h));
  for (const rpc of Object.keys(READ_ONLY_RPCS)) {
    assert.ok(fns.has(rpc), `${rpc} not found`);
    assert.ok(stable(fns.get(rpc)), `${rpc} is not STABLE in every definition`);
  }
  const readOnly = [...fns].filter(([, headers]) => stable(headers)).map(([name]) => name).sort();
  assert.deepEqual(readOnly, Object.keys(READ_ONLY_RPCS).sort(), 'a STABLE public function is not probed, or a probed one is not STABLE');
  const dir = new URL('../supabase/migrations/', import.meta.url);
  const sql = readdirSync(dir).filter((f) => f.endsWith('.sql')).map((f) => readFileSync(new URL(f, dir), 'utf8')).join('\n');
  const found = new Set();
  for (const m of sql.matchAll(/^create (?:or replace )?(?:table|view) public\.([a-z_]+)/gim)) found.add(m[1]);
  assert.deepEqual([...found].sort(), [...PROBE_TABLES].sort());
});

test('classifyHttp covers the fixed classes', () => {
  assert.equal(classifyHttp(200, '[]'), 'empty');
  assert.equal(classifyHttp(200, '[{"a":1}]'), 'data');
  assert.equal(classifyHttp(204, ''), 'empty');
  assert.equal(classifyHttp(401, '{}'), 'key-rejected');
  assert.equal(classifyHttp(400, '{"code":"42501"}'), 'denied');
  assert.equal(classifyHttp(302, ''), 'unexpected');
  assert.equal(classifyHttp(404, ''), 'absent');
  assert.equal(classifyHttp(400, '{"code":"x"}'), 'client-error');
  assert.equal(classifyHttp(503, ''), 'server-error');
  assert.deepEqual(checkAnonKey('sb_publishable_abcdefghijkl', STG), []);
});
