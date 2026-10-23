// Pure rules for the batch working list: sort/filter URL params, the red row wash, and selection.

import { WARNING_META } from '../../lib/warnings';
import type { BatchMembersSort, SortDir, WarningCode } from '../../types/domain';

export interface SortChoice { key: string; label: string; sort: BatchMembersSort; dir: SortDir }

/** Sorts the database can do for the whole batch (internal.batch_members_ordered). */
export const SORT_CHOICES: readonly SortChoice[] = [
  { key: 'status', label: 'Status', sort: 'status', dir: 'asc' },
  { key: 'name', label: 'Name', sort: 'legal_name', dir: 'asc' },
  { key: 'fleet', label: 'Fleet size', sort: 'power_units', dir: 'desc' },
  { key: 'city', label: 'City', sort: 'phy_city', dir: 'asc' },
  { key: 'recent', label: 'Recent contact', sort: 'last_contact_at', dir: 'desc' },
  { key: 'added', label: 'Recently added', sort: 'added_at', dir: 'desc' },
];

export function sortChoice(key: string | null): SortChoice {
  return SORT_CHOICES.find((choice) => choice.key === key) ?? SORT_CHOICES[0];
}

export const INSURANCE_CHOICES = [
  { key: 'any', label: 'Any insurance', min: null },
  { key: '500000', label: '$500K+', min: 500_000 },
  { key: '1000000', label: '$1MM+', min: 1_000_000 },
] as const;

export function insuranceMin(key: string | null): number | null {
  return INSURANCE_CHOICES.find((choice) => choice.key === key)?.min ?? null;
}

export const CONTACT_CHOICES = [
  { key: 'any', label: 'Any contact' },
  { key: 'phone', label: 'Has phone' },
  { key: 'email', label: 'Has email' },
  { key: 'missing', label: 'Missing both' },
] as const;

/** The two nullable tri-state filters batch_members takes for a contact choice. */
export function contactFilter(key: string | null): { hasPhone: boolean | null; hasEmail: boolean | null } {
  if (key === 'phone') return { hasPhone: true, hasEmail: null };
  if (key === 'email') return { hasPhone: null, hasEmail: true };
  if (key === 'missing') return { hasPhone: false, hasEmail: false };
  return { hasPhone: null, hasEmail: null };
}

interface WashInput { do_not_contact: boolean; warning_reasons: readonly string[] }

/** Round 5 default: the red row wash is for do-not-contact and critical warnings only. */
export function isCriticalRow(row: WashInput): boolean {
  return row.do_not_contact || row.warning_reasons.some((reason) => WARNING_META[reason as WarningCode]?.tone === 'crit');
}

/** Rows that bulk actions may act on: not do-not-contact. */
export function selectableDots(rows: readonly { dot_number: number; do_not_contact: boolean }[]): number[] {
  return rows.filter((row) => !row.do_not_contact).map((row) => row.dot_number);
}

export function toggleDot(selected: ReadonlySet<number>, dot: number): Set<number> {
  const next = new Set(selected);
  if (next.has(dot)) next.delete(dot);
  else next.add(dot);
  return next;
}

/** Select-all for a page: all selected -> clear this page's dots; otherwise add them all. */
export function togglePage(selected: ReadonlySet<number>, pageDots: readonly number[]): Set<number> {
  const next = new Set(selected);
  if (pageDots.length > 0 && pageDots.every((dot) => next.has(dot))) pageDots.forEach((dot) => next.delete(dot));
  else pageDots.forEach((dot) => next.add(dot));
  return next;
}

/** State that belongs to one batch. Read it with scopedValue: a value saved for another batch reads as empty. */
export interface Scoped<T> { batchId: string; value: T }

export function scopedValue<T>(state: Scoped<T>, batchId: string, empty: T): T {
  return state.batchId === batchId ? state.value : empty;
}

export function fmtMiles(miles: number | null | undefined): string {
  return miles === null || miles === undefined ? '—' : `${Math.round(miles).toLocaleString('en-US')} mi`;
}
