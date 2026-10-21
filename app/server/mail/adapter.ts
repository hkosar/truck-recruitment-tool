// Mail provider seam (Quote-Queue lib/sendgrid.ts:180-561 pattern, own code).
//
// Sign-in sends are ONE-SHOT. SendGrid's send API has no idempotency guarantee; the optional
// diagnostic header is not one. An uncertain outcome is recorded as `unknown` and is never
// replayed automatically: only the person's own new request mints a new link.

import type { SendStatus } from '../auth/ladder';

export type OutcomeClass =
  | 'accepted'
  | 'rate_limited' // 429: provider-side throttling
  | 'configuration_permanent' // 400/401/403: our key, sender or request is wrong
  | 'recipient_permanent' // the provider definitively refused THIS recipient
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
 * Link status for an outcome, as Quote-Queue records it (request route :437-444): only a
 * recipient-specific refusal is a definite failure (which unlocks the immediate retry).
 * Provider throttling (429), our own configuration faults (400/401/403) and pre-send
 * connection failures are provider-side problems, distinct from a recipient failure
 * (directive: "provider blocked/delayed is distinct from definite failure"). They are recorded
 * as `unknown`, unlock nothing, never block the recipient, and raise an operator alert
 * (operatorAlertFor). Manager decision 2026-10-21; an earlier departure was reverted.
 */
export function sendStatusFor(outcome: SendOutcome): SendStatus {
  switch (outcome.outcomeClass) {
    case 'accepted':
      return 'accepted';
    case 'recipient_permanent':
      return 'definite_failure';
    case 'rate_limited':
    case 'configuration_permanent':
    case 'pre_transmission':
    case 'unknown_outcome':
      return 'unknown';
  }
}

/** Provider-side failures that operators must see (value-free category names only). */
export function operatorAlertFor(outcome: SendOutcome): 'provider_rate_limited' | 'provider_configuration' | 'provider_unreachable' | undefined {
  switch (outcome.outcomeClass) {
    case 'rate_limited':
      return 'provider_rate_limited';
    case 'configuration_permanent':
      return 'provider_configuration';
    case 'pre_transmission':
      return 'provider_unreachable';
    default:
      return undefined;
  }
}
