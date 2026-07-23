import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { usePermissions, useSession } from '../../app/guards';
import { fmtInt, fmtPhone, fmtRel } from '../../lib/format';
import { queryKeys } from '../../lib/queryKeys';
import { batchMembers, batchStatusCounts, refreshBatch } from '../../lib/rpc';
import { supabase } from '../../lib/supabase';
import { WARNING_META } from '../../lib/warnings';
import type { BatchMemberRow, BatchStatusCounts, Status, WarningCode } from '../../types/domain';

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

function StatusControl({ row, batchId }: { row: BatchMemberRow; batchId: string }) {
  const { canEdit } = usePermissions();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: async (status: Status) => {
      const { error } = await supabase.from('batch_carriers').update({ status }).eq('batch_id', batchId).eq('dot_number', row.dot_number);
      if (error) throw error;
    },
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: queryKeys.batch(batchId) }),
  });
  const meta = STATUS_OPTIONS.find((item) => item.value === row.status) ?? STATUS_OPTIONS[0];
  if (!canEdit || row.do_not_contact) return <span className={`rounded-full px-2 py-1 text-[10px] font-bold ${row.do_not_contact ? 'bg-st-dnc-tint text-st-dnc' : meta.tone}`}>{row.do_not_contact ? 'Do not contact' : meta.label}</span>;
  return <select aria-label={`Status for ${row.legal_name}`} value={row.status} disabled={mutation.isPending} onChange={(event) => mutation.mutate(event.target.value as Status)} className={`rounded-full border-0 px-2 py-1 text-[10px] font-bold ${meta.tone}`}>{STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>;
}

export default function BatchPage() {
  const { batchId } = useParams<{ batchId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const { canEdit } = usePermissions();
  const { userId } = useSession();
  const queryClient = useQueryClient();
  const page = Math.max(1, Number(searchParams.get('page') || 1));
  const q = searchParams.get('q') || '';
  const status = searchParams.get('status') as Status | null;
  const warningsOnly = searchParams.get('warnings') === '1';
  const filterKey = searchParams.toString();

  const batchQuery = useQuery({
    queryKey: queryKeys.batch(batchId || ''),
    queryFn: async () => {
      const { data, error } = await supabase.from('batches').select('*, batch_zones(*)').eq('id', batchId as string).single();
      if (error) throw error;
      return data;
    },
    enabled: Boolean(batchId),
  });
  const countsQuery = useQuery({ queryKey: queryKeys.batchCounts(batchId || ''), queryFn: ({ signal }) => batchStatusCounts(batchId as string, signal), enabled: Boolean(batchId), staleTime: 15_000 });
  const membersQuery = useQuery({
    queryKey: queryKeys.batchMembers(batchId || '', filterKey),
    queryFn: ({ signal }) => batchMembers(batchId as string, { page, pageSize: 50, q: q || null, status: status ? [status] : null, warningsOnly, signal }),
    enabled: Boolean(batchId),
  });
  const activityQuery = useQuery({
    queryKey: queryKeys.batchActivity(batchId || ''),
    queryFn: async () => {
      const { data, error } = await supabase.from('batch_activity').select('id, activity_type, comment, payload, created_at, actor_id, profiles(full_name)').eq('batch_id', batchId as string).order('id', { ascending: false }).limit(3);
      if (error) throw error;
      return data ?? [];
    },
    enabled: Boolean(batchId),
  });
  const refreshMutation = useMutation({
    mutationFn: () => refreshBatch(batchId as string),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: queryKeys.batch(batchId as string) }),
  });
  const commentMutation = useMutation({
    mutationFn: async (comment: string) => {
      if (!userId) throw new Error('No signed-in user.');
      const { error } = await supabase.from('batch_activity').insert({ batch_id: batchId as string, actor_id: userId, activity_type: 'comment', comment });
      if (error) throw error;
    },
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: queryKeys.batchActivity(batchId as string) }),
  });

  const updateParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== 'page') next.delete('page');
    setSearchParams(next);
  };

  if (!batchId) return <div>Missing batch ID.</div>;
  if (batchQuery.isPending || countsQuery.isPending || membersQuery.isPending) return <div className="h-72 animate-pulse border border-border bg-surface" />;
  if (batchQuery.isError || countsQuery.isError || membersQuery.isError) return <section className="border border-crit bg-crit-tint p-5"><h1 className="text-xl font-extrabold">Batch unavailable</h1><button type="button" onClick={() => { void batchQuery.refetch(); void countsQuery.refetch(); void membersQuery.refetch(); }} className="mt-3 border border-crit px-4 py-2 text-xs font-bold text-crit">Retry</button></section>;

  const batch = batchQuery.data;
  const counts = countsQuery.data;
  const members = membersQuery.data;
  const totalPages = Math.max(1, Math.ceil(members.total / 50));
  const total = STATUS_OPTIONS.reduce((sum, item) => sum + counts[item.countKey], 0);

  return (
    <div className="mx-auto max-w-[1600px] space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-xl font-extrabold tracking-[-0.02em]">{batch.name}</h1><div className="mt-1 text-xs text-text-muted">{batch.customer || 'No customer'}{batch.job ? ` · ${batch.job}` : ''}</div><div className="mt-2 flex flex-wrap gap-1.5">{batch.batch_zones.map((zone, index) => <span key={zone.id} className="border border-border bg-surface px-2 py-1 text-[10px] font-bold text-text-muted">{String.fromCharCode(65 + index)} · {zone.label}</span>)}</div></div>{canEdit ? <button type="button" disabled={refreshMutation.isPending} onClick={() => refreshMutation.mutate()} className="bg-accent px-4 py-2.5 text-xs font-bold text-accent-ink disabled:opacity-50">{refreshMutation.isPending ? 'Refreshing…' : 'Refresh batch'}</button> : null}</header>

      <section className="grid border border-border bg-surface sm:grid-cols-3 lg:grid-cols-6">{[['Carriers', total], ['With phone', counts.with_phone], ['With email', counts.with_email], ['Interested', counts.interested_count], ['Warnings', counts.warnings_count], ['DNC', counts.dnc_count]].map(([label, value], index) => <div key={String(label)} className={`px-4 py-3 text-center ${index ? 'border-l border-border' : ''}`}><div className="text-[10px] font-extrabold uppercase tracking-[0.08em] text-text-subtle">{label}</div><div className={`mt-1 text-xl font-extrabold tabular-nums ${label === 'Warnings' || label === 'DNC' ? 'text-crit' : ''}`}>{fmtInt(Number(value))}</div></div>)}</section>

      <details className="border border-border bg-surface"><summary className="cursor-pointer bg-th-bg px-4 py-3 text-[11px] font-extrabold uppercase tracking-[0.08em] text-text-muted">Recent activity</summary><div className="divide-y divide-border">{activityQuery.data?.map((activity) => <div key={activity.id} className="px-4 py-2.5 text-xs"><span className="font-bold">{activity.profiles?.full_name || 'System'}</span> · {activity.comment || activity.activity_type.replaceAll('_', ' ')} <span className="text-text-subtle">{fmtRel(activity.created_at)}</span></div>)}{canEdit ? <form className="flex gap-2 p-3" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const comment = String(form.get('comment') || '').trim(); if (comment) { commentMutation.mutate(comment); event.currentTarget.reset(); } }}><input name="comment" required placeholder="Add a comment" className="min-w-0 flex-1 border border-border-strong bg-surface px-3 py-2 text-xs" /><button className="bg-accent px-3 py-2 text-xs font-bold text-accent-ink">Add</button></form> : null}</div></details>

      <div className="flex flex-wrap gap-2"> <button type="button" onClick={() => updateParam('status', null)} className={`border px-3 py-1.5 text-xs font-bold ${!status ? 'border-accent bg-accent-tint text-accent' : 'border-border bg-surface'}`}>All {fmtInt(total)}</button>{STATUS_OPTIONS.map((option) => <button key={option.value} type="button" onClick={() => updateParam('status', option.value)} className={`border px-3 py-1.5 text-xs font-bold ${status === option.value ? 'border-accent bg-accent-tint text-accent' : 'border-border bg-surface'}`}>{option.label} {fmtInt(counts[option.countKey])}</button>)}<button type="button" onClick={() => updateParam('warnings', warningsOnly ? null : '1')} className={`border px-3 py-1.5 text-xs font-bold ${warningsOnly ? 'border-crit bg-crit-tint text-crit' : 'border-border bg-surface'}`}>Warnings {fmtInt(counts.warnings_count)}</button></div>

      <div className="flex flex-wrap items-center gap-2 border border-border bg-surface p-3"><input value={q} onChange={(event) => updateParam('q', event.target.value || null)} placeholder="Search name, USDOT, or city" className="min-w-64 flex-1 border border-border-strong bg-surface px-3 py-2 text-xs" /><span className="text-xs text-text-subtle">{fmtInt(members.total)} results</span><Link to={`/batches/${batchId}/sheet`} target="_blank" rel="noopener noreferrer" className="border border-border-strong px-3 py-2 text-xs font-bold text-accent">Print contact sheet</Link></div>

      <section className="overflow-x-auto border border-border bg-surface"><table className="w-full min-w-[1200px] border-collapse text-[12px]"><thead className="bg-th-bg text-left text-[10px] font-extrabold uppercase tracking-[0.07em] text-text-muted"><tr><th className="px-3 py-2.5">Carrier</th><th className="px-3 py-2.5">Contact</th><th className="px-3 py-2.5">Location</th><th className="px-3 py-2.5 text-right">Trucks</th><th className="px-3 py-2.5">Warnings</th><th className="px-3 py-2.5">Status</th><th className="px-3 py-2.5">Last contact</th></tr></thead><tbody>{members.rows.map((row) => <tr key={row.dot_number} className={`border-t border-border align-top ${row.has_warnings ? 'bg-row-warning' : 'odd:bg-surface even:bg-zebra'} ${row.do_not_contact ? 'opacity-60' : ''}`}><td className="px-3 py-2.5"><Link to={`/carriers/${row.dot_number}?batch=${batchId}`} className="font-bold text-accent">{row.legal_name}</Link><div className="font-mono text-[10px] text-text-subtle">USDOT {row.dot_number}</div></td><td className="px-3 py-2.5"><div>{row.contact_name || '—'}</div><div className="font-mono">{fmtPhone(row.phone)}</div><div className="truncate text-[10px] text-text-subtle">{row.email || '—'}</div></td><td className="px-3 py-2.5">{row.phy_city || '—'}, TX</td><td className="px-3 py-2.5 text-right font-mono tabular-nums">{fmtInt(row.power_units)}</td><td className="px-3 py-2.5"><div className="flex max-w-48 flex-col items-start gap-1">{row.warning_reasons.map((reason) => <span key={reason} className="rounded-full bg-crit-tint px-2 py-0.5 text-[9px] font-bold text-crit">{warningLabel(reason)}</span>)}</div></td><td className="px-3 py-2.5"><StatusControl row={row} batchId={batchId} /></td><td className="px-3 py-2.5"><div className="font-bold">{row.last_contact_channel?.replaceAll('_', ' ') || 'No contact'}</div><div className="text-[10px] text-text-subtle">{fmtRel(row.last_contact_at)}</div></td></tr>)}</tbody></table>{members.rows.length === 0 ? <div className="py-14 text-center text-sm text-text-subtle">No carriers match these filters.</div> : null}</section>

      <footer className="flex items-center justify-between"><button type="button" disabled={page <= 1} onClick={() => updateParam('page', String(page - 1))} className="border border-border-strong px-3 py-2 text-xs font-bold disabled:opacity-40">Previous</button><span className="text-xs text-text-subtle">Page {page} of {totalPages}</span><button type="button" disabled={page >= totalPages} onClick={() => updateParam('page', String(page + 1))} className="border border-border-strong px-3 py-2 text-xs font-bold disabled:opacity-40">Next</button></footer>
    </div>
  );
}
