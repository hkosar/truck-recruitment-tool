// Keyed hashes and random secrets for sign-in (mirrors Quote-Queue lib/keys.ts:24-77).
// One key per purpose: links, sessions (and CSRF), rate buckets (and recovery codes).
// Raw links, session values and codes are never stored; only these keyed hashes are.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export type KeyPurpose = 'links' | 'sessions' | 'rate';

export interface AuthKeys {
  links: string;
  sessions: string;
  rate: string;
}

/** HMAC-SHA256 of `value` under a base64url key, returned as base64url. */
export function hmacWithKey(base64UrlKey: string, value: string): string {
  return createHmac('sha256', Buffer.from(base64UrlKey, 'base64url')).update(value, 'utf8').digest('base64url');
}

export function keyedHash(keys: AuthKeys, purpose: KeyPurpose, value: string): string {
  return hmacWithKey(keys[purpose], value);
}

/** 256-bit CSPRNG value, base64url (43 characters). */
export function randomSecret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Constant-time string comparison; false on any length difference. */
export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
