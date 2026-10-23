import { describe, expect, it } from 'vitest';
import { createApp, DEFAULT_TIMING, type AppConfig } from '../app';
import { Lifecycle } from '../core/lifecycle';
import { FakeMailAdapter } from '../mail/fake';
import { FakeAuthStore, FakeDataStore, fakeRequest } from '../testing/fakes';
import { createHealth, type Health } from './health';

const keys = { links: Buffer.alloc(32, 1).toString('base64url'), sessions: Buffer.alloc(32, 2).toString('base64url'), rate: Buffer.alloc(32, 3).toString('base64url') };

describe('createHealth', () => {
  it('readiness is false until one probe succeeds, then stays true even if the database fails later', async () => {
    let up = false;
    let calls = 0;
    const h = createHealth({ probe: async () => { calls++; if (!up) throw new Error('down'); }, timeoutMs: 200 });
    expect(await h.readiness()).toBe(false);
    expect(await h.readiness()).toBe(false);
    up = true;
    expect(await h.readiness()).toBe(true);
    up = false;
    const before = calls;
    expect(await h.readiness()).toBe(true); // latched: no new probe
    expect(calls).toBe(before);
    expect(await h.liveDb()).toBe(false); // the live check still sees the outage
  });

  it('a probe that never answers is bounded by timeoutMs', async () => {
    const h = createHealth({ probe: () => new Promise<void>(() => undefined), timeoutMs: 100 });
    const t0 = performance.now();
    expect(await h.liveDb()).toBe(false);
    expect(await h.readiness()).toBe(false);
    expect(performance.now() - t0).toBeLessThan(600);
  });

  it('concurrent checks share one probe in flight', async () => {
    let calls = 0;
    let release!: () => void;
    const h = createHealth({ probe: () => { calls++; return new Promise<void>((r) => { release = r; }); }, timeoutMs: 1_000 });
    const all = Promise.all([h.liveDb(), h.liveDb(), h.readiness(), h.liveDb()]);
    await new Promise((r) => setTimeout(r, 10));
    release();
    expect(await all).toEqual([true, true, true, true]);
    expect(calls).toBe(1);
  });
});

describe('/readyz and /healthz/db routes', () => {
  function app(health: Health | undefined, overrides: Partial<AppConfig> = {}) {
    return createApp({
      config: { appOrigin: 'https://recruiter.example.test', keys, stagingBanner: false, maintenance: false, webhookPublicKey: undefined, ...DEFAULT_TIMING, ...overrides },
      auth: new FakeAuthStore(), data: new FakeDataStore(), mail: new FakeMailAdapter(), lifecycle: new Lifecycle(),
      staticFiles: { get: () => undefined, index: () => Buffer.from('<div id="root"></div>') },
      log: () => undefined, now: () => Date.now(), monotonic: () => performance.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), random: Math.random,
      health,
    });
  }
  const fixed = (ready: boolean, live: boolean): Health => ({ readiness: async () => ready, liveDb: async () => live });

  it('200 "ok" / 503 "unavailable", generic bodies, no-store, no cookies', async () => {
    const up = app(fixed(true, true));
    const down = app(fixed(false, false));
    for (const path of ['/readyz', '/healthz/db']) {
      const ok = await up(fakeRequest({ url: path }));
      expect([ok.status, ok.body, ok.headers['cache-control'], ok.setCookies]).toEqual([200, 'ok', 'no-store', []]);
      const bad = await down(fakeRequest({ url: path }));
      expect([bad.status, bad.body, bad.headers['cache-control'], bad.setCookies]).toEqual([503, 'unavailable', 'no-store', []]);
    }
  });

  it('each path asks its own check: /readyz readiness, /healthz/db the live check', async () => {
    const h = app(fixed(true, false));
    expect((await h(fakeRequest({ url: '/readyz' }))).status).toBe(200);
    expect((await h(fakeRequest({ url: '/healthz/db' }))).status).toBe(503);
  });

  it('answers in maintenance (the cutover deploy waits for /readyz) and to HEAD; other methods fall through', async () => {
    const h = app(fixed(true, true), { maintenance: true });
    expect((await h(fakeRequest({ url: '/readyz' }))).status).toBe(200);
    expect((await h(fakeRequest({ url: '/readyz', method: 'HEAD' }))).status).toBe(200);
    expect((await h(fakeRequest({ url: '/signin' }))).status).toBe(503); // everything else is in maintenance
    expect((await h(fakeRequest({ url: '/readyz', method: 'POST' }))).status).toBe(503);
  });

  it('without a health check configured, both answer 503', async () => {
    const h = app(undefined);
    expect((await h(fakeRequest({ url: '/readyz' }))).status).toBe(503);
    expect((await h(fakeRequest({ url: '/healthz/db' }))).status).toBe(503);
  });
});
