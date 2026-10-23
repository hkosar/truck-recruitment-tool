import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiPost } from '../../lib/api';
import { queryKeys } from '../../lib/queryKeys';

/** The operation is captured when the dialog opens, so nothing that re-renders behind it can change what is confirmed. */
export interface BatchOperation { kind: 'rename' | 'delete'; batchId: string; batchName: string }

/** The "⋯" menu on the batch header: Rename (editors, managers) and Delete (managers only). */
export function BatchActions({ batchId, batchName, canRename, canDelete }: { batchId: string; batchName: string; canRename: boolean; canDelete: boolean }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [operation, setOperation] = useState<BatchOperation | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  if (!canRename && !canDelete) return null;
  const start = (kind: BatchOperation['kind']) => {
    setMenuOpen(false);
    setOperation({ kind, batchId, batchName });
  };
  return (
    <div className="relative">
      <button ref={trigger} type="button" aria-label="Batch actions" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)} className="border border-border-strong px-3 py-2.5 text-xs font-bold">⋯</button>
      {menuOpen ? (
        <div role="menu" className="absolute right-0 z-20 mt-1 w-44 border border-border bg-surface py-1 text-xs shadow-lg">
          {canRename ? <button type="button" role="menuitem" onClick={() => start('rename')} className="block w-full px-3 py-2 text-left font-bold hover:bg-accent-tint">Rename batch…</button> : null}
          {canDelete ? <button type="button" role="menuitem" onClick={() => start('delete')} className="block w-full px-3 py-2 text-left font-bold text-crit hover:bg-crit-tint">Delete batch…</button> : null}
        </div>
      ) : null}
      {operation ? <OperationDialog operation={operation} returnFocusTo={trigger} onClose={() => setOperation(null)} /> : null}
    </div>
  );
}

function OperationDialog({ operation, returnFocusTo, onClose }: { operation: BatchOperation; returnFocusTo: RefObject<HTMLButtonElement | null>; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState(operation.batchName);
  const [error, setError] = useState<string | null>(null);
  const isDelete = operation.kind === 'delete';

  // Native modal: showModal() makes the page behind inert, so focus can only go back to the "⋯"
  // trigger AFTER the dialog has closed (as in the carrier ConfirmDialog): close first, then focus.
  useEffect(() => {
    const element = dialog.current;
    const trigger = returnFocusTo.current;
    if (element && !element.open) element.showModal();
    return () => {
      if (element?.open) element.close();
      if (trigger?.isConnected) trigger.focus();
    };
  }, [returnFocusTo]);

  const mutation = useMutation({
    mutationFn: async () => {
      if (isDelete) await apiPost(`/api/batches/${operation.batchId}/delete`, {});
      else await apiPost(`/api/batches/${operation.batchId}/rename`, { name: name.trim() });
    },
    onSuccess: async () => {
      if (isDelete) {
        queryClient.removeQueries({ queryKey: queryKeys.batch(operation.batchId) });
        await queryClient.invalidateQueries({ queryKey: queryKeys.dashboard() });
        navigate('/dashboard');
        return;
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.batch(operation.batchId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboard() }),
      ]);
      onClose();
    },
    onError: (failure) => setError(failure instanceof Error ? failure.message : 'That did not work.'),
  });

  const unchanged = !isDelete && (name.trim() === '' || name.trim() === operation.batchName);
  return (
    <dialog ref={dialog} aria-labelledby="batch-op-title" onCancel={(event) => { event.preventDefault(); if (!mutation.isPending) onClose(); }} onClose={() => { if (!mutation.isPending && !mutation.isSuccess) onClose(); }} className="m-auto w-full max-w-md border border-border bg-surface p-0 text-text backdrop:bg-black/40">
      <form method="dialog" onSubmit={(event) => { event.preventDefault(); if (!unchanged) { setError(null); mutation.mutate(); } }}>
        <div id="batch-op-title" className="border-b border-border px-5 py-3 text-sm font-extrabold">{isDelete ? 'Delete this batch?' : 'Rename batch'}</div>
        <div className="space-y-3 px-5 py-4 text-sm">
          {isDelete ? (
            <p>This permanently deletes <b>{operation.batchName}</b>, its list of carriers and its activity feed. Contact history on the carriers is kept. This cannot be undone.</p>
          ) : (
            <label className="block text-xs font-bold">New name<input autoFocus value={name} maxLength={200} onChange={(event) => setName(event.target.value)} className="mt-1 w-full border border-border-strong bg-surface px-3 py-2 text-sm font-normal" /></label>
          )}
          {error ? <div role="alert" className="border border-crit bg-crit-tint px-3 py-2 text-xs font-bold text-crit">{error}</div> : null}
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <button type="button" autoFocus={isDelete} disabled={mutation.isPending} onClick={onClose} className="border border-border-strong px-3 py-2 text-xs font-bold disabled:opacity-40">Cancel</button>
          <button type="submit" disabled={mutation.isPending || unchanged} className={`px-4 py-2 text-xs font-bold disabled:opacity-40 ${isDelete ? 'bg-crit text-white' : 'bg-accent text-accent-ink'}`}>{mutation.isPending ? 'Working…' : isDelete ? 'Delete batch' : 'Save name'}</button>
        </div>
      </form>
    </dialog>
  );
}
