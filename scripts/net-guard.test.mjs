// Tests scripts/net-guard.mjs in child node processes. No network: each child first loads a stub that replaces
// Socket.prototype.connect (it only records and fails), THEN the guard, so the guard sits on top of the stub and a guard that
// failed to block would reach the stub, never a real socket.
// Run: node --test scripts/net-guard.test.mjs

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const guardUrl = pathToFileURL(join(import.meta.dirname, 'net-guard.mjs')).href;
const dir = mkdtempSync(join(tmpdir(), 'net-guard-test-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

const stub = `
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';
import { Socket } from 'node:net';
globalThis.reached = [];
globalThis.seen = [];
// FAKE_SYSTEM_ANSWER makes the SYSTEM resolver answer that address (the guard captures dns.lookup when it loads, after this stub).
if (process.env.FAKE_SYSTEM_ANSWER) { dns.lookup = (name, opts, done) => done(null, [{ address: process.env.FAKE_SYSTEM_ANSWER, family: 4 }]); syncBuiltinESMExports(); }
Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  globalThis.reached.push(first);
  globalThis.seen.push({ marked: Array.isArray(args[0]) && Object.getOwnPropertySymbols(args[0]).length > 0, plainArray: Array.isArray(args[0]), host: first?.host, port: first?.port, path: first?.path, lookup: typeof first?.lookup, last: typeof args.at(-1) });
  if (first && first.lookup && first.host) first.lookup(first.host, { all: true }, (err, ...rest) => { globalThis.delivered = rest; this.destroy(err ?? new Error('stub: reached the real connect')); });
  else this.destroy(new Error('stub: reached the real connect'));
  return this;
};
`;
writeFileSync(join(dir, 'stub.mjs'), stub);

// Runs a body in a child (guard loaded over the stub) and returns the printed JSON.
function run(body, extraEnv = {}) {
  const file = join(dir, 'child.mjs');
  writeFileSync(file, `import { Socket } from 'node:net';
const attempt = (options) => new Promise((resolve) => { const s = new Socket(); s.on('error', (e) => resolve(e.message)); s.connect(options); });
const out = await (async () => { ${body} })();
console.log(JSON.stringify({ out, reached: globalThis.reached.length, delivered: globalThis.delivered ?? null, seen: globalThis.seen }));
`);
  const log = join(dir, 'guard.log');
  writeFileSync(log, '');
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(join(dir, 'stub.mjs')).href, '--import', guardUrl, file], { env: { ...process.env, NODE_OPTIONS: '', NET_GUARD_LOG: log, ...extraEnv }, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  return { ...JSON.parse(r.stdout.trim().split('\n').pop()), log: readFileSync(log, 'utf8') };
}

test('blocks connects to non-loopback addresses and names without a caller resolver', () => {
  const r = run(`return [await attempt({ host: '192.0.2.1', port: 9 }), await attempt({ host: 'example.invalid', port: 9 }), await attempt({ host: '[2001:db8::1]', port: 9 })];`);
  assert.deepEqual(r.out, ['net-guard blocked a connect to 192.0.2.1', 'net-guard blocked a connect to example.invalid', 'net-guard blocked a connect to [2001:db8::1]']);
  assert.equal(r.reached, 0);
  assert.equal(r.log.trim().split('\n').length, 3);
});

test('lets loopback addresses through to the real connect', () => {
  const r = run(`return [await attempt({ host: '127.0.0.1', port: 9 }), await attempt({ host: '::1', port: 9 })];`);
  assert.deepEqual(r.out, ['stub: reached the real connect', 'stub: reached the real connect']);
  assert.equal(r.reached, 2);
});

test('checks the answers of a caller-supplied resolver: mixed, empty, non-address and non-loopback answers are blocked', () => {
  const body = (answer) => `return await attempt({ host: 'localhost', port: 9, lookup: (n, o, done) => done(null, ${answer}) });`;
  for (const answer of ["[{ address: '127.0.0.1', family: 4 }, { address: '192.0.2.1', family: 4 }]", "[{ address: '192.0.2.1', family: 4 }, { address: '127.0.0.1', family: 4 }]", '[]', "[{ address: 'not-an-ip' }]", "'192.0.2.1'", '{}', 'undefined']) {
    const r = run(body(answer));
    assert.equal(r.out, 'net-guard blocked a non-loopback lookup answer for localhost', answer);
  }
  const ok = run(body("[{ address: '127.0.0.1', family: 4 }, { address: '::1', family: 6 }]"));
  assert.equal(ok.out, 'stub: reached the real connect');
  assert.deepEqual(ok.delivered, [[{ address: '127.0.0.1', family: 4 }, { address: '::1', family: 6 }], null]);
});

test('a resolver error passes through, and a getter that changes after the first read is delivered as one plain value', () => {
  assert.equal(run(`return await attempt({ host: 'localhost', port: 9, lookup: (n, o, done) => done(new Error('stub ENOTFOUND')) });`).out, 'stub ENOTFOUND');
  const r = run(`let reads = 0; const entry = { family: 4, get address() { return reads++ === 0 ? '127.0.0.1' : '192.0.2.1'; } };
    return await attempt({ host: 'localhost', port: 9, lookup: (n, o, done) => done(null, [entry]) });`);
  assert.equal(r.out, 'stub: reached the real connect');
  assert.deepEqual(r.delivered, [[{ address: '127.0.0.1', family: 4 }], null]);
});

test('the system resolver is guarded too: no caller lookup, host localhost, the stub receives a wrapped lookup', () => {
  const r = run(`return await attempt({ host: 'localhost', port: 9 });`);
  assert.match(r.out, /stub: reached the real connect|net-guard blocked a non-loopback lookup answer for localhost/);
  assert.equal(r.reached, 1);
});

test('the system resolver is checked: a system answer that is not loopback is blocked, and net is handed a lookup (not undefined)', () => {
  const r = run(`return await attempt({ host: 'localhost', port: 9 });`, { FAKE_SYSTEM_ANSWER: '192.0.2.1' });
  assert.equal(r.out, 'net-guard blocked a non-loopback lookup answer for localhost');
  assert.equal(r.seen[0].lookup, 'function');
  const ok = run(`return await attempt({ host: 'localhost', port: 9 });`, { FAKE_SYSTEM_ANSWER: '127.0.0.1' });
  assert.equal(ok.out, 'stub: reached the real connect');
  assert.deepEqual(ok.delivered, [[{ address: '127.0.0.1', family: 4 }], null]);
});

test('(port, host) form: a non-loopback host is blocked, a loopback host reaches connect', () => {
  const r = run(`const s = () => new Socket(); const go = (...a) => new Promise((resolve) => { const x = s(); x.on('error', (e) => resolve(e.message)); x.connect(...a); });
    return [await go(9, '192.0.2.1'), await go(9, 'example.invalid', () => {}), await go(9, '127.0.0.1'), await go(9, '::1')];`);
  assert.deepEqual(r.out, ['net-guard blocked a connect to 192.0.2.1', 'net-guard blocked a connect to example.invalid', 'stub: reached the real connect', 'stub: reached the real connect']);
  assert.equal(r.reached, 2);
});

test('string ports are decided as Node decides: "0x50", "80", " 9", "1e1" are ports (checked); a non-numeric string is a pipe path', () => {
  const r = run(`const go = (...a) => new Promise((resolve) => { const x = new Socket(); x.on('error', (e) => resolve(e.message)); x.connect(...a); });
    return [await go('0x50', '192.0.2.1'), await go('80', '192.0.2.1'), await go(' 9', '192.0.2.1'), await go('1e1', '192.0.2.1'), await go('/tmp/a.sock'), await go('abc', '192.0.2.1')];`);
  assert.deepEqual(r.out, ['net-guard blocked a connect to 192.0.2.1', 'net-guard blocked a connect to 192.0.2.1', 'net-guard blocked a connect to 192.0.2.1', 'net-guard blocked a connect to 192.0.2.1', 'stub: reached the real connect', 'stub: reached the real connect']);
  assert.equal(r.reached, 2);
});

test('a bracketed host is checked as the text Node will use: no bracket bypass, with or without a caller resolver', () => {
  const r = run(`return [
    await attempt({ host: '[127.0.0.1]', port: 9, lookup: (n, o, done) => done(null, [{ address: '0.0.0.0', family: 4 }]) }),
    await attempt({ host: '[::1]', port: 9, lookup: (n, o, done) => done(null, [{ address: '0.0.0.0', family: 4 }]) }),
    await attempt({ host: '[::1]', port: 9 }),
    await attempt({ host: '[127.0.0.1]', port: 9 })];`);
  assert.deepEqual(r.out, ['net-guard blocked a non-loopback lookup answer for [127.0.0.1]', 'net-guard blocked a non-loopback lookup answer for [::1]', 'net-guard blocked a connect to [::1]', 'net-guard blocked a connect to [127.0.0.1]']);
  assert.equal(r.reached, 2); // the two with a caller resolver get as far as the stub's lookup call, which the guard answers with a refusal
});

test('the [options, cb] form (net.connect, http) keeps Node\'s marked array and gets a guarded lookup', () => {
  const r = run(`const net = await import('node:net');
    const go = (...a) => new Promise((resolve) => { const s = net.connect(...a); s.on('error', (e) => resolve(e.message)); });
    return [await go(9, 'localhost'), await go({ host: 'localhost', port: 9 }), await go(9, '127.0.0.1'), await go(9, '192.0.2.1')];`);
  assert.deepEqual(r.out.slice(2), ['stub: reached the real connect', 'net-guard blocked a connect to 192.0.2.1']);
  for (const i of [0, 1]) {
    assert.deepEqual({ marked: r.seen[i].marked, host: r.seen[i].host, port: r.seen[i].port, lookup: r.seen[i].lookup }, { marked: true, host: 'localhost', port: 9, lookup: 'function' }, `call ${i}`);
  }
  assert.equal(r.seen[2].marked, true);
});

test('a getter on host, path or lookup is read once: Node is handed the value that was checked', () => {
  const r = run(`let reads = 0; const options = { port: 9, get host() { return reads++ === 0 ? '127.0.0.1' : '192.0.2.1'; } };
    const out = await attempt(options);
    return [out, globalThis.seen[0].host];`);
  assert.deepEqual(r.out, ['stub: reached the real connect', '127.0.0.1']);
});

test('ordinary localhost traffic works under the guard with the real net (http.get, net.connect, fetch)', () => {
  const file = join(dir, 'plain.mjs');
  writeFileSync(file, `import http from 'node:http';
import net from 'node:net';
const server = http.createServer((q, s) => s.end('hi'));
await new Promise((r) => server.listen(0, 'localhost', r));
const port = server.address().port;
const results = {};
results.httpGet = await new Promise((resolve, reject) => http.get({ host: 'localhost', port, agent: false }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve(b)); }).on('error', reject));
results.netConnect = await new Promise((resolve, reject) => { const s = net.connect(port, 'localhost', () => { s.destroy(); resolve('connected'); }); s.on('error', reject); });
results.netConnectObject = await new Promise((resolve, reject) => { const s = net.connect({ host: 'localhost', port }, () => { s.destroy(); resolve('connected'); }); s.on('error', reject); });
results.fetch = await (await fetch('http://localhost:' + port + '/')).text();
console.log(JSON.stringify(results));
process.exit(0);
`);
  const r = spawnSync(process.execPath, ['--import', guardUrl, file], { env: { ...process.env, NODE_OPTIONS: '', NET_GUARD_LOG: join(dir, 'plain.log') }, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').pop()), { httpGet: 'hi', netConnect: 'connected', netConnectObject: 'connected', fetch: 'hi' });
});