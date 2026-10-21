// Per-person sign-in link ceilings and the two-minute courtesy (Quote-Queue request route
// :304-366 decision, own code). Runs post-response, under the person's profile lock, with
// counts taken under that lock.
//
// - Ceilings: at most 1 link per minute, 5 per hour, 10 per America/Chicago day.
// - Courtesy: a request within 2 minutes of the newest link is a no-op while that link is
//   pending/accepted/unknown.
// - Definite failure: if the newest link is definite_failure, revoke it (send_failed) and skip
//   ONLY the 1/minute ceiling and the courtesy; the hour/day ceilings still apply. Failed links
//   keep counting toward hour and day. Ceilings are never reset (also not on email change).

export type SendStatus = 'pending' | 'accepted' | 'unknown' | 'definite_failure';

export const LINKS_PER_MINUTE = 1;
export const LINKS_PER_HOUR = 5;
export const LINKS_PER_CHICAGO_DAY = 10;
export const COURTESY_MS = 2 * 60 * 1000;

export interface MintState {
  nowMs: number;
  newest: { status: SendStatus; createdAtMs: number } | undefined;
  lastMinute: number;
  lastHour: number;
  chicagoDay: number;
}

export type MintDecision =
  | { mint: true; revokeNewestAsSendFailed: boolean }
  | { mint: false; reason: 'hour_or_day_ceiling' | 'minute_ceiling' | 'courtesy' };

export function decideMint(state: MintState): MintDecision {
  const hourOrDay = state.lastHour >= LINKS_PER_HOUR || state.chicagoDay >= LINKS_PER_CHICAGO_DAY;
  if (state.newest?.status === 'definite_failure') {
    if (hourOrDay) return { mint: false, reason: 'hour_or_day_ceiling' };
    return { mint: true, revokeNewestAsSendFailed: true };
  }
  if (hourOrDay) return { mint: false, reason: 'hour_or_day_ceiling' };
  if (state.lastMinute >= LINKS_PER_MINUTE) return { mint: false, reason: 'minute_ceiling' };
  if (state.newest !== undefined && state.nowMs - state.newest.createdAtMs < COURTESY_MS) {
    return { mint: false, reason: 'courtesy' };
  }
  return { mint: true, revokeNewestAsSendFailed: false };
}

/**
 * The delivery lattice (Quote-Queue migrations 0006/0007; also enforced by a DB trigger):
 * definite_failure is terminal; accepted may move only to definite_failure; unknown never
 * returns to pending. Returns the status to store.
 */
export function nextSendStatus(current: SendStatus, proposed: SendStatus): SendStatus {
  if (current === 'definite_failure') return current;
  if (current === 'accepted') return proposed === 'definite_failure' ? proposed : current;
  if (current === 'unknown' && proposed === 'pending') return current;
  return proposed;
}
