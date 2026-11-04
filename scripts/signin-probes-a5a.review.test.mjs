// Regression tests for review notes 1-4 of the A5a driver (scripts/signin-probes-a5a.mjs). No database. Run: node --test scripts/signin-probes-a5a.review.test.mjs
// Local servers on 127.0.0.1 only.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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

test('review blocking: env proxy settings never route a probe (fake proxy receives 0 requests)', async () => {
  const seen = [];
  const proxy = await listen((req, res) => { seen.push(req.url); res.writeHead(502); res.end(); });
  const here = dirname(fileURLToPath(import.meta.url));
  const driver = process.env.A5A_DRIVER_UNDER_TEST ?? join(here, 'signin-probes-a5a.mjs');
  const proxyUrl = `http://127.0.0.1:${proxy.port}`;
  const base = { ...process.env, HTTP_PROXY: proxyUrl, http_proxy: proxyUrl, HTTPS_PROXY: proxyUrl, https_proxy: proxyUrl, NO_PROXY: '', no_proxy: '' };
  const settings = [{ NODE_USE_ENV_PROXY: '1', NODE_OPTIONS: '' }, { NODE_USE_ENV_PROXY: '0', NODE_OPTIONS: '--use-env-proxy' }];
  try {
    for (const extra of settings) {
      // Port 9 (discard) has no listener: with a private connection every probe fails "network"; through the proxy it would be answered.
      const r = await new Promise((resolve) => {
        const c = spawn(process.execPath, [driver, '--origin', 'http://127.0.0.1:9'], { env: { ...base, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        c.stdout.on('data', (d) => { out += d; });
        c.on('close', (code) => resolve({ code, out }));
      });
      assert.equal(seen.length, 0, `proxy received requests with ${JSON.stringify(extra)}`);
      assert.equal(r.code, 1);
      assert.match(r.out, /"reason":"network"/);
      assert.doesNotMatch(r.out, /"reason":"status"/);
    }
  } finally { await proxy.close(); }
});

test('review note 1: a long --app-origin host label with a digit is not a false leak, but a token after it still is', () => {
  const app = 'https://twisted-nail-recruiter-app-staging-2.onrender.com';
  const base = { ok: true, status: 303, headers: {}, cookies: [], body: '' };
  const exp = { status: [303], location: /^\/signin$/ };
  const at = (loc, appOrigin) => judge({ ...base, headers: { location: loc } }, exp, appOrigin);
  assert.equal(at(`${app}/signin`, app), null);
  assert.equal(at('/signin', app), null);
  assert.equal(judge({ ...base, status: 200, body: `see ${app}/signin` }, { status: [200] }, app), null);
  // Without --app-origin the same long label is still flagged (rule unchanged), and secrets next to the origin are still caught.
  assert.equal(at(`${app}/signin`), 'leak', 'no app origin given: rule unchanged');
  assert.equal(judge({ ...base, status: 200, body: `see ${app}/signin` }, { status: [200] }), 'leak');
  assert.equal(judge({ ...base, status: 200, body: `${app}/x?k=${'a1'.repeat(20)}` }, { status: [200] }, app), 'leak');
  assert.equal(at(`${app}/signin?token=${'A'.repeat(20)}`, app), 'leak');
  assert.equal(judge({ ...base, status: 200, body: `${'a1'.repeat(20)}${app}` }, { status: [200] }, app), 'leak');
  assert.equal(judge({ ...base, status: 200, body: `a@b.invalid ${app}` }, { status: [200] }, app), 'leak');
});

test('origin blanking applies only to the opaque-string rule: a user part glued to the origin is still a leak', () => {
  const base = { ok: true, status: 200, headers: {}, cookies: [], body: '' };
  const j = (body, app) => judge({ ...base, body }, { status: [200] }, app);
  const long = 'https://twisted-nail-recruiter-app-staging-2.onrender.com';
  assert.equal(j(`${long}@evil.example.com`, long), 'leak');
  assert.equal(j('http://a@x.example.com', 'http://a'), 'leak');
  assert.equal(j(`${long}%40evil.example.com`, long), 'leak');
  assert.equal(judge({ ...base, headers: { location: 'http://a@x.example.com' } }, { status: [200] }, 'http://a'), 'leak');
  // the long-label false alarm stays fixed
  assert.equal(j(`see ${long}/signin`, long), null);
});

test('TRUCKRECRU-47: the app address in capitals, without the scheme, or percent-encoded is not a false leak', () => {
  const base = { ok: true, status: 200, headers: {}, cookies: [], body: '' };
  const j = (body, app, headers = {}) => judge({ ...base, body, headers }, { status: [200] }, app);
  const long = 'https://twisted-nail-recruiter-app-staging-2.onrender.com';
  const host = 'twisted-nail-recruiter-app-staging-2.onrender.com';
  assert.equal(j(`go ${long.toUpperCase()}/signin`, long), null, 'capitals');
  assert.equal(j('go https://Twisted-Nail-Recruiter-App-Staging-2.onrender.com/x', long), null, 'mixed case');
  assert.equal(j(`host ${host}`, long), null, 'no scheme');
  assert.equal(j(`host ${host.toUpperCase()}`, long), null, 'no scheme, capitals');
  assert.equal(j(`next=${encodeURIComponent(`${long}/signin`)}`, long), null, 'percent-encoded');
  assert.equal(j(`next=${encodeURIComponent(`${long}/signin`).toLowerCase()}`, long), null, 'percent-encoded, lower-case hex');
  assert.equal(j('', long, { location: `/signin?next=${encodeURIComponent(`${long}/signin`)}` }), null, 'percent-encoded in a header');
  // Without --app-origin the rule is unchanged.
  assert.equal(j(`go ${long.toUpperCase()}/signin`), 'leak');
  assert.equal(j(`host ${host}`), 'leak');
});

test('TRUCKRECRU-47: the wider recognition hides no real leak', () => {
  const base = { ok: true, status: 200, headers: {}, cookies: [], body: '' };
  const j = (body, app, headers = {}) => judge({ ...base, body, headers }, { status: [200] }, app);
  const long = 'https://twisted-nail-recruiter-app-staging-2.onrender.com';
  const host = 'twisted-nail-recruiter-app-staging-2.onrender.com';
  const tok = 'abcdef0123456789abcdef0123456789zz';
  const enc = encodeURIComponent(long);
  assert.equal(j(`${long.toUpperCase()}@EVIL.EXAMPLE.COM`, long), 'leak', 'capitals + user part');
  assert.equal(j(`${long.toUpperCase()}%40Evil.Example.COM`, long), 'leak', 'capitals + %40');
  assert.equal(j(`${host}@evil.example.com`, long), 'leak', 'bare host + user part');
  assert.equal(j(`${enc}@evil.example.com`, long), 'leak', 'encoded origin + user part');
  assert.equal(j(`${enc}%40evil.example.com`, long), 'leak', 'encoded origin + %40');
  assert.equal(j(`${long.toUpperCase()}/${tok}`, long), 'leak', 'capitals + token');
  assert.equal(j(`${host}/${tok}`, long), 'leak', 'bare host + token');
  assert.equal(j(`${host}${tok}`, long), 'leak', 'bare host glued to token');
  assert.equal(j(`${tok}${host}`, long), 'leak', 'token glued before bare host');
  assert.equal(j(`${enc}${tok}`, long), 'leak', 'encoded origin glued to token');
  assert.equal(j(`${enc}/x?token=${'A'.repeat(20)}`, long), 'leak', 'encoded origin + token=');
  assert.equal(j('', long, { location: `${long.toUpperCase()}@evil.example.com` }), 'leak', 'header, capitals + user part');
  assert.equal(j('', long, { 'x-debug': tok }), 'leak', 'opaque string in another header');
  // A short host must not eat letters out of a longer secret (bare host is blanked as a whole token only).
  assert.equal(j('http://abcdef0123456789abcdef0123456789z', 'http://a'), 'leak', 'one-letter host inside a secret');
  assert.equal(j('xxxxxxxx0123456789a0123456789xxxxxxxxxxxx', 'http://a'), 'leak', 'one-letter host inside a secret (2)');
  // Boundary check itself (review of TRUCKRECRU-47): in each case the host is at the edge of a secret that is 32+ characters on its own.
  const s30 = 'Qx7Lm2Pz9Rt4Vb6Nc8Wd1Ye3Hf5Gk0';
  assert.equal(j(`id=${s30}Za/x`, 'http://a'), 'leak', 'secret ends in the host, then a slash');
  assert.equal(j(`/x/aZ${s30}`, 'http://a'), 'leak', 'secret starts with the host, after a slash');
  assert.equal(j(`${s30.slice(0, 16)}-a-${s30.slice(16)}`, 'http://a'), 'leak', 'host between hyphens inside a secret');
  assert.equal(j('Qx7Lm2Pz9Rt4Vb6N_a_c8Wd1Ye3Hf5Gk0', 'http://a'), 'leak', 'host between underscores inside a secret');
  assert.equal(j(`k=${s30.slice(0, 10)}${host}`, long), 'leak', 'real address: secret glued in front of the staging app host');
  // Overlap: a secret that starts with the end of the app address, or ends with its scheme, glued on with no gap.
  assert.equal(j('https://app.example.COMQx7Lm2Pz9Rt4Vb6Nc8Wd1Ye3Hf5Gk', 'https://app.example.com'), 'leak', 'secret starts with the last label, capitals');
  assert.equal(j('https%3A%2F%2Fapp.example.comQx7Lm2Pz9Rt4Vb6Nc8Wd1Ye3Hf5Gk', 'https://app.example.com'), 'leak', 'secret starts with the last label, encoded');
  assert.equal(j('https://app.example.comQx7Lm2Pz9Rt4Vb6Nc8Wd1Ye3Hf5Gk', 'https://app.example.com'), 'leak', 'secret starts with the last label, exact');
  assert.equal(j(`${s30.slice(0, 28)}https://app.example.com`, 'https://app.example.com'), 'leak', 'secret ends with the scheme text, glued before the address');
});

test('review note 2: the usage example in the script header names --app-origin', async () => {
  const { readFileSync } = await import('node:fs');
  const text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'signin-probes-a5a.mjs'), 'utf8');
  assert.match(text, /node scripts\/signin-probes-a5a\.mjs --origin http:\/\/127\.0\.0\.1:8788 --app-origin /);
});
