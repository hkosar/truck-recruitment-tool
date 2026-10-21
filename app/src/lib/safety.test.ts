import { describe, expect, it } from 'vitest';
import { safetyVerdict } from './safety';

describe('safetyVerdict', () => {
  it('never shows Verified when the rating is missing', () => {
    expect(safetyVerdict(null)).toBe('warn');
    expect(safetyVerdict({ safety_rating: null })).toBe('warn');
    expect(safetyVerdict({ safety_rating: '' })).toBe('warn');
    expect(safetyVerdict({ safety_rating: 'Unrated' })).toBe('warn');
  });
  it('maps explicit ratings', () => {
    expect(safetyVerdict({ safety_rating: 'Satisfactory' })).toBe('good');
    expect(safetyVerdict({ safety_rating: 'Conditional' })).toBe('warn');
    expect(safetyVerdict({ safety_rating: 'Unsatisfactory' })).toBe('bad');
  });
});
