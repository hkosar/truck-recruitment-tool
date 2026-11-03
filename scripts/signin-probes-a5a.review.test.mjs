// Regression tests for review notes 1-4 of the A5a driver (scripts/signin-probes-a5a.mjs). No database. Run: node --test scripts/signin-probes-a5a.review.test.mjs
// Local servers on 127.0.0.1 only.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { exitCodeFor, judge, parseAppOrigin, parseArgs, PROBES, runClassA } from './signin-probes-a5a.mjs';

const listen = async (handler) => {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, close: () => { server.closeAllConnections?.(); return new Promise((r) => server.close(r)); } };
};

test('note 1: a redirect must stay on the app; a foreign host fails with "location"', () => {
  const base = { ok: true, status: 303, headers: {}, cookies: [], body: '' };
  const exp = { status: [303], location: /^\/signin$/ };
  const at = (loc, appOrigin) => judge({ ...base, headers: { location: loc } }, exp, appOrigin);
  assert.equal(at('/signin'), null);
  assert.equal(at('https://evil.example.invalid/signin'), 'location');
  assert.equal(at('//evil.example.invalid/signin'), 'location');
  assert.equal(at('/\\evil.example.invalid/signin'), 'location');
  assert.equal(at('https://evil.example.invalid/signin', 'https://app.example.invalid'), 'location');
  assert.equal(at('https://app.example.invalid/signin', 'https://app.example.invalid'), null);
  assert.equal(at('https://app.example.invalid.evil.example/signin', 'https://app.example.invalid'), 'location');
  assert.notEqual(at('https://app.example.invalid@evil.example/signin', 'https://app.example.invalid'), null);
  assert.equal(at('https://app.example.invalid/signin'), 'location');
  assert.equal(at('http://app.example.invalid/signin', 'https://app.example.invalid'), 'location');
  assert.equal(at('https://app.example.invalid//evil.example/signin', 'https://app.example.invalid'), 'location');
});

test('note 1: --app-origin parsing is strict, with one fixed message', () => {
  assert.equal(parseAppOrigin('https://app.example.invalid'), 'https://app.example.invalid');
  assert.equal(parseAppOrigin('http://127.0.0.1:8788'), 'http://127.0.0.1:8788');
  const bad = ['https://app.example.invalid/', 'https://app.example.invalid/x', 'https://u@app.example.invalid', 'ftp://x.invalid', 'https://APP.example.invalid', 'app.example.invalid', '', undefined, 'https://a.invalid?x=1', 'https://a.invalid#f'];
  for (const raw of bad) {
    assert.throws(() => parseAppOrigin(raw), (e) => e.message === 'refusing: --app-origin must be exactly http(s)://<host>[:<port>] with no path, query or user', String(raw));
  }
  assert.deepEqual(parseArgs(['--origin', 'http://127.0.0.1:1', '--app-origin', 'https://a.invalid']), { origin: 'http://127.0.0.1:1', appOrigin: 'https://a.invalid' });
  assert.throws(() => parseAppOrigin(parseArgs(['--origin', 'x', '--app-origin']).appOrigin), /refusing/);
  assert.throws(() => parseArgs(['--origin', 'x', '--origin', 'y']), /usage/);
});

test('note 1: a live server redirecting a legacy path to a foreign host fails exactly that probe', async () => {
  const s = await listen((req, res) => {
    if (req.url === '/login') { res.writeHead(303, { location: 'https://evil.example.invalid/signin' }); res.end(); return; }
    if (req.url === '/register') { res.writeHead(303, { location: 'https://app.example.invalid/signin' }); res.end(); return; }
    res.writeHead(404); res.end();
  });
  const out = [];
  await runClassA(`http://127.0.0.1:${s.port}`, (e) => out.push(e), { appOrigin: 'https://app.example.invalid' });
  await s.close();
  const get = (id) => out.find((e) => e.id === id);
  assert.deepEqual(get('legacy/login'), { event: 'probe', id: 'legacy/login', result: 'fail', reason: 'location' });
  assert.equal(get('legacy/register').result, 'pass');
  const noOrigin = [];
  const s2 = await listen((req, res) => { res.writeHead(303, { location: 'https://app.example.invalid/signin' }); res.end(); });
  await runClassA(`http://127.0.0.1:${s2.port}`, (e) => noOrigin.push(e));
  await s2.close();
  assert.equal(noOrigin.find((e) => e.id === 'legacy/login').reason, 'location');
});

test('note 2: a server that streams forever or drips slowly cannot stall a probe past the total limit; an oversize body fails', async () => {
  for (const mode of ['stream', 'drip']) {
    const timers = new Set();
    const s = await listen((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      const t = setInterval(() => { if (!res.destroyed) res.write(mode === 'stream' ? 'x' : 'y'); }, mode === 'stream' ? 1 : 20);
      timers.add(t);
      res.on('close', () => clearInterval(t));
    });
    const started = Date.now();
    const out = [];
    const r = await runClassA(`http://127.0.0.1:${s.port}`, (e) => out.push(e), { timeoutMs: 60 });
    const elapsed = Date.now() - started;
    for (const t of timers) clearInterval(t);
    await s.close();
    assert.equal(r.pass, 0, mode);
    assert.equal(r.fail, PROBES.length, mode);
    assert.ok(out.filter((e) => e.event === 'probe').every((e) => e.reason === 'network'), mode);
    assert.ok(elapsed < PROBES.length * 60 + 15_000, `${mode} took ${elapsed} ms`);
  }
  const big = await listen((req, res) => { res.writeHead(200); res.end('x'.repeat(400_000)); });
  const out = [];
  await runClassA(`http://127.0.0.1:${big.port}`, (e) => out.push(e));
  await big.close();
  assert.ok(out.filter((e) => e.event === 'probe').every((e) => e.result === 'fail'));
  assert.equal(judge({ ok: true, tooBig: true, status: 401, headers: {}, cookies: [], body: '' }, { status: [401] }), 'body');
});

test('note 3: nothing executed is never a success; running through a linked folder still runs and reports', () => {
  assert.equal(exitCodeFor({ pass: 0, fail: 0, expected: 80 }), 3);
  assert.equal(exitCodeFor({ pass: 80, fail: 0, expected: 80 }), 0);
  assert.equal(exitCodeFor({ pass: 79, fail: 1, expected: 80 }), 1);
  assert.equal(exitCodeFor({ pass: 79, fail: 0, expected: 80 }), 1);
  const here = dirname(fileURLToPath(import.meta.url));
  const tmp = mkdtempSync(join(tmpdir(), 'a5a-link-'));
  const link = join(tmp, 'linked-scripts');
  try {
    symlinkSync(here, link, 'junction');
    const run = (script, args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 120_000 });
    const viaLink = run(join(link, 'signin-probes-a5a.mjs'), ['--origin', 'http://127.0.0.1:1']);
    assert.equal(viaLink.status, 1, viaLink.stderr);
    assert.match(viaLink.stdout.trim().split('\n').at(-1), /^\{"event":"summary","pass":0,"fail":\d+,"expected":\d+\}$/);
    const direct = run(join(here, 'signin-probes-a5a.mjs'), ['--origin', 'http://127.0.0.1:1']);
    assert.equal(direct.status, 1);
    assert.equal(direct.stdout, viaLink.stdout);
    const bad = run(join(link, 'signin-probes-a5a.mjs'), ['--origin', 'http://evil.example:80']);
    assert.equal(bad.status, 2);
    assert.equal(bad.stdout, '');
  } finally {
    rmSync(link, { recursive: false, force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
  assert.ok(!existsSync(tmp));
});

test('note 4: emails and other identifier shapes in headers or bodies fail with "leak", and only the fixed word is printed', async () => {
  const base = { ok: true, status: 401, headers: {}, cookies: [], body: '{"error":"signed_out"}' };
  const exp = { status: [401], json: 'signed_out' };
  const shapes = {
    email: 'person@example.invalid',
    uuid: '3f2b8c1e-9d4a-4b7e-8a61-0c5d2e7f9a10',
    jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk',
    bearer: 'Bearer abcdefgh12345678',
    opaque: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8',
  };
  for (const [name, value] of Object.entries(shapes)) {
    assert.equal(judge({ ...base, headers: { 'x-rows': value } }, exp), 'leak', `header value ${name}`);
    assert.equal(judge({ ...base, headers: { 'x-multi': ['a', value] } }, exp), 'leak', `header list ${name}`);
    assert.equal(judge({ ...base, body: `{"error":"signed_out"} ${value}` }, exp), 'leak', `body ${name}`);
  }
  assert.equal(judge({ ...base, headers: { 'x-person@example.invalid': '1' } }, exp), 'leak', 'header name');
  const ok = { ...base, headers: { 'content-security-policy': "default-src 'self'; frame-ancestors 'none'; upgrade-insecure-requests", 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' } };
  assert.equal(judge(ok, exp), null);
  assert.equal(judge({ ...base, body: '{"error":"signed_out"}' }, exp), null);
  assert.equal(judge({ ...base, status: 200, body: '<input placeholder="you@example.com">' }, { status: [200], allowPlaceholder: true }), null, 'the page placeholder is the one allowed address');
  assert.equal(judge({ ...base, status: 200, headers: { 'x-a': 'you@example.com' }, body: '' }, { status: [200] }), 'leak', 'not allowed in headers');
  assert.equal(judge({ ...base, status: 200, body: 'you@example.com person@example.invalid' }, { status: [200] }), 'leak');

  const s = await listen((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json', 'x-rows': 'a@example.invalid,b@example.invalid' });
    res.end('{"error":"signed_out"}');
  });
  const out = [];
  await runClassA(`http://127.0.0.1:${s.port}`, (e) => out.push(e));
  await s.close();
  assert.deepEqual(out.find((e) => e.id === 'api-get/api/session'), { event: 'probe', id: 'api-get/api/session', result: 'fail', reason: 'leak' });
  const text = JSON.stringify(out);
  assert.ok(!text.includes('example.invalid') && !text.includes('@'));
});

test('review note 1: the placeholder exemption is the exact attribute text, on the sign-in page probe only', () => {
  const base = { ok: true, status: 200, headers: {}, cookies: [], body: '' };
  const page = { status: [200], allowPlaceholder: true };
  const withBody = (body, exp) => judge({ ...base, body }, exp);
  assert.equal(withBody('<input placeholder="you@example.com">', page), null);
  for (const bad of ['thank-you@example.com', 'boss.you@example.com', 'you@example.com.au', 'you@example.community', '<b>you@example.com</b>', "placeholder='you@example.com'"]) {
    assert.equal(withBody(`<input placeholder="you@example.com"> ${bad}`, page), 'leak', bad);
  }
  assert.equal(withBody('<input placeholder="you@example.com">', { status: [200] }), 'leak', 'a probe that does not opt in gets no exemption');
  assert.equal(PROBES.filter((p) => p.exp.allowPlaceholder).map((p) => p.id).join(), 'signin-page', 'only the sign-in page probe opts in');
});

test('review note 2: percent-encoded and other encoded "@" forms in a body or header fail with "leak"', () => {
  const base = { ok: true, status: 404, headers: {}, cookies: [], body: 'Not found' };
  const exp = { status: [404] };
  const BS = String.fromCharCode(92);
  const encoded = {
    percent: 'alice%40corp.invalid',
    percentLower: 'alice%40Corp.invalid',
    doublePercent: 'alice%2540corp.invalid',
    entityDec: 'alice&#64;corp.invalid',
    entityPadded: 'alice&#0064;corp.invalid',
    entityHex: 'alice&#x40;corp.invalid',
    entityName: 'alice&commat;corp.invalid',
    hexEscape: `alice${BS}x40corp.invalid`,
    unicodeEscape: `alice${BS}u0040corp.invalid`,
    fullWidth: 'alice＠corp.invalid',
    zeroWidth: 'ali​ce@corp.invalid',
    placeholderSuffixed: 'thank-you@example.com',
  };
  for (const [name, value] of Object.entries(encoded)) {
    assert.equal(judge({ ...base, body: `x ${value} y` }, exp), 'leak', `body ${name}`);
    assert.equal(judge({ ...base, headers: { 'x-h': value } }, exp), 'leak', `header ${name}`);
  }
  assert.equal(judge(base, exp), null);
  assert.equal(judge({ ...base, body: '100%40 off, a&#64 b, 50%' }, exp), null, 'no false alarm without an address shape');
});
