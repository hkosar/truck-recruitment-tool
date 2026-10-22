// Real-HTTP tests of the Node binding (approval A4: a local server on 127.0.0.1, no database).
// Skipped unless RUN_HTTP_TESTS=1. Gate 2 review finding 7 (shutdown tracks response completion;
// post-response work starts after completion) and N2 (staggered uploads get their response).

import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Lifecycle } from '../core/lifecycle';
import type { AppRequest, AppResponse } from '../core/types';
import { createNodeServer } from './node-adapter';

const enabled = process.env.RUN_HTTP_TESTS === '1';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!enabled)('Node binding over real HTTP (A4)', () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server?.listening) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  });

  async function start(handle: (r: AppRequest) => Promise<AppResponse>, lifecycle = new Lifecycle()) {
    server = createNodeServer(handle, lifecycle, 0, () => {});
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    return { lifecycle, port: (server.address() as AddressInfo).port };
  }
  const big = (bytes: number): AppResponse => ({ status: 200, headers: { 'content-type': 'application/octet-stream' }, setCookies: [], body: Buffer.alloc(bytes, 97).toString('latin1') });

  it('post-response work starts only after the response finished; shutdown waits for the request and that work', async () => {
    const order: string[] = [];
    let releaseWork: () => void = () => {};
    const lifecycle = new Lifecycle();
    const { port } = await start(async () => ({
      ...big(4 * 1024 * 1024),
      afterResponse: async () => {
        order.push('after-response work started');
        await new Promise<void>((r) => { releaseWork = r; });
        order.push('after-response work done');
      },
    }), lifecycle);
    server!.on('request', (_req, res) => res.on('finish', () => order.push('response finished')));
    const received = await new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/big' }, (res) => {
        let n = 0;
        res.on('data', (c: Buffer) => { n += c.length; });
        res.on('end', () => resolve(n));
      });
      req.on('error', reject);
      req.end();
    });
    expect(received).toBe(4 * 1024 * 1024);
    let shutdownDone = false;
    server!.close();
    const shutdown = lifecycle.shutdown(15_000, async () => {}).then((n) => { shutdownDone = true; return n; });
    await sleep(200);
    expect(shutdownDone).toBe(false); // the continuation is still running
    releaseWork();
    expect(await shutdown).toBe(0);
    expect(order).toEqual(['response finished', 'after-response work started', 'after-response work done']);
  });

  it('a staggered oversized upload still gets the bounded response (no reset), ten times in a row', async () => {
    const { port } = await start(async (r) => {
      const body = await r.readBody(32 * 1024);
      return { status: 303, headers: { location: '/signin?sent=1' }, setCookies: [], body: '', closeAfter: !body.ok };
    });
    for (let round = 0; round < 10; round++) {
      // The client keeps uploading WITHOUT reading the response (its socket is paused for
      // reading), then reads it. If the server resets the connection while upload bytes are
      // still arriving, the unread response is discarded and the client sees ECONNRESET/EPIPE
      // instead: the failure the reviewer described (N2).
      const result = await new Promise<{ status: number; location?: string; connection?: string } | { error: string }>((resolve) => {
        const req = request({ host: '127.0.0.1', port, method: 'POST', path: '/auth/request', headers: { 'content-type': 'application/x-www-form-urlencoded', 'transfer-encoding': 'chunked' } }, (res) => {
          res.resume();
          res.on('end', () => resolve({ status: res.statusCode ?? 0, location: res.headers.location, connection: res.headers.connection }));
        });
        req.on('error', (e: NodeJS.ErrnoException) => resolve({ error: e.code ?? e.message }));
        req.on('socket', (socket) => {
          socket.pause();
          void (async () => {
            for (let i = 0; i < 48 && !req.destroyed; i++) {
              req.write(Buffer.alloc(8 * 1024, 120));
              await sleep(i % 4 === 0 ? 15 : 0); // uneven: bursts, then pauses
            }
            if (!req.destroyed) req.end();
            await sleep(30);
            socket.resume();
          })();
        });
      });
      expect({ round, result }).toEqual({ round, result: { status: 303, location: '/signin?sent=1', connection: 'close' } });
    }
  }, 30_000);

  it('during shutdown a new request on a kept-alive connection gets 503 + Retry-After, not a reset', async () => {
    const lifecycle = new Lifecycle();
    const { port } = await start(async () => ({ status: 200, headers: {}, setCookies: [], body: 'ok' }), lifecycle);
    await lifecycle.shutdown(1_000, async () => {});
    const result = await new Promise<{ status: number; retry?: string }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, method: 'POST', path: '/x', headers: { 'content-length': '5' } }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0, retry: res.headers['retry-after'] as string | undefined }));
      });
      req.on('error', reject);
      req.end('hello');
    });
    expect(result).toEqual({ status: 503, retry: '5' });
  });
});
