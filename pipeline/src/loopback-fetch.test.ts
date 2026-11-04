// Proves loopbackFetch is not redirected by Node env-proxy settings. A fake proxy and a fake target
// both listen on loopback; a child node process (env proxy is read at startup) requests the target.
// Run: tsx src/loopback-fetch.test.ts

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import type { lookup } from 'node:dns';
import { createServer, request } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { types } from 'node:util';
import { closeLoopbackAgent, loopbackAgent, loopbackFetch } from './loopback-fetch.js';
import { createServer as createTcpServer, Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

const HELPER = fileURLToPath(new URL('./loopback-fetch.ts', import.meta.url));

async function listen(onRequest: () => void, answer: string) {
  const server = createServer((req, res) => { onRequest(); req.resume(); res.writeHead(200); res.end(answer); });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return { server, port: (server.address() as AddressInfo).port };
}

// Child script: one request to the target through the transport named in argv, prints the body.
const CHILD = `
const [mode, helper, url] = process.argv.slice(1);
const f = mode === 'plain' ? fetch : (await import(helper)).loopbackFetch;
const r = await f(url, { method: 'POST', headers: { apikey: 'fake-key-not-real' }, body: '{}' });
console.log('BODY=' + await r.text());
`;

// Async on purpose: the fake servers live in this process and must keep answering while the child runs.
function runChild(mode: 'plain' | 'loopback', env: Record<string, string>, url: string) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD, mode, 'file:///' + HELPER.replace(/\\/g, '/'), url], {
      env: { ...process.env, NODE_USE_ENV_PROXY: '', NODE_OPTIONS: '', HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '', ...env },
      timeout: 30_000,
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (c) => { stdout += String(c); });
    child.stderr.on('data', (c) => { stderr += String(c); });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

let proxyHits = 0; let targetHits = 0;
// Node tunnels through an env proxy with CONNECT, which an http server never reports as a request,
// so the fake proxy counts raw TCP connections (any connection at all is a leak) and drops them.
const proxyServer = createTcpServer((socket) => { proxyHits++; socket.on('error', () => undefined); socket.destroy(); });
await new Promise<void>((done) => proxyServer.listen(0, '127.0.0.1', done));
const proxy = { server: proxyServer, port: (proxyServer.address() as AddressInfo).port };
const target = await listen(() => { targetHits++; }, 'FROM-TARGET');
const targetUrl = `http://127.0.0.1:${target.port}/auth/v1/admin/users`;
const proxyEnv = (extra: Record<string, string>) => ({ HTTP_PROXY: `http://127.0.0.1:${proxy.port}`, HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`, ...extra });
try {
  for (const [label, extra] of [['NODE_USE_ENV_PROXY=1', { NODE_USE_ENV_PROXY: '1' }], ['NODE_OPTIONS=--use-env-proxy', { NODE_OPTIONS: '--use-env-proxy' }]] as const) {
    // Control: the plain global fetch IS redirected under this setting, so the setup really exercises the proxy.
    proxyHits = 0; targetHits = 0;
    const plain = await runChild('plain', proxyEnv(extra), targetUrl);
    assert.equal(proxyHits, 1, `${label}: control (plain fetch) must reach the fake proxy (connection counted); stderr: ${plain.stderr}`);
    assert.equal(targetHits, 0);

    // The helper must reach the target directly and send nothing to the proxy.
    proxyHits = 0; targetHits = 0;
    const direct = await runChild('loopback', proxyEnv(extra), targetUrl);
    assert.equal(direct.status, 0, `${label}: helper child failed: ${direct.stderr}`);
    assert.match(direct.stdout, /BODY=FROM-TARGET/);
    assert.equal(proxyHits, 0, `${label}: 0 requests may reach the proxy`);
    assert.equal(targetHits, 1, `${label}: the target gets exactly one request`);
  }

  // Non-loopback addresses are refused before any socket is opened, as a rejected promise.
  for (const bad of ['http://example.com/', 'https://127.0.0.1/', 'http://10.0.0.5/', 'http://127.0.0.2/']) {
    await assert.rejects(loopbackFetch(bad), /refuses non-loopback/, bad);
  }
  await assert.rejects(loopbackFetch('not a url'), /Invalid URL/);

  // Keep-alive: two requests share one socket and the client never asks the server to close
  // (agent: false would send "Connection: close" and hide whether the server closes).
  {
    let connections = 0; const asked: Array<string | undefined> = [];
    const server = createServer((req, res) => { asked.push(req.headers.connection); res.writeHead(200); res.end('ok'); });
    server.on('connection', () => { connections++; });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const port = (server.address() as AddressInfo).port;
    try {
      await (await loopbackFetch(`http://127.0.0.1:${port}/`)).text();
      await (await loopbackFetch(`http://127.0.0.1:${port}/`)).text();
      assert.equal(connections, 1, 'the second request reuses the connection');
      assert.deepEqual(asked, ['keep-alive', 'keep-alive']);
      await new Promise<void>((resolve, reject) => { request({ agent: loopbackAgent(), host: '127.0.0.1', port }, (res) => { res.resume(); res.on('end', resolve); }).on('error', reject).end(); });
      assert.equal(connections, 1, 'request() through the shared agent reuses it too');
    } finally { closeLoopbackAgent(); server.close(); }
  }

  // The shared agent refuses non-loopback addresses at connect time, before any socket is opened.
  {
    // Even if a refusal regressed, nothing reaches a network: the resolver is a stub that answers with a reserved
    // documentation address (192.0.2.x), and Socket.connect fails instead of connecting.
    // Like real net, the stub asks for ALL addresses ({ all: true }) unless askAll is false; in that mode the answer is a mixed list (a
    // loopback address first, then the given one), so a check that accepts "some" loopback answers, or skips lists, is caught.
    const realConnect = Socket.prototype.connect; let opened = 0; let askAll = true; let delivered: unknown[][] = [];
    Socket.prototype.connect = function (this: Socket, options: unknown) {
      // Stands in for net: resolve the host with the options' lookup (as net would), then "connect" by failing.
      opened++;
      const o = (Array.isArray(options) ? options[0] : options) as { host?: string; lookup?: (name: string, opts: object, done: (err: Error | null, ...rest: unknown[]) => void) => void };
      if (o.lookup && o.host) o.lookup(o.host, askAll ? { all: true } : {}, (err, ...rest) => { delivered.push(rest); this.destroy(err ?? new Error('socket opened')); });
      else this.destroy(new Error('socket opened'));
      return this;
    } as typeof Socket.prototype.connect;
    const answerWith = (address: string, calls: string[] = []) =>
      ((name: string, opts: { all?: boolean }, done: (err: null, a: unknown, f?: number) => void) => {
        calls.push(name);
        if (opts.all) done(null, [{ address: '127.0.0.1', family: 4 }, { address, family: 4 }]); else done(null, address, 4);
      }) as unknown as typeof lookup;
    const refusedRequest = (host: string, lookup: unknown) => new Promise((resolve, reject) => { request({ agent: loopbackAgent(), host, port: 9, lookup: lookup as typeof import('node:dns').lookup }, resolve).on('error', reject).end(); });
    try {
      for (const host of ['192.0.2.1', 'example.invalid', '192.0.2.5', '127.0.0.2']) {
        await assert.rejects(refusedRequest(host, answerWith('192.0.2.1')), /refuses non-loopback/, host);
      }
      // The bracketed [::1] spelling is refused before any name lookup.
      const bracketLookups: string[] = [];
      await assert.rejects(refusedRequest('[::1]', answerWith('192.0.2.1', bracketLookups)), /refuses non-loopback/);
      assert.deepEqual(bracketLookups, [], '[::1] is refused before a lookup');
      assert.equal(opened, 0, 'no socket was opened for an outside address');
      // localhost may only resolve to loopback addresses (connect is entered for it, the lookup runs inside; 'socket opened' would mean a regression).
      const localhostLookups: string[] = [];
      await assert.rejects(refusedRequest('localhost', answerWith('192.0.2.1', localhostLookups)), /refuses non-loopback address: localhost/);
      assert.deepEqual(localhostLookups, ['localhost']);
      // The same in single-answer mode.
      askAll = false;
      await assert.rejects(refusedRequest('localhost', answerWith('192.0.2.1')), /refuses non-loopback address: localhost/);
      askAll = true;
      // A lookup error passes through unchanged; an empty answer list is refused.
      await assert.rejects(refusedRequest('localhost', ((name: string, opts: object, done: (err: Error) => void) => done(new Error('stub ENOTFOUND'))) as unknown as typeof lookup), /stub ENOTFOUND/);
      await assert.rejects(refusedRequest('localhost', ((name: string, opts: object, done: (err: null, a: unknown[]) => void) => done(null, [])) as unknown as typeof lookup), /refuses non-loopback address: localhost/);
      // Copy contract: the answer handed to net is a plain copy that cannot change after the check.
      const flipping = () => { let reads = 0; return { family: 4, get address() { return reads++ === 0 ? '127.0.0.1' : '127.0.0.3'; } }; };
      const sneaky = ((name: string, opts: object, done: (err: null, a: unknown) => void) => done(null, [flipping()])) as unknown as typeof lookup;
      const proxied = ((name: string, opts: object, done: (err: null, a: unknown) => void) => {
        let reads = 0; const entry = { address: '127.0.0.1', family: 4 };
        done(null, new Proxy([entry], { get: (t, k, r) => (k === '0' && reads++ > 0 ? { address: '127.0.0.3', family: 4 } : Reflect.get(t, k, r)) }));
      }) as unknown as typeof lookup;
      for (const l of [sneaky, proxied]) {
        delivered = [];
        await assert.rejects(refusedRequest('localhost', l), /socket opened/); // loopback answer: the stub "connects" (fails)
        const list = delivered[0]?.[0] as Array<{ address: string }>;
        assert.ok(Array.isArray(list));
        assert.equal(types.isProxy(list), false);
        assert.deepEqual(list.map((a) => [a.address, a.address, Object.getOwnPropertyDescriptor(a, 'address')?.value]), [['127.0.0.1', '127.0.0.1', '127.0.0.1']]);
      }
    } finally { Socket.prototype.connect = realConnect; closeLoopbackAgent(); }
  }

  // A string body on DELETE and OPTIONS is framed with Content-Length, as fetch does.
  {
    const got: Array<[string, string, string | undefined]> = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += String(c); });
      req.on('end', () => { got.push([req.method ?? '', body, req.headers['content-length']]); res.writeHead(200); res.end('ok'); });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    try {
      for (const method of ['DELETE', 'OPTIONS', 'POST']) {
        const r = await loopbackFetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`, { method, body: 'héllo' });
        assert.equal(r.status, 200, method);
      }
      assert.deepEqual(got, [['DELETE', 'héllo', '6'], ['OPTIONS', 'héllo', '6'], ['POST', 'héllo', '6']]);
    } finally { closeLoopbackAgent(); server.close(); }
  }

  // redirect option, as in fetch.
  {
    const seen: Array<{ port: number; method: string; url: string; body: string; authorization?: string }> = [];
    let aPort = 0; let bPort = 0;
    const handler = (port: () => number) => (req: IncomingMessage, res: ServerResponse) => {
      let body = '';
      req.on('data', (c) => { body += String(c); });
      req.on('end', () => {
        seen.push({ port: port(), method: req.method ?? '', url: req.url ?? '', body, authorization: req.headers.authorization });
        const to = (status: number, location: string) => { res.writeHead(status, { location }); res.end(); };
        const u = req.url ?? '';
        if (u === '/r301') to(301, '/final'); else if (u === '/r303') to(303, '/final'); else if (u === '/r307') to(307, '/final');
        else if (u === '/loop') to(302, '/loop');
        else if (u === '/offsite') to(302, 'http://redirect-target.invalid/x');
        else if (u === '/cross') to(307, `http://127.0.0.1:${bPort}/final`);
        else if (u === '/no-location') { res.writeHead(302); res.end('plain'); }
        else { res.writeHead(200); res.end('FINAL'); }
      });
    };
    const a = createServer(handler(() => aPort)); const b = createServer(handler(() => bPort));
    await new Promise<void>((done) => a.listen(0, '127.0.0.1', done));
    await new Promise<void>((done) => b.listen(0, '127.0.0.1', done));
    aPort = (a.address() as AddressInfo).port; bPort = (b.address() as AddressInfo).port;
    const at = (path: string) => `http://127.0.0.1:${aPort}${path}`;
    try {
      for (const path of ['/r301', '/r303', '/r307']) await assert.rejects(loopbackFetch(at(path), { redirect: 'error' }), /redirect/, `error ${path}`);
      assert.deepEqual(seen.map((s) => s.url), ['/r301', '/r303', '/r307'], "'error' never makes the second request");

      seen.length = 0;
      const manual = await loopbackFetch(at('/r303'), { redirect: 'manual' });
      assert.deepEqual([manual.status, manual.headers.get('location'), seen.length], [303, '/final', 1]);

      const init = { method: 'POST', body: 'payload', headers: { 'content-type': 'text/plain' } };
      for (const [path, method, body] of [['/r301', 'GET', ''], ['/r303', 'GET', ''], ['/r307', 'POST', 'payload']] as const) {
        seen.length = 0;
        const r = await loopbackFetch(at(path), init);
        assert.deepEqual([r.status, await r.text()], [200, 'FINAL']);
        assert.deepEqual(seen.map((s) => [s.method, s.url, s.body]), [['POST', path, 'payload'], [method, '/final', body]], `follow ${path}`);
      }

      await assert.rejects(loopbackFetch(at('/offsite')), /refuses non-loopback/, 'every hop is re-checked');
      await assert.rejects(loopbackFetch(at('/loop')), /too many redirects/);
      seen.length = 0;
      await (await loopbackFetch(at('/cross'), { headers: { authorization: 'Bearer fake' } })).text();
      assert.deepEqual(seen.map((s) => [s.port === bPort ? 'b' : 'a', s.url, s.authorization]), [['a', '/cross', 'Bearer fake'], ['b', '/final', undefined]], 'credentials do not cross origins');

      await assert.rejects(loopbackFetch(at('/no-location'), { redirect: 'error' }), TypeError, "'error' rejects on a 3xx without Location, as fetch does");
      for (const redirect of ['follow', 'manual']) {
        const plain = await loopbackFetch(at('/no-location'), { redirect });
        assert.deepEqual([plain.status, await plain.text()], [302, 'plain'], `${redirect} returns a 3xx without Location as is`);
      }
      await assert.rejects(loopbackFetch(at('/'), { redirect: 'sideways' }), TypeError);
    } finally { closeLoopbackAgent(); a.close(); b.close(); }
  }

  // Source guard: smoke-tests.ts and every *.test.ts here may reach the network only through loopbackFetch/loopbackAgent.
  // (The two helper copies being byte-identical is checked by scripts/verify-loopback-fetch-contract.mjs.)
  const { findLoopbackViolations } = await import('./loopback-guard.js');
  const here = fileURLToPath(new URL('.', import.meta.url));
  const files = readdirSync(here).filter((f) => f === 'smoke-tests.ts' || f.endsWith('.test.ts'));
  assert.ok(files.includes('smoke-tests.ts') && files.includes('loopback-fetch.test.ts'), 'the scan finds the test files');
  const found = files.flatMap((f) => findLoopbackViolations(f, readFileSync(join(here, f), 'utf8')));
  assert.deepEqual(found, []);
  const prefix = "import { request } from 'node:http';\nimport { loopbackAgent } from './loopback-fetch.js';\n";
  const bypasses = [
    'request(\n  { host: "127.0.0.1" }, () => {});', 'const o = { agent: loopbackAgent() }; request(o, () => {});', 'globalThis.fetch("http://x/");', 'fetch ("http://x/");',
    'const f = fetch; f("http://x/");', 'request({ host: "127.0.0.1" }, () => {}); // agent: false', 'const falseAgent = 1; request({ agent: falseAgent }, () => {});',
    'request({ agent: false }, () => {});', 'const r = request; r({ agent: loopbackAgent() }, () => {});', 'globalThis["fetch"]("http://x/");',
  ];
  for (const code of bypasses) assert.notDeepEqual(findLoopbackViolations('sample.ts', prefix + code), [], code);
  assert.deepEqual(findLoopbackViolations('sample.ts', `${prefix}request({ agent: loopbackAgent(), host: "127.0.0.1" }, () => {}); const s = "fetch(x)"; type T = typeof fetch;`), []);
  console.log('loopback-fetch.test: ok');
} finally {
  proxy.server.close(); target.server.close();
}
