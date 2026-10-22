import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { isDeliberateNavigation, PingThrottle, renewalReason, renewedExpiry, SESSION_WINDOWS, WRITE_RPCS } from './activity';
import { BODY_LIMITS, DRAIN_CAP_BYTES, readBodyLimited, type BodySource } from './body';
import { readFormFields } from './form';
import { getClientIp } from './ip';

const headers = (h: Record<string, string>) => ({ get: (name: string) => h[name.toLowerCase()] ?? null });

describe('readBodyLimited (T-BODY, unit level)', () => {
  it('reads a body within the limit', async () => {
    const result = await readBodyLimited(Readable.from([Buffer.from('email=a%40b.co')]), { maxBytes: BODY_LIMITS.auth });
    expect(result).toEqual({ ok: true, body: Buffer.from('email=a%40b.co') });
  });

  it('rejects an oversized chunked body (no Content-Length) while streaming', async () => {
    let produced = 0;
    let returned = false;
    async function* endless() {
      try {
        for (;;) {
          produced += 1;
          yield Buffer.alloc(8 * 1024, 120);
        }
      } finally {
        returned = true;
      }
    }
    const source: BodySource = endless();
    const result = await readBodyLimited(source, { maxBytes: BODY_LIMITS.auth });
    // Rejected at the first chunk that crosses 32 KiB (the 5th of 8 KiB), with nothing buffered.
    expect(result).toEqual({ ok: false, reason: 'too_large' });
    expect(produced).toBeGreaterThanOrEqual(5);
    // The rest is drained and DISCARDED (so a real client is not reset mid-upload), bounded by
    // the drain cap; the reader never closes the source (that would destroy the socket).
    await new Promise((r) => setTimeout(r, 300));
    expect(returned).toBe(false);
    expect(produced).toBeLessThanOrEqual(5 + DRAIN_CAP_BYTES / (8 * 1024) + 1);
  });

  it('rejects a declared oversize before buffering anything; a huge declared size is not even drained', async () => {
    let read = false;
    async function* body() {
      read = true;
      yield Buffer.from('x');
    }
    const result = await readBodyLimited(body(), { maxBytes: 10, declaredLength: String(10 + DRAIN_CAP_BYTES + 1) });
    expect(result).toEqual({ ok: false, reason: 'declared_too_large' });
    await new Promise((r) => setTimeout(r, 50));
    expect(read).toBe(false);
    expect(await readBodyLimited(body(), { maxBytes: 10, declaredLength: '1e3' })).toEqual({ ok: false, reason: 'declared_invalid' });
  });

  it('treats an interrupted upload as aborted, with no partial body', async () => {
    async function* broken() {
      yield Buffer.from('email=');
      throw new Error('socket hang up');
    }
    expect(await readBodyLimited(broken(), { maxBytes: 100 })).toEqual({ ok: false, reason: 'aborted' });
  });

  it('times out a slow-drip upload', async () => {
    async function* slow() {
      yield Buffer.from('a');
      await new Promise((resolve) => setTimeout(resolve, 200));
      yield Buffer.from('b');
    }
    expect(await readBodyLimited(slow(), { maxBytes: 100, deadlineMs: 50 })).toEqual({ ok: false, reason: 'timeout' });
  });
});

describe('readFormFields', () => {
  const form = 'application/x-www-form-urlencoded; charset=utf-8';
  it('returns single-valued fields only', () => {
    expect(readFormFields(form, Buffer.from('email=a%40b.co&nonce=x'), ['email', 'nonce'])).toEqual({ email: 'a@b.co', nonce: 'x' });
    expect(readFormFields(form, Buffer.from('email=a&email=b'), ['email'])).toEqual({ email: undefined });
  });
  it('collapses wrong content types and invalid UTF-8 to "no field"', () => {
    expect(readFormFields('application/json', Buffer.from('{"email":"a"}'), ['email'])).toEqual({ email: undefined });
    expect(readFormFields(form, Buffer.from([0x65, 0x3d, 0xff]), ['e'])).toEqual({ e: undefined });
    expect(readFormFields(form, undefined, ['email'])).toEqual({ email: undefined });
  });
});

describe('getClientIp (placeholder until hosted T-IP)', () => {
  it('takes the hop appended by the trusted proxy, not a client-forged first entry', () => {
    expect(getClientIp(headers({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }))).toBe('203.0.113.9');
    expect(getClientIp(headers({ 'x-forwarded-for': '6.6.6.6, 198.51.100.1, 203.0.113.9' }), { trustedHops: 2 })).toBe('198.51.100.1');
    expect(getClientIp(headers({ 'x-forwarded-for': '203.0.113.9' }), { trustedHops: 2 })).toBeUndefined();
    expect(getClientIp(headers({ 'x-real-ip': ' 192.0.2.1 ' }))).toBe('192.0.2.1');
    expect(getClientIp(headers({}))).toBeUndefined();
  });
});

describe('renewal allowlist (never "any POST")', () => {
  const none = headers({});
  it('read-only RPC POSTs and the DNC lookup never renew', () => {
    for (const rpc of ['search_carriers', 'count_carriers', 'facet_other_values', 'facet_suggested_keywords', 'facet_cargo_flags',
      'batch_members', 'batch_members_map', 'search_carriers_map', 'generate_contact_sheet', 'batch_status_counts', 'dashboard_totals', 'is_contactable']) {
      expect(renewalReason('POST', `/api/rpc/${rpc}`, none)).toBe('none');
    }
    expect(renewalReason('POST', '/api/dnc/lookup', none)).toBe('none');
    expect(renewalReason('POST', '/api/rpc/unknown_thing', none)).toBe('none');
  });
  it('background GET reads never renew, for link or recovery sessions alike', () => {
    for (const path of ['/api/session', '/api/dashboard', '/api/carriers/1/profile', '/api/recovery/batches']) {
      expect(renewalReason('GET', path, headers({ 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }))).toBe('none');
    }
  });
  it('allow-listed writes, the ping and real navigations renew', () => {
    for (const rpc of WRITE_RPCS) expect(renewalReason('POST', `/api/rpc/${rpc}`, none)).toBe('write');
    expect(renewalReason('POST', '/api/batch-carriers/status', none)).toBe('write');
    expect(renewalReason('POST', '/api/contact-logs', none)).toBe('write');
    expect(renewalReason('POST', '/api/batches/44444444-4444-4444-8444-444444444444/export-csv', none)).toBe('write');
    expect(renewalReason('GET', '/api/batches/44444444-4444-4444-8444-444444444444/list-extras', none)).toBe('none');
    expect(renewalReason('POST', '/api/recovery/batch-carriers/status', none)).toBe('write');
    expect(renewalReason('POST', '/api/session/activity', none)).toBe('ping');
    expect(renewalReason('GET', '/batches/1', headers({ 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }))).toBe('navigation');
  });
  it('a prefetch never renews, even of a write path', () => {
    expect(renewalReason('POST', '/api/session/activity', headers({ 'sec-purpose': 'prefetch' }))).toBe('none');
  });
});

describe('deliberate use', () => {
  it('only a non-prefetch document navigation counts', () => {
    const nav = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
    expect(isDeliberateNavigation('GET', headers(nav))).toBe(true);
    expect(isDeliberateNavigation('GET', headers({ ...nav, 'sec-purpose': 'prefetch' }))).toBe(false);
    expect(isDeliberateNavigation('GET', headers({ ...nav, purpose: 'prefetch' }))).toBe(false);
    expect(isDeliberateNavigation('GET', headers({ 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }))).toBe(false);
    expect(isDeliberateNavigation('POST', headers(nav))).toBe(false);
  });

  it('ping throttle: 100 pings in 60 s count once per session', () => {
    const throttle = new PingThrottle();
    const t0 = 1_000_000;
    let counted = 0;
    for (let i = 0; i < 100; i++) if (throttle.allow('s1', t0 + i * 500)) counted += 1;
    expect(counted).toBe(1);
    expect(throttle.allow('s2', t0)).toBe(true);
    expect(throttle.allow('s1', t0 + 60_000)).toBe(true);
  });

  it('renewal uses the kind window and never passes the absolute cap', () => {
    const now = Date.UTC(2026, 0, 1);
    expect(renewedExpiry('recovery', now, now + 12 * 3600_000)).toBe(now + 3600_000);
    expect(renewedExpiry('recovery', now, now + 1000)).toBe(now + 1000);
    expect(renewedExpiry('link', now, now + 90 * 24 * 3600_000)).toBe(now + SESSION_WINDOWS.link.idleMs);
  });
});
