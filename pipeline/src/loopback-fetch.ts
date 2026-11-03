// A fetch for tools that promise "loopback only" (local fake servers in tests). Node's env-proxy
// support (NODE_USE_ENV_PROXY=1 or NODE_OPTIONS=--use-env-proxy with HTTP_PROXY/HTTPS_PROXY) reroutes
// the global fetch and the default http agent through the proxy, so a fake-server test could send its
// request (and a fake key) to whatever the proxy is. This helper uses a private agent (agent: false)
// that never reads those settings, and refuses any address that is not loopback.

import { request } from 'node:http';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);

export type LoopbackInit = { method?: string; headers?: Record<string, string>; body?: string; redirect?: string; signal?: AbortSignal };

export function loopbackFetch(url: string, init: LoopbackInit = {}): Promise<Response> {
  const target = new URL(url);
  if (target.protocol !== 'http:' || !LOOPBACK_HOSTS.has(target.hostname)) {
    return Promise.reject(new Error(`loopback-fetch refuses non-loopback address: ${target.protocol}//${target.hostname}`));
  }
  return new Promise<Response>((resolve, reject) => {
    const req = request(target, { method: init.method ?? 'GET', headers: init.headers, agent: false, signal: init.signal }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) for (const v of value) headers.append(name, v);
          else if (value !== undefined) headers.set(name, value);
        }
        const status = res.statusCode ?? 0;
        const noBody = status === 204 || status === 205 || status === 304 || init.method === 'HEAD';
        resolve(new Response(noBody ? null : Buffer.concat(chunks), { status, statusText: res.statusMessage, headers }));
      });
    });
    req.on('error', reject);
    req.end(init.body);
  });
}
