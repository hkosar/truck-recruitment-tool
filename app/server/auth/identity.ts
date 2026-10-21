// Email normalization, masking and role sets.

/** "Is there anything here to bucket at all" (Quote-Queue request route :148-150), not RFC validation. */
export function isSyntacticallyValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/** Trim + lower-case; the database compares lower(email) the same way. */
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/** First character + "•••" + "@domain" (Quote-Queue lib/auth/mask.ts:37-46). */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at < 0) return email;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return `${local.length > 0 ? `${local[0]}•••` : '•••'}@${domain}`;
}

// Roles are compared ONLY by membership in explicit sets. `user_role` is declared
// ('manager','edit','view','guest'), so any ordering comparison would reverse permissions
// (doc 15 §14.1).
export type UserRole = 'manager' | 'edit' | 'view' | 'guest';
export type UserStatus = 'pending' | 'approved' | 'disabled';
export type SessionKind = 'link' | 'recovery';

export const STAFF: ReadonlySet<UserRole> = new Set<UserRole>(['manager', 'edit', 'view']);
export const EDITOR: ReadonlySet<UserRole> = new Set<UserRole>(['manager', 'edit']);
export const MANAGER: ReadonlySet<UserRole> = new Set<UserRole>(['manager']);

export function isActiveStaff(role: UserRole, status: UserStatus): boolean {
  return status === 'approved' && STAFF.has(role);
}

export function roleAllowed(role: UserRole, status: UserStatus, allowed: ReadonlySet<UserRole>): boolean {
  return status === 'approved' && allowed.has(role);
}

/** UI labels; stored values stay manager/edit/view. */
export const ROLE_LABEL: Record<Exclude<UserRole, 'guest'>, string> = {
  manager: 'Manager',
  edit: 'Editor',
  view: 'Viewer',
};
