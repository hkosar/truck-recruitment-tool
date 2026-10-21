// __Host- cookies for sign-in (mirrors Quote-Queue lib/cookies.ts:52-158 with this app's names).
// Every cookie: Secure; HttpOnly; SameSite=Lax (Strict for the recovery pre-session token);
// Path=/; no Domain. Values are opaque base64url strings, so no escaping is needed, and any
// value outside that alphabet is rejected on parse.

export const SESSION_COOKIE = '__Host-tr_session';
export const APP_CSRF_COOKIE = '__Host-tr_app_csrf';
export const CONFIRM_COOKIE = '__Host-tr_confirm';
export const CONFIRM_CSRF_COOKIE = '__Host-tr_csrf';
export const RECOVERY_PRE_COOKIE = '__Host-tr_pre';

/** Confirm landing binding lifetime (QQ: 5 minutes). */
export const CONFIRM_COOKIE_MAX_AGE_SECONDS = 5 * 60;
/** Recovery pre-session form token lifetime (doc 14 §7.2: 30 minutes). */
export const RECOVERY_PRE_MAX_AGE_SECONDS = 30 * 60;
/** Session cookie lifetime = the 90-day absolute cap; the database decides real validity. */
export const SESSION_COOKIE_MAX_AGE_SECONDS = 90 * 24 * 60 * 60;

const OPAQUE = /^[A-Za-z0-9_-]+$/;

export type SameSite = 'Lax' | 'Strict';

export function serializeCookie(name: string, value: string, maxAgeSeconds: number, sameSite: SameSite = 'Lax'): string {
  if (value !== '' && !OPAQUE.test(value) && !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`refusing to serialize a non-opaque value into ${name}`);
  }
  return `${name}=${value}; Path=/; Max-Age=${maxAgeSeconds}; Secure; HttpOnly; SameSite=${sameSite}`;
}

export function clearCookie(name: string, sameSite: SameSite = 'Lax'): string {
  return serializeCookie(name, '', 0, sameSite);
}

/**
 * Parses a Cookie header into a map. A name that appears more than once is dropped entirely
 * (ambiguous input fails closed rather than picking one).
 */
export function parseCookieHeader(header: string | null | undefined): Map<string, string> {
  const seen = new Map<string, string>();
  const duplicated = new Set<string>();
  if (!header) return seen;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (seen.has(name)) duplicated.add(name);
    seen.set(name, value);
  }
  for (const name of duplicated) seen.delete(name);
  return seen;
}

/** Returns an opaque cookie value, or undefined if absent or malformed. */
export function readOpaqueCookie(cookies: Map<string, string>, name: string): string | undefined {
  const value = cookies.get(name);
  if (value === undefined || value === '' || !OPAQUE.test(value)) return undefined;
  return value;
}

export function serializeConfirmCookie(token: string, nonce: string): string {
  if (!OPAQUE.test(token) || !OPAQUE.test(nonce)) throw new Error('confirm cookie parts must be opaque');
  return serializeCookie(CONFIRM_COOKIE, `${token}.${nonce}`, CONFIRM_COOKIE_MAX_AGE_SECONDS);
}

export function parseConfirmCookie(raw: string | undefined): { token: string; nonce: string } | undefined {
  if (raw === undefined) return undefined;
  const dot = raw.indexOf('.');
  if (dot <= 0 || dot === raw.length - 1 || raw.indexOf('.', dot + 1) !== -1) return undefined;
  const token = raw.slice(0, dot);
  const nonce = raw.slice(dot + 1);
  if (!OPAQUE.test(token) || !OPAQUE.test(nonce)) return undefined;
  return { token, nonce };
}
