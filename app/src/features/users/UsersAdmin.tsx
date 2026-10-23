import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSession } from '../../app/guards';
import { ApiError, apiGet, apiPost } from '../../lib/api';
import { fmtRel } from '../../lib/format';
import { queryKeys } from '../../lib/queryKeys';
import type { UserRole } from '../../types/domain';

/**
 * Team (manager only). Staff are added by a manager; there is no self-registration or approval
 * queue (Hunter decision 3). Every role, status or email change signs that person out everywhere
 * (database trigger). Legacy pending/guest accounts are preserved and shown read-only: changing
 * them needs an explicit, separately approved migration decision.
 */

interface TeamMember {
  id: string;
  email: string;
  full_name: string;
  role: UserRole;
  status: 'pending' | 'approved' | 'disabled';
  created_at: string;
}

const ROLE_LABEL: Record<string, string> = { manager: 'Manager', edit: 'Editor', view: 'Viewer' };

function isLegacy(member: TeamMember): boolean {
  return member.status === 'pending' || member.role === 'guest';
}

/** Add-person refusals, in plain words (the server answers with fixed codes only). */
function addPersonError(error: unknown): string {
  if (error instanceof ApiError && error.code === 'conflict') return 'That email address already belongs to someone on the team. A deactivated person can be reactivated instead.';
  if (error instanceof ApiError && error.code === 'invalid') return 'Check the name, the email address, the role and the mobile number (mobile is optional).';
  return error instanceof Error ? error.message : 'Adding the person failed.';
}

export default function UsersAdmin() {
  const { userId } = useSession();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState({ full_name: '', email: '', role: 'edit' as 'manager' | 'edit' | 'view', mobile: '' });
  const query = useQuery({ queryKey: queryKeys.users(), queryFn: () => apiGet<TeamMember[]>('/api/team'), staleTime: 15_000 });

  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.users() });
  const onError = (error: unknown) => setMessage(error instanceof Error ? error.message : 'Team update failed.');

  const setRole = useMutation({
    mutationFn: ({ id, role }: { id: string; role: UserRole }) => apiPost('/api/team/edit', { id, full_name: null, role, email: null }),
    onSuccess: refresh,
    onError,
  });
  const setActive = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) => apiPost(active ? '/api/team/reactivate' : '/api/team/deactivate', { id }),
    onSuccess: refresh,
    onError,
  });
  // Task D: a manager adds a person. Nothing is emailed now; the person signs in by requesting a
  // link with this address. The mobile is optional, stored unverified and never used to sign in.
  // The submitted values are captured at submit and passed as the mutation's variables, so the
  // notice always names what was actually added; the fields are disabled while the add runs.
  const addPerson = useMutation({
    mutationFn: (submitted: typeof draft) =>
      apiPost<{ id: string }>('/api/team/add', { ...submitted, mobile: submitted.mobile.trim() === '' ? null : submitted.mobile }),
    onSuccess: (_result, submitted) => {
      setMessage(null);
      setNotice(`Added ${submitted.full_name.trim()}. They can sign in now by entering ${submitted.email.trim().toLowerCase()} on the sign-in page; no email has been sent.`);
      setDraft({ full_name: '', email: '', role: 'edit', mobile: '' });
      void refresh();
    },
    onError: (error) => {
      setNotice(null);
      setMessage(addPersonError(error));
    },
  });
  const signEveryoneOut = useMutation({
    mutationFn: () => apiPost<{ revoked: number }>('/api/team/sign-everyone-out', {}),
    // Every session ends, including this one: a full navigation shows the sign-in page, which
    // confirms that everyone was signed out and unused links and recovery codes were cancelled.
    onSuccess: () => window.location.assign('/signin?everyone=1'),
    onError,
  });

  const members = query.data ?? [];
  const staff = members.filter((m) => !isLegacy(m));
  const legacy = members.filter(isLegacy);
  const busy = setRole.isPending || setActive.isPending || signEveryoneOut.isPending || addPerson.isPending;
  const field = 'border border-border-strong bg-surface px-2 py-1.5 text-sm';

  return (
    <div className="mx-auto max-w-[1300px] space-y-5">
      <h1 className="text-xl font-extrabold tracking-[-0.02em]">Team</h1>

      {message ? <div role="alert" className="border border-crit bg-crit-tint p-3 text-sm text-crit">{message}</div> : null}
      {notice ? <div role="status" className="border border-good bg-good-tint p-3 text-sm text-good">{notice}</div> : null}
      {query.isPending ? <div className="h-64 animate-pulse border border-border bg-surface" /> : null}
      {query.isError ? (
        <section className="border border-crit bg-crit-tint p-5">
          <div className="font-bold">Team list unavailable</div>
          <button type="button" onClick={() => void query.refetch()} className="mt-3 border border-crit px-4 py-2 text-xs font-bold text-crit">Retry</button>
        </section>
      ) : null}

      {!query.isPending && !query.isError ? (
        <>
          <section className="border border-border bg-surface p-4">
            <h2 className="text-[11px] font-extrabold uppercase tracking-[0.08em] text-text-muted">Add a person</h2>
            <form
              className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-[1.2fr_1.4fr_0.8fr_1fr_auto] md:items-end"
              onSubmit={(e) => {
                e.preventDefault();
                addPerson.mutate({ ...draft });
              }}
            >
              <fieldset disabled={addPerson.isPending} className="contents">
              <label className="text-xs font-bold text-text-muted">Name
                <input required maxLength={200} value={draft.full_name} onChange={(e) => setDraft({ ...draft, full_name: e.target.value })} className={`mt-1 block w-full ${field}`} />
              </label>
              <label className="text-xs font-bold text-text-muted">Email
                <input required type="email" maxLength={320} value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} className={`mt-1 block w-full ${field}`} />
              </label>
              <label className="text-xs font-bold text-text-muted">Role
                <select value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value as 'manager' | 'edit' | 'view' })} className={`mt-1 block w-full ${field}`}>
                  <option value="manager">Manager</option><option value="edit">Editor</option><option value="view">Viewer</option>
                </select>
              </label>
              <label className="text-xs font-bold text-text-muted">Mobile (optional)
                <input type="tel" maxLength={32} value={draft.mobile} onChange={(e) => setDraft({ ...draft, mobile: e.target.value })} className={`mt-1 block w-full ${field}`} />
              </label>
              <button type="submit" disabled={busy} className="border border-accent bg-accent px-4 py-2 text-xs font-bold text-white disabled:opacity-50">Add person</button>
              </fieldset>
            </form>
            <p className="mt-2 text-xs text-text-subtle">
              No email is sent when you add someone. They sign in by entering their address on the sign-in page. The mobile number is stored unverified and is not used to sign in.
            </p>
          </section>

          <section className="overflow-x-auto border border-border bg-surface">
            <header className="border-b border-border bg-th-bg px-4 py-3 text-[11px] font-extrabold uppercase tracking-[0.08em] text-text-muted">Staff</header>
            <table className="w-full min-w-[760px] border-collapse text-[13px]">
              <thead className="bg-th-bg text-left text-[10px] font-extrabold uppercase tracking-[0.07em] text-text-muted">
                <tr><th className="px-3 py-2.5">Person</th><th className="px-3 py-2.5">Role</th><th className="px-3 py-2.5">Status</th><th className="px-3 py-2.5">Added</th><th className="px-3 py-2.5 text-right">Action</th></tr>
              </thead>
              <tbody>
                {staff.map((m) => {
                  const isSelf = m.id === userId;
                  return (
                    <tr key={m.id} className="border-t border-border odd:bg-surface even:bg-zebra">
                      <td className="px-3 py-2.5"><div className="font-bold">{m.full_name || 'Unnamed'} {isSelf ? <span className="text-[10px] text-accent">YOU</span> : null}</div><div className="text-xs text-text-subtle">{m.email}</div></td>
                      <td className="px-3 py-2.5">
                        <select aria-label={`Role for ${m.full_name || m.email}`} disabled={isSelf || busy} value={m.role} onChange={(e) => setRole.mutate({ id: m.id, role: e.target.value as UserRole })} className="border border-border-strong bg-surface px-2 py-1.5 text-xs disabled:bg-surface-sunk disabled:text-text-subtle">
                          <option value="manager">Manager</option><option value="edit">Editor</option><option value="view">Viewer</option>
                        </select>
                      </td>
                      <td className="px-3 py-2.5"><span className={`rounded-full px-2 py-1 text-[11px] font-bold ${m.status === 'approved' ? 'bg-good-tint text-good' : 'bg-crit-tint text-crit'}`}>{m.status === 'approved' ? 'Active' : 'Deactivated'}</span></td>
                      <td className="px-3 py-2.5 text-xs text-text-muted">{fmtRel(m.created_at)}</td>
                      <td className="px-3 py-2.5 text-right">
                        <button type="button" disabled={isSelf || busy} onClick={() => setActive.mutate({ id: m.id, active: m.status !== 'approved' })} className={`px-3 py-2 text-xs font-bold disabled:text-text-subtle ${m.status === 'approved' ? 'text-crit hover:bg-crit-tint' : 'text-good hover:bg-good-tint'}`}>
                          {isSelf ? 'You' : m.status === 'approved' ? 'Deactivate' : 'Reactivate'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>

          {legacy.length ? (
            <section className="border border-border bg-surface">
              <header className="border-b border-border bg-th-bg px-4 py-3 text-[11px] font-extrabold uppercase tracking-[0.08em] text-text-muted">No access (legacy accounts, kept unchanged)</header>
              <ul className="divide-y divide-border">
                {legacy.map((m) => (
                  <li key={m.id} className="px-4 py-3 text-sm"><span className="font-bold">{m.full_name || 'Unnamed'}</span> <span className="text-xs text-text-subtle">{m.email} · {m.status === 'pending' ? 'pending' : 'guest'} · {fmtRel(m.created_at)}</span></li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="border border-crit bg-surface p-4">
            <h2 className="text-[11px] font-extrabold uppercase tracking-[0.08em] text-crit">Emergency</h2>
            <p className="mt-2 text-sm text-text-muted">
              Signs out every staff member at once, including you, and cancels all unused sign-in links and recovery codes. Everyone then needs a new sign-in link by email. If email is down, nobody can get back in until it works again: there is no other way in.
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (
                  window.confirm(
                    'Sign everyone out now?\n\nEvery staff member, including you, is signed out immediately, and all unused sign-in links and recovery codes are cancelled.\n\nEveryone will need a new sign-in link by email. If email is down, nobody can get back in until it works again.',
                  )
                )
                  signEveryoneOut.mutate();
              }}
              className="mt-3 border border-crit px-4 py-2 text-xs font-bold text-crit hover:bg-crit-tint disabled:opacity-50"
            >
              Sign everyone out
            </button>
          </section>
        </>
      ) : null}
      {/* Roles are labelled Manager / Editor / Viewer; stored values stay manager / edit / view. */}
      <span className="sr-only">{Object.values(ROLE_LABEL).join(', ')}</span>
    </div>
  );
}
