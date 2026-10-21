// SendGrid v3 mail/send adapter. Built against the documented request shape; never run live
// in this repository (no key, no account configuration approved).

import type { MailAdapter, SendOutcome, SignInMail } from './adapter';

export const SENDGRID_SEND_URL = 'https://api.sendgrid.com/v3/mail/send';
export const SEND_TIMEOUT_MS = 8_000;
export const CORRELATION_SOURCE = 'auth';

export type FetchLike = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ status: number; headers: { get(name: string): string | null } }>;

export interface SendGridConfig {
  apiKey: string;
  fromAddress: string;
  fromName: string;
  fetch: FetchLike;
  timeoutMs?: number;
}

/** The exact request body. Click and open tracking are always off, so the link is never rewritten. */
export function buildSignInRequest(mail: SignInMail, fromAddress: string, fromName: string): Record<string, unknown> {
  return {
    from: { email: fromAddress, name: fromName },
    personalizations: [{ to: [{ email: mail.to }] }],
    subject: 'Your Carrier Recruiter sign-in link',
    content: [
      {
        type: 'text/plain',
        value: `Sign in to Carrier Recruiter: ${mail.linkUrl}\n\nThis link works once and expires in 15 minutes. If you didn't ask for it, ignore this email.`,
      },
      {
        type: 'text/html',
        value: `<p>Use the link below to sign in to Carrier Recruiter. It works once and expires in 15 minutes. If you didn't ask for it, ignore this email.</p><p><a href="${escapeAttribute(mail.linkUrl)}">Sign in</a></p>`,
      },
    ],
    tracking_settings: { click_tracking: { enable: false }, open_tracking: { enable: false } },
    custom_args: { tr_source: CORRELATION_SOURCE, tr_local_id: mail.localId },
  };
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Classifies a received response. Pure. */
export function classifySendGridResponse(status: number, headers: { get(name: string): string | null }): SendOutcome {
  if (status >= 200 && status < 300) {
    const id = headers.get('x-message-id');
    return id ? { outcomeClass: 'accepted', httpStatus: status, providerMessageId: id } : { outcomeClass: 'unknown_outcome', httpStatus: status, errorCode: 'accepted_without_id' };
  }
  if (status === 429) return { outcomeClass: 'rate_limited', httpStatus: status, errorCode: 'provider_rate_limited' };
  if (status === 400 || status === 401 || status === 403) return { outcomeClass: 'configuration_permanent', httpStatus: status, errorCode: `provider_config_${status}` };
  return { outcomeClass: 'unknown_outcome', httpStatus: status, errorCode: status >= 500 ? 'provider_server_error' : `provider_status_${status}` };
}

const PRE_TRANSMISSION_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** Classifies a thrown fetch error (no response received). Pure. */
export function classifyNetworkError(err: unknown): SendOutcome {
  const name = err instanceof Error ? err.name : undefined;
  if (name === 'AbortError' || name === 'TimeoutError') return { outcomeClass: 'unknown_outcome', errorCode: 'provider_timeout' };
  const cause = err instanceof Error ? (err as Error & { cause?: { code?: unknown } }).cause : undefined;
  const code = typeof cause?.code === 'string' ? cause.code : undefined;
  if (code !== undefined && PRE_TRANSMISSION_CODES.has(code)) return { outcomeClass: 'pre_transmission', errorCode: 'provider_unreachable' };
  return { outcomeClass: 'unknown_outcome', errorCode: 'provider_network_error' };
}

export class SendGridAdapter implements MailAdapter {
  constructor(private readonly config: SendGridConfig) {}

  async sendSignInLink(mail: SignInMail): Promise<SendOutcome> {
    const body = JSON.stringify(buildSignInRequest(mail, this.config.fromAddress, this.config.fromName));
    try {
      const response = await this.config.fetch(SENDGRID_SEND_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.config.apiKey}`, 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(this.config.timeoutMs ?? SEND_TIMEOUT_MS),
      });
      return classifySendGridResponse(response.status, response.headers);
    } catch (err) {
      return classifyNetworkError(err);
    }
  }
}
