import { describe, expect, it } from 'vitest';
import { canDismiss, cargoFlagLabels, confirmCopy, dncRequest, filterTimeline, timelineCounts } from './carrierLogic';

const logs = [{ id: 1, channel: 'call' }, { id: 2, channel: 'email' }, { id: 3, channel: 'call' }, { id: 4, channel: 'mail' }];

describe('filterTimeline', () => {
  it('returns everything for all, including channels without a chip', () => {
    expect(filterTimeline(logs, 'all')).toHaveLength(4);
  });
  it('keeps only the chosen channel, in order', () => {
    expect(filterTimeline(logs, 'call').map((l) => l.id)).toEqual([1, 3]);
    expect(filterTimeline(logs, 'text')).toEqual([]);
  });
});

describe('timelineCounts', () => {
  it('counts per channel and the total', () => {
    expect(timelineCounts(logs)).toEqual({ all: 4, call: 2, text: 0, email: 1 });
  });
});

describe('cargoFlagLabels', () => {
  it('lists set flags, skips false/null and the Other flag', () => {
    expect(cargoFlagLabels({ crgo_drybulk: true, crgo_construct: true, crgo_meat: false, crgo_chem: null, crgo_cargoothr: true })).toEqual(['Dry Bulk', 'Construction']);
  });
  it('is empty when nothing is set', () => {
    expect(cargoFlagLabels({})).toEqual([]);
  });
});

describe('confirmCopy', () => {
  it('warns the DNC is global and uses the danger tone', () => {
    const c = confirmCopy('dnc-set', 'ACME HAULING', 123);
    expect(c.tone).toBe('danger');
    expect(c.body).toContain('ACME HAULING');
    expect(c.body).toContain('every batch');
  });
  it('restore is a normal tone; promote names the USDOT and says nothing is sent', () => {
    expect(confirmCopy('dnc-restore', 'ACME', 1).tone).toBe('primary');
    const p = confirmCopy('promote', 'ACME', 1234567);
    expect(p.body).toContain('USDOT 1234567');
    expect(p.body).toContain('Nothing is sent');
  });
});

describe('dncRequest', () => {
  // The dialog kind is fixed when it opens. A cache refresh in between (someone else set DNC)
  // must not change what is sent: the request depends only on the confirmed kind and the dot.
  it('set always sends on=true with a reason, whatever the cache later says', () => {
    expect(dncRequest('dnc-set', 42)).toEqual({ dot: 42, on: true, reason: 'Set from carrier profile' });
  });
  it('restore always sends on=false with no reason', () => {
    expect(dncRequest('dnc-restore', 42)).toEqual({ dot: 42, on: false, reason: null });
  });
  it('carries the carrier id it was given', () => {
    expect(dncRequest('dnc-set', 7).dot).toBe(7);
  });
});

describe('canDismiss', () => {
  it('blocks Escape / backdrop dismissal while a request is pending', () => {
    expect(canDismiss(true)).toBe(false);
    expect(canDismiss(false)).toBe(true);
  });
});
