// Recovery permission matrix (doc 14 §7.3, default proposal; policy D2 open). Deny by default.
// The database is the authority (recovery_* functions check the session kind and the live
// ordinary role); this Worker-side copy is defence in depth and routing only.

import { EDITOR, roleAllowed, STAFF, type SessionKind, type UserRole, type UserStatus } from '../auth/identity';

export interface MatrixEntry {
  method: 'GET' | 'POST';
  path: RegExp;
  dbFunction: string;
  allowedRoles: ReadonlySet<UserRole>;
  kinds: ReadonlySet<SessionKind>;
}

const RECOVERY = new Set<SessionKind>(['recovery']);
const ANY_KIND = new Set<SessionKind>(['link', 'recovery']);

export const RECOVERY_MATRIX: readonly MatrixEntry[] = [
  { method: 'GET', path: /^\/api\/session$/, dbFunction: 'internal.current_session', allowedRoles: STAFF, kinds: ANY_KIND },
  { method: 'GET', path: /^\/api\/recovery\/batches$/, dbFunction: 'public.recovery_batches', allowedRoles: STAFF, kinds: RECOVERY },
  { method: 'GET', path: /^\/api\/recovery\/batches\/[0-9a-f-]{36}\/members$/, dbFunction: 'public.recovery_batch_members', allowedRoles: STAFF, kinds: RECOVERY },
  { method: 'POST', path: /^\/api\/recovery\/batch-carriers\/status$/, dbFunction: 'public.recovery_set_status', allowedRoles: EDITOR, kinds: RECOVERY },
  { method: 'POST', path: /^\/api\/session\/activity$/, dbFunction: 'internal.auth_session_touch', allowedRoles: STAFF, kinds: ANY_KIND },
  { method: 'POST', path: /^\/auth\/signout$/, dbFunction: 'internal.auth_session_revoke', allowedRoles: STAFF, kinds: ANY_KIND },
];

/** Whether a recovery session may call this route, given the person's ordinary role. */
export function recoveryRouteAllowed(method: string, path: string, role: UserRole, status: UserStatus): boolean {
  const entry = RECOVERY_MATRIX.find((e) => e.method === method && e.path.test(path));
  if (!entry || !entry.kinds.has('recovery')) return false;
  return roleAllowed(role, status, entry.allowedRoles);
}

/** Columns a recovery read may return (explicit; no contact details, notes or colleague data). */
export const RECOVERY_COLUMNS = {
  batches: ['id', 'name', 'customer', 'job', 'created_at', 'counts_by_status'],
  members: ['dot_number', 'legal_name', 'dba_name', 'phy_city', 'phy_state', 'status', 'status_changed_at', 'is_dnc'],
} as const;

/** Off unless explicitly enabled; anything other than the exact string "true" is off. */
export function recoveryEnabled(env: Record<string, string | undefined>): boolean {
  return env.RECOVERY_ENABLED === 'true';
}
