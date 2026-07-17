import type { UserRole } from '../types/domain';

/**
 * can() from profile.role — docs/build-plan/02-frontend-spec.md §1.1.
 * Pure functions only (no React, no fetching) so they're trivial to unit
 * test and safe to call from anywhere, incl. app/guards.tsx's route guards
 * and non-component code. `role` is nullable throughout: guests mid-
 * approval, signed-out visitors, and "still loading the profile" all read
 * as "no permissions" rather than needing a separate loading branch.
 *
 * RLS enforces every one of these server-side already (01 §6) — this is
 * strictly a UI convenience (hide/disable controls a request would 403 on
 * anyway), never the actual security boundary.
 */
export interface Permissions {
  /** role in ('manager','edit') — create/refresh batches, log contact,
   * change status, bulk actions, curate facets. */
  canEdit: boolean;
  /** role === 'manager' — Users admin, deletes, curation writes. */
  isManager: boolean;
  /** role === 'view' — read-only staff. */
  isViewer: boolean;
  /** role === 'guest' or no profile yet (pending approval / signed out). */
  isGuest: boolean;
}

export function getPermissions(role: UserRole | null | undefined): Permissions {
  return {
    canEdit: role === 'manager' || role === 'edit',
    isManager: role === 'manager',
    isViewer: role === 'view',
    isGuest: role == null || role === 'guest',
  };
}

/** `can(role, 'edit')` mirrors canEdit; `can(role, 'manage')` mirrors
 * isManager. Convenience for call sites that already have a bare role and
 * want a single boolean rather than destructuring getPermissions(). */
export function can(role: UserRole | null | undefined, action: 'edit' | 'manage'): boolean {
  const permissions = getPermissions(role);
  return action === 'manage' ? permissions.isManager : permissions.canEdit;
}
