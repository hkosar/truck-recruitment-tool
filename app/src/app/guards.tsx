import { useEffect, useState } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { queryKeys } from '../lib/queryKeys';
import { getPermissions } from '../lib/permissions';
import type { Permissions } from '../lib/permissions';
import type { Profile, UserRole } from '../types/domain';

/**
 * RequireAuth / RequireApproved / RequireManager — docs/build-plan/
 * 02-frontend-spec.md §1.2 routing guards, gated on the `profiles` row per
 * §1.4: `status='pending'` (or role `guest`) hard-redirects to `/pending`
 * from every app route (the v1 guest gate, kept); `status='disabled'`
 * signs out + redirects to `/login` (amendment #14 — 02's prose said
 * "suspended", the canonical `user_status` value is `disabled`).
 *
 * Also exports RequireAnon (anon-only auth screens) and RequireRole (the
 * general "manager|edit" case /batches/new needs — §1.2's routing table has
 * more than the three guard names this file's spec comment lists;
 * RequireManager is RequireRole(['manager']) underneath).
 */

// ---------------------------------------------------------------------------
// Session/profile plumbing
// ---------------------------------------------------------------------------
async function fetchProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle();
  if (error) throw error;
  return data;
}

function useAuthUserId(): { loading: boolean; userId: string | null } {
  const [state, setState] = useState<{ loading: boolean; userId: string | null }>({
    loading: true,
    userId: null,
  });

  useEffect(() => {
    let active = true;

    supabase.auth.getSession().then(({ data }) => {
      if (active) setState({ loading: false, userId: data.session?.user.id ?? null });
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setState({ loading: false, userId: session?.user.id ?? null });
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  return state;
}

export interface SessionState {
  /** true until the initial auth check AND (if authed) the profile fetch
   * both resolve. */
  loading: boolean;
  userId: string | null;
  profile: Profile | null;
}

export function useSession(): SessionState {
  const { loading: authLoading, userId } = useAuthUserId();

  const profileQuery = useQuery({
    queryKey: queryKeys.me(),
    queryFn: () => fetchProfile(userId as string),
    enabled: Boolean(userId),
  });

  return {
    loading: authLoading || (Boolean(userId) && profileQuery.isPending),
    userId,
    profile: profileQuery.data ?? null,
  };
}

export function useProfile(): Profile | null {
  return useSession().profile;
}

export function usePermissions(): Permissions {
  const profile = useProfile();
  return getPermissions(profile?.role ?? null);
}

// ---------------------------------------------------------------------------
// UI bits
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/** anon-only auth screens (§1.2: /login, /register, /forgot). Any
 * authenticated session — regardless of approval status — bounces to `/`,
 * where RequireAuth -> RequireApproved sort out the correct destination
 * (pending/disabled/approved), so the branching logic has one owner. */
export function RequireAnon({ children }: { children?: ReactNode }) {
  const { loading, userId } = useSession();
  if (loading) return <FullScreenLoader />;
  if (userId) return <Navigate to="/" replace />;
  return renderOutletOrChildren(children);
}

export function RequireAuth({ children }: { children?: ReactNode }) {
  const { loading, userId } = useSession();
  const location = useLocation();
  if (loading) return <FullScreenLoader />;
  if (!userId) return <Navigate to="/login" state={{ from: location }} replace />;
  return renderOutletOrChildren(children);
}

/** Must render under RequireAuth (or checks auth itself, as here, so it's
 * also safe to use standalone). */
export function RequireApproved({ children }: { children?: ReactNode }) {
  const { loading, userId, profile } = useSession();
  const location = useLocation();

  if (loading) return <FullScreenLoader />;
  if (!userId) return <Navigate to="/login" state={{ from: location }} replace />;

  if (profile?.status === 'disabled') {
    void supabase.auth.signOut();
    return <Navigate to="/login" replace />;
  }
  if (!profile || profile.status === 'pending' || profile.role === 'guest') {
    return <Navigate to="/pending" replace />;
  }

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
