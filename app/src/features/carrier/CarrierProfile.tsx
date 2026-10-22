import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { usePermissions, useSession } from '../../app/guards';
import { DNC_BLOCKED_MESSAGE, isGloballyDnc } from '../../lib/contactability';
import { loadGlobalDncDots } from '../../lib/dnc';
import { fmtInt, fmtMoney, fmtPhone, fmtRel } from '../../lib/format';
import { queryKeys } from '../../lib/queryKeys';
import { safetyVerdict } from '../../lib/safety';
import { setDoNotContact } from '../../lib/rpc';
import { apiGet, apiPost } from '../../lib/api';
import type { Database } from '../../types/database';
import { WARNING_META } from '../../lib/warnings';
import { DISPOSITIONS_BY_CHANNEL } from '../../types/domain';
import type { Channel, ContactDisposition, WarningCode } from '../../types/domain';
import { cargoFlagLabels, confirmCopy, filterTimeline, TIMELINE_FILTERS, timelineCounts } from './carrierLogic';
import type { ConfirmKind, TimelineFilter } from './carrierLogic';
import { ConfirmDialog } from './ConfirmDialog';

type Tables = Database['public']['Tables'];
interface CarrierProfilePayload {
  carrier: Tables['carriers']['Row'];
  insurance: Tables['carrier_insurance']['Row'] | null;
  safety: Tables['carrier_safety']['Row'] | null;
  inspections: Tables['carrier_inspections']['Row'][];
  warning: Database['public']['Views']['carrier_warnings']['Row'] | null;
  logs: (Tables['contact_logs']['Row'] & { profiles: { full_name: string } | null; batches: { name: string } | null })[];
  memberships: (Tables['batch_carriers']['Row'] & { batches: { name: string; customer: string | null; job: string | null } | null })[];
  suppressions: Pick<Tables['contact_suppressions']['Row'], 'channel' | 'value' | 'expires_at'>[];
}

async function loadCarrier(dot: number) {
  const p = await apiGet<CarrierProfilePayload>(`/api/carriers/${dot}/profile`);
  return {
    carrier: p.carrier,
    insurance: p.insurance,
    safety: p.safety,
    inspections: p.inspections ?? [],
    warningReasons: p.warning?.warning_reasons ?? [],
    logs: p.logs ?? [],
    memberships: p.memberships ?? [],
    suppressions: p.suppressions ?? [],
  };
}

function Tile({ label, verdict, children }: { label: string; verdict: 'good' | 'warn' | 'bad'; children: React.ReactNode }) {
  const tone = verdict === 'good' ? 'border-good bg-good-tint text-good' : verdict === 'warn' ? 'border-warn bg-warn-tint text-warn' : 'border-crit bg-crit-tint text-crit';
  return <section className={`border-t-4 bg-surface p-4 ${tone.split(' ')[0]}`}><div className={`inline-block rounded-full px-2 py-1 text-[10px] font-extrabold uppercase tracking-[0.08em] ${tone.split(' ').slice(1).join(' ')}`}>{verdict === 'good' ? 'Verified' : verdict === 'warn' ? 'Review' : 'Attention'}</div><h2 className="mt-3 text-[11px] font-extrabold uppercase tracking-[0.08em] text-text-muted">{label}</h2><div className="mt-2 text-sm text-text">{children}</div></section>;
}

export default function CarrierProfile() {
  const { dot: rawDot } = useParams<{ dot: string }>();
  const [searchParams] = useSearchParams();
  const batchId = searchParams.get('batch');
  const dot = Number(rawDot);
  const { canEdit } = usePermissions();
  const { userId } = useSession();
  const queryClient = useQueryClient();
  const [channel, setChannel] = useState<Extract<Channel, 'call' | 'text' | 'email'>>('call');
  const [message, setMessage] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmKind | null>(null);
  const [timelineFilter, setTimelineFilter] = useState<TimelineFilter>('all');

  const query = useQuery({ queryKey: queryKeys.carrier(dot), queryFn: () => loadCarrier(dot), enabled: Number.isSafeInteger(dot) && dot > 0 });
  const dncMutation = useMutation({
    mutationFn: async () => { const on = isGloballyDnc(query.data?.carrier, query.data?.suppressions); return setDoNotContact(dot, !on, on ? null : 'Set from carrier profile'); },
    onSuccess: async () => { setMessage('Contact preference updated.'); await queryClient.invalidateQueries({ queryKey: queryKeys.carrier(dot) }); },
    onError: (error) => setMessage(error instanceof Error ? error.message : 'DNC update failed.'),
  });
  const promoteMutation = useMutation({
    mutationFn: async () => {
      if (!batchId) throw new Error('Open this carrier from a batch to mark it promoted.');
      await apiPost('/api/batch-carriers/promote', { batch_id: batchId, dot_number: dot });
    },
    onSuccess: async () => { setMessage('Carrier marked as promoted.'); await queryClient.invalidateQueries({ queryKey: queryKeys.carrier(dot) }); },
    onError: (error) => setMessage(error instanceof Error ? error.message : 'Promotion failed.'),
  });
  const logMutation = useMutation({
    mutationFn: async ({ disposition, notes, nextSteps }: { disposition: ContactDisposition; notes: string; nextSteps: string }) => {
      if (!userId) throw new Error('No signed-in user.');
      // Re-check at submission: DNC may have been set after this page loaded.
      if ((await loadGlobalDncDots([dot])).has(dot)) throw new Error(DNC_BLOCKED_MESSAGE);
      await apiPost('/api/contact-logs', { dot_number: dot, batch_id: batchId, channel, disposition, notes: notes || null, next_steps: nextSteps || null });
    },
    onSuccess: async () => { setMessage(`${channel} logged.`); await queryClient.invalidateQueries({ queryKey: queryKeys.carrier(dot) }); },
    onError: async (error) => { setMessage(error instanceof Error ? error.message : 'Contact log failed.'); await queryClient.invalidateQueries({ queryKey: queryKeys.carrier(dot) }); },
  });

  if (!Number.isSafeInteger(dot) || dot <= 0) return <div>Invalid USDOT number.</div>;
  if (query.isPending) return <div className="h-96 animate-pulse border border-border bg-surface" />;
  if (query.isError) return <section className="border border-crit bg-crit-tint p-5"><h1 className="text-xl font-extrabold">Carrier unavailable</h1><button type="button" onClick={() => void query.refetch()} className="mt-3 border border-crit px-4 py-2 text-xs font-bold text-crit">Retry</button></section>;

  const { carrier, insurance, safety, inspections, warningReasons, logs, memberships, suppressions } = query.data;
  const contactName = carrier.contact_name_override || carrier.contact_name || carrier.company_officer_1 || carrier.company_officer_2;
  const phone = carrier.contact_phone_override || carrier.phone || carrier.cell_phone;
  const email = carrier.contact_email_override || carrier.email_address;
  const currentMembership = memberships.find((membership) => membership.batch_id === batchId);
  const encodedName = encodeURIComponent(`"${carrier.legal_name}" ${carrier.phy_city || ''} TX trucking`);
  const insuranceVerdict = !insurance?.bipd_on_file ? 'bad' : insurance.bipd_on_file >= 1_000_000 ? 'good' : 'warn';
  const dnc = isGloballyDnc(carrier, suppressions);
  const safetyTone = safetyVerdict(safety);
  const counts = timelineCounts(logs);
  const shownLogs = filterTimeline(logs, timelineFilter);
  const cargoFlags = cargoFlagLabels(carrier);
  const detailRows: [string, React.ReactNode][] = [
    ['Legal name', carrier.legal_name],
    ['DBA', carrier.dba_name || '—'],
    ['Cargo (Other)', carrier.crgo_cargoothr_desc ? <span className="rounded-full bg-info-tint px-2 py-1 text-[11px] font-bold text-info">“{carrier.crgo_cargoothr_desc}”</span> : '—'],
    ['Cargo flags', cargoFlags.length ? <span className="flex flex-wrap gap-1">{cargoFlags.map((label) => <span key={label} className="rounded-full border border-border px-2 py-0.5 text-[11px]">{label}</span>)}</span> : '—'],
    ['Operation', carrier.carrier_operation || '—'],
    ['Classification', carrier.classdef || '—'],
    ['Power units', <span className="font-mono">{fmtInt(carrier.power_units)}</span>],
    ['Drivers', <span className="font-mono">{fmtInt(carrier.total_drivers)}</span>],
    ['Address', [carrier.phy_street, carrier.phy_city, carrier.phy_state, carrier.phy_zip].filter(Boolean).join(', ') || '—'],
  ];

  return (
    <div className="mx-auto max-w-[1500px] space-y-4">
      {message ? <div className="border border-info bg-info-tint px-4 py-3 text-sm text-info">{message}</div> : null}
      {confirm ? <ConfirmDialog copy={confirmCopy(confirm, carrier.legal_name, dot)} pending={confirm === 'promote' ? promoteMutation.isPending : dncMutation.isPending} onCancel={() => setConfirm(null)} onConfirm={() => { const mutation = confirm === 'promote' ? promoteMutation : dncMutation; mutation.mutate(undefined, { onSettled: () => setConfirm(null) }); }} /> : null}
      <header className={`border border-border bg-surface p-5 ${warningReasons.length ? 'bg-row-warning' : ''}`}><div className="flex flex-wrap items-start justify-between gap-5"><div><div className="flex flex-wrap items-center gap-2"><h1 className="text-2xl font-extrabold tracking-[-0.02em]">{carrier.legal_name}</h1>{carrier.status_code === 'A' ? <span className="rounded-full bg-good-tint px-2 py-1 text-[10px] font-bold text-good">Active</span> : <span className="rounded-full bg-crit-tint px-2 py-1 text-[10px] font-bold text-crit">Inactive</span>}{dnc ? <span className="rounded-full bg-st-dnc-tint px-2 py-1 text-[10px] font-bold text-st-dnc">Do not contact</span> : null}</div>{carrier.dba_name ? <div className="mt-1 text-sm font-semibold text-text-muted">DBA {carrier.dba_name}</div> : null}<div className="mt-2 font-mono text-sm">USDOT {carrier.dot_number}</div><div className="mt-2 text-xs text-text-muted">{carrier.entity_type || 'Entity type unavailable'} · {carrier.classdef || 'Classification unavailable'} · {carrier.carrier_operation || 'Operation unavailable'} · {fmtInt(carrier.power_units)} power units · {fmtInt(carrier.total_drivers)} drivers</div><div className="mt-1 text-xs text-text-muted">{[carrier.phy_street, carrier.phy_city, carrier.phy_state, carrier.phy_zip].filter(Boolean).join(', ') || 'Physical address unavailable'}</div></div>{canEdit ? <div className="flex flex-wrap gap-2">{batchId && !currentMembership?.promoted_at ? <button type="button" disabled={promoteMutation.isPending} onClick={() => setConfirm('promote')} className="bg-accent px-3 py-2 text-xs font-bold text-accent-ink">Mark as Promoted</button> : currentMembership?.promoted_at ? <span className="bg-good-tint px-3 py-2 text-xs font-bold text-good">Promoted</span> : null}<button type="button" disabled={dncMutation.isPending} onClick={() => setConfirm(dnc ? 'dnc-restore' : 'dnc-set')} className={`border px-3 py-2 text-xs font-bold ${dnc ? 'border-good text-good' : 'border-crit text-crit'}`}>{dnc ? 'Restore contact' : 'Set global DNC'}</button></div> : null}</div>{warningReasons.length ? <div className="mt-4 flex flex-wrap gap-1.5">{warningReasons.map((reason) => <span key={reason} className="rounded-full bg-crit-tint px-2 py-1 text-[10px] font-bold text-crit">{WARNING_META[reason as WarningCode]?.label ?? reason}</span>)}</div> : null}</header>

      <div className="grid gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
        <aside className="space-y-4">
          <section className="border border-border bg-surface p-4"><h2 className="text-[11px] font-extrabold uppercase tracking-[0.08em] text-text-muted">Contact</h2><dl className="mt-3 space-y-3 text-sm"><div><dt className="text-[10px] uppercase text-text-subtle">Name</dt><dd className="font-semibold">{contactName || '—'}</dd></div><div><dt className="text-[10px] uppercase text-text-subtle">Phone</dt><dd>{dnc ? <span className="font-mono font-semibold text-text-subtle line-through" aria-disabled="true">{fmtPhone(phone)}</span> : <a className="font-mono font-semibold text-accent" href={phone ? `tel:${phone}` : undefined}>{fmtPhone(phone)}</a>}</dd></div><div><dt className="text-[10px] uppercase text-text-subtle">Email</dt><dd className="break-all">{dnc ? <span className="font-semibold text-text-subtle line-through" aria-disabled="true">{email || 'No email on file'}</span> : <a className="font-semibold text-accent" href={email ? `mailto:${email}` : undefined}>{email || 'No email on file'}</a>}</dd></div></dl></section>
          {canEdit && dnc ? <section className="border border-crit bg-crit-tint p-4 text-xs font-bold text-crit">Do not contact — call, text and email links and outreach logging are disabled. Use “Restore contact” to lift the block.</section> : null}
          {canEdit && !dnc ? <section className="border border-border bg-surface p-4"><h2 className="text-[11px] font-extrabold uppercase tracking-[0.08em] text-text-muted">Log contact</h2><div className="mt-3 flex gap-1">{(['call', 'text', 'email'] as const).map((value) => <button key={value} type="button" onClick={() => setChannel(value)} className={`flex-1 border px-2 py-2 text-[10px] font-bold uppercase ${channel === value ? 'border-accent bg-accent-tint text-accent' : 'border-border'}`}>{value}</button>)}</div><form className="mt-3 space-y-2" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); logMutation.mutate({ disposition: String(form.get('disposition')) as ContactDisposition, notes: String(form.get('notes') || ''), nextSteps: String(form.get('next_steps') || '') }); event.currentTarget.reset(); }}><select name="disposition" className="w-full border border-border-strong bg-surface px-3 py-2 text-xs">{DISPOSITIONS_BY_CHANNEL[channel].map((value) => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}</select><textarea name="notes" rows={3} placeholder="Notes" className="w-full border border-border-strong px-3 py-2 text-xs" /><input name="next_steps" placeholder="Next steps" className="w-full border border-border-strong px-3 py-2 text-xs" /><button disabled={logMutation.isPending} className="w-full bg-accent px-3 py-2 text-xs font-bold text-accent-ink">Log {channel}</button></form></section> : null}
          <section className="border border-border bg-surface p-4"><h2 className="text-[11px] font-extrabold uppercase tracking-[0.08em] text-text-muted">Research</h2><div className="mt-3 flex flex-col items-start gap-2 text-xs font-bold"><a target="_blank" rel="noopener noreferrer" href={`https://www.google.com/search?q=${encodedName}`} className="text-accent">Google company search</a><a target="_blank" rel="noopener noreferrer" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${carrier.legal_name} ${carrier.phy_city || ''} TX`)}`} className="text-accent">Google Maps</a><a target="_blank" rel="noopener noreferrer" href={`https://safer.fmcsa.dot.gov/query.asp?searchtype=ANY&query_type=queryCarrierSnapshot&query_param=USDOT&query_string=${dot}`} className="text-accent">FMCSA SAFER snapshot</a><a target="_blank" rel="noopener noreferrer" href={`https://www.linkedin.com/search/results/companies/?keywords=${encodeURIComponent(carrier.legal_name)}`} className="text-accent">LinkedIn company search</a></div></section>
        </aside>

        <main className="space-y-4"><div className="grid gap-3 md:grid-cols-3"><Tile label="Insurance" verdict={insuranceVerdict}><div className="text-xl font-extrabold tabular-nums">{fmtMoney(insurance?.bipd_on_file)}</div><div className="mt-1 text-xs text-text-muted">Required {fmtMoney(insurance?.bipd_required)}</div><div className="mt-1 text-xs">{insurance?.authority_active ? 'Authority active' : 'Authority not verified'}</div></Tile><Tile label="Safety" verdict={safetyTone}><div className="text-xl font-extrabold">{safety?.safety_rating || (safety ? 'Rating unknown — needs review' : 'No rating snapshot')}</div><div className="mt-1 text-xs text-text-muted">{fmtInt(safety?.inspections_24mo)} inspections · {safety?.vehicle_oos_rate ?? '—'}% vehicle OOS</div><div className="mt-1 text-[10px] text-text-subtle">Public signals only</div></Tile><Tile label="Inspections" verdict={inspections.some((item) => item.oos) ? 'warn' : inspections.length ? 'good' : 'warn'}><div className="text-xl font-extrabold tabular-nums">{fmtInt(inspections.length)}</div><div className="mt-1 text-xs text-text-muted">detail records on file</div><div className="mt-1 text-xs">{inspections.filter((item) => item.oos).length} out-of-service</div></Tile></div>

          <section className="border border-border bg-surface p-4"><h2 className="text-[11px] font-extrabold uppercase tracking-[0.08em] text-text-muted">Carrier detail</h2><dl className="mt-3 grid grid-cols-[130px_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">{detailRows.map(([label, value]) => <Fragment key={label}><dt className="text-[10px] font-bold uppercase text-text-subtle">{label}</dt><dd>{value}</dd></Fragment>)}</dl></section>

          <section className="border border-border bg-surface"><header className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-th-bg px-4 py-3"><span className="text-[11px] font-extrabold uppercase tracking-[0.08em] text-text-muted">Contact timeline</span><div className="flex gap-1" role="group" aria-label="Filter contact timeline by channel">{TIMELINE_FILTERS.map((chip) => <button key={chip.value} type="button" aria-pressed={timelineFilter === chip.value} onClick={() => setTimelineFilter(chip.value)} className={`border px-2 py-1 text-[10px] font-bold uppercase ${timelineFilter === chip.value ? 'border-accent bg-accent-tint text-accent' : 'border-border text-text-muted'}`}>{chip.label} <span className="font-mono">{counts[chip.value]}</span></button>)}</div></header>{shownLogs.length ? <div className="divide-y divide-border">{shownLogs.map((log) => <div key={log.id} className="px-4 py-3 text-sm"><div className="flex flex-wrap items-center gap-2"><span className="rounded-full bg-info-tint px-2 py-1 text-[10px] font-bold uppercase text-info">{log.channel}</span><span className="font-bold">{log.disposition.replaceAll('_', ' ')}</span><span className="text-xs text-text-subtle">{fmtRel(log.contacted_at)}</span></div>{log.notes ? <div className="mt-2 text-text-muted">{log.notes}</div> : null}<div className="mt-1 text-[10px] text-text-subtle">{log.profiles?.full_name || 'Unknown user'}{log.batches?.name ? ` · ${log.batches.name}` : ''}{log.next_steps ? ` · Next: ${log.next_steps}` : ''}</div></div>)}</div> : <div className="px-4 py-10 text-center text-sm text-text-subtle">{logs.length ? 'No entries for this channel.' : 'No contact history yet.'}</div>}</section>

          <section className="overflow-x-auto border border-border bg-surface"><header className="border-b border-border bg-th-bg px-4 py-3 text-[11px] font-extrabold uppercase tracking-[0.08em] text-text-muted">Batch memberships</header><table className="w-full min-w-[650px] text-xs"><thead className="text-left text-[10px] uppercase text-text-subtle"><tr><th className="px-3 py-2">Batch</th><th className="px-3 py-2">Customer / job</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Added</th></tr></thead><tbody>{memberships.map((membership) => <tr key={membership.batch_id} className="border-t border-border odd:bg-surface even:bg-zebra"><td className="px-3 py-2"><Link className="font-bold text-accent" to={`/batches/${membership.batch_id}`}>{membership.batches?.name}</Link></td><td className="px-3 py-2">{membership.batches?.customer || '—'}{membership.batches?.job ? ` · ${membership.batches.job}` : ''}</td><td className="px-3 py-2 font-bold">{membership.status.replaceAll('_', ' ')}</td><td className="px-3 py-2 text-text-subtle">{fmtRel(membership.added_at)}</td></tr>)}</tbody></table></section>
        </main>
      </div>
    </div>
  );
}
