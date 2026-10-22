import { isGloballyDnc } from './contactability';
import { apiPost } from './api';

/** Reads the same two sources the database guard checks and returns the DNC subset of `dots`. */
export async function loadGlobalDncDots(dots: number[]): Promise<Set<number>> {
  if (dots.length === 0) return new Set();
  const lookup = await apiPost<{
    carriers: { dot_number: number; do_not_contact: boolean }[];
    suppressions: { dot_number: number; channel: string; value: string | null; expires_at: string | null }[];
  }>('/api/dnc/lookup', { dots });
  const result = new Set<number>();
  for (const carrier of lookup.carriers) {
    const rows = lookup.suppressions.filter((row) => row.dot_number === carrier.dot_number);
    if (isGloballyDnc(carrier, rows)) result.add(carrier.dot_number);
  }
  return result;
}
