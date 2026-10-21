import { describe, expect, it } from 'vitest';
import { validateLane } from './lanes';
import type { LaneDraft } from './lanes';

const lane = (patch: Partial<LaneDraft> = {}): LaneDraft => ({ id: '1', label: '', anchorLabel: 'Austin, TX', lat: '30.27', lng: '-97.74', radius: '50', ...patch });

describe('validateLane', () => {
  it('accepts a complete lane', () => {
    expect(validateLane(lane()).valid).toEqual({ label: '', anchorLabel: 'Austin, TX', lat: 30.27, lng: -97.74, radius: 50 });
  });
  it('rejects blank coordinates instead of treating them as zero', () => {
    const result = validateLane(lane({ lat: '', lng: '  ' }));
    expect(result.valid).toBeUndefined();
    expect(result.errors.lat).toMatch(/required/);
    expect(result.errors.lng).toMatch(/required/);
  });
  it('rejects out-of-range and non-numeric coordinates', () => {
    expect(validateLane(lane({ lat: '91' })).errors.lat).toBeDefined();
    expect(validateLane(lane({ lng: '-181' })).errors.lng).toBeDefined();
    expect(validateLane(lane({ lat: 'abc' })).errors.lat).toBeDefined();
  });
  it('accepts boundary values', () => {
    expect(validateLane(lane({ lat: '-90', lng: '180' })).valid).toBeDefined();
  });
  it('requires an anchor and positive radius', () => {
    expect(validateLane(lane({ anchorLabel: ' ' })).errors.anchorLabel).toBeDefined();
    expect(validateLane(lane({ radius: '0' })).errors.radius).toBeDefined();
  });
});
