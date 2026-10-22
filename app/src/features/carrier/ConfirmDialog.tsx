import { useEffect } from 'react';
import type { ConfirmCopy } from './carrierLogic';

export function ConfirmDialog({ copy, pending, onConfirm, onCancel }: { copy: ConfirmCopy; pending: boolean; onConfirm: () => void; onCancel: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !pending) onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pending, onCancel]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => { if (!pending) onCancel(); }}>
      <div role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-body" className="w-full max-w-md border border-border bg-surface p-5 shadow-xl" onClick={(event) => event.stopPropagation()}>
        <h2 id="confirm-title" className="text-lg font-extrabold">{copy.title}</h2>
        <p id="confirm-body" className="mt-3 text-sm text-text-muted">{copy.body}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" autoFocus disabled={pending} onClick={onCancel} className="border border-border-strong px-3 py-2 text-xs font-bold">Cancel</button>
          <button type="button" disabled={pending} onClick={onConfirm} className={`px-3 py-2 text-xs font-bold ${copy.tone === 'danger' ? 'bg-crit text-white' : 'bg-accent text-accent-ink'}`}>{copy.confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
