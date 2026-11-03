// Tests for scripts/signin-probes-a5a.mjs that need no database. Run: node --test scripts/signin-probes-a5a.test.mjs
// The run against the real app (all probes pass; a deliberately broken endpoint fails) is in app/server/e2e.http.test.ts.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { judge, parseArgs, parseLocalOrigin, PROBES, runClassA } from './signin-probes-a5a.mjs';

test('accepts exactly the two local origins with a port', () => {
  assert.deepEqual(parseLocalOrigin('http://127.0.0.1:8788'), { hostHeader: '127.0.0.1:8788', port: 8788 });
  assert.deepEqual(parseLocalOrigin('http://localhost:8788'), { hostHeader: 'localhost:8788', port: 8788 });
});

test('refuses every other origin with the same fixed message and no echo', () => {
  const bad = [
    'https://127.0.0.1:8788', 'http://127.0.0.1', 'http://localhost', 'http://127.0.0.1:8788/', 'http://127.0.0.1:8788/x',
    'http://127.0.0.1:8788?a=1', 'http://127.0.0.1:8788#f', 'http://user:pw@127.0.0.1:8788', 'http://127.0.0.2:8788', 'http://[::1]:8788',
    'http://0.0.0.0:8788', 'http://localhost.evil.example:8788', 'http://127.0.0.1.evil.example:8788', 'http://evil.example:8788',
    'http://staging.example.com:443', 'http://127.0.0.1:99999', 'http://127.0.0.1:0', '', undefined, 'localhost:8788', 'http://127.0.0.1:8788@evil.example',
    'http://evil.example#@127.0.0.1:8788', 'http://LOCALHOST:8788', 'http://127.0.0.1:08788x',
  ];
  for (const raw of bad) {
    assert.throws(() => parseLocalOrigin(raw), (e) => e.message === 'refusing: --origin must be exactly http://localhost:<port> or http://127.0.0.1:<port> (this computer only)', String(raw));
  }
});

test('argument parsing: only --origin, and it is required', () => {
  assert.deepEqual(parseArgs(['--origin', 'http://127.0.0.1:1']), { origin: 'http://127.0.0.1:1' });
  assert.throws(() => parseArgs([]), /usage/);
  assert.throws(() => parseArgs(['--origin', 'x', '--anon-key', 'y']), /usage/);
});

test('runClassA refuses a non-local origin before sending anything', async () => {
  let hits = 0;
  const server = createServer(() => { hits += 1; });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  await assert.rejects(runClassA(`http://127.0.0.1.invalid:${port}`), /refusing/);
  server.close();
  assert.equal(hits, 0);
});

test('the probe table never sends mail, uses no cookie or key, and has unique ids', () => {
  const ids = PROBES.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const p of PROBES) {
    const pathname = new URL(p.req.path, 'http://127.0.0.1').pathname.replace(/\/+$/, '').toLowerCase();
    assert.notEqual(pathname, '/auth/request', p.id);
    assert.ok(!decodeURIComponent(p.req.path).toLowerCase().includes('/auth/request'), p.id);
    assert.equal(p.req.headers?.cookie, undefined, p.id);
    assert.equal(p.req.headers?.authorization, undefined, p.id);
    assert.ok(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'].includes(p.req.method ?? 'GET'), p.id);
    if (/^\/(auth|rest|graphql|storage|realtime)\/v1/.test(p.req.path)) assert.ok(p.req.body === undefined || p.req.body === '{}', p.id);
  }
  assert.ok(PROBES.length >= 80);
});

test('judge: cookies, leaks, status, body, header and network failures give fixed reasons', () => {
  const base = { ok: true, status: 401, headers: {}, cookies: [], body: '{"error":"signed_out"}' };
  const exp = { status: [401], json: 'signed_out' };
  assert.equal(judge(base, exp), null);
  assert.equal(judge({ ok: false }, exp), 'network');
  assert.equal(judge({ ...base, cookies: ['__Host-tr_session=abcdefghijklmnopqrstuvwxyz; Path=/'] }, exp), 'cookie');
  assert.equal(judge({ ...base, cookies: ['__Host-tr_session=; Path=/; Max-Age=0; Secure'] }, exp), null);
  assert.equal(judge({ ...base, body: '{"error":"signed_out"} token=abcdefghijklmnopqrstuvwxyz' }, exp), 'leak');
  assert.equal(judge({ ...base, headers: { location: 'https://x.example/auth/confirm?token=abcdefghijklmnopqrstuvwxyz' } }, exp), 'leak');
  assert.equal(judge({ ...base, status: 200 }, exp), 'status');
  assert.equal(judge({ ...base, body: '{"error":"signed_out","rows":[1]}' }, exp), 'body');
  assert.equal(judge({ ...base, body: 'not json' }, exp), 'body');
  assert.equal(judge(base, { status: [401], headers: { 'x-content-type-options': 'nosniff' } }), 'header');
  assert.equal(judge({ ...base, status: 303 }, { status: [303], location: /\/signin$/ }), 'location');
});

test('output carries only fixed words even when the server returns secrets, and an unreachable server fails with "network"', async () => {
  const secret = 'SECRETVALUE0123456789abcdefghijklmnop';
  const server = createServer((req, res) => {
    res.writeHead(200, { 'set-cookie': `__Host-tr_session=${secret}; Path=/`, 'content-type': 'application/json', location: `/x?token=${secret}` });
    res.end(JSON.stringify({ leaked: secret, rows: [{ email: 'person@example.invalid' }] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const lines = [];
  const result = await runClassA(`http://127.0.0.1:${port}`, (e) => lines.push(JSON.stringify(e)));
  server.close();
  assert.equal(result.pass, 0);
  assert.equal(result.fail, PROBES.length);
  const text = lines.join('\n');
  assert.ok(!text.includes(secret) && !text.includes('person@') && !text.includes(String(port)) && !text.includes('127.0.0.1'));
  for (const l of lines) assert.match(l, /^\{"event":"(probe","id":"[a-zA-Z0-9:/_.-]+","result":"(pass|fail)"(,"reason":"(status|location|body|header|cookie|leak|network)")?|summary","pass":\d+,"fail":\d+,"expected":\d+)\}$/);

  const dead = createServer();
  await new Promise((r) => dead.listen(0, '127.0.0.1', r));
  const deadPort = dead.address().port;
  await new Promise((r) => dead.close(r));
  const out = [];
  const r2 = await runClassA(`http://127.0.0.1:${deadPort}`, (e) => out.push(e));
  assert.equal(r2.fail, PROBES.length);
  assert.ok(out.filter((e) => e.event === 'probe').every((e) => e.reason === 'network'));
});
