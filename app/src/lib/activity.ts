// Activity ping for session renewal (docs/build-plan/14-same-origin-signin-design.md §3.5).
//
// The SPA has no full page loads between screens, so an in-app navigation the PERSON caused
// is reported with one POST /api/session/activity. It is never sent from timers, prefetch,
// focus/visibility changes, background refetch or app start-up. Only the router's
// user-navigation handler may call `reportUserNavigation` (enforced by activity.test.ts).
// Not wired yet: the server route arrives with the server slice.

export type NavigationTrigger = 'click' | 'keyboard' | 'history';

const USER_TRIGGERS: ReadonlySet<string> = new Set(['click', 'keyboard', 'history']);

/** Client-side spacing between pings; the server also counts at most one per 60 s. */
export const CLIENT_PING_INTERVAL_MS = 60_000;

export interface ActivityDeps {
  send: () => Promise<void>;
  now: () => number;
}

export function createActivityReporter(deps: ActivityDeps) {
  let lastSentAt: number | undefined;
  return {
    /** Returns true if a ping was sent. Anything that is not a user trigger is ignored. */
    reportUserNavigation(trigger: NavigationTrigger): boolean {
      if (!USER_TRIGGERS.has(trigger)) return false;
      const now = deps.now();
      if (lastSentAt !== undefined && now - lastSentAt < CLIENT_PING_INTERVAL_MS) return false;
      lastSentAt = now;
      void deps.send().catch(() => {
        // A failed ping changes nothing visible; a 401 is handled by the next data request.
      });
      return true;
    },
  };
}

/** The real sender: same-origin POST with the session's CSRF token, empty body. */
export function activitySender(getCsrfToken: () => string | undefined): () => Promise<void> {
  return async () => {
    const token = getCsrfToken();
    if (!token) return;
    await fetch('/api/session/activity', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'x-csrf-token': token },
    });
  };
}
