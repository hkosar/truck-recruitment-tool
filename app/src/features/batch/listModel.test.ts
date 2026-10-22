import { describe, expect, it } from 'vitest';
import { contactFilter, insuranceMin, isCriticalRow, selectableDots, sortChoice, toggleDot, togglePage } from './listModel';

describe('isCriticalRow (red wash)', () => {
  it('washes do-not-contact rows', () => expect(isCriticalRow({ do_not_contact: true, warning_reasons: [] })).toBe(true));
  it('washes critical warnings', () => expect(isCriticalRow({ do_not_contact: false, warning_reasons: ['no_insurance'] })).toBe(true));
  it('does not wash ordinary warnings', () => {
    expect(isCriticalRow({ do_not_contact: false, warning_reasons: ['insurance_below_standard', 'high_oos', 'missing_from_source', 'insurance_expiring_30d'] })).toBe(false);
  });
  it('washes when a critical code is mixed with ordinary ones', () => expect(isCriticalRow({ do_not_contact: false, warning_reasons: ['high_oos', 'recent_crashes'] })).toBe(true));
  it('does not wash clean rows', () => expect(isCriticalRow({ do_not_contact: false, warning_reasons: [] })).toBe(false));
});

describe('sort and filters', () => {
  it('falls back to status for unknown sorts', () => expect(sortChoice('bogus').sort).toBe('status'));
  it('maps fleet to power_units descending', () => expect(sortChoice('fleet')).toMatchObject({ sort: 'power_units', dir: 'desc' }));
  it('maps insurance choices', () => {
    expect(insuranceMin('any')).toBeNull();
    expect(insuranceMin('1000000')).toBe(1_000_000);
    expect(insuranceMin('nope')).toBeNull();
  });
  it('maps contact choices to the tri-state filters', () => {
    expect(contactFilter('missing')).toEqual({ hasPhone: false, hasEmail: false });
    expect(contactFilter('phone')).toEqual({ hasPhone: true, hasEmail: null });
    expect(contactFilter(null)).toEqual({ hasPhone: null, hasEmail: null });
  });
});

describe('selection', () => {
  const rows = [{ dot_number: 1, do_not_contact: false }, { dot_number: 2, do_not_contact: true }, { dot_number: 3, do_not_contact: false }];
  it('never offers do-not-contact rows', () => expect(selectableDots(rows)).toEqual([1, 3]));
  it('toggles one dot', () => expect([...toggleDot(new Set([1]), 3)]).toEqual([1, 3]));
  it('select-all adds then clears a page', () => {
    const all = togglePage(new Set(), [1, 3]);
    expect([...all]).toEqual([1, 3]);
    expect(togglePage(all, [1, 3]).size).toBe(0);
  });
  it('select-all keeps other pages', () => expect([...togglePage(new Set([9]), [1, 3])].sort()).toEqual([1, 3, 9]));
});
