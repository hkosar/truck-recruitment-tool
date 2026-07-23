import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSession } from '../../app/guards';
import { fmtRel } from '../../lib/format';
import { queryKeys } from '../../lib/queryKeys';
import { supabase } from '../../lib/supabase';
import type { Profile, UserRole } from '../../types/domain';

async function loadUsers(): Promise<Profile[]> {
  const { data, error } = await supabase.from('profiles').select('*').order('created_at', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export default function UsersAdmin() {
  const { userId } = useSession();
  const queryClient = useQueryClient();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const query = useQuery({ queryKey: queryKeys.users(), queryFn: loadUsers, staleTime: 15_000 });

  const update = useMutation({
    mutationFn: async ({ id, values }: { id: string; values: Partial<Pick<Profile, 'role' | 'status' | 'approved_by' | 'approved_at'>> }) => {
      setErrorMessage(null);
      const { error } = await supabase.from('profiles').update(values).eq('id', id);
      if (error) throw error;
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.users() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.me() }),
      ]);
    },
    onError: (error) => setErrorMessage(error instanceof Error ? error.message : 'User update failed.'),
  });

  const approve = (profile: Profile, role: Extract<UserRole, 'edit' | 'view'>) => {
    if (!userId) return;
    update.mutate({
      id: profile.id,
      values: { role, status: 'approved', approved_by: userId, approved_at: new Date().toISOString() },
    });
  };

  const users = query.data ?? [];
  const pending = users.filter((profile) => profile.status === 'pending');
  const active = users.filter((profile) => profile.status !== 'pending');

  return (
    <div className="mx-auto max-w-[1300px] space-y-5">
      <h1 className="text-xl font-extrabold tracking-[-0.02em]">Users</h1>

      {errorMessage ? <div className="border border-crit bg-crit-tint p-3 text-sm text-crit">{errorMessage}</div> : null}

      {query.isPending ? <div className="h-64 animate-pulse border border-border bg-surface" /> : null}
      {query.isError ? (
        <section className="border border-crit bg-crit-tint p-5">
          <div className="font-bold">User list unavailable</div>
          <button type="button" onClick={() => void query.refetch()} className="mt-3 border border-crit px-4 py-2 text-xs font-bold text-crit">Retry</button>
        </section>
      ) : null}

      {!query.isPending && !query.isError ? (
        <>
          <section className="border border-border bg-surface">
            <header className="flex items-center justify-between border-b border-border bg-th-bg px-4 py-3">
              <h2 className="text-[11px] font-extrabold uppercase tracking-[0.08em] text-text-muted">Pending approval</h2>
              <span className="rounded-full bg-accent px-2 py-0.5 text-[11px] font-bold text-accent-ink">{pending.length}</span>
            </header>
            {pending.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-text-subtle">No users are waiting for approval.</div>
            ) : (
              <div className="divide-y divide-border">
                {pending.map((profile) => (
                  <div key={profile.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <div className="flex h-9 w-9 items-center justify-center rounded-full text-xs font-bold text-white" style={{ backgroundColor: profile.avatar_color }}>
                      {(profile.full_name || profile.email).slice(0, 1).toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="font-bold">{profile.full_name || 'Unnamed user'}</div>
                      <div className="text-xs text-text-subtle">{profile.email} · requested {fmtRel(profile.created_at)}</div>
                    </div>
                    <button type="button" disabled={update.isPending} onClick={() => approve(profile, 'view')} className="border border-border-strong px-3 py-2 text-xs font-bold hover:bg-row-hover disabled:opacity-50">Approve Viewer</button>
                    <button type="button" disabled={update.isPending} onClick={() => approve(profile, 'edit')} className="bg-accent px-3 py-2 text-xs font-bold text-accent-ink hover:bg-accent-hover disabled:opacity-50">Approve Editor</button>
                    <button type="button" disabled={update.isPending} onClick={() => update.mutate({ id: profile.id, values: { status: 'disabled' } })} className="px-3 py-2 text-xs font-bold text-crit hover:bg-crit-tint disabled:opacity-50">Reject</button>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="overflow-x-auto border border-border bg-surface">
            <header className="border-b border-border bg-th-bg px-4 py-3 text-[11px] font-extrabold uppercase tracking-[0.08em] text-text-muted">Active and disabled users</header>
            <table className="w-full min-w-[850px] border-collapse text-[13px]">
              <thead className="bg-th-bg text-left text-[10px] font-extrabold uppercase tracking-[0.07em] text-text-muted">
                <tr><th className="px-3 py-2.5">User</th><th className="px-3 py-2.5">Role</th><th className="px-3 py-2.5">Status</th><th className="px-3 py-2.5">Approved</th><th className="px-3 py-2.5 text-right">Action</th></tr>
              </thead>
              <tbody>
                {active.map((profile) => {
                  const isSelf = profile.id === userId;
                  return (
                    <tr key={profile.id} className="border-t border-border odd:bg-surface even:bg-zebra">
                      <td className="px-3 py-2.5"><div className="font-bold">{profile.full_name || 'Unnamed user'} {isSelf ? <span className="text-[10px] text-accent">YOU</span> : null}</div><div className="text-xs text-text-subtle">{profile.email}</div></td>
                      <td className="px-3 py-2.5">
                        <select disabled={isSelf || update.isPending} value={profile.role} onChange={(event) => update.mutate({ id: profile.id, values: { role: event.target.value as UserRole } })} className="border border-border-strong bg-surface px-2 py-1.5 text-xs disabled:bg-surface-sunk disabled:text-text-subtle">
                          <option value="manager">Manager</option><option value="edit">Editor</option><option value="view">Viewer</option><option value="guest">Guest</option>
                        </select>
                      </td>
                      <td className="px-3 py-2.5"><span className={`rounded-full px-2 py-1 text-[11px] font-bold ${profile.status === 'approved' ? 'bg-good-tint text-good' : 'bg-crit-tint text-crit'}`}>{profile.status === 'approved' ? 'Approved' : 'Disabled'}</span></td>
                      <td className="px-3 py-2.5 text-xs text-text-muted">{fmtRel(profile.approved_at)}</td>
                      <td className="px-3 py-2.5 text-right">
                        <button type="button" disabled={isSelf || update.isPending} onClick={() => update.mutate({ id: profile.id, values: { status: profile.status === 'disabled' ? 'approved' : 'disabled' } })} className={`px-3 py-2 text-xs font-bold disabled:text-text-subtle ${profile.status === 'disabled' ? 'text-good hover:bg-good-tint' : 'text-crit hover:bg-crit-tint'}`}>
                          {isSelf ? 'Self locked' : profile.status === 'disabled' ? 'Restore' : 'Disable'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        </>
      ) : null}
    </div>
  );
}
