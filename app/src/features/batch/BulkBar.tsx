import type { Status } from '../../types/domain';

const MORE: { value: Status; label: string }[] = [
  { value: 'new', label: 'New' },
  { value: 'attempted', label: 'Attempted' },
  { value: 'not_a_fit', label: 'Not a fit' },
];

/** Fixed bar shown while carriers are selected. Editors and managers only (the page does not render it for viewers). */
export function BulkBar({ count, busy, disabled, onStatus, onContactOptions, onClear }: {
  count: number;
  busy: boolean;
  /** True while the do-not-contact check has not answered. */
  disabled: boolean;
  onStatus: (status: Status) => void;
  onContactOptions: () => void;
  onClear: () => void;
}) {
  const ghost = 'border border-white/25 px-3 py-1.5 text-xs font-bold disabled:opacity-40';
  return (
    <div role="region" aria-label="Bulk actions" className="fixed bottom-5 left-4 right-4 z-30 mx-auto flex max-w-[1200px] flex-wrap items-center gap-3 bg-text px-4 py-2.5 text-bg shadow-xl">
      <span><b className="font-mono tabular-nums">{count}</b> selected</span>
      <div className="flex-1" />
      <button type="button" disabled={busy || disabled} onClick={() => onStatus('contacted')} className={ghost}>Mark contacted</button>
      <button type="button" disabled={busy || disabled} onClick={() => onStatus('interested')} className={ghost}>Mark interested</button>
      <select aria-label="Set another status" value="" disabled={busy || disabled} onChange={(event) => { if (event.target.value) onStatus(event.target.value as Status); }} className="border border-white/25 bg-text px-2 py-1.5 text-xs font-bold text-bg disabled:opacity-40">
        <option value="">More status…</option>
        {MORE.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      <button type="button" disabled={busy} onClick={onContactOptions} className="bg-accent px-3 py-1.5 text-xs font-bold text-accent-ink disabled:opacity-40">Generate Contact Options</button>
      <button type="button" aria-label="Clear selection" onClick={onClear} className={ghost}>✕</button>
    </div>
  );
}
