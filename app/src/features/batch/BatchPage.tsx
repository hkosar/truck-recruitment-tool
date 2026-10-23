import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { usePermissions, useSession } from '../../app/guards';
import { LogContactPanel } from '../../components/LogContactPanel';
import type { ContactLogInput } from '../../components/LogContactPanel';
import { DNC_BLOCKED_MESSAGE, dncLookupStatus, dncQueryKey, outreachAllowed } from '../../lib/contactability';
import { loadGlobalDncDots } from '../../lib/dnc';
import { fmtInt, fmtMoney, fmtPhone, fmtRel } from '../../lib/format';
import { queryKeys } from '../../lib/queryKeys';
import { batchMembers, batchStatusCounts, bulkSetStatus, refreshBatch } from '../../lib/rpc';
import { apiGet, apiPost } from '../../lib/api';
import { WARNING_META } from '../../lib/warnings';
import type { BatchMemberRow, BatchStatusCounts, Status, WarningCode } from '../../types/domain';
import type { Database, Json } from '../../types/database';
import { BatchActions } from './BatchActions';
import { BulkBar } from './BulkBar';
import { ContactOptionsModal } from './ContactOptionsModal';
import { type Scoped, scopedValue, CONTACT_CHOICES, contactFilter, fmtMiles, INSURANCE_CHOICES, insuranceMin, isCriticalRow, selectableDots, SORT_CHOICES, sortChoice, toggleDot, togglePage } from './listModel';

interface MemberExtra { dot_number: number; bipd_on_file: number | null; bipd_required: number | null; distance_mi: number | null }
const DNC_LOOKUP_CHUNK = 1000;

function InsuranceBadge({ extra, failed, onRetry }: { extra: MemberExtra | undefined; failed: boolean; onRetry: () => void }) {
  if (failed) return <span className="text-[10px] text-crit">Insurance unavailable <button type="button" onClick={onRetry} className="font-bold underline">Retry</button></span>;
  if (!extra) return <span className="text-text-subtle">…</span>;
  const onFile = extra.bipd_on_file ?? 0;
  if (onFile <= 0) return <span className="rounded-full bg-crit-tint px-2 py-0.5 text-[10px] font-bold text-crit">None on file</span>;
  const tone = onFile < 1_000_000 ? 'bg-warn-tint text-warn' : 'bg-good-tint text-good';
  return <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ${tone}`}>{fmtMoney(onFile)}</span>;
}

type BatchRow = Database['public']['Tables']['batches']['Row'] & { batch_zones: Database['public']['Tables']['batch_zones']['Row'][] };
interface ActivityRow {
  id: number;
  activity_type: Database['public']['Enums']['activity_type'];
  comment: string | null;
  payload: Json;
  created_at: string;
  actor_id: string | null;
  profiles: { full_name: string } | null;
}

const STATUS_OPTIONS: { value: Status; label: string; countKey: keyof BatchStatusCounts; tone: string }[] = [
  { value: 'new', label: 'New', countKey: 'new_count', tone: 'bg-st-new-tint text-st-new' },
  { value: 'attempted', label: 'Attempted', countKey: 'attempted_count', tone: 'bg-st-attempted-tint text-st-attempted' },
  { value: 'contacted', label: 'Contacted', countKey: 'contacted_count', tone: 'bg-st-contacted-tint text-st-contacted' },
  { value: 'interested', label: 'Interested', countKey: 'interested_count', tone: 'bg-st-interested-tint text-st-interested' },
  { value: 'not_a_fit', label: 'Not a fit', countKey: 'not_a_fit_count', tone: 'bg-st-notfit-tint text-st-notfit' },
];

function warningLabel(reason: string): string {
  return WARNING_META[reason as WarningCode]?.label ?? reason;
}

function StatusControl({ row, batchId, locked }: { row: BatchMemberRow; batchId: string; locked: boolean }) {
  const { canEdit } = usePermissions();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: async (status: Status) => {
      await apiPost('/api/batch-carriers/status', { batch_id: batchId, dot_number: row.dot_number, status });
    },
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: queryKeys.batch(batchId) }),
  });
  const meta = STATUS_OPTIONS.find((item) => item.value === row.status) ?? STATUS_OPTIONS[0];
  if (!canEdit || row.do_not_contact || locked) return <span className={`rounded-full px-2 py-1 text-[10px] font-bold ${row.do_not_contact ? 'bg-st-dnc-tint text-st-dnc' : meta.tone}`}>{row.do_not_contact ? 'Do not contact' : meta.label}</span>;
  return <select aria-label={`Status for ${row.legal_name}`} value={row.status} disabled={mutation.isPending} onChange={(event) => mutation.mutate(event.target.value as Status)} className={`rounded-full border-0 px-2 py-1 text-[10px] font-bold ${meta.tone}`}>{STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>;
}

/** Keyed by batch id so every piece of page state (selection, dialogs, messages) starts fresh for another batch. */
export default function BatchPage() {
  const { batchId } = useParams<{ batchId: string }>();
  return <BatchPageBody key={batchId} />;
}

function BatchPageBody() {
  const { batchId } = useParams<{ batchId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const { canEdit, isManager } = usePermissions();
  const [, setClock] = useState(0);
  const { userId } = useSession();
  const queryClient = useQueryClient();
  const [loggingCarrier, setLoggingCarrier] = useState<BatchMemberRow | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [selectedState, setSelectedState] = useState<Scoped<ReadonlySet<number>>>({ batchId: '', value: new Set() });
  const [optionsState, setOptionsState] = useState<Scoped<boolean>>({ batchId: '', value: false });
  const selected = scopedValue(selectedState, batchId ?? '', new Set<number>());
  const contactOptionsOpen = scopedValue(optionsState, batchId ?? '', false);
  const setSelected = (value: ReadonlySet<number>) => setSelectedState({ batchId: batchId ?? '', value });
  const setContactOptionsOpen = (value: boolean) => setOptionsState({ batchId: batchId ?? '', value });
  const page = Math.max(1, Number(searchParams.get('page') || 1));
  const q = searchParams.get('q') || '';
  const status = searchParams.get('status') as Status | null;
  const warningsOnly = searchParams.get('warnings') === '1';
  const sortKey = sortChoice(searchParams.get('sort'));
  const insuranceKey = searchParams.get('ins') || 'any';
  const contactKey = searchParams.get('contact') || 'any';
  const { hasPhone, hasEmail } = contactFilter(contactKey);
  const filterKey = searchParams.toString();

  const batchQuery = useQuery({
    queryKey: queryKeys.batch(batchId || ''),
    queryFn: async () => {
      return apiGet<BatchRow>(`/api/batches/${batchId as string}`);
    },
    enabled: Boolean(batchId),
  });
  const countsQuery = useQuery({ queryKey: queryKeys.batchCounts(batchId || ''), queryFn: ({ signal }) => batchStatusCounts(batchId as string, signal), enabled: Boolean(batchId), staleTime: 15_000 });
  const membersQuery = useQuery({
    queryKey: queryKeys.batchMembers(batchId || '', filterKey),
    queryFn: ({ signal }) => batchMembers(batchId as string, { page, pageSize: 50, q: q || null, status: status ? [status] : null, warningsOnly, minInsurance: insuranceMin(insuranceKey), hasPhone, hasEmail, sort: sortKey.sort, dir: sortKey.dir, signal }),
    enabled: Boolean(batchId),
  });
  const pageDots = membersQuery.data?.rows.map((row) => row.dot_number) ?? [];
  const extrasQuery = useQuery({ queryKey: [...queryKeys.batch(batchId || ''), 'list-extras', [...pageDots].sort((a, b) => a - b).join(',')], queryFn: ({ signal }) => apiGet<MemberExtra[]>(`/api/batches/${batchId as string}/list-extras?dots=${pageDots.join(',')}`, signal), enabled: Boolean(batchId) && pageDots.length > 0, staleTime: 60_000 });
  const extras = new Map((extrasQuery.data ?? []).map((extra) => [extra.dot_number, extra]));
  const dncQuery = useQuery({ queryKey: dncQueryKey(batchId || '', pageDots), queryFn: () => loadGlobalDncDots(pageDots), enabled: Boolean(batchId) && pageDots.length > 0 });
  const dncStatus = dncLookupStatus(pageDots.length, { isError: dncQuery.isError, hasData: dncQuery.data !== undefined });
  const outreachLocked = !outreachAllowed(dncStatus);
  const activityQuery = useQuery({
    queryKey: queryKeys.batchActivity(batchId || ''),
    queryFn: async () => {
      return apiGet<ActivityRow[]>(`/api/batches/${batchId as string}/activity?limit=3`);
    },
    enabled: Boolean(batchId),
  });
  const refreshMutation = useMutation({
    mutationFn: () => refreshBatch(batchId as string),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: queryKeys.batch(batchId as string) }),
  });
  const bulkMutation = useMutation({
    mutationFn: async ({ target, dots }: { target: Status; dots: number[] }) => {
      // Re-check do-not-contact at the moment of the change; the database function itself does not.
      const dnc = new Set<number>();
      for (let i = 0; i < dots.length; i += DNC_LOOKUP_CHUNK) (await loadGlobalDncDots(dots.slice(i, i + DNC_LOOKUP_CHUNK))).forEach((dot) => dnc.add(dot));
      const allowed = dots.filter((dot) => !dnc.has(dot));
      if (allowed.length === 0) throw new Error('Every selected carrier is on the do-not-contact list, so nothing was changed.');
      const result = await bulkSetStatus(batchId as string, allowed, target);
      return { changed: result.changed, skipped: dots.length - allowed.length + result.skipped.length, target };
    },
    onSuccess: async ({ changed, skipped, target }) => {
      const label = STATUS_OPTIONS.find((item) => item.value === target)?.label ?? target;
      setMessage(`${changed} carrier${changed === 1 ? '' : 's'} set to ${label}.${skipped ? ` ${skipped} skipped (do not contact).` : ''}`);
      setSelected(new Set());
      await queryClient.invalidateQueries({ queryKey: queryKeys.batch(batchId as string) });
    },
    onError: async (error) => {
      setMessage(error instanceof Error ? error.message : 'The status change failed.');
      await queryClient.invalidateQueries({ queryKey: queryKeys.batch(batchId as string) });
    },
  });
  const commentMutation = useMutation({
    mutationFn: async (comment: string) => {
      if (!userId) throw new Error('No signed-in user.');
      await apiPost(`/api/batches/${batchId as string}/comments`, { comment });
    },
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: queryKeys.batchActivity(batchId as string) }),
  });
  const contactMutation = useMutation({
    mutationFn: async (input: ContactLogInput) => {
      if (!userId || !loggingCarrier) throw new Error('Choose a carrier while signed in.');
      if (outreachLocked) throw new Error('The do-not-contact check is not complete. Outreach is disabled until it succeeds.');
      // Re-check at submission: the panel may have been open while DNC was set elsewhere.
      if ((await loadGlobalDncDots([loggingCarrier.dot_number])).has(loggingCarrier.dot_number)) throw new Error(DNC_BLOCKED_MESSAGE);
      await apiPost('/api/contact-logs', {
        dot_number: loggingCarrier.dot_number,
        batch_id: batchId as string,
        channel: input.channel,
        disposition: input.disposition,
        notes: input.notes || null,
        next_steps: input.nextSteps || null,
      });
    },
    onSuccess: async () => {
      setMessage(`Outreach logged for ${loggingCarrier?.legal_name ?? 'carrier'}.`);
      setLoggingCarrier(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.batch(batchId as string) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.batchActivity(batchId as string) }),
      ]);
    },
    onError: async (error) => {
      setMessage(error instanceof Error ? error.message : 'Outreach could not be logged.');
      if (error instanceof Error && error.message === DNC_BLOCKED_MESSAGE) setLoggingCarrier(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.batch(batchId as string) });
    },
  });

  // No realtime: show how old the list is and let anyone reload it. Re-render every 30 s so the age stays honest.
  useEffect(() => {
    const timer = window.setInterval(() => setClock((tick) => tick + 1), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const reload = () => { void queryClient.invalidateQueries({ queryKey: queryKeys.batch(batchId as string) }); };

  const updateParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== 'page') {
      next.delete('page');
      setSelected(new Set());
    }
    setSearchParams(next);
  };

  if (!batchId) return <div>Missing batch ID.</div>;
  if (batchQuery.isPending || countsQuery.isPending || membersQuery.isPending) return <div className="h-72 animate-pulse border border-border bg-surface" />;
  if (batchQuery.isError || countsQuery.isError || membersQuery.isError) return <section className="border border-crit bg-crit-tint p-5"><h1 className="text-xl font-extrabold">Batch unavailable</h1><button type="button" onClick={() => { void batchQuery.refetch(); void countsQuery.refetch(); void membersQuery.refetch(); }} className="mt-3 border border-crit px-4 py-2 text-xs font-bold text-crit">Retry</button></section>;

  const batch = batchQuery.data;
  const counts = countsQuery.data;
  const members = membersQuery.data;
  const dncDots = dncQuery.data ?? new Set<number>();
  const rows = members.rows.map((row) => (row.do_not_contact || !dncDots.has(row.dot_number) ? row : { ...row, do_not_contact: true }));
  const pageSelectable = selectableDots(rows);
  const allPageSelected = pageSelectable.length > 0 && pageSelectable.every((dot) => selected.has(dot));
  const totalPages = Math.max(1, Math.ceil(members.total / 50));
  const total = STATUS_OPTIONS.reduce((sum, item) => sum + counts[item.countKey], 0);

  return (
    <div className="mx-auto max-w-[1600px] space-y-4">
      {dncStatus === 'failed' ? <div role="alert" className="border border-crit bg-crit-tint px-4 py-3 text-sm font-bold text-crit">Could not check the do-not-contact list, so outreach and status changes are disabled. <button type="button" onClick={() => void dncQuery.refetch()} className="underline">Retry</button></div> : null}
      {dncStatus === 'pending' ? <div className="border border-info bg-info-tint px-4 py-3 text-xs text-info">Checking the do-not-contact list…</div> : null}
      {message ? <div className="border border-info bg-info-tint px-4 py-3 text-sm text-info">{message}</div> : null}
      {loggingCarrier && !outreachLocked && !rows.some((row) => row.dot_number === loggingCarrier.dot_number && row.do_not_contact) ? <LogContactPanel carrierName={loggingCarrier.legal_name} submitting={contactMutation.isPending} onCancel={() => setLoggingCarrier(null)} onSubmit={(input) => contactMutation.mutate(input)} /> : null}
      <header className="flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-xl font-extrabold tracking-[-0.02em]">{batch.name}</h1><div className="mt-1 text-xs text-text-muted">{batch.customer || 'No customer'}{batch.job ? ` · ${batch.job}` : ''}</div><div className="mt-2 flex flex-wrap gap-1.5">{batch.batch_zones.map((zone, index) => <span key={zone.id} className="border border-border bg-surface px-2 py-1 text-[10px] font-bold text-text-muted">{String.fromCharCode(65 + index)} · {zone.label}</span>)}</div></div><div className="flex items-center gap-2"><span className="text-[11px] text-text-subtle" aria-live="polite">Updated {membersQuery.dataUpdatedAt ? fmtRel(new Date(membersQuery.dataUpdatedAt).toISOString()) : 'just now'}</span><button type="button" disabled={membersQuery.isFetching} onClick={reload} className="border border-border-strong px-4 py-2.5 text-xs font-bold disabled:opacity-50">{membersQuery.isFetching ? 'Refreshing…' : 'Refresh'}</button>{canEdit ? <button type="button" disabled={refreshMutation.isPending} onClick={() => refreshMutation.mutate()} className="bg-accent px-4 py-2.5 text-xs font-bold text-accent-ink disabled:opacity-50">{refreshMutation.isPending ? 'Updating carriers…' : 'Refresh batch'}</button> : null}<BatchActions batchId={batchId} batchName={batch.name} canRename={canEdit} canDelete={isManager} /></div></header>

      <section className="grid border border-border bg-surface sm:grid-cols-3 lg:grid-cols-6">{[['Carriers', total], ['With phone', counts.with_phone], ['With email', counts.with_email], ['Interested', counts.interested_count], ['Warnings', counts.warnings_count], ['DNC', counts.dnc_count]].map(([label, value], index) => <div key={String(label)} className={`px-4 py-3 text-center ${index ? 'border-l border-border' : ''}`}><div className="text-[10px] font-extrabold uppercase tracking-[0.08em] text-text-subtle">{label}</div><div className={`mt-1 text-xl font-extrabold tabular-nums ${label === 'Warnings' || label === 'DNC' ? 'text-crit' : ''}`}>{fmtInt(Number(value))}</div></div>)}</section>

      <details className="border border-border bg-surface"><summary className="cursor-pointer bg-th-bg px-4 py-3 text-[11px] font-extrabold uppercase tracking-[0.08em] text-text-muted">Recent activity</summary><div className="divide-y divide-border">{activityQuery.data?.map((activity) => <div key={activity.id} className="px-4 py-2.5 text-xs"><span className="font-bold">{activity.profiles?.full_name || 'System'}</span> · {activity.comment || activity.activity_type.replaceAll('_', ' ')} <span className="text-text-subtle">{fmtRel(activity.created_at)}</span></div>)}{canEdit ? <form className="flex gap-2 p-3" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const comment = String(form.get('comment') || '').trim(); if (comment) { commentMutation.mutate(comment); event.currentTarget.reset(); } }}><input name="comment" required placeholder="Add a comment" className="min-w-0 flex-1 border border-border-strong bg-surface px-3 py-2 text-xs" /><button className="bg-accent px-3 py-2 text-xs font-bold text-accent-ink">Add</button></form> : null}</div></details>

      <div className="flex flex-wrap gap-2"> <button type="button" onClick={() => updateParam('status', null)} className={`border px-3 py-1.5 text-xs font-bold ${!status ? 'border-accent bg-accent-tint text-accent' : 'border-border bg-surface'}`}>All {fmtInt(total)}</button>{STATUS_OPTIONS.map((option) => <button key={option.value} type="button" onClick={() => updateParam('status', option.value)} className={`border px-3 py-1.5 text-xs font-bold ${status === option.value ? 'border-accent bg-accent-tint text-accent' : 'border-border bg-surface'}`}>{option.label} {fmtInt(counts[option.countKey])}</button>)}<button type="button" onClick={() => updateParam('warnings', warningsOnly ? null : '1')} className={`border px-3 py-1.5 text-xs font-bold ${warningsOnly ? 'border-crit bg-crit-tint text-crit' : 'border-border bg-surface'}`}>Warnings {fmtInt(counts.warnings_count)}</button></div>

      <div className="flex flex-wrap items-center gap-2 border border-border bg-surface p-3"><input value={q} onChange={(event) => updateParam('q', event.target.value || null)} placeholder="Search name, USDOT, or city" className="min-w-64 flex-1 border border-border-strong bg-surface px-3 py-2 text-xs" /><select aria-label="Insurance filter" value={insuranceKey} onChange={(event) => updateParam('ins', event.target.value === 'any' ? null : event.target.value)} className="border border-border-strong bg-surface px-2 py-2 text-xs">{INSURANCE_CHOICES.map((choice) => <option key={choice.key} value={choice.key}>{choice.label}</option>)}</select><select aria-label="Contact filter" value={contactKey} onChange={(event) => updateParam('contact', event.target.value === 'any' ? null : event.target.value)} className="border border-border-strong bg-surface px-2 py-2 text-xs">{CONTACT_CHOICES.map((choice) => <option key={choice.key} value={choice.key}>{choice.label}</option>)}</select><select aria-label="Sort" value={sortKey.key} onChange={(event) => updateParam('sort', event.target.value === SORT_CHOICES[0].key ? null : event.target.value)} className="border border-border-strong bg-surface px-2 py-2 text-xs">{SORT_CHOICES.map((choice) => <option key={choice.key} value={choice.key}>Sort: {choice.label}</option>)}</select><span className="text-xs text-text-subtle">{fmtInt(members.total)} results</span><Link to={`/batches/${batchId}/sheet`} target="_blank" rel="noopener noreferrer" className="border border-border-strong px-3 py-2 text-xs font-bold text-accent">Print contact sheet</Link></div>

      <section className="overflow-x-auto border border-border bg-surface"><table className="w-full min-w-[1300px] border-collapse text-[12px]"><thead className="bg-th-bg text-left text-[10px] font-extrabold uppercase tracking-[0.07em] text-text-muted"><tr>{canEdit ? <th className="w-8 px-3 py-2.5"><input type="checkbox" aria-label="Select all carriers on this page" disabled={pageSelectable.length === 0 || outreachLocked} checked={allPageSelected} onChange={() => setSelected(togglePage(selected, pageSelectable))} /></th> : null}<th className="px-3 py-2.5">Carrier</th><th className="px-3 py-2.5">Contact</th><th className="px-3 py-2.5">Location</th><th className="px-3 py-2.5 text-right">Trucks</th><th className="px-3 py-2.5">Insurance</th><th className="px-3 py-2.5">Warnings</th><th className="px-3 py-2.5">Status</th><th className="px-3 py-2.5">Last contact</th><th className="px-3 py-2.5">Action</th></tr></thead><tbody>{rows.map((row) => <tr key={row.dot_number} className={`border-t border-border align-top ${isCriticalRow(row) ? 'bg-row-warning' : 'odd:bg-surface even:bg-zebra'} ${row.do_not_contact ? 'opacity-60' : ''}`}>{canEdit ? <td className="px-3 py-2.5">{row.do_not_contact ? null : <input type="checkbox" aria-label={`Select ${row.legal_name}`} disabled={outreachLocked} checked={selected.has(row.dot_number)} onChange={() => setSelected(toggleDot(selected, row.dot_number))} />}</td> : null}<td className="px-3 py-2.5"><Link to={`/carriers/${row.dot_number}?batch=${batchId}`} className="font-bold text-accent">{row.legal_name}</Link><div className="font-mono text-[10px] text-text-subtle">USDOT {row.dot_number}</div></td><td className="px-3 py-2.5"><div>{row.contact_name || '—'}</div><div className="font-mono">{fmtPhone(row.phone)}</div><div className="truncate text-[10px] text-text-subtle">{row.email || '—'}</div></td><td className="px-3 py-2.5"><div>{row.phy_city || '—'}, TX</div><div className="font-mono text-[10px] text-text-subtle">{extrasQuery.isError ? '—' : extrasQuery.isPending && pageDots.length > 0 ? '…' : fmtMiles(extras.get(row.dot_number)?.distance_mi)}</div></td><td className="px-3 py-2.5 text-right font-mono tabular-nums">{fmtInt(row.power_units)}</td><td className="px-3 py-2.5"><InsuranceBadge extra={extras.get(row.dot_number)} failed={extrasQuery.isError} onRetry={() => void extrasQuery.refetch()} /></td><td className="px-3 py-2.5"><div className="flex max-w-48 flex-col items-start gap-1">{row.warning_reasons.map((reason) => <span key={reason} className={`rounded-full px-2 py-0.5 text-[9px] font-bold ${WARNING_META[reason as WarningCode]?.tone === 'warn' ? 'bg-warn-tint text-warn' : 'bg-crit-tint text-crit'}`}>{warningLabel(reason)}</span>)}</div></td><td className="px-3 py-2.5"><StatusControl row={row} batchId={batchId} locked={outreachLocked} /></td><td className="px-3 py-2.5"><div className="font-bold">{row.last_contact_channel?.replaceAll('_', ' ') || 'No contact'}</div><div className="text-[10px] text-text-subtle">{fmtRel(row.last_contact_at)}</div></td><td className="px-3 py-2.5">{canEdit && !row.do_not_contact && !outreachLocked ? <button type="button" onClick={() => { setMessage(null); setLoggingCarrier(row); }} className="border border-border-strong px-2 py-1.5 text-[10px] font-bold text-accent hover:bg-accent-tint">Log outreach</button> : <span className="text-[10px] text-text-subtle">—</span>}</td></tr>)}</tbody></table>{members.rows.length === 0 ? <div className="py-14 text-center text-sm text-text-subtle">No carriers match these filters.</div> : null}</section>

      {canEdit && selected.size > 0 ? <BulkBar count={selected.size} busy={bulkMutation.isPending} disabled={outreachLocked} onStatus={(target) => { setMessage(null); bulkMutation.mutate({ target, dots: [...selected] }); }} onContactOptions={() => setContactOptionsOpen(true)} onClear={() => setSelected(new Set())} /> : null}
      {contactOptionsOpen && selected.size > 0 ? <ContactOptionsModal batchId={batchId} dots={[...selected]} canEdit={canEdit} onClose={() => setContactOptionsOpen(false)} onMessage={(text) => { setMessage(text); void queryClient.invalidateQueries({ queryKey: queryKeys.batchActivity(batchId) }); }} /> : null}

      <footer className="flex items-center justify-between pb-16"><button type="button" disabled={page <= 1} onClick={() => updateParam('page', String(page - 1))} className="border border-border-strong px-3 py-2 text-xs font-bold disabled:opacity-40">Previous</button><span className="text-xs text-text-subtle">Page {page} of {totalPages}</span><button type="button" disabled={page >= totalPages} onClick={() => updateParam('page', String(page + 1))} className="border border-border-strong px-3 py-2 text-xs font-bold disabled:opacity-40">Next</button></footer>
    </div>
  );
}
