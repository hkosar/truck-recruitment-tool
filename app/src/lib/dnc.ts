import { isGloballyDnc } from './contactability';
import { supabase } from './supabase';

/** Reads the same two sources the database guard checks and returns the DNC subset of `dots`. */
export async function loadGlobalDncDots(dots: number[]): Promise<Set<number>> {
  if (dots.length === 0) return new Set();
  const [carriers, suppressions] = await Promise.all([
    supabase.from('carriers').select('dot_number, do_not_contact').in('dot_number', dots),
    supabase.from('contact_suppressions').select('dot_number, channel, value, expires_at').in('dot_number', dots).eq('channel', 'all').is('value', null),
  ]);
  if (carriers.error) throw carriers.error;
  if (suppressions.error) throw suppressions.error;
  const result = new Set<number>();
  for (const carrier of carriers.data ?? []) {
    const rows = (suppressions.data ?? []).filter((row) => row.dot_number === carrier.dot_number);
    if (isGloballyDnc(carrier, rows)) result.add(carrier.dot_number);
  }
  return result;
}
