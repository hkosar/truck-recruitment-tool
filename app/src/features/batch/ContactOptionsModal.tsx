import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { fmtPhone } from '../../lib/format';
import { generateContactSheet } from '../../lib/rpc';
import { fetchBatchCsv, saveBlob } from './exportCsv';

/** "Generate Contact Options": a preview of who can be contacted from the selection, then print or CSV. */
export function ContactOptionsModal({ batchId, dots, canEdit, onClose, onMessage }: {
  batchId: string;
  dots: number[];
  canEdit: boolean;
  onClose: () => void;
  onMessage: (message: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  // Native modal dialog: showModal makes the page behind inert and handles Tab. Focus goes to Done on open and back to the opener on close.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    return () => {
      if (element?.open) element.close();
      opener?.focus();
    };
  }, []);
  const sorted = [...dots].sort((a, b) => a - b);
  // generate_contact_sheet drops do-not-contact carriers in the database, so this preview is the exportable set.
  const preview = useQuery({ queryKey: ['batch', batchId, 'contact-options', sorted.join(',')], queryFn: () => generateContactSheet(batchId, sorted), staleTime: 0, gcTime: 0 });
  const csv = useMutation({
    mutationFn: () => fetchBatchCsv(batchId, sorted),
    onSuccess: (result) => {
      saveBlob(result.blob, 'contact-options.csv');
      onMessage(`CSV exported: ${result.rows} carrier${result.rows === 1 ? '' : 's'}${result.excluded ? `, ${result.excluded} left out (do not contact)` : ''}.`);
      onClose();
    },
    onError: (error) => onMessage(error instanceof Error ? error.message : 'The CSV could not be exported.'),
  });
  const rows = preview.data ?? [];
  const withPhone = rows.filter((row) => row.phone || row.cell_phone).length;
  const withEmail = rows.filter((row) => row.email).length;
  const withName = rows.filter((row) => row.contact_name).length;
  const left = sorted.length - rows.length;
  const print = () => {
    window.sessionStorage.setItem(`sheet:${batchId}`, JSON.stringify(sorted));
    window.open(`/batches/${batchId}/sheet`, '_blank');
  };

  return (
    <dialog ref={dialog} aria-labelledby="contact-options-title" onCancel={(event) => { event.preventDefault(); onClose(); }} className="m-auto w-full max-w-3xl border border-border bg-surface p-0 text-text shadow-xl backdrop:bg-black/40">
      <div className="flex max-h-[90dvh] w-full flex-col">
        <div className="border-b border-border px-5 py-3 text-sm font-extrabold" id="contact-options-title">Generate Contact Options</div>
        <div className="space-y-3 overflow-y-auto p-5">
          {preview.isPending ? <div className="h-24 animate-pulse bg-th-bg" /> : null}
          {preview.isError ? <div role="alert" className="border border-crit bg-crit-tint px-3 py-2 text-xs font-bold text-crit">Could not prepare the list. <button type="button" onClick={() => void preview.refetch()} className="underline">Retry</button></div> : null}
          {preview.isSuccess ? (
            <>
              <div className="flex flex-wrap gap-2 text-xs font-bold">
                <span className="bg-info-tint px-3 py-1.5 text-info">{rows.length} carriers</span>
                <span className="bg-good-tint px-3 py-1.5 text-good">{withPhone} phone</span>
                <span className="bg-th-bg px-3 py-1.5">{withName} names</span>
                <span className="bg-th-bg px-3 py-1.5">{withEmail} email</span>
                {left > 0 ? <span className="bg-crit-tint px-3 py-1.5 text-crit">{left} left out (do not contact)</span> : null}
              </div>
              {rows.length === 0 ? <div className="py-8 text-center text-sm text-text-subtle">No contactable carriers in this selection.</div> : (
                <div className="max-h-72 overflow-y-auto border border-border">
                  <table className="w-full border-collapse text-[12px]">
                    <thead className="sticky top-0 bg-th-bg text-left text-[10px] font-extrabold uppercase tracking-[0.07em] text-text-muted"><tr><th className="px-3 py-2">Carrier</th><th className="px-3 py-2">Contact name</th><th className="px-3 py-2">Phone</th><th className="px-3 py-2">Email</th><th className="px-3 py-2">Status</th></tr></thead>
                    <tbody>{rows.map((row) => <tr key={row.dot_number} className="border-t border-border"><td className="px-3 py-2 font-bold">{row.legal_name}</td><td className="px-3 py-2">{row.contact_name || '—'}</td><td className="px-3 py-2 font-mono">{fmtPhone(row.phone || row.cell_phone)}</td><td className="px-3 py-2">{row.email || '—'}</td><td className="px-3 py-2">{row.status.replaceAll('_', ' ')}</td></tr>)}</tbody>
                  </table>
                </div>
              )}
              <p className="text-[11px] text-text-subtle">Do-not-contact carriers are left out automatically, on the server. Email and text blasts come in a later phase.</p>
            </>
          ) : null}
        </div>
        <div className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-3">
          <button type="button" onClick={print} disabled={!preview.isSuccess || rows.length === 0} className="border border-border-strong px-3 py-2 text-xs font-bold disabled:opacity-40">Print call sheet</button>
          {canEdit ? <button type="button" onClick={() => csv.mutate()} disabled={!preview.isSuccess || rows.length === 0 || csv.isPending} className="border border-border-strong px-3 py-2 text-xs font-bold disabled:opacity-40">{csv.isPending ? 'Exporting…' : 'Export CSV'}</button> : null}
          <button type="button" autoFocus onClick={onClose} className="bg-accent px-4 py-2 text-xs font-bold text-accent-ink">Done</button>
        </div>
      </div>
    </dialog>
  );
}
