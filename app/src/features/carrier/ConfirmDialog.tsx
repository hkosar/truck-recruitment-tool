import { useEffect, useRef } from 'react';
import { canDismiss } from './carrierLogic';
import type { ConfirmCopy } from './carrierLogic';

/**
 * Native modal <dialog>: showModal() gives Tab / Shift+Tab containment and makes the rest of the
 * page inert. Focus goes back to the opener when the dialog unmounts.
 */
export function ConfirmDialog({ copy, pending, onConfirm, onCancel }: { copy: ConfirmCopy; pending: boolean; onConfirm: () => void; onCancel: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby="confirm-title"
      aria-describedby="confirm-body"
      className="m-auto w-full max-w-md border border-border bg-surface p-5 text-text shadow-xl backdrop:bg-black/40"
      onCancel={(event) => { event.preventDefault(); if (canDismiss(pending)) onCancel(); }}
      onClick={(event) => { if (event.target === event.currentTarget && canDismiss(pending)) onCancel(); }}
    >
      <h2 id="confirm-title" className="text-lg font-extrabold">{copy.title}</h2>
      <p id="confirm-body" className="mt-3 text-sm text-text-muted">{copy.body}</p>
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" autoFocus disabled={pending} onClick={onCancel} className="border border-border-strong px-3 py-2 text-xs font-bold">Cancel</button>
        <button type="button" disabled={pending} onClick={onConfirm} className={`px-3 py-2 text-xs font-bold ${copy.tone === 'danger' ? 'bg-crit text-white' : 'bg-accent text-accent-ink'}`}>{copy.confirmLabel}</button>
      </div>
    </dialog>
  );
}
