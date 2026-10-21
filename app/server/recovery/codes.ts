// Recovery codes (doc 14 §7; NOT in Quote-Queue). Off by default: nothing here is reachable
// until RECOVERY_ENABLED is set, which needs the cross-app policy decision (D2).
//
// 16 symbols from Crockford base32 (no I, L, O, U) = 80 bits, shown as XXXX-XXXX-XXXX-XXXX.
// Stored only as hmac(KEY_RATE, normalized code).

import { randomInt } from 'node:crypto';

export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_LENGTH = 16;
export const CODES_PER_SET = 10;

export function generateCode(): string {
  let raw = '';
  for (let i = 0; i < CODE_LENGTH; i++) raw += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return raw.match(/.{4}/g)!.join('-');
}

export function generateCodeSet(count = CODES_PER_SET): string[] {
  const set = new Set<string>();
  while (set.size < count) set.add(generateCode());
  return [...set];
}

/**
 * Normalizes what a person typed: case-insensitive, spaces and hyphens ignored, and the
 * Crockford look-alikes O→0, I/L→1. Returns undefined if the result is not exactly 16 valid
 * symbols.
 */
export function normalizeCode(input: string): string | undefined {
  const cleaned = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (cleaned.length !== CODE_LENGTH) return undefined;
  for (const ch of cleaned) if (!CODE_ALPHABET.includes(ch)) return undefined;
  return cleaned;
}
