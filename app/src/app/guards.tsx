import { Navigate, Outlet } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { loadSession, type SessionPayload } from '../lib/api';
import { queryKeys } from '../lib/queryKeys';
import { getPermissions } from '../lib/permissions';
import type { Permissions } from '../lib/permissions';
import type { Profile, UserRole } from '../types/domain';

/**
 * Session guards for the same-origin sign-in (docs/build-plan/14-same-origin-signin-design.md,
 * 15-qq-infrastructure-reconciliation.md). The server only serves the app shell to a valid
 * staff session and redirects everyone else to its own /signin page, so there is no in-app
 * login, registration, pending or guest screen (Hunter decision 3: manager-added staff only).
 * A session that ends while the app is open is caught by the first 401 (lib/api.ts), which
 * does a full page load to /signin.
 */

export interface SessionState {
  loading: boolean;
  userId: string | null;
  profile: Profile | null;
  session: SessionPayload | null;
}

function profileFrom(session: SessionPayload): Profile {
  return {
    id: session.user.id,
    email: session.user.email,
    full_name: session.user.name,
    role: session.user.role,
    status: 'approved',
    avatar_color: '#64748b',
    approved_by: null,
    approved_at: null,
    created_at: '',
  } as Profile;
}

export function useSession(): SessionState {
  const query = useQuery({ queryKey: queryKeys.me(), queryFn: () => loadSession(), staleTime: 60_000, retry: false });
  const session = query.data ?? null;
  return {
    loading: query.isPending,
    userId: session?.user.id ?? null,
    profile: session ? profileFrom(session) : null,
    session,
  };
}

export function useProfile(): Profile | null {
  return useSession().profile;
}

export function usePermissions(): Permissions {
  const profile = useProfile();
  return getPermissions(profile?.role ?? null);
}

function FullScreenLoader() {
  return (
    <div className="flex h-dvh w-full items-center justify-center bg-bg text-text-muted">
      <span className="font-ui text-sm">Loading…</span>
    </div>
  );
}

function renderOutletOrChildren(children: ReactNode | undefined) {
  return children === undefined ? <Outlet /> : <>{children}</>;
}

/** Signed-in staff only. Without a session the API answers 401 and lib/api.ts navigates to /signin. */
export function RequireStaff({ children }: { children?: ReactNode }) {
  const { loading, session } = useSession();
  if (loading || !session) return <FullScreenLoader />;
  return renderOutletOrChildren(children);
}

export function RequireRole({ roles, children }: { roles: UserRole[]; children?: ReactNode }) {
  const { loading, profile } = useSession();
  if (loading) return <FullScreenLoader />;
  if (!profile || !roles.includes(profile.role)) return <Navigate to="/dashboard" replace />;
  return renderOutletOrChildren(children);
}

export function RequireManager({ children }: { children?: ReactNode }) {
  return <RequireRole roles={['manager']}>{children}</RequireRole>;
}
