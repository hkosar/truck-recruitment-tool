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

/**
 * Settles when the response has really left the process: Node's 'finish' (the whole response
 * handed to the socket) AND the socket's own write buffer drained, or the connection closed.
 * 'finish' alone fires while a large body still sits in the socket buffer (measured: 64 MiB to
 * a paused client, finish with 0 bytes received).
 */
export function responseDone(res: ServerResponse): Promise<void> {
  const socket = res.socket; // captured now: Node detaches it from the response on finish
  return new Promise((resolve) => {
    let settled = false;
    const settle = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    const flushed = () => {
      if (!socket || socket.destroyed || socket.writableLength === 0) return settle();
      socket.once('drain', flushed);
      socket.once('close', settle);
    };
    res.once('finish', flushed);
    res.once('close', settle);
  });
}

/** Writes the response; the promise settles only when it has finished or the connection closed. */
export function writeAppResponse(req: IncomingMessage, res: ServerResponse, r: AppResponse): Promise<void> {
  const headers: Record<string, string | string[]> = { ...r.headers };
  if (r.setCookies.length) headers['set-cookie'] = r.setCookies;
  const body = r.body;
  if (r.closeAfter) {
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    return respondThenClose(req, res, r.status, {}, typeof body === 'string' ? body : body.toString('utf8'));
  }
  const done = responseDone(res);
  res.writeHead(r.status, { ...headers, 'content-length': String(Buffer.byteLength(body)) });
  res.end(req.method === 'HEAD' ? undefined : body);
  return done;
}

/**
 * Each request stays tracked by the lifecycle until its response has FINISHED (or the
 * connection closed), not merely until end() was called, so shutdown never exits while a
 * response is still draining to a slow client. Post-response work (`afterResponse`) is started
 * only then, and is registered as a continuation before the request stops being tracked, so
 * the shutdown drain always sees it (Gate 2 review finding 7).
 */
export function createNodeServer(handle: (r: AppRequest) => Promise<AppResponse>, lifecycle: Lifecycle, trustedHops: number, log: Logger): Server {
  const server = createServer((req, res) => {
    const tracked = lifecycle.trackRequest(async () => {
      let r: AppResponse | undefined;
      try {
        r = await handle(toAppRequest(req, trustedHops));
        await writeAppResponse(req, res, r);
      } catch {
        log('unhandled_request_error');
        if (!res.headersSent) {
          req.resume();
          await respondThenClose(req, res, 500, { 'content-type': 'text/plain' }, 'Internal error');
        }
      }
      if (r?.afterResponse) lifecycle.trackContinuation(r.afterResponse);
    });
    if (!tracked) {
      req.resume(); // discard any upload so the refusal is not lost to a reset
      void respondThenClose(req, res, 503, { 'content-type': 'text/plain', 'retry-after': '5' }, 'Restarting');
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  return server;
}
