// Proves the loopback-only HTTP tests cannot be redirected by Node env-proxy settings. A fake proxy
// (raw TCP, because Node tunnels with CONNECT) and a fake target listen on loopback; a child node
// process (env proxy is read at startup) requests the target. Also a source guard: every
// http.request in the loopback test files must use a private agent.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createTcpServer, type AddressInfo, type Server } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loopbackFetch } from './loopback-fetch';

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

  for (const [label, extra] of [['NODE_USE_ENV_PROXY=1', { NODE_USE_ENV_PROXY: '1' }], ['NODE_OPTIONS=--use-env-proxy', { NODE_OPTIONS: '--use-env-proxy' }]] as const) {
    it(`${label}: plain fetch reaches the proxy (control), loopbackFetch sends 0 requests to it`, async () => {
      const env = { HTTP_PROXY: `http://127.0.0.1:${proxyPort}`, HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`, ...extra };
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

  it('refuses addresses that are not loopback http', async () => {
    for (const bad of ['http://example.com/', 'https://127.0.0.1/', 'http://10.0.0.5/']) {
      await expect(loopbackFetch(bad)).rejects.toThrow(/refuses non-loopback/);
    }
  });

  it('source guard: every node:http request() in the loopback test files uses agent: false, and none calls the global fetch', () => {
    for (const file of ['../e2e.http.test.ts', '../http/node-adapter.http.test.ts', '../http/respond.http.test.ts']) {
      const src = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
      const calls = src.match(/\brequest\(\{[^\n]*/g) ?? [];
      for (const call of calls) expect(call, `${file}: ${call.slice(0, 60)}`).toContain('agent: false');
      expect(/(^|[^.\w])fetch\(/m.test(src), `${file} must not call the global fetch`).toBe(false);
    }
  });
});
