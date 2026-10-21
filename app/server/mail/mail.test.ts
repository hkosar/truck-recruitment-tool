import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { operatorAlertFor, sendStatusFor } from './adapter';
import { FakeMailAdapter } from './fake';
import { buildSignInRequest, classifyNetworkError, classifySendGridResponse, SendGridAdapter, type FetchLike } from './sendgrid';
import { blockReasonFor, blocksAddress, correlates, evidenceFor, mapEventType, messageIdCheck, parseEvents, verifySendGridSignature } from './webhook';

const headers = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null });
const LINK_ID = '11111111-2222-4333-8444-555555555555';

describe('SendGrid send', () => {
  it('builds a one-shot request with tracking off and correlation args', () => {
    const body = buildSignInRequest({ to: 'a@b.co', linkUrl: 'https://x.test/auth/verify?token=T', localId: LINK_ID }, 'signin@example.test', 'Carrier Recruiter');
    expect(body.tracking_settings).toEqual({ click_tracking: { enable: false }, open_tracking: { enable: false } });
    expect(body.custom_args).toEqual({ tr_source: 'auth', tr_local_id: LINK_ID });
  });

  it('classifies responses without echoing provider text', () => {
    expect(classifySendGridResponse(202, headers({ 'x-message-id': 'm1' }))).toEqual({ outcomeClass: 'accepted', httpStatus: 202, providerMessageId: 'm1' });
    expect(classifySendGridResponse(202, headers({}))).toMatchObject({ outcomeClass: 'unknown_outcome' });
    expect(classifySendGridResponse(429, headers({}))).toMatchObject({ outcomeClass: 'rate_limited' });
    expect(classifySendGridResponse(401, headers({}))).toEqual({ outcomeClass: 'configuration_permanent', httpStatus: 401, errorCode: 'provider_config_401' });
    expect(classifySendGridResponse(503, headers({}))).toMatchObject({ outcomeClass: 'unknown_outcome', errorCode: 'provider_server_error' });
  });

  it('maps outcomes as Quote-Queue does: only a recipient refusal is a definite failure', () => {
    expect(sendStatusFor({ outcomeClass: 'accepted' })).toBe('accepted');
    expect(sendStatusFor({ outcomeClass: 'recipient_permanent' })).toBe('definite_failure');
    // Provider-side problems unlock nothing (not definite) and raise an operator alert.
    for (const c of ['rate_limited', 'configuration_permanent', 'pre_transmission', 'unknown_outcome'] as const) {
      expect(sendStatusFor({ outcomeClass: c })).toBe('unknown');
    }
    expect(operatorAlertFor({ outcomeClass: 'rate_limited' })).toBe('provider_rate_limited');
    expect(operatorAlertFor({ outcomeClass: 'configuration_permanent' })).toBe('provider_configuration');
    expect(operatorAlertFor({ outcomeClass: 'pre_transmission' })).toBe('provider_unreachable');
    expect(operatorAlertFor({ outcomeClass: 'unknown_outcome' })).toBeUndefined();
  });

  it('timeouts are unknown; pre-transmission failures are definite', () => {
    expect(classifyNetworkError(Object.assign(new Error('t'), { name: 'TimeoutError' }))).toMatchObject({ outcomeClass: 'unknown_outcome' });
    expect(classifyNetworkError(Object.assign(new Error('x'), { cause: { code: 'ECONNREFUSED' } }))).toMatchObject({ outcomeClass: 'pre_transmission' });
    expect(classifyNetworkError(Object.assign(new Error('x'), { cause: { code: 'ECONNRESET' } }))).toMatchObject({ outcomeClass: 'unknown_outcome' });
  });

  it('adapter calls fetch exactly once per send (no retry)', async () => {
    let calls = 0;
    const fetch: FetchLike = async () => {
      calls += 1;
      return { status: 500, headers: headers({}) };
    };
    const adapter = new SendGridAdapter({ apiKey: 'k', fromAddress: 'f@example.test', fromName: 'n', fetch });
    expect(await adapter.sendSignInLink({ to: 'a@b.co', linkUrl: 'https://x.test/v', localId: LINK_ID })).toMatchObject({ outcomeClass: 'unknown_outcome' });
    expect(calls).toBe(1);
  });

  it('fake adapter keeps links in memory only', async () => {
    const fake = new FakeMailAdapter();
    await fake.sendSignInLink({ to: 'a@b.co', linkUrl: 'L1', localId: LINK_ID });
    expect(fake.lastLinkFor('a@b.co')).toBe('L1');
    expect(fake.count).toBe(1);
  });
});

describe('SendGrid webhook', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKeyBase64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const body = Buffer.from(JSON.stringify([{ email: 'A@b.co', event: 'bounce', type: 'bounce', sg_event_id: 'e1', timestamp: 1_700_000_000, tr_source: 'auth', tr_local_id: LINK_ID }]));
  const ts = '1700000000';
  const signature = sign('sha256', Buffer.concat([Buffer.from(ts), body]), privateKey).toString('base64');

  it('accepts a valid signature over timestamp + raw body', () => {
    expect(verifySendGridSignature(publicKeyBase64, signature, ts, body)).toBe(true);
  });
  it('rejects tampering, wrong timestamp, missing headers and garbage', () => {
    expect(verifySendGridSignature(publicKeyBase64, signature, ts, Buffer.concat([body, Buffer.from(' ')]))).toBe(false);
    expect(verifySendGridSignature(publicKeyBase64, signature, '1700000001', body)).toBe(false);
    expect(verifySendGridSignature(publicKeyBase64, null, ts, body)).toBe(false);
    expect(verifySendGridSignature(publicKeyBase64, 'not-base64!!', ts, body)).toBe(false);
    expect(verifySendGridSignature('bad-key', signature, ts, body)).toBe(false);
  });
  it('maps events; bounce=blocked is a delay, not a failure; accepted is not delivered', () => {
    expect(mapEventType('bounce', 'blocked')).toBe('delivery_delayed');
    expect(mapEventType('bounce', 'bounce')).toBe('bounced');
    expect(mapEventType('open', undefined)).toBeUndefined();
    expect(evidenceFor('delivered')).toEqual({ status: 'accepted', delivered: true });
    expect(evidenceFor('sent')).toEqual({ status: 'accepted', delivered: false });
    expect(evidenceFor('delivery_delayed')).toEqual({ status: 'unknown', delivered: false });
    expect(evidenceFor('failed').status).toBe('definite_failure');
    expect(blocksAddress('bounced', undefined)).toBe(true);
    expect(blocksAddress('complained', undefined)).toBe(true);
    expect(blocksAddress('delivery_delayed', undefined)).toBe(false);
  });
  it('a drop blocks the recipient only for recipient-specific reasons; quota or config never does', () => {
    for (const r of ['Bounced Address', 'Unsubscribed Address', 'Spam Reporting Address', 'Invalid Address']) expect(blocksAddress('failed', r)).toBe(true);
    for (const r of [undefined, 'Invalid', 'Spam Content', 'Exceeded Quota', 'Invalid SMTPAPI header', 'Unknown reason']) expect(blocksAddress('failed', r)).toBe(false);
    // The send itself still failed definitely, whoever's fault the drop was.
    expect(evidenceFor('failed').status).toBe('definite_failure');
    expect(blockReasonFor('failed', 'Invalid Address')).toBe('invalid');
    expect(blockReasonFor('failed', 'Unsubscribed Address')).toBe('rejected');
  });
  it('message ids: first fills, same matches, different conflicts, missing neither', () => {
    expect(messageIdCheck(undefined, 'm1')).toBe('fill');
    expect(messageIdCheck('m1', 'm1')).toBe('match');
    expect(messageIdCheck('m1', 'm2')).toBe('mismatch');
    expect(messageIdCheck('m1', undefined)).toBe('absent');
  });
  it('keeps the drop reason and message id from the event', () => {
    const parsed = parseEvents(Buffer.from(JSON.stringify([
      { email: 'a@b.co', event: 'dropped', reason: 'Bounced Address', sg_message_id: 'msg.1', sg_event_id: 'e9', timestamp: 1, tr_source: 'auth', tr_local_id: LINK_ID },
    ])));
    expect(parsed![0]).toMatchObject({ mapped: 'failed', reason: 'Bounced Address', messageId: 'msg.1' });
  });
  it('parses only our correlated sign-in events and checks the recipient', () => {
    const parsed = parseEvents(Buffer.from(JSON.stringify([
      { email: 'A@b.co', event: 'delivered', sg_event_id: 'e2', timestamp: 1, tr_source: 'auth', tr_local_id: LINK_ID },
      { email: 'x@b.co', event: 'delivered', sg_event_id: 'e3', timestamp: 1, qq_source: 'auth', qq_local_id: LINK_ID },
      { email: 'x@b.co', event: 'delivered', sg_event_id: 'e4', timestamp: 1, tr_source: 'auth', tr_local_id: 'not-a-uuid' },
    ])));
    expect(parsed).toHaveLength(1);
    expect(correlates(parsed![0], 'a@b.co')).toBe(true);
    expect(correlates(parsed![0], 'other@b.co')).toBe(false);
    expect(parseEvents(Buffer.from('{not json'))).toBeUndefined();
    expect(parseEvents(Buffer.from('{}'))).toBeUndefined();
  });
});
