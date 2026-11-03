// Offline tests for scripts/signin-probes-hosted-a5a.mjs. Run: node --test scripts/signin-probes-hosted-a5a.test.mjs
// A local fake server on 127.0.0.1 mimics PostgREST, GraphQL, Storage and Realtime. No hosted contact, no real key.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import {
  OLD_STAGING_REF, PRODUCTION_REF, PROBE_TABLES, READ_ONLY_RPCS, REALTIME_TABLES,
  buildPlan, checkAnonKey, checkTarget, classifyHttp, isAllowedRequest, main, recordedStagingRef,
} from './signin-probes-hosted-a5a.mjs';

const STG = recordedStagingRef();
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const KEY = `${b64({ alg: 'HS256' })}.${b64({ role: 'anon', ref: STG })}.SIGNATURE-CANARY-9f31`;
const GOOD_ENV = { VITE_SUPABASE_ANON_KEY: KEY };

/** mode: locked (denied/empty), denied (all 401 + realtime errors), open (data + realtime event + buckets). */
async function fakeServer(mode) {
  const seen = [];
  const sockets = new Set();
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, path: req.url, apikey: req.headers.apikey, auth: req.headers.authorization, body });
      const send = (status, payload) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(payload === undefined ? '' : JSON.stringify(payload)); };
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
    assert.equal(r.code, 2); assert.match(r.text, /different project/);
    r = await runCli(['--bogus'], {}, hooks);
    assert.equal(r.code, 2);
    r = await runCli(['--realtime-seconds=61'], {}, hooks);
    assert.equal(r.code, 2);
    assert.deepEqual(srv.seen.filter((s) => s.method !== 'WS' && !s.path.startsWith('/rest/') && !s.path.startsWith('/graphql') && !s.path.startsWith('/storage')), []);
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

test('read-only RPC list holds only STABLE functions in the migrations; probe tables cover every public table and view', () => {
  const dir = new URL('../supabase/migrations/', import.meta.url);
  const sql = readdirSync(dir).filter((f) => f.endsWith('.sql')).map((f) => readFileSync(new URL(f, dir), 'utf8')).join('\n');
  for (const rpc of Object.keys(READ_ONLY_RPCS)) {
    const m = new RegExp(`create or replace function public\\.${rpc}\\([\\s\\S]*?\\$[a-z_]*\\$;`, 'i').exec(sql);
    assert.ok(m, `${rpc} not found`);
    assert.match(m[0].split(/\bas\b\s+\$/i)[0], /\bstable\b/i, `${rpc} is not STABLE`);
  }
  const found = new Set();
  for (const m of sql.matchAll(/^create (?:or replace )?(?:table|view) public\.([a-z_]+)/gim)) found.add(m[1]);
  assert.deepEqual([...found].sort(), [...PROBE_TABLES].sort());
});

test('classifyHttp covers the fixed classes', () => {
  assert.equal(classifyHttp(200, '[]'), 'empty');
  assert.equal(classifyHttp(200, '[{"a":1}]'), 'data');
  assert.equal(classifyHttp(204, ''), 'empty');
  assert.equal(classifyHttp(401, '{}'), 'denied');
  assert.equal(classifyHttp(400, '{"code":"42501"}'), 'denied');
  assert.equal(classifyHttp(404, ''), 'absent');
  assert.equal(classifyHttp(400, '{"code":"x"}'), 'client-error');
  assert.equal(classifyHttp(503, ''), 'server-error');
  assert.deepEqual(checkAnonKey('sb_publishable_abcdefghijkl', STG), []);
});
