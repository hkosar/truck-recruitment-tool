// Flood limits and IP canonicalization (Quote-Queue lib/rate.ts:172-221 behaviour, own code).
//
// Pre-response, anonymous only: the IP and address buckets are keyed hashes. Fixed 15-minute
// windows, as in QQ (a short 2x burst at a window edge is accepted for parity).
//
// Unknown client IP (no trusted header, or an unparseable value): requests do NOT bypass the
// IP ceiling. They all share ONE bounded bucket keyed by UNKNOWN_IP_SENTINEL, with the same
// 20-per-15-minutes ceiling, and the server raises an operator alert ('client_ip_unavailable')
// because a missing IP means the proxy chain is not what T-IP verified.

import { isIPv4, isIPv6 } from 'node:net';

export const REQUEST_IP_CEILING = 20;
export const REQUEST_EMAIL_CEILING = 10;
export const BUCKET_WINDOW_MS = 15 * 60 * 1000;

/** Fixed sentinels, hashed like real keys (QQ request route :152-157). */
export const UNKNOWN_IP_SENTINEL = 'sentinel:unknown-ip';
export const INVALID_EMAIL_SENTINEL = 'sentinel:invalid-email';

export type CanonicalIp = { ok: true; value: string } | { ok: false; reason: 'empty' | 'zone_id_unsupported' | 'invalid' };

/**
 * IPv4 → dotted decimal; IPv6 → RFC 5952 compressed lower-case; IPv4-mapped IPv6 folded to
 * its IPv4 form, so one client never gets two buckets.
 */
export function canonicalizeIp(raw: string): CanonicalIp {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: false, reason: 'empty' };
  if (trimmed.includes('%')) return { ok: false, reason: 'zone_id_unsupported' };
  if (isIPv4(trimmed)) return { ok: true, value: trimmed.split('.').map((p) => String(Number(p))).join('.') };
  if (isIPv6(trimmed)) {
    // The WHATWG URL parser serializes IPv6 hosts in RFC 5952 canonical form.
    const host = new URL(`http://[${trimmed}]/`).hostname.slice(1, -1);
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
    if (mapped) {
      const hi = parseInt(mapped[1], 16);
      const lo = parseInt(mapped[2], 16);
      return { ok: true, value: [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.') };
    }
    return { ok: true, value: host };
  }
  return { ok: false, reason: 'invalid' };
}

/** The IP bucket key: the canonical IP, or the one shared unknown-IP bucket. */
export function ipBucketKey(rawIp: string | undefined): { key: string; known: boolean } {
  if (rawIp === undefined) return { key: UNKNOWN_IP_SENTINEL, known: false };
  const canonical = canonicalizeIp(rawIp);
  return canonical.ok ? { key: canonical.value, known: true } : { key: UNKNOWN_IP_SENTINEL, known: false };
}

export function bucketWindowStart(nowMs: number): number {
  return Math.floor(nowMs / BUCKET_WINDOW_MS) * BUCKET_WINDOW_MS;
}

export interface AdmissionInput {
  emailValid: boolean;
  /** Count for this request's IP bucket: the real IP, or the shared unknown-IP bucket. */
  ipCount: number;
  emailCount: number;
}

/** Whether post-response identity work may be scheduled. The IP ceiling always applies. */
export function admitRequest(input: AdmissionInput): boolean {
  if (!input.emailValid) return false;
  if (input.ipCount > REQUEST_IP_CEILING) return false;
  if (input.emailCount > REQUEST_EMAIL_CEILING) return false;
  return true;
}
