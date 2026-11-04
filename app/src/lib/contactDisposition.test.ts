import { describe, expect, it } from 'vitest';
import { CONTACT_DISPOSITIONS_BY_CHANNEL } from '../../server/core/contact-dispositions';
import { DISPOSITIONS_BY_CHANNEL } from '../types/domain';
import { resolveDisposition } from './contactDisposition';

describe('resolveDisposition', () => {
  it('an untouched call form sends connected', () => {
    expect(resolveDisposition('call', undefined)).toBe('connected');
    expect(resolveDisposition('call', null)).toBe('connected');
    expect(resolveDisposition('call', '')).toBe('connected');
    expect(resolveDisposition('call', 'connected')).toBe('connected');
  });
  it('after switching to text or email an untouched form sends that channel\'s first option', () => {
    expect(resolveDisposition('text', 'connected')).toBe('sent');
    expect(resolveDisposition('email', 'connected')).toBe('sent');
    expect(resolveDisposition('text', undefined)).toBe('sent');
  });
  it('keeps a valid choice for its channel', () => {
    expect(resolveDisposition('email', 'bounced')).toBe('bounced');
    expect(resolveDisposition('call', 'voicemail')).toBe('voicemail');
  });
  it('replaces a choice from another channel', () => {
    expect(resolveDisposition('call', 'bounced')).toBe('connected');
    expect(resolveDisposition('text', 'bounced')).toBe('sent');
  });
  it('never returns a value outside the channel list', () => {
    for (const channel of ['call', 'text', 'email'] as const) {
      for (const chosen of [undefined, '', 'null', 'x', ...Object.values(DISPOSITIONS_BY_CHANNEL).flat()]) {
        expect(DISPOSITIONS_BY_CHANNEL[channel]).toContain(resolveDisposition(channel, chosen));
      }
    }
  });
});

describe('server outcome list', () => {
  it('matches the UI list exactly', () => {
    expect(CONTACT_DISPOSITIONS_BY_CHANNEL).toEqual(DISPOSITIONS_BY_CHANNEL);
  });
});
