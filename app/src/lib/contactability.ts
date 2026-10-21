/**
 * Global do-not-contact. Mirrors the database trigger contact_logs_dnc_guard
 * (supabase/migrations/20260723020000_contact_logs_dnc_guard.sql): a carrier is
 * globally DNC when carriers.do_not_contact is true OR an unexpired carrier-wide
 * contact_suppressions row (channel 'all', no value) exists.
 */
export interface SuppressionRow { channel: string; value: string | null; expires_at: string | null }

export function isActiveGlobalSuppression(row: SuppressionRow, now: Date = new Date()): boolean {
  return row.channel === 'all' && row.value === null && (row.expires_at === null || new Date(row.expires_at) > now);
}

export function isGloballyDnc(
  carrier: { do_not_contact: boolean } | null | undefined,
  suppressions: readonly SuppressionRow[] = [],
  now: Date = new Date(),
): boolean {
  return carrier?.do_not_contact === true || suppressions.some((row) => isActiveGlobalSuppression(row, now));
}

export const DNC_BLOCKED_MESSAGE = 'This carrier is on the global do-not-contact list. Outreach cannot be logged.';

export type DncLookupStatus = 'ready' | 'pending' | 'failed';

/** Outreach must stay disabled until the supplementary suppression lookup has answered for this page. */
export function dncLookupStatus(dotCount: number, query: { isError: boolean; hasData: boolean }): DncLookupStatus {
  if (dotCount === 0) return 'ready';
  if (query.isError) return 'failed';
  return query.hasData ? 'ready' : 'pending';
}

/** Cache key that changes whenever the set of carriers on the page changes. */
export function dncQueryKey(batchId: string, dots: readonly number[]) {
  return ['batch', batchId, 'global-dnc', [...dots].sort((a, b) => a - b).join(',')] as const;
}
