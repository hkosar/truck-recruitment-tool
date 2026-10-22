// The SPA's only path to data: same-origin JSON calls to the sign-in server (docs/build-plan/
// 15-qq-infrastructure-reconciliation.md §12.1). The session lives in an HttpOnly cookie the
// page cannot read; writes carry the CSRF token from GET /api/session. A 401 means the session
// is gone: a full page load to /signin clears every in-memory cache.

import type { UserRole } from '../types/domain';

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
}

export interface SessionPayload {
  user: SessionUser;
  sessionKind: 'link' | 'recovery';
  expiresAt: string;
  csrfToken: string;
}

/** A fixed, user-presentable error. `code` comes from the server's fixed vocabulary. */
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(messageFor(status, code));
  }
}

export const DNC_BLOCKED_CODE = 'dnc_blocked';

function messageFor(status: number, code: string): string {
  if (code === 'outcome_unknown') return "We couldn't confirm the save. Refresh to check before trying again.";
  if (code === 'unavailable') return 'The service is temporarily unavailable. Try again in a minute.';
  if (code === 'forbidden') return 'You do not have permission to do that.';
  if (code === 'not_found') return 'Not found.';
  if (code === DNC_BLOCKED_CODE) return 'This carrier is on the do-not-contact list.';
  if (code === 'invalid') return 'That request was not accepted.';
  return `Request failed (${status}).`;
}

let csrfToken: string | undefined;

export function currentCsrfToken(): string | undefined {
  return csrfToken;
}

function signedOut(): never {
  window.location.assign('/signin');
  throw new ApiError(401, 'signed_out');
}

async function parse(response: Response): Promise<unknown> {
  if (response.status === 401) signedOut();
  if (response.status === 204) return null;
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const code = body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : 'error';
    throw new ApiError(response.status, code);
  }
  return body;
}

export async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { method: 'GET', credentials: 'same-origin', signal, headers: { accept: 'application/json' } });
  return (await parse(response)) as T;
}

export async function apiPost<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  if (!csrfToken) await loadSession();
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    signal,
    headers: { 'content-type': 'application/json', accept: 'application/json', 'x-csrf-token': csrfToken ?? '' },
    body: JSON.stringify(body ?? {}),
  });
  return (await parse(response)) as T;
}

/** Calls one of the 17 allow-listed RPCs by name with p_-named arguments. */
export function rpc<T>(name: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
  return apiPost<T>(`/api/rpc/${name}`, args, signal);
}

export async function loadSession(): Promise<SessionPayload> {
  const session = await apiGet<SessionPayload>('/api/session');
  csrfToken = session.csrfToken;
  return session;
}
