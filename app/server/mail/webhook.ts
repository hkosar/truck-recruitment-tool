// SendGrid signed Event Webhook (Quote-Queue app/webhooks/sendgrid/route.ts pattern, own code).
//
// Order: size-limited raw body (http/body.ts) → signature over timestamp + exact raw bytes →
// only then JSON parse. Events are correlated to a sign-in link by custom_args AND by the
// recipient snapshotted on the link. Replays are harmless: sg_event_id is unique in storage and
// every status update is monotonic (auth/ladder.ts nextSendStatus).

import { createPublicKey, verify } from 'node:crypto';
import type { SendStatus } from '../auth/ladder';
import { CORRELATION_SOURCE } from './sendgrid';

export const SIGNATURE_HEADER = 'x-twilio-email-event-webhook-signature';
export const TIMESTAMP_HEADER = 'x-twilio-email-event-webhook-timestamp';

/** Verifies SendGrid's ECDSA (P-256, SHA-256, DER signature) over timestamp + raw body. */
export function verifySendGridSignature(publicKeyBase64: string, signatureBase64: string | null, timestamp: string | null, rawBody: Buffer): boolean {
  if (!signatureBase64 || !timestamp || !/^\d{1,12}$/.test(timestamp)) return false;
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyBase64, 'base64'), format: 'der', type: 'spki' });
    const payload = Buffer.concat([Buffer.from(timestamp, 'utf8'), rawBody]);
    return verify('sha256', payload, { key, dsaEncoding: 'der' }, Buffer.from(signatureBase64, 'base64'));
  } catch {
    return false;
  }
}

export type MappedEvent = 'sent' | 'delivered' | 'delivery_delayed' | 'bounced' | 'failed' | 'complained' | 'suppressed';

/** Event mapping as in QQ (route :681-705). Unknown types are ignored. */
export function mapEventType(event: string, bounceType: string | undefined): MappedEvent | undefined {
  switch (event) {
    case 'processed':
      return 'sent';
    case 'delivered':
      return 'delivered';
    case 'deferred':
      return 'delivery_delayed';
    case 'bounce':
      return bounceType === 'blocked' ? 'delivery_delayed' : 'bounced';
    case 'dropped':
      return 'failed';
    case 'spamreport':
      return 'complained';
    case 'unsubscribe':
      return 'suppressed';
    default:
      return undefined;
  }
}

/** Evidence for the link row. Accepted is not delivered: delivery is recorded separately. */
export function evidenceFor(mapped: MappedEvent): { status: SendStatus; delivered: boolean } {
  switch (mapped) {
    case 'bounced':
    case 'failed':
    case 'complained':
    case 'suppressed':
      return { status: 'definite_failure', delivered: false };
    case 'sent':
      return { status: 'accepted', delivered: false };
    case 'delivered':
      return { status: 'accepted', delivered: true };
    case 'delivery_delayed':
      return { status: 'unknown', delivered: false };
  }
}

/**
 * Recipient-specific drop reasons (QQ route.ts:510-515). Only these let a `dropped` event block
 * the address. Any other or missing reason (quota, our configuration, content, bare
 * "Invalid") never blocks an innocent recipient (QQ :517-538), though it still proves this
 * send failed.
 */
export const FAILED_RECIPIENT_REASON_ALLOWLIST: ReadonlySet<string> = new Set([
  'Bounced Address',
  'Unsubscribed Address',
  'Spam Reporting Address',
  'Invalid Address',
]);

/** Events that put the address on the block list (never cleared automatically). */
export function blocksAddress(mapped: MappedEvent, reason: string | undefined): boolean {
  if (mapped === 'bounced' || mapped === 'complained' || mapped === 'suppressed') return true;
  if (mapped === 'failed') return reason !== undefined && FAILED_RECIPIENT_REASON_ALLOWLIST.has(reason);
  return false;
}

/** Block reason recorded with the block (QQ route.ts blockReasonFor). */
export function blockReasonFor(mapped: MappedEvent, reason: string | undefined): 'bounced' | 'rejected' | 'complained' | 'suppressed' | 'invalid' {
  if (mapped === 'complained') return 'complained';
  if (mapped === 'suppressed') return 'suppressed';
  if (mapped === 'failed') {
    switch (reason) {
      case 'Unsubscribed Address':
        return 'rejected';
      case 'Spam Reporting Address':
        return 'complained';
      case 'Invalid Address':
        return 'invalid';
      default:
        return 'bounced';
    }
  }
  return 'bounced';
}

export interface ParsedEvent {
  providerEventId: string;
  linkId: string;
  email: string;
  mapped: MappedEvent;
  occurredAtMs: number;
  /** SendGrid's drop/bounce reason, at most 500 characters (stored; never logged). */
  reason: string | undefined;
  /** sg_message_id from the event, used for fill-or-mismatch correlation. */
  messageId: string | undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Parses the verified JSON array; drops anything that is not one of our sign-in events. */
export function parseEvents(rawBody: Buffer): ParsedEvent[] | undefined {
  let data: unknown;
  try {
    data = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return undefined;
  }
  if (!Array.isArray(data)) return undefined;
  const out: ParsedEvent[] = [];
  for (const item of data) {
    if (typeof item !== 'object' || item === null) continue;
    const e = item as Record<string, unknown>;
    if (e.tr_source !== CORRELATION_SOURCE) continue;
    if (typeof e.tr_local_id !== 'string' || !UUID.test(e.tr_local_id)) continue;
    if (typeof e.sg_event_id !== 'string' || e.sg_event_id.length === 0 || e.sg_event_id.length > 200) continue;
    if (typeof e.email !== 'string' || typeof e.event !== 'string' || typeof e.timestamp !== 'number') continue;
    const mapped = mapEventType(e.event, typeof e.type === 'string' ? e.type : undefined);
    if (mapped === undefined) continue;
    const reason = typeof e.reason === 'string' && e.reason.length > 0 ? e.reason.slice(0, 500) : undefined;
    const messageId = typeof e.sg_message_id === 'string' && e.sg_message_id.length > 0 && e.sg_message_id.length <= 300 ? e.sg_message_id : undefined;
    out.push({ providerEventId: e.sg_event_id, linkId: e.tr_local_id, email: e.email.trim().toLowerCase(), mapped, occurredAtMs: e.timestamp * 1000, reason, messageId });
  }
  return out;
}

/** An event applies only if its recipient equals the address snapshotted on the link. */
export function correlates(event: ParsedEvent, linkRecipient: string): boolean {
  return event.email === linkRecipient.trim().toLowerCase();
}

/**
 * Message-id correlation (QQ route.ts:869-908): the first event that carries an sg_message_id
 * fills it; a later event with a different id is rejected BEFORE any delivery or block update.
 * An event without an id neither fills nor conflicts.
 */
export function messageIdCheck(stored: string | undefined, incoming: string | undefined): 'fill' | 'match' | 'mismatch' | 'absent' {
  if (incoming === undefined) return 'absent';
  if (stored === undefined) return 'fill';
  return stored === incoming ? 'match' : 'mismatch';
}
