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

import { dncLookupStatus, dncQueryKey } from './contactability';

describe('dncLookupStatus', () => {
  it('blocks outreach while pending and when failed', () => {
    expect(dncLookupStatus(5, { isError: false, hasData: false })).toBe('pending');
    expect(dncLookupStatus(5, { isError: true, hasData: false })).toBe('failed');
    expect(dncLookupStatus(5, { isError: true, hasData: true })).toBe('failed');
  });
  it('is ready with data, or when the page has no carriers', () => {
    expect(dncLookupStatus(5, { isError: false, hasData: true })).toBe('ready');
    expect(dncLookupStatus(0, { isError: false, hasData: false })).toBe('ready');
  });
});

describe('dncQueryKey', () => {
  it('includes the DOT list so a different page does not reuse cached results', () => {
    expect(dncQueryKey('b1', [3, 1, 2])).toEqual(dncQueryKey('b1', [1, 2, 3]));
    expect(dncQueryKey('b1', [1, 2, 3])).not.toEqual(dncQueryKey('b1', [1, 2, 4]));
    expect(dncQueryKey('b1', [1])).not.toEqual(dncQueryKey('b2', [1]));
  });
});

import { outreachAllowed } from './contactability';

describe('outreachAllowed', () => {
  it('rejects outreach unless the lookup is ready', () => {
    expect(outreachAllowed('ready')).toBe(true);
    expect(outreachAllowed('pending')).toBe(false);
    expect(outreachAllowed('failed')).toBe(false);
  });
});
