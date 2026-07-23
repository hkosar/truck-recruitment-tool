import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { usePermissions, useSession } from '../../app/guards';
import { fmtInt, fmtMoney, fmtPhone, fmtRel } from '../../lib/format';
import { queryKeys } from '../../lib/queryKeys';
import { setDoNotContact } from '../../lib/rpc';
import { supabase } from '../../lib/supabase';
import { WARNING_META } from '../../lib/warnings';
import { DISPOSITIONS_BY_CHANNEL } from '../../types/domain';
import type { Channel, ContactDisposition, WarningCode } from '../../types/domain';

async function loadCarrier(dot: number) {
  const [carrier, insurance, safety, inspections, warning, logs, memberships] = await Promise.all([
    supabase.from('carriers').select('*').eq('dot_number', dot).single(),
    supabase.from('carrier_insurance').select('*').eq('dot_number', dot).maybeSingle(),
    supabase.from('carrier_safety').select('*').eq('dot_number', dot).maybeSingle(),
    supabase.from('carrier_inspections').select('*').eq('dot_number', dot).order('inspection_date', { ascending: false }).limit(10),
    supabase.from('carrier_warnings').select('*').eq('dot_number', dot).maybeSingle(),
    supabase.from('contact_logs').select('*, profiles(full_name), batches(name)').eq('dot_number', dot).order('contacted_at', { ascending: false }).limit(100),
    supabase.from('batch_carriers').select('*, batches(name, customer, job)').eq('dot_number', dot).order('added_at', { ascending: false }),
  ]);
  for (const result of [carrier, insurance, safety, inspections, warning, logs, memberships]) {
    if (result.error) throw result.error;
  }
  if (!carrier.data) throw new Error(`Carrier USDOT ${dot} not found`);
  return {
    carrier: carrier.data,
    insurance: insurance.data,
    safety: safety.data,
    inspections: inspections.data ?? [],
    warningReasons: warning.data?.warning_reasons ?? [],
    logs: logs.data ?? [],
    memberships: memberships.data ?? [],
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

  const query = useQuery({ queryKey: queryKeys.carrier(dot), queryFn: () => loadCarrier(dot), enabled: Number.isSafeInteger(dot) && dot > 0 });
  const dncMutation = useMutation({
    mutationFn: async () => setDoNotContact(dot, !query.data?.carrier.do_not_contact, query.data?.carrier.do_not_contact ? null : 'Set from carrier profile'),
    onSuccess: async () => { setMessage('Contact preference updated.'); await queryClient.invalidateQueries({ queryKey: queryKeys.carrier(dot) }); },
    onError: (error) => setMessage(error instanceof Error ? error.message : 'DNC update failed.'),
  });
  const promoteMutation = useMutation({
    mutationFn: async () => {
      if (!batchId) throw new Error('Open this carrier from a batch to mark it promoted.');
      const { error } = await supabase.from('batch_carriers').update({ promoted_at: new Date().toISOString() }).eq('batch_id', batchId).eq('dot_number', dot);
      if (error) throw error;
    },
    onSuccess: async () => { setMessage('Carrier marked as promoted.'); await queryClient.invalidateQueries({ queryKey: queryKeys.carrier(dot) }); },
    onError: (error) => setMessage(error instanceof Error ? error.message : 'Promotion failed.'),
  });
  const logMutation = useMutation({
    mutationFn: async ({ disposition, notes, nextSteps }: { disposition: ContactDisposition; notes: string; nextSteps: string }) => {
      if (!userId) throw new Error('No signed-in user.');
      const { error } = await supabase.from('contact_logs').insert({ dot_number: dot, batch_id: batchId, user_id: userId, channel, disposition, notes: notes || null, next_steps: nextSteps || null });
      if (error) throw error;
    },
    onSuccess: async () => { setMessage(`${channel} logged.`); await queryClient.invalidateQueries({ queryKey: queryKeys.carrier(dot) }); },
    onError: (error) => setMessage(error instanceof Error ? error.message : 'Contact log failed.'),
  });

  if (!Number.isSafeInteger(dot) || dot <= 0) return <div>Invalid USDOT number.</div>;
  if (query.isPending) return <div className="h-96 animate-pulse border border-border bg-surface" />;
  if (query.isError) return <section className="border border-crit bg-crit-tint p-5"><h1 className="text-xl font-extrabold">Carrier unavailable</h1><button type="button" onClick={() => void query.refetch()} className="mt-3 border border-crit px-4 py-2 text-xs font-bold text-crit">Retry</button></section>;

  const { carrier, insurance, safety, inspections, warningReasons, logs, memberships } = query.data;
  const contactName = carrier.contact_name_override || carrier.contact_name || carrier.company_officer_1 || carrier.company_officer_2;
  const phone = carrier.contact_phone_override || carrier.phone || carrier.cell_phone;
  const email = carrier.contact_email_override || carrier.email_address;
  const currentMembership = memberships.find((membership) => membership.batch_id === batchId);
  const encodedName = encodeURIComponent(`"${carrier.legal_name}" ${carrier.phy_city || ''} TX trucking`);
  const insuranceVerdict = !insurance?.bipd_on_file ? 'bad' : insurance.bipd_on_file >= 1_000_000 ? 'good' : 'warn';
  const safetyVerdict = !safety ? 'warn' : safety.safety_rating === 'Unsatisfactory' ? 'bad' : safety.safety_rating === 'Conditional' ? 'warn' : 'good';

  return (
    <div className="mx-auto max-w-[1500px] space-y-4">
      {message ? <div className="border border-info bg-info-tint px-4 py-3 text-sm text-info">{message}</div> : null}
      <header className={`border border-border bg-surface p-5 ${warningReasons.length ? 'bg-row-warning' : ''}`}><div className="flex flex-wrap items-start justify-between gap-5"><div><div className="flex flex-wrap items-center gap-2"><h1 className="text-2xl font-extrabold tracking-[-0.02em]">{carrier.legal_name}</h1>{carrier.status_code === 'A' ? <span className="rounded-full bg-good-tint px-2 py-1 text-[10px] font-bold text-good">Active</span> : <span className="rounded-full bg-crit-tint px-2 py-1 text-[10px] font-bold text-crit">Inactive</span>}{carrier.do_not_contact ? <span className="rounded-full bg-st-dnc-tint px-2 py-1 text-[10px] font-bold text-st-dnc">Do not contact</span> : null}</div>{carrier.dba_name ? <div className="mt-1 text-sm font-semibold text-text-muted">DBA {carrier.dba_name}</div> : null}<div className="mt-2 font-mono text-sm">USDOT {carrier.dot_number}</div><div className="mt-2 text-xs text-text-muted">{carrier.entity_type || 'Entity type unavailable'} · {carrier.classdef || 'Classification unavailable'} · {carrier.carrier_operation || 'Operation unavailable'} · {fmtInt(carrier.power_units)} power units · {fmtInt(carrier.total_drivers)} drivers</div><div className="mt-1 text-xs text-text-muted">{[carrier.phy_street, carrier.phy_city, carrier.phy_state, carrier.phy_zip].filter(Boolean).join(', ') || 'Physical address unavailable'}</div></div>{canEdit ? <div className="flex flex-wrap gap-2">{batchId && !currentMembership?.promoted_at ? <button type="button" disabled={promoteMutation.isPending} onClick={() => promoteMutation.mutate()} className="bg-accent px-3 py-2 text-xs font-bold text-accent-ink">Mark as Promoted</button> : currentMembership?.promoted_at ? <span className="bg-good-tint px-3 py-2 text-xs font-bold text-good">Promoted</span> : null}<button type="button" disabled={dncMutation.isPending} onClick={() => dncMutation.mutate()} className={`border px-3 py-2 text-xs font-bold ${carrier.do_not_contact ? 'border-good text-good' : 'border-crit text-crit'}`}>{carrier.do_not_contact ? 'Restore contact' : 'Set global DNC'}</button></div> : null}</div>{warningReasons.length ? <div className="mt-4 flex flex-wrap gap-1.5">{warningReasons.map((reason) => <span key={reason} className="rounded-full bg-crit-tint px-2 py-1 text-[10px] font-bold text-crit">{WARNING_META[reason as WarningCode]?.label ?? reason}</span>)}</div> : null}</header>

      <div className="grid gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
        <aside className="space-y-4">
          <section className="border border-border bg-surface p-4"><h2 className="text-[11px] font-extrabold uppercase tracking-[0.08em] text-text-muted">Contact</h2><dl className="mt-3 space-y-3 text-sm"><div><dt className="text-[10px] uppercase text-text-subtle">Name</dt><dd className="font-semibold">{contactName || '—'}</dd></div><div><dt className="text-[10px] uppercase text-text-subtle">Phone</dt><dd><a className="font-mono font-semibold text-accent" href={phone ? `tel:${phone}` : undefined}>{fmtPhone(phone)}</a></dd></div><div><dt className="text-[10px] uppercase text-text-subtle">Email</dt><dd className="break-all"><a className="font-semibold text-accent" href={email ? `mailto:${email}` : undefined}>{email || 'No email on file'}</a></dd></div></dl></section>
          {canEdit ? <section className="border border-border bg-surface p-4"><h2 className="text-[11px] font-extrabold uppercase tracking-[0.08em] text-text-muted">Log contact</h2><div className="mt-3 flex gap-1">{(['call', 'text', 'email'] as const).map((value) => <button key={value} type="button" onClick={() => setChannel(value)} className={`flex-1 border px-2 py-2 text-[10px] font-bold uppercase ${channel === value ? 'border-accent bg-accent-tint text-accent' : 'border-border'}`}>{value}</button>)}</div><form className="mt-3 space-y-2" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); logMutation.mutate({ disposition: String(form.get('disposition')) as ContactDisposition, notes: String(form.get('notes') || ''), nextSteps: String(form.get('next_steps') || '') }); event.currentTarget.reset(); }}><select name="disposition" className="w-full border border-border-strong bg-surface px-3 py-2 text-xs">{DISPOSITIONS_BY_CHANNEL[channel].map((value) => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}</select><textarea name="notes" rows={3} placeholder="Notes" className="w-full border border-border-strong px-3 py-2 text-xs" /><input name="next_steps" placeholder="Next steps" className="w-full border border-border-strong px-3 py-2 text-xs" /><button disabled={logMutation.isPending} className="w-full bg-accent px-3 py-2 text-xs font-bold text-accent-ink">Log {channel}</button></form></section> : null}
          <section className="border border-border bg-surface p-4"><h2 className="text-[11px] font-extrabold uppercase tracking-[0.08em] text-text-muted">Research</h2><div className="mt-3 flex flex-col items-start gap-2 text-xs font-bold"><a target="_blank" rel="noopener noreferrer" href={`https://www.google.com/search?q=${encodedName}`} className="text-accent">Google company search</a><a target="_blank" rel="noopener noreferrer" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${carrier.legal_name} ${carrier.phy_city || ''} TX`)}`} className="text-accent">Google Maps</a><a target="_blank" rel="noopener noreferrer" href={`https://safer.fmcsa.dot.gov/query.asp?searchtype=ANY&query_type=queryCarrierSnapshot&query_param=USDOT&query_string=${dot}`} className="text-accent">FMCSA SAFER snapshot</a><a target="_blank" rel="noopener noreferrer" href={`https://www.linkedin.com/search/results/companies/?keywords=${encodeURIComponent(carrier.legal_name)}`} className="text-accent">LinkedIn company search</a></div></section>
        </aside>

        <main className="space-y-4"><div className="grid gap-3 md:grid-cols-3"><Tile label="Insurance" verdict={insuranceVerdict}><div className="text-xl font-extrabold tabular-nums">{fmtMoney(insurance?.bipd_on_file)}</div><div className="mt-1 text-xs text-text-muted">Required {fmtMoney(insurance?.bipd_required)}</div><div className="mt-1 text-xs">{insurance?.authority_active ? 'Authority active' : 'Authority not verified'}</div></Tile><Tile label="Safety" verdict={safetyVerdict}><div className="text-xl font-extrabold">{safety?.safety_rating || 'No rating snapshot'}</div><div className="mt-1 text-xs text-text-muted">{fmtInt(safety?.inspections_24mo)} inspections · {safety?.vehicle_oos_rate ?? '—'}% vehicle OOS</div><div className="mt-1 text-[10px] text-text-subtle">Public signals only</div></Tile><Tile label="Inspections" verdict={inspections.some((item) => item.oos) ? 'warn' : inspections.length ? 'good' : 'warn'}><div className="text-xl font-extrabold tabular-nums">{fmtInt(inspections.length)}</div><div className="mt-1 text-xs text-text-muted">detail records on file</div><div className="mt-1 text-xs">{inspections.filter((item) => item.oos).length} out-of-service</div></Tile></div>

          <section className="border border-border bg-surface"><header className="border-b border-border bg-th-bg px-4 py-3 text-[11px] font-extrabold uppercase tracking-[0.08em] text-text-muted">Contact timeline</header>{logs.length ? <div className="divide-y divide-border">{logs.map((log) => <div key={log.id} className="px-4 py-3 text-sm"><div className="flex flex-wrap items-center gap-2"><span className="rounded-full bg-info-tint px-2 py-1 text-[10px] font-bold uppercase text-info">{log.channel}</span><span className="font-bold">{log.disposition.replaceAll('_', ' ')}</span><span className="text-xs text-text-subtle">{fmtRel(log.contacted_at)}</span></div>{log.notes ? <div className="mt-2 text-text-muted">{log.notes}</div> : null}<div className="mt-1 text-[10px] text-text-subtle">{log.profiles?.full_name || 'Unknown user'}{log.batches?.name ? ` · ${log.batches.name}` : ''}{log.next_steps ? ` · Next: ${log.next_steps}` : ''}</div></div>)}</div> : <div className="px-4 py-10 text-center text-sm text-text-subtle">No contact history yet.</div>}</section>

          <section className="overflow-x-auto border border-border bg-surface"><header className="border-b border-border bg-th-bg px-4 py-3 text-[11px] font-extrabold uppercase tracking-[0.08em] text-text-muted">Batch memberships</header><table className="w-full min-w-[650px] text-xs"><thead className="text-left text-[10px] uppercase text-text-subtle"><tr><th className="px-3 py-2">Batch</th><th className="px-3 py-2">Customer / job</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Added</th></tr></thead><tbody>{memberships.map((membership) => <tr key={membership.batch_id} className="border-t border-border odd:bg-surface even:bg-zebra"><td className="px-3 py-2"><Link className="font-bold text-accent" to={`/batches/${membership.batch_id}`}>{membership.batches?.name}</Link></td><td className="px-3 py-2">{membership.batches?.customer || '—'}{membership.batches?.job ? ` · ${membership.batches.job}` : ''}</td><td className="px-3 py-2 font-bold">{membership.status.replaceAll('_', ' ')}</td><td className="px-3 py-2 text-text-subtle">{fmtRel(membership.added_at)}</td></tr>)}</tbody></table></section>
        </main>
      </div>
    </div>
  );
}
