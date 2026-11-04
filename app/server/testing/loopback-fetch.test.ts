// Proves the loopback-only HTTP tests cannot be redirected by Node env-proxy settings. A fake proxy
// (raw TCP, because Node tunnels with CONNECT) and a fake target listen on loopback; a child node
// process (env proxy is read at startup) requests the target. Also: keep-alive, redirect handling, and the source guard.

import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { createServer as createTcpServer, Socket, type AddressInfo, type Server } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeLoopbackAgent, loopbackAgent, loopbackFetch } from './loopback-fetch';
import { findLoopbackViolations } from './loopback-guard';

const HELPER = fileURLToPath(new URL('./loopback-fetch.ts', import.meta.url));
const CHILD = `
const [mode, helper, url] = process.argv.slice(1);
const f = mode === 'plain' ? fetch : (await import(helper)).loopbackFetch;
const r = await f(url, { method: 'POST', body: '{}' });
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

describe('loopbackFetch ignores Node env-proxy settings', () => {
  let proxyHits = 0; let targetHits = 0;
  let proxy: Server; let target: ReturnType<typeof createServer>;
  let proxyPort = 0; let targetUrl = '';
  beforeAll(async () => {
    proxy = createTcpServer((socket) => { proxyHits++; socket.on('error', () => undefined); socket.destroy(); });
    await new Promise<void>((done) => proxy.listen(0, '127.0.0.1', done));
    proxyPort = (proxy.address() as AddressInfo).port;
    target = createServer((req, res) => { targetHits++; req.resume(); res.writeHead(200); res.end('FROM-TARGET'); });
    await new Promise<void>((done) => target.listen(0, '127.0.0.1', done));
    targetUrl = `http://127.0.0.1:${(target.address() as AddressInfo).port}/x`;
  });
  afterAll(() => { proxy.close(); target.close(); });

  // A Node without env-proxy support (no --use-env-proxy flag) cannot redirect fetch, so the proxy cases have nothing to prove there.
  const envProxySupported = process.allowedNodeEnvironmentFlags.has('--use-env-proxy');
  if (!envProxySupported) console.log(`SKIP env-proxy cases: Node ${process.version} has no --use-env-proxy / NODE_USE_ENV_PROXY support`);
  for (const [label, extra] of [['NODE_USE_ENV_PROXY=1', { NODE_USE_ENV_PROXY: '1' }], ['NODE_OPTIONS=--use-env-proxy', { NODE_OPTIONS: '--use-env-proxy' }]] as const) {
    it.skipIf(!envProxySupported)(`${label}: plain fetch reaches the proxy (control), loopbackFetch sends 0 requests to it`, async () => {
      // Both spellings: Node reads http_proxy ?? HTTP_PROXY, so on Linux (case-sensitive env) the blank lowercase name from runChild would win.
      const env = { HTTP_PROXY: `http://127.0.0.1:${proxyPort}`, HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`, http_proxy: `http://127.0.0.1:${proxyPort}`, https_proxy: `http://127.0.0.1:${proxyPort}`, ...extra };
      proxyHits = 0; targetHits = 0;
      await runChild('plain', env, targetUrl);
      expect(proxyHits, 'control: the setting must really redirect plain fetch').toBe(1);
      expect(targetHits).toBe(0);

      proxyHits = 0; targetHits = 0;
      const direct = await runChild('loopback', env, targetUrl);
      expect(direct.status, direct.stderr).toBe(0);
      expect(direct.stdout).toContain('BODY=FROM-TARGET');
      expect(proxyHits).toBe(0);
      expect(targetHits).toBe(1);
    });
  }

  it('refuses addresses that are not loopback http (as a rejected promise, never a connect)', async () => {
    for (const bad of ['http://example.com/', 'https://127.0.0.1/', 'http://10.0.0.5/', 'http://127.0.0.2/', 'not a url']) {
      await expect(loopbackFetch(bad)).rejects.toThrow(/refuses non-loopback|Invalid URL/);
    }
  });
});

describe('loopbackFetch keeps connections alive on a private agent', () => {
  afterAll(() => closeLoopbackAgent());
  it('two requests reuse one socket, and the client does not ask the server to close', async () => {
    let connections = 0; const asked: Array<string | undefined> = [];
    const server = createServer((req, res) => { asked.push(req.headers.connection); res.writeHead(200); res.end('ok'); });
    server.on('connection', () => { connections++; });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    try {
      await (await loopbackFetch(url)).text();
      await (await loopbackFetch(url)).text();
      expect(connections).toBe(1);
      expect(asked).toEqual(['keep-alive', 'keep-alive']);
      // Node's own request() through the shared agent behaves the same.
      await new Promise<void>((resolve, reject) => { request({ agent: loopbackAgent(), host: '127.0.0.1', port: (server.address() as AddressInfo).port }, (res) => { res.resume(); res.on('end', resolve); }).on('error', reject).end(); });
      expect(connections).toBe(1);
    } finally {
      closeLoopbackAgent();
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});

describe('the shared agent refuses non-loopback addresses at connect time', () => {
  afterAll(() => closeLoopbackAgent());
  // Even if a refusal regressed, these tests cannot reach a network: the resolver is a stub that answers with a
  // reserved documentation address (192.0.2.x), and Socket.connect is stubbed to fail instead of connecting.
  const answerWith = (address: string, calls: string[] = []) =>
    ((name: string, opts: { all?: boolean }, done: (err: null, a: unknown, f?: number) => void) => {
      calls.push(name);
      if (opts.all) done(null, [{ address, family: 4 }]); else done(null, address, 4);
    }) as unknown as typeof import('node:dns').lookup;
  const refusedRequest = (host: string, lookup: unknown) => new Promise((resolve, reject) => { request({ agent: loopbackAgent(), host, port: 9, lookup: lookup as typeof import('node:dns').lookup }, resolve).on('error', reject).end(); });
  const noRealConnect = () => vi.spyOn(Socket.prototype, 'connect').mockImplementation(function (this: Socket, options: unknown) {
    // Stands in for net: resolve the host with the options' lookup (as net would), then "connect" by failing.
    const o = (Array.isArray(options) ? options[0] : options) as { host?: string; lookup?: (name: string, opts: object, done: (err: Error | null) => void) => void };
    // Like net: mark the socket connecting, then resolve later (Node 22 attaches the request's error listener only after connect returns).
    if (o.lookup && o.host) { (this as unknown as { connecting: boolean }).connecting = true; setImmediate(() => o.lookup!(o.host!, {}, (err) => { this.destroy(err ?? new Error('socket opened')); })); }
    else this.destroy(new Error('socket opened'));
    return this;
  });
  it('an outside host is refused before any socket is opened', async () => {
    const opened = noRealConnect();
    try {
      for (const host of ['192.0.2.1', 'example.invalid', '192.0.2.5', '127.0.0.2']) {
        await expect(refusedRequest(host, answerWith('192.0.2.1')), host).rejects.toThrow(/refuses non-loopback/);
      }
      expect(opened).not.toHaveBeenCalled();
    } finally {
      opened.mockRestore();
    }
  });

  it('the bracketed [::1] spelling is refused before any name lookup', async () => {
    const opened = noRealConnect();
    const lookups: string[] = [];
    try {
      await expect(refusedRequest('[::1]', answerWith('192.0.2.1', lookups))).rejects.toThrow(/refuses non-loopback/);
      expect(lookups).toEqual([]);
      expect(opened).not.toHaveBeenCalled();
    } finally {
      opened.mockRestore();
    }
  });

  it('localhost may only resolve to loopback addresses', async () => {
    const opened = noRealConnect();
    const lookups: string[] = [];
    try {
      await expect(refusedRequest('localhost', answerWith('192.0.2.1', lookups))).rejects.toThrow(/refuses non-loopback address: localhost/);
      expect(lookups).toEqual(['localhost']);
      // Not asserted: connect is entered for localhost (the lookup runs inside it); only a 'socket opened' error would mean a regression.
    } finally {
      opened.mockRestore();
    }
  });

  it('a loopback host still connects through the agent', async () => {
    const server = createServer((req, res) => { req.resume(); res.writeHead(200); res.end('ok'); });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    try {
      const r = await loopbackFetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
      expect(await r.text()).toBe('ok');
    } finally {
      closeLoopbackAgent();
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});

describe('loopbackFetch sends a body on every method with its length', () => {
  afterAll(() => closeLoopbackAgent());
  it('a string body on DELETE and OPTIONS arrives as one request with that body', async () => {
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
        expect(r.status, method).toBe(200);
      }
      expect(got).toEqual([['DELETE', 'héllo', '6'], ['OPTIONS', 'héllo', '6'], ['POST', 'héllo', '6']]);
    } finally {
      closeLoopbackAgent();
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});

describe('loopbackFetch honours the redirect option like fetch', () => {
  const seen: Array<{ port: number; method: string; url: string; body: string; authorization?: string }> = [];
  let a: ReturnType<typeof createServer>; let b: ReturnType<typeof createServer>; let aPort = 0; let bPort = 0;
  const handler = (port: () => number) => (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
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
  beforeAll(async () => {
    a = createServer(handler(() => aPort)); b = createServer(handler(() => bPort));
    await new Promise<void>((done) => a.listen(0, '127.0.0.1', done));
    await new Promise<void>((done) => b.listen(0, '127.0.0.1', done));
    aPort = (a.address() as AddressInfo).port; bPort = (b.address() as AddressInfo).port;
  });
  afterAll(async () => {
    closeLoopbackAgent();
    await new Promise<void>((done) => a.close(() => done()));
    await new Promise<void>((done) => b.close(() => done()));
  });
  const at = (path: string) => `http://127.0.0.1:${aPort}${path}`;

  it("'error' rejects on any redirect and never makes the second request", async () => {
    seen.length = 0;
    for (const path of ['/r301', '/r303', '/r307']) await expect(loopbackFetch(at(path), { redirect: 'error' })).rejects.toThrow(/redirect/);
    expect(seen.map((s) => s.url)).toEqual(['/r301', '/r303', '/r307']);
  });

  it("'manual' returns the 3xx and its Location without following", async () => {
    seen.length = 0;
    const r = await loopbackFetch(at('/r303'), { redirect: 'manual' });
    expect([r.status, r.headers.get('location')]).toEqual([303, '/final']);
    expect(seen).toHaveLength(1);
  });

  it("'follow' (the default, as in fetch) follows, with fetch's method and body rules", async () => {
    seen.length = 0;
    const init = { method: 'POST', body: 'payload', headers: { 'content-type': 'text/plain' } };
    for (const [path, method, body] of [['/r301', 'GET', ''], ['/r303', 'GET', ''], ['/r307', 'POST', 'payload']] as const) {
      seen.length = 0;
      const r = await loopbackFetch(at(path), init);
      expect([r.status, await r.text()]).toEqual([200, 'FINAL']);
      expect(seen.map((s) => [s.method, s.url, s.body])).toEqual([['POST', path, 'payload'], [method, '/final', body]]);
    }
    expect((await loopbackFetch(at('/r303'), { redirect: 'follow' })).status).toBe(200);
  });

  it("'follow' re-checks every hop: an off-loopback Location is refused, a redirect loop stops, and credentials do not cross origins", async () => {
    await expect(loopbackFetch(at('/offsite'))).rejects.toThrow(/refuses non-loopback/);
    await expect(loopbackFetch(at('/loop'))).rejects.toThrow(/too many redirects/);
    seen.length = 0;
    await (await loopbackFetch(at('/cross'), { headers: { authorization: 'Bearer fake' } })).text();
    expect(seen.map((s) => [s.port === bPort ? 'b' : 'a', s.url, s.authorization])).toEqual([['a', '/cross', 'Bearer fake'], ['b', '/final', undefined]]);
  });

  it("a 3xx without Location rejects with 'error' (as fetch does) and is returned as is with 'follow' and 'manual'", async () => {
    await expect(loopbackFetch(at('/no-location'), { redirect: 'error' })).rejects.toThrow(TypeError);
    for (const redirect of ['follow', 'manual']) {
      const r = await loopbackFetch(at('/no-location'), { redirect });
      expect([r.status, await r.text()]).toEqual([302, 'plain']);
    }
  });

  it('an invalid redirect option is a TypeError', async () => {
    await expect(loopbackFetch(at('/'), { redirect: 'sideways' })).rejects.toThrow(TypeError);
  });
});

// ---- the source guard ----------------------------------------------------------------------------------

const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url));
function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? testFiles(join(dir, e.name)) : /\.test\.ts$/.test(e.name) ? [join(dir, e.name)] : []));
}
const PREFIX = "import { request, get } from 'node:http';\nimport * as http from 'node:http';\nimport { loopbackAgent } from './testing/loopback-fetch';\n";
const violations = (body: string, prefix = PREFIX) => findLoopbackViolations('sample.test.ts', prefix + body);

describe('source guard (syntax-tree based)', () => {
  it('flags every bypass the review listed, and more', () => {
    const bypasses: Record<string, string> = {
      'request( with { on the next line': 'request(\n  { host: "127.0.0.1" },\n  () => {});',
      'request(optionsVariable, cb)': 'const o = { host: "127.0.0.1", agent: loopbackAgent() }; request(o, () => {});',
      'get({...})': 'get({ host: "127.0.0.1" }, () => {});',
      'globalThis.fetch(': 'globalThis.fetch("http://x/");',
      'fetch (url) with a space': 'fetch ("http://x/");',
      'const f = fetch; f(url)': 'const f = fetch; f("http://x/");',
      'agent: false only in a trailing comment': 'request({ host: "127.0.0.1" }, () => {}); // agent: false',
      'agent: falseAgent': 'const falseAgent = 1; request({ host: "127.0.0.1", agent: falseAgent }, () => {});',
      'agent: false itself': 'request({ host: "127.0.0.1", agent: false }, () => {});',
      'the default agent': 'request({ host: "127.0.0.1", agent: http.globalAgent }, () => {});',
      'spread after the agent': 'request({ agent: loopbackAgent(), ...{ agent: undefined }, host: "127.0.0.1" }, () => {});',
      'http.request without the agent': 'http.request({ host: "127.0.0.1" }, () => {});',
      'http.get through computed access': 'http["get"]({ host: "127.0.0.1" }, () => {});',
      'alias of request': 'const r = request; r({ agent: loopbackAgent() }, () => {});',
      'alias of http.request': 'const r = http.request; r({ agent: loopbackAgent() }, () => {});',
      'destructured from the namespace': 'const { request: r } = http; r({ host: "127.0.0.1" }, () => {});',
      "globalThis['fetch']": 'globalThis["fetch"]("http://x/");',
      'global.fetch': 'global.fetch("http://x/");',
      'ClientRequest': 'new http.ClientRequest({ host: "127.0.0.1" });',
      'dynamic import': 'await import("node:http");',
      'require': 'require("node:http");',
      'node:https import': 'import https from "node:https";',
      'undici import': 'import { fetch as f } from "undici";',
    };
    for (const [label, code] of Object.entries(bypasses)) expect(violations(code, code.startsWith('import ') ? '' : PREFIX), label).not.toEqual([]);
  });

  it('flags a request() call when loopbackAgent is not the helper import', () => {
    expect(violations('request({ agent: loopbackAgent() }, () => {});', "import { request } from 'node:http';\nconst loopbackAgent = () => undefined;\n")).not.toEqual([]);
  });

  it('accepts the sanctioned forms, and ignores comments, strings and types', () => {
    const ok = [
      'request({ agent: loopbackAgent(), host: "127.0.0.1", port: 1 }, () => {});',
      'http.request("http://127.0.0.1/", { agent: loopbackAgent() }, () => {});',
      'get({ "agent": loopbackAgent(), host: "127.0.0.1" }, () => {});',
      '// fetch(url) request({ host: 1 })\nconst s = "fetch(url) request({ x })"; type T = typeof fetch; const h = { fetch: 1 }.fetch; http.createServer(() => {});',
    ];
    for (const code of ok) expect(violations(code), code).toEqual([]);
  });

  it('every real-HTTP test file under app/server (*.http.test.ts) follows all the rules', () => {
    const files = testFiles(SERVER_DIR);
    const http = files.filter((f) => /\.http\.test\.ts$/.test(f));
    expect(files.length, 'the scan must find the test files').toBeGreaterThan(15);
    expect(http.map((f) => f.slice(SERVER_DIR.length).replace(/\\/g, '/')).sort()).toEqual(expect.arrayContaining(['e2e.http.test.ts', 'http/node-adapter.http.test.ts', 'http/respond.http.test.ts']));
    expect(http.flatMap((f) => findLoopbackViolations(f.slice(SERVER_DIR.length), readFileSync(f, 'utf8')))).toEqual([]);
  });

  it('no other test file makes node:http requests or imports another HTTP client (a new real-HTTP test must be named *.http.test.ts)', () => {
    const others = testFiles(SERVER_DIR).filter((f) => !/\.http\.test\.ts$/.test(f));
    const found = others.flatMap((f) => findLoopbackViolations(f.slice(SERVER_DIR.length), readFileSync(f, 'utf8'))).filter((v) => /node:http|loopbackAgent|ClientRequest|imports /.test(v));
    expect(found).toEqual([]);
  });
});