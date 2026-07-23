import { useState } from 'react';
import { DISPOSITIONS_BY_CHANNEL } from '../types/domain';
import type { Channel, ContactDisposition } from '../types/domain';

export interface ContactLogInput {
  channel: Extract<Channel, 'call' | 'text' | 'email'>;
  disposition: ContactDisposition;
  notes: string;
  nextSteps: string;
}

export function LogContactPanel({
  carrierName,
  submitting,
  onCancel,
  onSubmit,
}: {
  carrierName: string;
  submitting: boolean;
  onCancel: () => void;
  onSubmit: (input: ContactLogInput) => void;
}) {
  const [channel, setChannel] = useState<ContactLogInput['channel']>('call');
  const [disposition, setDisposition] = useState<ContactDisposition>(DISPOSITIONS_BY_CHANNEL.call[0]);
  const [notes, setNotes] = useState('');
  const [nextSteps, setNextSteps] = useState('');

  const chooseChannel = (value: ContactLogInput['channel']) => {
    setChannel(value);
    setDisposition(DISPOSITIONS_BY_CHANNEL[value][0]);
  };

  return (
    <section className="border border-accent bg-accent-tint p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[10px] font-extrabold uppercase tracking-[0.09em] text-accent">Log outreach</div>
          <h2 className="mt-1 text-sm font-bold text-text">{carrierName}</h2>
        </div>
        <button type="button" onClick={onCancel} className="text-xs font-bold text-text-muted">Cancel</button>
      </div>
      <div className="mt-3 flex gap-1">
        {(['call', 'text', 'email'] as const).map((value) => (
          <button key={value} type="button" onClick={() => chooseChannel(value)} className={`flex-1 border px-2 py-2 text-[10px] font-bold uppercase ${channel === value ? 'border-accent bg-accent text-accent-ink' : 'border-border-strong bg-surface text-text-muted'}`}>{value}</button>
        ))}
      </div>
      <div className="mt-3 grid gap-2 md:grid-cols-2">
        <label className="text-[10px] font-bold uppercase text-text-muted">Outcome<select value={disposition} onChange={(event) => setDisposition(event.target.value as ContactDisposition)} className="mt-1 w-full border border-border-strong bg-surface px-3 py-2 text-xs normal-case text-text">{DISPOSITIONS_BY_CHANNEL[channel].map((value) => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}</select></label>
        <label className="text-[10px] font-bold uppercase text-text-muted">Next step<input value={nextSteps} onChange={(event) => setNextSteps(event.target.value)} placeholder="Optional follow-up" className="mt-1 w-full border border-border-strong bg-surface px-3 py-2 text-xs normal-case text-text" /></label>
      </div>
      <label className="mt-2 block text-[10px] font-bold uppercase text-text-muted">Notes<textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={2} placeholder="What happened?" className="mt-1 w-full border border-border-strong bg-surface px-3 py-2 text-xs normal-case text-text" /></label>
      <button type="button" disabled={submitting} onClick={() => onSubmit({ channel, disposition, notes: notes.trim(), nextSteps: nextSteps.trim() })} className="mt-3 bg-accent px-4 py-2 text-xs font-bold text-accent-ink disabled:opacity-50">{submitting ? 'Saving…' : `Save ${channel}`}</button>
    </section>
  );
}
