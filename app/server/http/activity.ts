// Deliberate-use rules for session renewal (doc 14 §3.5, coordinator item 3).
//
// Renewal happens only for: a top-level document navigation that is not a prefetch; a
// write operation on the explicit allowlist below (never "any POST": read-only RPCs and the
// DNC lookup are POSTs too, and background queries must not renew); or the SPA activity ping,
// which must pass session + strict Origin + CSRF checks (done by the route) and this module's
// throttle. Background reads never renew, for either session kind.

export type SessionKind = 'link' | 'recovery';

/** Idle window and absolute cap per session kind (doc 14 §3.5). */
export const SESSION_WINDOWS: Record<SessionKind, { idleMs: number; absoluteMs: number; renewThrottleMs: number }> = {
  link: { idleMs: 30 * 24 * 3600_000, absoluteMs: 90 * 24 * 3600_000, renewThrottleMs: 5 * 60_000 },
  recovery: { idleMs: 3600_000, absoluteMs: 12 * 3600_000, renewThrottleMs: 60_000 },
};

/** At most one counted activity ping per session per 60 seconds. */
export const PING_THROTTLE_MS = 60_000;

type HeaderBag = { get(name: string): string | null };

export function isPrefetch(headers: HeaderBag): boolean {
  const purpose = `${headers.get('sec-purpose') ?? ''} ${headers.get('purpose') ?? ''}`.toLowerCase();
  return purpose.includes('prefetch') || purpose.includes('prerender');
}

/** A real, user-initiated top-level page load. */
export function isDeliberateNavigation(method: string, headers: HeaderBag): boolean {
  return (
    method === 'GET' &&
    headers.get('sec-fetch-mode') === 'navigate' &&
    headers.get('sec-fetch-dest') === 'document' &&
    !isPrefetch(headers)
  );
}

/** RPCs that write (doc 15 §14.1 M7, M10–M12). Every other allow-listed RPC is a read. */
export const WRITE_RPCS: ReadonlySet<string> = new Set(['create_batch', 'refresh_batch', 'bulk_set_status', 'set_do_not_contact', 'log_export']);

/** Write routes that count as deliberate use (method + exact path pattern). */
const WRITE_ROUTES: ReadonlyArray<{ method: 'POST'; path: RegExp }> = [
  { method: 'POST', path: /^\/api\/batch-carriers\/status$/ },
  { method: 'POST', path: /^\/api\/batch-carriers\/promote$/ },
  { method: 'POST', path: /^\/api\/batches\/[0-9a-f-]{36}\/comments$/ },
  { method: 'POST', path: /^\/api\/contact-logs$/ },
  { method: 'POST', path: /^\/api\/batches\/[0-9a-f-]{36}\/(export-csv|rename|delete)$/ },
  { method: 'POST', path: /^\/api\/team\/(edit|deactivate|reactivate|block-clear|recovery-revoke)$/ },
  { method: 'POST', path: /^\/api\/recovery\/batch-carriers\/status$/ },
  { method: 'POST', path: /^\/api\/recovery-codes$/ },
];

export const ACTIVITY_PING_PATH = '/api/session/activity';

export type RenewalReason = 'navigation' | 'write' | 'ping' | 'none';

/**
 * Whether this request may renew the session (the ping is further throttled by PingThrottle;
 * the database renewal is throttled again). Same rule for link and recovery sessions; the
 * recovery matrix decides separately whether a recovery session may call the route at all.
 */
export function renewalReason(method: string, path: string, headers: HeaderBag): RenewalReason {
  if (isDeliberateNavigation(method, headers)) return 'navigation';
  if (method !== 'POST' || isPrefetch(headers)) return 'none';
  if (path === ACTIVITY_PING_PATH) return 'ping';
  const rpc = /^\/api\/rpc\/([a-z_]+)$/.exec(path);
  if (rpc) return WRITE_RPCS.has(rpc[1]) ? 'write' : 'none';
  return WRITE_ROUTES.some((r) => r.method === method && r.path.test(path)) ? 'write' : 'none';
}

/** New expiry after a renewal; never past the absolute cap. */
export function renewedExpiry(kind: SessionKind, nowMs: number, absoluteExpiresAtMs: number): number {
  return Math.min(nowMs + SESSION_WINDOWS[kind].idleMs, absoluteExpiresAtMs);
}

/**
 * Per-process ping throttle. Returns true when this ping may count. The database renewal
 * behind it has its own throttle, so a second server process can at most double the counted
 * pings, never extend past the database rules.
 */
export class PingThrottle {
  private readonly last = new Map<string, number>();

  constructor(private readonly windowMs = PING_THROTTLE_MS, private readonly maxEntries = 10_000) {}

  allow(sessionKey: string, nowMs: number): boolean {
    const previous = this.last.get(sessionKey);
    if (previous !== undefined && nowMs - previous < this.windowMs) return false;
    if (this.last.size >= this.maxEntries) this.prune(nowMs);
    this.last.set(sessionKey, nowMs);
    return true;
  }

  private prune(nowMs: number): void {
    for (const [key, at] of this.last) if (nowMs - at >= this.windowMs) this.last.delete(key);
    if (this.last.size >= this.maxEntries) this.last.clear();
  }
}
