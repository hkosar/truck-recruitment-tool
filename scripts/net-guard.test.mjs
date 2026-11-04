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
import { Socket } from 'node:net';
globalThis.reached = [];
Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  globalThis.reached.push(first);
  if (first && first.lookup && first.host) first.lookup(first.host, { all: true }, (err, ...rest) => { globalThis.delivered = rest; this.destroy(err ?? new Error('stub: reached the real connect')); });
  else this.destroy(new Error('stub: reached the real connect'));
  return this;
};
`;
writeFileSync(join(dir, 'stub.mjs'), stub);

// Runs a body in a child (guard loaded over the stub) and returns the printed JSON.
function run(body) {
  const file = join(dir, 'child.mjs');
  writeFileSync(file, `import { Socket } from 'node:net';
const attempt = (options) => new Promise((resolve) => { const s = new Socket(); s.on('error', (e) => resolve(e.message)); s.connect(options); });
const out = await (async () => { ${body} })();
console.log(JSON.stringify({ out, reached: globalThis.reached.length, delivered: globalThis.delivered ?? null }));
`);
  const log = join(dir, 'guard.log');
  writeFileSync(log, '');
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(join(dir, 'stub.mjs')).href, '--import', guardUrl, file], { env: { ...process.env, NODE_OPTIONS: '', NET_GUARD_LOG: log }, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  return { ...JSON.parse(r.stdout.trim().split('\n').pop()), log: readFileSync(log, 'utf8') };
}

test('blocks connects to non-loopback addresses and names without a caller resolver', () => {
  const r = run(`return [await attempt({ host: '192.0.2.1', port: 9 }), await attempt({ host: 'example.invalid', port: 9 }), await attempt({ host: '[2001:db8::1]', port: 9 })];`);
  assert.deepEqual(r.out, ['net-guard blocked a connect to 192.0.2.1', 'net-guard blocked a connect to example.invalid', 'net-guard blocked a connect to 2001:db8::1']);
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
