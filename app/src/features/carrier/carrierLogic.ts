import type { CargoFlagName } from '../../types/domain';

export const CARGO_FLAG_LABELS: Record<CargoFlagName, string> = {
  crgo_genfreight: 'General Freight', crgo_household: 'Household Goods', crgo_metalsheet: 'Metal Sheets / Coils', crgo_motoveh: 'Motor Vehicles',
  crgo_drivetow: 'Drive / Tow Away', crgo_logpole: 'Logs / Poles', crgo_bldgmat: 'Building Materials', crgo_mobilehome: 'Mobile Homes',
  crgo_machlrg: 'Large Machinery', crgo_produce: 'Fresh Produce', crgo_liqgas: 'Liquids / Gases', crgo_intermodal: 'Intermodal',
  crgo_passengers: 'Passengers', crgo_oilfield: 'Oilfield Equipment', crgo_livestock: 'Livestock', crgo_grainfeed: 'Grain / Feed',
  crgo_coalcoke: 'Coal / Coke', crgo_meat: 'Meat', crgo_garbage: 'Garbage', crgo_usmail: 'US Mail', crgo_chem: 'Chemicals',
  crgo_drybulk: 'Dry Bulk', crgo_coldfood: 'Refrigerated Food', crgo_beverages: 'Beverages', crgo_paperprod: 'Paper Products',
  crgo_utility: 'Utility', crgo_farmsupp: 'Farm Supplies', crgo_construct: 'Construction', crgo_waterwell: 'Water Well', crgo_cargoothr: 'Other Cargo',
};

/** Labels of every cargo flag set on the carrier, excluding "Other" (shown separately with its text). */
export function cargoFlagLabels(carrier: Partial<Record<CargoFlagName, boolean | null>>): string[] {
  return (Object.keys(CARGO_FLAG_LABELS) as CargoFlagName[])
    .filter((flag) => flag !== 'crgo_cargoothr' && carrier[flag] === true)
    .map((flag) => CARGO_FLAG_LABELS[flag]);
}

export type ConfirmKind = 'dnc-set' | 'dnc-restore' | 'promote';
export interface ConfirmCopy { title: string; body: string; confirmLabel: string; tone: 'danger' | 'primary' }

/** Wording follows the mockup modals (dnc / undnc / promote in mockup/src/screens2.js). */
export function confirmCopy(kind: ConfirmKind, legalName: string, dot: number): ConfirmCopy {
  if (kind === 'dnc-set') {
    return { title: 'Set Do Not Call?', tone: 'danger', confirmLabel: 'Set Do Not Call', body: `This flags ${legalName} as Do Not Call — a global suppression across every batch and all channels (call, text, email, mail).` };
  }
  if (kind === 'dnc-restore') {
    return { title: 'Clear Do Not Call?', tone: 'primary', confirmLabel: 'Clear flag', body: `Re-enable contact for ${legalName} across all batches?` };
  }
  return { title: 'Mark as Promoted?', tone: 'primary', confirmLabel: 'Mark as Promoted', body: `Records that ${legalName} (USDOT ${dot}) asked to register and was promoted into the TNBS tools. Nothing is sent anywhere — this is a tracking flag; you add the USDOT to your other tools yourself.` };
}

export type TimelineFilter = 'all' | 'call' | 'text' | 'email';
export const TIMELINE_FILTERS: { value: TimelineFilter; label: string }[] = [
  { value: 'all', label: 'All' }, { value: 'call', label: 'Call' }, { value: 'text', label: 'Text' }, { value: 'email', label: 'Email' },
];

export function filterTimeline<T extends { channel: string }>(logs: T[], filter: TimelineFilter): T[] {
  return filter === 'all' ? logs : logs.filter((log) => log.channel === filter);
}

/** Per-channel counts for the chips; "all" is the total. */
export function timelineCounts(logs: { channel: string }[]): Record<TimelineFilter, number> {
  const counts: Record<TimelineFilter, number> = { all: logs.length, call: 0, text: 0, email: 0 };
  for (const log of logs) if (log.channel === 'call' || log.channel === 'text' || log.channel === 'email') counts[log.channel] += 1;
  return counts;
}

/** Explicit request for the DNC call, fixed when the dialog opens and never re-derived from cached data. */
export function dncRequest(kind: 'dnc-set' | 'dnc-restore', dot: number): { dot: number; on: boolean; reason: string | null } {
  return kind === 'dnc-set' ? { dot, on: true, reason: 'Set from carrier profile' } : { dot, on: false, reason: null };
}

/** Escape / backdrop click may close the dialog only while no request is in flight. */
export function canDismiss(pending: boolean): boolean {
  return !pending;
}
