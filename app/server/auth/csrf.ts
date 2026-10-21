// CSRF for sign-in forms and SPA mutations (Quote-Queue lib/csrf.ts:34-137, adapted).
//
// Double-submit pair: an HttpOnly cookie holds a random secret; the form field (or the
// X-CSRF-Token header for SPA fetches) holds hmac(KEY_SESSIONS, prefix + secret).
//
// Origin rule (doc 14 §3.4): a PRESENT Origin must equal APP_ORIGIN exactly, including the
// literal "null"; there is never a fallback to Host when Origin is present but wrong. Only
// when Origin is absent may Host stand in, and only in non-strict mode. Strict mode (recovery
// sign-in and every /api mutation) requires Origin.

import { constantTimeEqual, hmacWithKey, randomSecret } from './keys';

export type CsrfPurpose = 'confirm' | 'app' | 'recovery-pre';

export interface IssuedCsrf {
  cookieValue: string;
  formToken: string;
}

function tokenFor(sessionsKey: string, purpose: CsrfPurpose, cookieValue: string): string {
  return hmacWithKey(sessionsKey, `csrf:${purpose}:${cookieValue}`);
}

export function issueCsrf(sessionsKey: string, purpose: CsrfPurpose): IssuedCsrf {
  const cookieValue = randomSecret();
  return { cookieValue, formToken: tokenFor(sessionsKey, purpose, cookieValue) };
}

/** The form/header token for an existing cookie value (used to hand the SPA its token). */
export function csrfTokenForCookie(sessionsKey: string, purpose: CsrfPurpose, cookieValue: string): string {
  return tokenFor(sessionsKey, purpose, cookieValue);
}

export type OriginCheck = { ok: true } | { ok: false; reason: 'origin_mismatch' | 'origin_missing' | 'origin_and_host_missing' };

export function checkOrigin(
  appOrigin: string,
  origin: string | null | undefined,
  host: string | null | undefined,
  strict: boolean,
): OriginCheck {
  if (origin !== null && origin !== undefined && origin !== '') {
    return origin === appOrigin ? { ok: true } : { ok: false, reason: 'origin_mismatch' };
  }
  if (strict) return { ok: false, reason: 'origin_missing' };
  if (host !== null && host !== undefined && host !== '') {
    return host === new URL(appOrigin).host ? { ok: true } : { ok: false, reason: 'origin_mismatch' };
  }
  return { ok: false, reason: 'origin_and_host_missing' };
}

export interface CsrfInput {
  appOrigin: string;
  sessionsKey: string;
  purpose: CsrfPurpose;
  origin: string | null | undefined;
  host: string | null | undefined;
  cookieValue: string | undefined;
  submittedToken: string | undefined;
  strict: boolean;
}

export type CsrfResult =
  | { ok: true }
  | { ok: false; reason: 'origin_mismatch' | 'origin_missing' | 'origin_and_host_missing' | 'cookie_missing' | 'token_missing' | 'token_mismatch' };

export function verifyCsrf(input: CsrfInput): CsrfResult {
  const origin = checkOrigin(input.appOrigin, input.origin, input.host, input.strict);
  if (!origin.ok) return origin;
  if (!input.cookieValue) return { ok: false, reason: 'cookie_missing' };
  if (!input.submittedToken) return { ok: false, reason: 'token_missing' };
  const expected = tokenFor(input.sessionsKey, input.purpose, input.cookieValue);
  return constantTimeEqual(expected, input.submittedToken) ? { ok: true } : { ok: false, reason: 'token_mismatch' };
}
