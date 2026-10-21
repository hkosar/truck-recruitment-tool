import { describe, expect, it } from 'vitest';
import { isActiveGlobalSuppression, isGloballyDnc } from './contactability';

const now = new Date('2026-07-23T12:00:00Z');
const all = { channel: 'all', value: null, expires_at: null };

describe('isGloballyDnc', () => {
  it('is true for the carrier flag', () => {
    expect(isGloballyDnc({ do_not_contact: true }, [], now)).toBe(true);
  });
  it('is true for an active carrier-wide all suppression even when the flag is false', () => {
    expect(isGloballyDnc({ do_not_contact: false }, [all], now)).toBe(true);
    expect(isGloballyDnc({ do_not_contact: false }, [{ ...all, expires_at: '2026-07-24T00:00:00Z' }], now)).toBe(true);
  });
  it('ignores expired, channel-specific and value-specific suppressions', () => {
    expect(isActiveGlobalSuppression({ ...all, expires_at: '2026-07-23T11:00:00Z' }, now)).toBe(false);
    expect(isGloballyDnc({ do_not_contact: false }, [{ ...all, channel: 'call' }], now)).toBe(false);
    expect(isGloballyDnc({ do_not_contact: false }, [{ ...all, value: '5125550142' }], now)).toBe(false);
  });
  it('is false with no signals or no carrier', () => {
    expect(isGloballyDnc({ do_not_contact: false }, [], now)).toBe(false);
    expect(isGloballyDnc(null, [], now)).toBe(false);
  });
});
