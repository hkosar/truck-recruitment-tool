import { describe, expect, it } from 'vitest';
import { RefusedError } from '../core/types';
import { normalizeMobile, parseAddPerson } from './add-person';

describe('add person: request shaping', () => {
  it('normalizes name and email; accepts only staff roles', () => {
    expect(parseAddPerson({ full_name: '  Pat Lee ', email: ' Pat.Lee@Example.COM ', role: 'edit' }))
      .toEqual({ fullName: 'Pat Lee', email: 'pat.lee@example.com', role: 'edit', mobile: null });
    for (const role of ['manager', 'edit', 'view']) expect(parseAddPerson({ full_name: 'A', email: 'a@b.co', role }).role).toBe(role);
    for (const role of ['guest', 'admin', '', null, 3]) expect(() => parseAddPerson({ full_name: 'A', email: 'a@b.co', role })).toThrow(RefusedError);
  });

  it('refuses a missing or overlong name, a bad email and non-object bodies', () => {
    for (const body of [
      { full_name: '   ', email: 'a@b.co', role: 'view' },
      { full_name: 'x'.repeat(201), email: 'a@b.co', role: 'view' },
      { full_name: 'A', email: 'not-an-email', role: 'view' },
      { full_name: 'A', email: `${'x'.repeat(320)}@b.co`, role: 'view' },
      null, [], 'text',
    ]) expect(() => parseAddPerson(body)).toThrow(RefusedError);
  });

  it('mobile is optional and normalized to E.164 (US numbers may omit +1); anything else is refused', () => {
    expect(normalizeMobile(undefined)).toBeNull();
    expect(normalizeMobile('  ')).toBeNull();
    expect(normalizeMobile('(555) 123-4567')).toBe('+15551234567');
    expect(normalizeMobile('1 555.123.4567')).toBe('+15551234567');
    expect(normalizeMobile('+44 20 7946 0958')).toBe('+442079460958');
    for (const bad of ['123', 'call me', '+0 555 123 4567', '555-1234', 42]) expect(() => normalizeMobile(bad)).toThrow(RefusedError);
  });
});
