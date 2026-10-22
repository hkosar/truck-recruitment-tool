import { describe, expect, it } from 'vitest';
import { buildCsv, csvCell } from './batch-list';

describe('csvCell', () => {
  it('leaves plain text alone and blanks null', () => {
    expect(csvCell('Acme Hauling')).toBe('Acme Hauling');
    expect(csvCell(null)).toBe('');
  });
  it('quotes commas, quotes and newlines', () => {
    expect(csvCell('Smith, Jones & "Sons"')).toBe('"Smith, Jones & ""Sons"""');
    expect(csvCell('a\nb')).toBe('"a\nb"');
  });
  it('defuses spreadsheet formulas', () => {
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('+1 555')).toBe("'+1 555");
    expect(csvCell('@cmd')).toBe("'@cmd");
    expect(csvCell('-2+3')).toBe("'-2+3");
  });
});

describe('buildCsv', () => {
  const row = {
    dot_number: 1400001, legal_name: 'Colorado River Sand & Gravel LLC', dba_name: null, contact_name: 'Pat "P" Lee', phone: '5125550100', cell_phone: null,
    email: 'pat@example.test', phy_city: 'Austin', phy_state: 'TX', status: 'not_a_fit', warning_reasons: ['no_insurance', 'high_oos'], last_contact_at: new Date('2026-10-20T15:30:00Z'),
  };
  it('writes a header, one CRLF line per carrier, readable status and warnings', () => {
    const csv = buildCsv([row]);
    const lines = csv.split('\r\n');
    expect(lines[0].startsWith('USDOT,Legal name,')).toBe(true);
    expect(lines[1]).toBe('1400001,Colorado River Sand & Gravel LLC,,"Pat ""P"" Lee",5125550100,,pat@example.test,Austin,TX,not a fit,no_insurance; high_oos,2026-10-20T15:30:00.000Z');
    expect(lines[2]).toBe('');
  });
  it('is just the header when there are no rows', () => {
    expect(buildCsv([]).split('\r\n')).toHaveLength(2);
  });
});
