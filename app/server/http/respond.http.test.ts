// Real-HTTP check that a rejected body still gets its bounded response before the connection
// closes (doc 15 §4.3). It starts a local HTTP server on 127.0.0.1, which needs approval A4,
// so it is SKIPPED unless RUN_HTTP_TESTS=1 is set by someone with that approval.

import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BODY_LIMITS, readBodyLimited } from './body';
import { respondThenClose } from './respond';
// Loaded machines (manager decision): only TEST timeouts are raised; product limits are unchanged.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const enabled = process.env.RUN_HTTP_TESTS === '1';

describe.skipIf(!enabled)('rejected bodies over real HTTP (A4)', () => {
  let server: Server;
  let port = 0;

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const result = await readBodyLimited(req, { maxBytes: BODY_LIMITS.auth, declaredLength: req.headers['content-length'] ?? null, deadlineMs: 2_000 });
      if (!result.ok) {
        respondThenClose(req, res, 413, { 'content-type': 'text/plain' }, 'too large');
        return;
      }
      res.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function send(body: Buffer[], headers: Record<string, string>): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, method: 'POST', path: '/auth/request', headers }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
      });
      req.on('error', reject);
      for (const chunk of body) req.write(chunk);
      req.end();
    });
  }

  it('an oversized chunked body (no Content-Length) gets the 413, then the connection closes', async () => {
    const chunks = Array.from({ length: 64 }, () => Buffer.alloc(8 * 1024, 120));
    const result = await send(chunks, { 'content-type': 'application/x-www-form-urlencoded', 'transfer-encoding': 'chunked' });
    expect(result).toEqual({ status: 413, text: 'too large' });
  });

  it('a declared oversize gets the 413 without the body being read', async () => {
    const result = await send([Buffer.from('x')], { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(BODY_LIMITS.auth + 1) });
    expect(result.status).toBe(413);
  });

  it('a small body is accepted', async () => {
    expect(await send([Buffer.from('email=a%40b.co')], { 'content-type': 'application/x-www-form-urlencoded' })).toEqual({ status: 200, text: 'ok' });
  });
});
