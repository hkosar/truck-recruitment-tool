import { NavLink } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { usePermissions, useProfile } from './guards';
import { queryKeys } from '../lib/queryKeys';
import { dashboardTotals } from '../lib/rpc';
import { supabase } from '../lib/supabase';

/**
 * Sidebar nav — docs/build-plan/02-frontend-spec.md §3f.
 *  - "Recruiting": Dashboard (renamed from Batches, F3; badge = active
 *    batches) + New Batch (edit-gated, matches the /batches/new route
 *    guard so the nav never links somewhere the user would get bounced
 *    from).
 *  - "Outreach — coming soon" (F2): visible-but-disabled reserved tabs, no
 *    routes exist for them yet.
 *  - "Admin" (manager only): Users, pending-count badge.
 *  - Footer: user identity + sign out. The locked TNBS system is light-only,
 *    so there is intentionally no theme state or toggle.
 */

const OUTREACH_ITEMS: { label: string }[] = [
  { label: 'Email' },
  { label: 'Text' },
  { label: 'Mail' },
  { label: 'Enrichment' },
];

function navLinkClass({ isActive }: { isActive: boolean }): string {
  return [
    'flex items-center justify-between rounded-md px-3 py-2 text-sm font-medium transition-colors',
    isActive ? 'bg-accent-tint text-accent' : 'text-text-muted hover:bg-surface-2 hover:text-text',
  ].join(' ');
}

export function Sidebar() {
  const { canEdit, isManager } = usePermissions();
  const profile = useProfile();

  const totalsQuery = useQuery({
    queryKey: queryKeys.dashboard(),
    queryFn: ({ signal }) => dashboardTotals(signal),
    staleTime: 30_000,
  });

  const pendingCountQuery = useQuery({
    queryKey: queryKeys.users(),
    queryFn: async () => {
      const { count, error } = await supabase
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending');
      if (error) throw error;
      return count ?? 0;
    },
    enabled: isManager,
    staleTime: 30_000,
  });

  const initial = (profile?.full_name || profile?.email || '?').slice(0, 1).toUpperCase();

  return (
    <aside className="flex h-full shrink-0 flex-col border-r border-border bg-surface" style={{ width: 'var(--sidebar-w)' }}>
      <div className="border-b border-border px-4 py-3 text-[10px] font-extrabold uppercase tracking-[0.12em] text-text-subtle">
        Recruiting workspace
      </div>

      <nav className="flex-1 space-y-6 overflow-y-auto px-3 py-4">
        <div>
          <div className="px-3 pb-2 text-[11px] font-bold uppercase tracking-wider text-text-subtle">Recruiting</div>
          <div className="space-y-1">
            <NavLink to="/dashboard" className={navLinkClass}>
              <span>Dashboard</span>
              {totalsQuery.data ? (
                <span className="rounded-full bg-surface-sunk px-2 py-0.5 text-xs tabular-nums text-text-muted">
                  {totalsQuery.data.active_batches}
                </span>
              ) : null}
            </NavLink>
            {canEdit ? (
              <NavLink to="/batches/new" className={navLinkClass}>
                <span>New Batch</span>
              </NavLink>
            ) : null}
          </div>
        </div>

        <div>
          <div className="px-3 pb-2 text-[11px] font-bold uppercase tracking-wider text-text-subtle">
            Outreach — coming soon
          </div>
          <div className="space-y-1">
            {OUTREACH_ITEMS.map((item) => (
              <div
                key={item.label}
                role="button"
                aria-disabled="true"
                title="Planned module — not yet available"
                className="flex cursor-not-allowed items-center justify-between rounded-md px-3 py-2 text-sm text-text-subtle"
              >
                <span>{item.label}</span>
                <span className="rounded-full bg-surface-sunk px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-subtle">
                  Soon
                </span>
              </div>
            ))}
          </div>
        </div>

        {isManager ? (
          <div>
            <div className="px-3 pb-2 text-[11px] font-bold uppercase tracking-wider text-text-subtle">Admin</div>
            <div className="space-y-1">
              <NavLink to="/users" className={navLinkClass}>
                <span>Users</span>
                {pendingCountQuery.data ? (
                  <span className="rounded-full bg-accent px-2 py-0.5 text-xs font-semibold tabular-nums text-accent-ink">
                    {pendingCountQuery.data}
                  </span>
                ) : null}
              </NavLink>
            </div>
          </div>
        ) : null}
      </nav>

      <div className="border-t border-border px-3 py-3">
        <div className="flex items-center gap-2 rounded-md px-2 py-2">
          <div
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
            style={{ backgroundColor: profile?.avatar_color ?? '#64748b' }}
          >
            {initial}
          </div>
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-sm font-medium text-text">{profile?.full_name || 'Signed in'}</div>
            <div className="truncate text-xs text-text-subtle">{profile?.email}</div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void supabase.auth.signOut()}
          className="mt-2 w-full rounded-md border border-border-strong px-2 py-2 text-xs font-bold text-text-muted hover:bg-surface-2"
        >
          Sign out
        </button>
      </div>
    </aside>
  );
}
