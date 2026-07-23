/**
 * Formatting helpers — docs/build-plan/02-frontend-spec.md §1.1
 * ("fmtMoney, fmtRel, fmtPhone, tabular helpers").
 */

/** Dash shown for missing values across ContactCell, tables, etc. (G4). */
export const EMPTY_VALUE = '—';

/** `font-variant-numeric: tabular-nums` utility class (app.css `.tabular-data`,
 * also just Tailwind's built-in `tabular-nums`) for money/count/USDOT/phone
 * table cells (§1.5). */
export const TABULAR_NUMS_CLASS = 'tabular-nums';

/**
 * Insurance/BIPD figures are whole dollars. The binding Round-2 contract is
 * `$X.X MM` for millions and `$NNN K` for thousands everywhere (F36/G14).
 */
export function fmtMoney(dollars: number | null | undefined): string {
  if (dollars === null || dollars === undefined || Number.isNaN(dollars)) return EMPTY_VALUE;
  const absolute = Math.abs(dollars);
  const sign = dollars < 0 ? '-' : '';
  if (absolute >= 1_000_000) return `${sign}$${(absolute / 1_000_000).toFixed(1)} MM`;
  if (absolute >= 1_000) return `${sign}$${Math.round(absolute / 1_000).toLocaleString('en-US')} K`;
  return `${sign}$${Math.round(absolute).toLocaleString('en-US')}`;
}

const RELATIVE_UNITS: { unit: Intl.RelativeTimeFormatUnit; ms: number }[] = [
  { unit: 'year', ms: 365 * 24 * 60 * 60 * 1000 },
  { unit: 'month', ms: 30 * 24 * 60 * 60 * 1000 },
  { unit: 'week', ms: 7 * 24 * 60 * 60 * 1000 },
  { unit: 'day', ms: 24 * 60 * 60 * 1000 },
  { unit: 'hour', ms: 60 * 60 * 1000 },
  { unit: 'minute', ms: 60 * 1000 },
];

const relativeTimeFormatter = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' });

/**
 * "2h ago" / "3d ago" style relative timestamps for activity feeds,
 * timelines, last-contact columns (F11/G6/G7). Accepts an ISO string (what
 * every RPC row / Postgres timestamptz column arrives as over PostgREST).
 */
export function fmtRel(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return EMPTY_VALUE;
  const then = new Date(iso);
  const diffMs = then.getTime() - now.getTime();
  const absMs = Math.abs(diffMs);

  if (absMs < 60_000) return 'just now';

  for (const { unit, ms } of RELATIVE_UNITS) {
    if (absMs >= ms || unit === 'minute') {
      const value = Math.round(diffMs / ms);
      return relativeTimeFormatter.format(value, unit);
    }
  }
  return relativeTimeFormatter.format(0, 'minute');
}

/**
 * Formats a US 10-digit number as "(512) 555-0142". Falls back to the
 * trimmed original string for anything that doesn't parse as 10 (or 11
 * with a leading 1) digits, rather than mangling odd source data.
 */
export function fmtPhone(raw: string | null | undefined): string {
  if (!raw) return EMPTY_VALUE;
  const digits = raw.replace(/\D/g, '');
  const tenDigit = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (tenDigit.length !== 10) return raw.trim() || EMPTY_VALUE;
  return `(${tenDigit.slice(0, 3)}) ${tenDigit.slice(3, 6)}-${tenDigit.slice(6)}`;
}

/** Thousands-separated integer for count/fleet-size/mono table cells. */
export function fmtInt(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return EMPTY_VALUE;
  return Math.round(value).toLocaleString('en-US');
}

/** USDOT numbers render as plain mono digits — no thousands separators
 * (they're an identifier, not a quantity). */
export function fmtDot(dot: number | null | undefined): string {
  if (dot === null || dot === undefined) return EMPTY_VALUE;
  return String(dot);
}
