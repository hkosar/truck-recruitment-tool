import { describe, expect, it } from 'vitest';
import { fmtInt, fmtMoney, fmtPhone, fmtRel } from './format';

describe('format helpers', () => {
  it('uses the locked insurance money notation', () => {
    expect(fmtMoney(2_000_000)).toBe('$2.0 MM');
    expect(fmtMoney(750_000)).toBe('$750 K');
    expect(fmtMoney(null)).toBe('—');
  });

  it('formats common carrier fields without corrupting odd source data', () => {
    expect(fmtPhone('5125550142')).toBe('(512) 555-0142');
    expect(fmtPhone('ext 7')).toBe('ext 7');
    expect(fmtInt(192300)).toBe('192,300');
  });

  it('renders relative timestamps deterministically', () => {
    expect(fmtRel('2026-07-23T17:00:00Z', new Date('2026-07-23T19:00:00Z'))).toBe('2 hours ago');
  });
});
