// Node `http` binding for the framework-free handler. Tracks every accepted request in the
// lifecycle; refuses new ones (503, Connection: close) once shutdown has begun.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AppRequest, AppResponse, Logger } from '../core/types';
import type { Lifecycle } from '../core/lifecycle';
import { parseCookieHeader } from '../auth/cookies';
import { readBodyLimited } from './body';
import { getClientIp } from './ip';
import { respondThenClose } from './respond';

export function toAppRequest(req: IncomingMessage, trustedHops: number): AppRequest {
  const url = new URL(req.url ?? '/', 'http://internal.invalid');
  const headers = { get: (name: string) => {
    const v = req.headers[name.toLowerCase()];
    return v === undefined ? null : Array.isArray(v) ? v.join(', ') : v;
  } };
  return {
    method: req.method ?? 'GET',
    path: url.pathname,
    query: url.searchParams,
    headers,
    cookies: parseCookieHeader(headers.get('cookie')),
    clientIp: trustedHops === 0 ? req.socket.remoteAddress ?? undefined : getClientIp(headers, { trustedHops }),
    receivedAt: performance.now(),
    readBody: (maxBytes) => readBodyLimited(req, { maxBytes, declaredLength: headers.get('content-length') }),
  };
}

export function writeAppResponse(req: IncomingMessage, res: ServerResponse, r: AppResponse): void {
  const headers: Record<string, string | string[]> = { ...r.headers };
  if (r.setCookies.length) headers['set-cookie'] = r.setCookies;
  const body = typeof r.body === 'string' ? r.body : r.body;
  if (r.closeAfter) {
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    respondThenClose(req, res, r.status, {}, typeof body === 'string' ? body : body.toString('utf8'));
    return;
  }
  res.writeHead(r.status, { ...headers, 'content-length': String(Buffer.byteLength(body)) });
  res.end(req.method === 'HEAD' ? undefined : body);
}

export function createNodeServer(handle: (r: AppRequest) => Promise<AppResponse>, lifecycle: Lifecycle, trustedHops: number, log: Logger): Server {
  const server = createServer((req, res) => {
    const tracked = lifecycle.trackRequest(async () => {
      try {
        writeAppResponse(req, res, await handle(toAppRequest(req, trustedHops)));
      } catch {
        log('unhandled_request_error');
        if (!res.headersSent) respondThenClose(req, res, 500, { 'content-type': 'text/plain' }, 'Internal error');
      }
    });
    if (!tracked) respondThenClose(req, res, 503, { 'content-type': 'text/plain', 'retry-after': '5' }, 'Restarting');
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  return server;
}
