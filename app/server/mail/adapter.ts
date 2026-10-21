// Mail provider seam (Quote-Queue lib/sendgrid.ts:180-561 pattern, own code).
//
// Sign-in sends are ONE-SHOT. SendGrid's send API has no idempotency guarantee; the optional
// diagnostic header is not one. An uncertain outcome is recorded as `unknown` and is never
// replayed automatically: only the person's own new request mints a new link.

import type { SendStatus } from '../auth/ladder';

export type OutcomeClass =
  | 'accepted'
  | 'rate_limited' // 429: the provider definitively did not accept the message
  | 'configuration_permanent' // 400/401/403: our key, sender or request is wrong
  | 'recipient_permanent'
  | 'pre_transmission' // connection failed before any byte was sent
  | 'unknown_outcome'; // 5xx, timeout, network error after transmission, 2xx without id

export interface SendOutcome {
  outcomeClass: OutcomeClass;
  httpStatus?: number;
  providerMessageId?: string;
  /** Stable, value-free code for the link row. Never provider text (QQ gap D3). */
  errorCode?: string;
}

export interface SignInMail {
  to: string;
  linkUrl: string;
  /** Correlation, echoed back by the webhook: source "auth", local id = link id. */
  localId: string;
}

export interface MailAdapter {
  sendSignInLink(mail: SignInMail): Promise<SendOutcome>;
}

/**
 * Link status for an outcome. Nothing was sent for rate_limited, configuration_permanent and
 * pre_transmission, so they are definite failures: the person may retry at once (minute
 * ceiling and courtesy bypassed; hour/day ceilings still apply). Uncertain → unknown.
 */
export function sendStatusFor(outcome: SendOutcome): SendStatus {
  switch (outcome.outcomeClass) {
    case 'accepted':
      return 'accepted';
    case 'rate_limited':
    case 'configuration_permanent':
    case 'recipient_permanent':
    case 'pre_transmission':
      return 'definite_failure';
    case 'unknown_outcome':
      return 'unknown';
  }
}
