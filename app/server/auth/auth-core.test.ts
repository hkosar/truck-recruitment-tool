import { describe, expect, it } from 'vitest';
import { chicagoDateString, chicagoDayUtcBounds } from './chicago';
import {
  APP_CSRF_COOKIE,
  clearCookie,
  parseConfirmCookie,
  parseCookieHeader,
  readOpaqueCookie,
  serializeConfirmCookie,
  serializeCookie,
  SESSION_COOKIE,
} from './cookies';
import { checkOrigin, issueCsrf, verifyCsrf } from './csrf';
import { EDITOR, isActiveStaff, isSyntacticallyValidEmail, MANAGER, maskEmail, normalizeEmail, roleAllowed, STAFF, type UserRole, type UserStatus } from './identity';
import { constantTimeEqual, hmacWithKey, randomSecret } from './keys';
import { decideMint, nextSendStatus, type SendStatus } from './ladder';
import { admitRequest, bucketWindowStart, canonicalizeIp, ipBucketKey, UNKNOWN_IP_SENTINEL } from './rate';

const KEY = Buffer.alloc(32, 7).toString('base64url');
const ORIGIN = 'https://recruiter.example.test';

describe('keys', () => {
  it('produces a stable keyed hash that differs by key', () => {
    const other = Buffer.alloc(32, 8).toString('base64url');
    expect(hmacWithKey(KEY, 'x')).toBe(hmacWithKey(KEY, 'x'));
    expect(hmacWithKey(KEY, 'x')).not.toBe(hmacWithKey(other, 'x'));
  });
  it('random secrets are 256-bit base64url', () => {
    const a = randomSecret();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomSecret()).not.toBe(a);
  });
  it('constant-time compare', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('cookies', () => {
  it('serializes __Host- cookies with the required attributes', () => {
    const c = serializeCookie(SESSION_COOKIE, 'abc_DEF-1', 60);
    expect(c).toBe('__Host-tr_session=abc_DEF-1; Path=/; Max-Age=60; Secure; HttpOnly; SameSite=Lax');
    expect(c).not.toMatch(/Domain=/i);
    expect(clearCookie(APP_CSRF_COOKIE)).toContain('Max-Age=0');
  });
  it('refuses non-opaque values', () => {
    expect(() => serializeCookie(SESSION_COOKIE, 'a;b', 60)).toThrow();
  });
  it('drops duplicated and malformed cookies', () => {
    const map = parseCookieHeader(`${SESSION_COOKIE}=a; ${SESSION_COOKIE}=b; other=1`);
    expect(readOpaqueCookie(map, SESSION_COOKIE)).toBeUndefined();
    expect(readOpaqueCookie(parseCookieHeader(`${SESSION_COOKIE}=a%20b`), SESSION_COOKIE)).toBeUndefined();
    expect(readOpaqueCookie(parseCookieHeader(`${SESSION_COOKIE}=good_1`), SESSION_COOKIE)).toBe('good_1');
  });
  it('confirm cookie round trip and rejection', () => {
    const header = serializeConfirmCookie('tok', 'non');
    expect(header).toContain('Max-Age=300');
    expect(parseConfirmCookie('tok.non')).toEqual({ token: 'tok', nonce: 'non' });
    for (const bad of [undefined, '', 'tok', '.non', 'tok.', 'a.b.c', 'to k.non']) expect(parseConfirmCookie(bad)).toBeUndefined();
  });
});

describe('csrf and origin', () => {
  it('present-but-wrong Origin never falls back to Host', () => {
    expect(checkOrigin(ORIGIN, 'https://evil.test', 'recruiter.example.test', false)).toEqual({ ok: false, reason: 'origin_mismatch' });
    expect(checkOrigin(ORIGIN, 'null', 'recruiter.example.test', false)).toEqual({ ok: false, reason: 'origin_mismatch' });
  });
  it('Host stands in only when Origin is absent and not strict', () => {
    expect(checkOrigin(ORIGIN, undefined, 'recruiter.example.test', false)).toEqual({ ok: true });
    expect(checkOrigin(ORIGIN, undefined, 'recruiter.example.test', true)).toEqual({ ok: false, reason: 'origin_missing' });
    expect(checkOrigin(ORIGIN, undefined, undefined, false)).toEqual({ ok: false, reason: 'origin_and_host_missing' });
  });
  it('double-submit token must match the cookie and purpose', () => {
    const issued = issueCsrf(KEY, 'confirm');
    const base = { appOrigin: ORIGIN, sessionsKey: KEY, purpose: 'confirm' as const, origin: ORIGIN, host: undefined, cookieValue: issued.cookieValue, submittedToken: issued.formToken, strict: true };
    expect(verifyCsrf(base)).toEqual({ ok: true });
    expect(verifyCsrf({ ...base, purpose: 'app' })).toEqual({ ok: false, reason: 'token_mismatch' });
    expect(verifyCsrf({ ...base, submittedToken: undefined })).toEqual({ ok: false, reason: 'token_missing' });
    expect(verifyCsrf({ ...base, cookieValue: undefined })).toEqual({ ok: false, reason: 'cookie_missing' });
    expect(verifyCsrf({ ...base, origin: 'https://evil.test' })).toEqual({ ok: false, reason: 'origin_mismatch' });
  });
});

describe('identity', () => {
  it('email syntax, normalization and masking', () => {
    expect(isSyntacticallyValidEmail('a@b.co')).toBe(true);
    expect(isSyntacticallyValidEmail('a b@c.co')).toBe(false);
    expect(normalizeEmail('  Jo@TwistedNail.com ')).toBe('jo@twistednail.com');
    expect(maskEmail('jo@twistednail.com')).toBe('j•••@twistednail.com');
    expect(maskEmail('@x.com')).toBe('•••@x.com');
  });
  it('role sets: every role against every set (never an ordering comparison)', () => {
    const roles: UserRole[] = ['manager', 'edit', 'view', 'guest'];
    const expected: Record<UserRole, [boolean, boolean, boolean]> = {
      manager: [true, true, true],
      edit: [true, true, false],
      view: [true, false, false],
      guest: [false, false, false],
    };
    for (const role of roles) {
      expect([STAFF, EDITOR, MANAGER].map((set) => roleAllowed(role, 'approved', set))).toEqual(expected[role]);
      for (const status of ['pending', 'disabled'] as UserStatus[]) {
        expect([STAFF, EDITOR, MANAGER].map((set) => roleAllowed(role, status, set))).toEqual([false, false, false]);
      }
    }
    expect(isActiveStaff('view', 'approved')).toBe(true);
    expect(isActiveStaff('guest', 'approved')).toBe(false);
  });
});

describe('Chicago day', () => {
  it('ordinary day is 24 hours, CST offset', () => {
    const { start, end } = chicagoDayUtcBounds(new Date('2026-01-15T18:00:00Z'));
    expect(start.toISOString()).toBe('2026-01-15T06:00:00.000Z');
    expect(end.toISOString()).toBe('2026-01-16T06:00:00.000Z');
  });
  it('spring-forward day (2026-03-08) is 23 hours', () => {
    const { start, end } = chicagoDayUtcBounds(new Date('2026-03-08T12:00:00Z'));
    expect(start.toISOString()).toBe('2026-03-08T06:00:00.000Z');
    expect(end.toISOString()).toBe('2026-03-09T05:00:00.000Z');
  });
  it('fall-back day (2026-11-01) is 25 hours', () => {
    const { start, end } = chicagoDayUtcBounds(new Date('2026-11-01T12:00:00Z'));
    expect(start.toISOString()).toBe('2026-11-01T05:00:00.000Z');
    expect(end.toISOString()).toBe('2026-11-02T06:00:00.000Z');
  });
  it('late-evening UTC still belongs to the Chicago day', () => {
    expect(chicagoDateString(new Date('2026-01-16T05:59:59Z'))).toBe('2026-01-15');
    expect(chicagoDateString(new Date('2026-01-16T06:00:00Z'))).toBe('2026-01-16');
  });
});

describe('rate limits', () => {
  it('canonicalizes IPv4, IPv6 and IPv4-mapped IPv6', () => {
    expect(canonicalizeIp(' 10.0.0.1 ')).toEqual({ ok: true, value: '10.0.0.1' });
    expect(canonicalizeIp('2001:DB8:0:0:0:0:0:1')).toEqual({ ok: true, value: '2001:db8::1' });
    expect(canonicalizeIp('::ffff:192.0.2.5')).toEqual({ ok: true, value: '192.0.2.5' });
    expect(canonicalizeIp('fe80::1%eth0')).toEqual({ ok: false, reason: 'zone_id_unsupported' });
    expect(canonicalizeIp('not-an-ip')).toEqual({ ok: false, reason: 'invalid' });
    expect(canonicalizeIp('')).toEqual({ ok: false, reason: 'empty' });
  });
  it('admission: 20/IP and 10/address per window; invalid address never admitted', () => {
    expect(admitRequest({ emailValid: true, ipCount: 20, emailCount: 10 })).toBe(true);
    expect(admitRequest({ emailValid: true, ipCount: 21, emailCount: 1 })).toBe(false);
    expect(admitRequest({ emailValid: true, ipCount: 1, emailCount: 11 })).toBe(false);
    expect(admitRequest({ emailValid: false, ipCount: 1, emailCount: 1 })).toBe(false);
  });
  it('an unknown IP never bypasses the IP ceiling: all unknown-IP requests share one bucket', () => {
    expect(ipBucketKey(undefined)).toEqual({ key: UNKNOWN_IP_SENTINEL, known: false });
    expect(ipBucketKey('garbage')).toEqual({ key: UNKNOWN_IP_SENTINEL, known: false });
    expect(ipBucketKey('fe80::1%eth0')).toEqual({ key: UNKNOWN_IP_SENTINEL, known: false });
    expect(ipBucketKey(' ::ffff:10.1.2.3 ')).toEqual({ key: '10.1.2.3', known: true });
    // 21 requests for 21 different addresses through the shared unknown-IP bucket: the 21st is refused.
    const decisions = Array.from({ length: 21 }, (_, i) => admitRequest({ emailValid: true, ipCount: i + 1, emailCount: 1 }));
    expect(decisions.filter(Boolean)).toHaveLength(20);
    expect(decisions[20]).toBe(false);
  });
  it('fixed 15-minute windows', () => {
    const t = Date.UTC(2026, 0, 1, 10, 14, 59);
    expect(bucketWindowStart(t)).toBe(Date.UTC(2026, 0, 1, 10, 0, 0));
    expect(bucketWindowStart(t + 1000)).toBe(Date.UTC(2026, 0, 1, 10, 15, 0));
  });
});

describe('mint ladder', () => {
  const now = Date.UTC(2026, 0, 1, 12);
  const base = { nowMs: now, newest: undefined, lastMinute: 0, lastHour: 0, chicagoDay: 0 };
  it('mints on a clean slate', () => {
    expect(decideMint(base)).toEqual({ mint: true, revokeNewestAsSendFailed: false });
  });
  it('enforces 1/minute, 5/hour, 10/Chicago-day', () => {
    expect(decideMint({ ...base, lastMinute: 1 })).toEqual({ mint: false, reason: 'minute_ceiling' });
    expect(decideMint({ ...base, lastHour: 5 })).toEqual({ mint: false, reason: 'hour_or_day_ceiling' });
    expect(decideMint({ ...base, chicagoDay: 10 })).toEqual({ mint: false, reason: 'hour_or_day_ceiling' });
  });
  it('two-minute courtesy for pending/accepted/unknown', () => {
    for (const status of ['pending', 'accepted', 'unknown'] as SendStatus[]) {
      expect(decideMint({ ...base, newest: { status, createdAtMs: now - 90_000 } })).toEqual({ mint: false, reason: 'courtesy' });
      expect(decideMint({ ...base, newest: { status, createdAtMs: now - 121_000 } })).toEqual({ mint: true, revokeNewestAsSendFailed: false });
    }
  });
  it('definite failure bypasses only the minute ceiling and the courtesy', () => {
    const newest = { status: 'definite_failure' as const, createdAtMs: now - 5_000 };
    expect(decideMint({ ...base, newest, lastMinute: 1 })).toEqual({ mint: true, revokeNewestAsSendFailed: true });
    expect(decideMint({ ...base, newest, lastHour: 5 })).toEqual({ mint: false, reason: 'hour_or_day_ceiling' });
    expect(decideMint({ ...base, newest, chicagoDay: 10 })).toEqual({ mint: false, reason: 'hour_or_day_ceiling' });
  });
  it('delivery lattice never leaves definite_failure and never downgrades accepted', () => {
    const all: SendStatus[] = ['pending', 'accepted', 'unknown', 'definite_failure'];
    for (const p of all) expect(nextSendStatus('definite_failure', p)).toBe('definite_failure');
    expect(nextSendStatus('accepted', 'unknown')).toBe('accepted');
    expect(nextSendStatus('accepted', 'pending')).toBe('accepted');
    expect(nextSendStatus('accepted', 'definite_failure')).toBe('definite_failure');
    expect(nextSendStatus('unknown', 'pending')).toBe('unknown');
    expect(nextSendStatus('unknown', 'accepted')).toBe('accepted');
    expect(nextSendStatus('pending', 'unknown')).toBe('unknown');
  });
});
