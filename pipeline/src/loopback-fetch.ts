// A fetch for the loopback-only HTTP tests. This file exists twice, byte-identical, in
// app/server/testing/ and pipeline/src/ (the packages are separate); scripts/verify-loopback-fetch-contract.mjs
// keeps the copies identical.
// Node env-proxy support (NODE_USE_ENV_PROXY=1 or NODE_OPTIONS=--use-env-proxy with HTTP_PROXY/HTTPS_PROXY)
// reroutes the global fetch and the default http agent through the proxy, so a fake-server test could send
// its request (and a fake key) to whatever the proxy is. Everything here goes through ONE private keep-alive
// agent that never reads those settings, and refuses any address that is not loopback http. Keep-alive is
// deliberate: agent: false would make the client send "Connection: close", which hides whether the SERVER
// closes a connection. Tests that call node:http request() themselves pass agent: loopbackAgent().
// Call closeLoopbackAgent() when the tests are done so idle sockets do not hold the process open.

import { Agent, request } from 'node:http';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const STANDARD_METHODS = new Set(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'POST', 'PUT']);
const MAX_REDIRECTS = 20;

export type LoopbackInit = { method?: string; headers?: Record<string, string>; body?: string; redirect?: string; signal?: AbortSignal };

let sharedAgent: Agent | undefined;

/** The private proxy-free keep-alive agent (created on first use). */
export function loopbackAgent(): Agent {
  sharedAgent ??= new Agent({ keepAlive: true });
  return sharedAgent;
}

/** Destroys the agent and its sockets; a later call to loopbackAgent() makes a fresh one. */
export function closeLoopbackAgent(): void {
  sharedAgent?.destroy();
  sharedAgent = undefined;
}

function checkLoopback(target: URL): URL {
  if (target.protocol !== 'http:' || !LOOPBACK_HOSTS.has(target.hostname)) {
    throw new Error(`loopback-fetch refuses non-loopback address: ${target.protocol}//${target.hostname}`);
  }
  return target;
}

function exchange(target: URL, method: string, headers: Record<string, string>, body: string | undefined, signal?: AbortSignal): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const req = request(target, { method, headers, agent: loopbackAgent(), signal }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) for (const v of value) responseHeaders.append(name, v);
          else if (value !== undefined) responseHeaders.set(name, value);
        }
        const status = res.statusCode ?? 0;
        const noBody = status === 204 || status === 205 || status === 304 || method === 'HEAD';
        resolve(new Response(noBody ? null : Buffer.concat(chunks), { status, statusText: res.statusMessage, headers: responseHeaders }));
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

function without(headers: Record<string, string>, names: string[]): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !names.includes(name.toLowerCase())));
}

/**
 * fetch() for loopback http only, with fetch's redirect option: 'follow' (default) follows up to 20
 * redirects and checks every hop is loopback http; 'manual' returns the 3xx; 'error' rejects on a redirect.
 */
export async function loopbackFetch(url: string, init: LoopbackInit = {}): Promise<Response> {
  const redirect = init.redirect ?? 'follow';
  if (redirect !== 'follow' && redirect !== 'error' && redirect !== 'manual') {
    throw new TypeError(`loopback-fetch: invalid redirect option: ${redirect}`);
  }
  let target = checkLoopback(new URL(url));
  const upper = (init.method ?? 'GET').toUpperCase();
  let method = STANDARD_METHODS.has(upper) ? upper : (init.method ?? 'GET');
  let headers: Record<string, string> = { ...init.headers };
  let body = init.body;
  for (let hops = 0; ; hops++) {
    const response = await exchange(target, method, headers, body, init.signal);
    const location = response.headers.get('location');
    if (!REDIRECT_STATUSES.has(response.status) || location === null || redirect === 'manual') return response;
    if (redirect === 'error') throw new TypeError(`fetch failed: unexpected redirect (${response.status})`);
    if (hops >= MAX_REDIRECTS) throw new TypeError('fetch failed: too many redirects');
    const next = checkLoopback(new URL(location, target));
    if ((response.status === 303 && method !== 'HEAD') || ((response.status === 301 || response.status === 302) && method === 'POST')) {
      method = 'GET';
      body = undefined;
      headers = without(headers, ['content-length', 'content-type', 'content-encoding', 'content-language', 'content-location']);
    }
    if (next.origin !== target.origin) headers = without(headers, ['authorization', 'cookie', 'proxy-authorization']);
    target = next;
  }
}
