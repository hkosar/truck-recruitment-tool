// Activity ping for session renewal (docs/build-plan/14-same-origin-signin-design.md §3.5).
//
// The SPA has no full page loads between screens, so an in-app navigation the PERSON caused
// is reported with one POST /api/session/activity. It is never sent from timers, prefetch,
// focus/visibility changes, background refetch or app start-up. Only the router's
// user-navigation handler may call `reportUserNavigation` (enforced by activity.test.ts).
// Wired by the router through wireNavigationActivity (below).

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

/** The parts of a React Router data router this module reads (kept minimal for tests). */
export interface NavigationSource {
  state: { location: { key: string } };
  subscribe(listener: (state: { location: { key: string }; historyAction: string; navigation: { state: string } }) => void): () => void;
}

/** The parts of `window` this module listens on. */
export interface GestureTarget {
  addEventListener(type: string, listener: (event: { key?: string; button?: number }) => void, options: { capture: true; passive: true }): void;
}

/** The history methods that page script (including React Router's navigate(-1)) calls. */
export interface HistoryLike {
  go(delta?: number): void;
  back(): void;
  forward(): void;
}

/** A navigation counts as user-caused only within this time after the person's gesture. */
export const GESTURE_WINDOW_MS = 1_500;

/**
 * Report a ping when the ROUTER completes a navigation the person caused (Gate 2 finding 6).
 * React Router handles <Link> clicks itself (it prevents the browser default), so the trigger is
 * the router's own completed location change, attributed to a gesture seen just before it in the
 * CAPTURE phase (pointer, click, or Enter/Space, which also covers keyboard activation of a link),
 * or to the browser's own back/forward (history action POP). Programmatic navigations with no
 * recent gesture (timers, redirects after background work) and revalidations without a location
 * change report nothing.
 *
 * A POP looks the same whether the browser's back button or script caused it (both fire
 * popstate). Script must call history.go/back/forward (React Router's navigate(-1) calls
 * window.history.go), while the browser's own back/forward controls never call page script. So
 * those methods are wrapped to queue a scripted history move. Each POP consumes the oldest
 * queued move, however long the traversal took (a long task can delay it; Gate 2 final check 1),
 * and counts only if a user gesture was recent when the script called (an in-app "Back" button),
 * never on its own (a timer calling navigate(-1)). Queued moves are cancelled by the next PUSH or
 * REPLACE navigation; go(0) (a reload) queues nothing. Only a POP with nothing queued is the
 * browser's own back/forward.
 */
export function wireNavigationActivity(deps: {
  router: NavigationSource;
  target: GestureTarget;
  report: (trigger: NavigationTrigger) => boolean;
  now: () => number;
  history?: HistoryLike;
}): () => void {
  let gesture: { trigger: NavigationTrigger; at: number } | undefined;
  const recent = (at: number | undefined) => at !== undefined && deps.now() - at <= GESTURE_WINDOW_MS;
  // Scripted history moves not yet seen as a POP, oldest first, each with the user gesture (if
  // any) that was recent when the script called.
  const scripted: Array<{ userTrigger: NavigationTrigger | undefined }> = [];
  if (deps.history) {
    const h = deps.history;
    for (const method of ['go', 'back', 'forward'] as const) {
      const original = h[method].bind(h) as (delta?: number) => void;
      h[method] = (delta?: number) => {
        if (!(method === 'go' && !delta)) scripted.push({ userTrigger: gesture && recent(gesture.at) ? gesture.trigger : undefined });
        original(delta);
      };
    }
  }
  const mark = (trigger: NavigationTrigger) => () => {
    gesture = { trigger, at: deps.now() };
  };
  const opts = { capture: true, passive: true } as const;
  deps.target.addEventListener('pointerdown', (e) => { if (e.button === undefined || e.button === 0) mark('click')(); }, opts);
  deps.target.addEventListener('click', (e) => { if (e.button === undefined || e.button === 0) mark('click')(); }, opts);
  deps.target.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') mark('keyboard')(); }, opts);
  let lastKey = deps.router.state.location.key;
  return deps.router.subscribe((state) => {
    if (state.navigation.state !== 'idle' || state.location.key === lastKey) return;
    lastKey = state.location.key;
    const userGesture = gesture && recent(gesture.at) ? gesture.trigger : undefined;
    if (state.historyAction === 'POP') {
      const move = scripted.shift();
      if (!move) deps.report('history'); // the browser's own back/forward
      else if (move.userTrigger) deps.report(move.userTrigger); // an in-app Back control the person pressed
    } else {
      scripted.length = 0; // a new PUSH/REPLACE supersedes any traversal still queued
      if (userGesture) deps.report(userGesture);
    }
    gesture = undefined;
  });
}
