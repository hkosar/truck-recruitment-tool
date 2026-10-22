import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLIENT_PING_INTERVAL_MS, createActivityReporter, GESTURE_WINDOW_MS, wireNavigationActivity, type NavigationSource, type NavigationTrigger } from './activity';

afterEach(() => {
  vi.useRealTimers();
});

describe('activity reporter', () => {
  it('sends for a user navigation and spaces pings 60 s apart', () => {
    let t = 0;
    const send = vi.fn(async () => {});
    const reporter = createActivityReporter({ send, now: () => t });
    expect(reporter.reportUserNavigation('click')).toBe(true);
    t += 1_000;
    expect(reporter.reportUserNavigation('history')).toBe(false);
    t += CLIENT_PING_INTERVAL_MS;
    expect(reporter.reportUserNavigation('keyboard')).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('ignores anything that is not a user trigger (timer, prefetch, focus, refetch)', () => {
    const send = vi.fn(async () => {});
    const reporter = createActivityReporter({ send, now: () => 0 });
    for (const trigger of ['timer', 'prefetch', 'focus', 'visibility', 'refetch', 'startup']) {
      expect(reporter.reportUserNavigation(trigger as NavigationTrigger)).toBe(false);
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('a timer by itself never sends', () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => {});
    createActivityReporter({ send, now: () => Date.now() });
    vi.advanceTimersByTime(10 * CLIENT_PING_INTERVAL_MS);
    expect(send).not.toHaveBeenCalled();
  });

  it('a failed ping does not throw', async () => {
    const reporter = createActivityReporter({ send: async () => { throw new Error('offline'); }, now: () => 0 });
    expect(reporter.reportUserNavigation('click')).toBe(true);
    await Promise.resolve();
  });
});

describe('router-driven navigation pings (Gate 2 finding 6)', () => {
  function harness() {
    let t = 1_000;
    const listeners = new Map<string, (e: { key?: string; button?: number }) => void>();
    let sub: ((s: { location: { key: string }; historyAction: string; navigation: { state: string } }) => void) | undefined;
    const router: NavigationSource = { state: { location: { key: 'k0' } }, subscribe: (fn) => { sub = fn; return () => {}; } };
    const reports: NavigationTrigger[] = [];
    const historyCalls: string[] = [];
    const history = { go: (d?: number) => { historyCalls.push(`go(${d})`); }, back: () => { historyCalls.push('back'); }, forward: () => { historyCalls.push('forward'); } };
    wireNavigationActivity({
      router,
      target: { addEventListener: (type, fn, opts) => { expect(opts.capture).toBe(true); listeners.set(type, fn); } },
      report: (trigger) => { reports.push(trigger); return true; },
      now: () => t,
      history,
    });
    let n = 0;
    return {
      reports,
      history,
      historyCalls,
      fire: (type: string, e: { key?: string; button?: number } = {}) => listeners.get(type)!(e),
      navigate: (historyAction = 'PUSH', state = 'idle', sameKey = false) => sub!({ location: { key: sameKey ? `k${n}` : `k${++n}` }, historyAction, navigation: { state } }),
      advance: (ms: number) => { t += ms; },
    };
  }

  it('a link click (pointer then click, captured before React Router prevents the default) pings once the navigation completes', () => {
    const h = harness();
    h.fire('pointerdown', { button: 0 });
    h.fire('click', { button: 0 });
    h.navigate('PUSH', 'loading');
    expect(h.reports).toEqual([]);
    h.navigate('PUSH', 'idle');
    expect(h.reports).toEqual(['click']);
  });

  it('keyboard activation (Enter or Space) pings as keyboard; other keys do not count', () => {
    const h = harness();
    h.fire('keydown', { key: 'Enter' });
    h.navigate();
    h.fire('keydown', { key: ' ' });
    h.navigate();
    h.fire('keydown', { key: 'a' });
    h.navigate();
    expect(h.reports).toEqual(['keyboard', 'keyboard']);
  });

  it('a programmatic history move (a timer calling navigate(-1) -> history.go) does not ping; the call still goes through', () => {
    const h = harness();
    h.history.go(-1);
    h.navigate('POP');
    h.history.back();
    h.navigate('POP');
    h.history.forward();
    h.navigate('POP');
    expect(h.reports).toEqual([]);
    expect(h.historyCalls).toEqual(['go(-1)', 'back', 'forward']);
  });

  it('an in-app Back control the person pressed (click, then history.back) pings as click', () => {
    const h = harness();
    h.fire('click', { button: 0 });
    h.history.back();
    h.navigate('POP');
    expect(h.reports).toEqual(['click']);
  });

  it('the browser back/forward controls (POP with no script history call) ping as history', () => {
    const h = harness();
    h.navigate('POP');
    expect(h.reports).toEqual(['history']);
  });

  it('programmatic navigation with no recent gesture, a stale gesture, a right click or a same-location revalidation does not ping', () => {
    const h = harness();
    h.navigate('PUSH');
    h.navigate('REPLACE');
    h.fire('click', { button: 0 });
    h.advance(GESTURE_WINDOW_MS + 1);
    h.navigate('PUSH');
    h.fire('pointerdown', { button: 2 });
    h.navigate('PUSH');
    h.fire('click', { button: 0 });
    h.navigate('PUSH', 'idle', true);
    expect(h.reports).toEqual([]);
  });

  it('one gesture counts for one navigation only', () => {
    const h = harness();
    h.fire('click', { button: 0 });
    h.navigate();
    h.navigate();
    expect(h.reports).toEqual(['click']);
  });
});

describe('only the router may import the activity module', () => {
  it('no other source file imports lib/activity', () => {
    const srcRoot = resolve(import.meta.dirname, '..');
    const allowed = new Set(['app/router.tsx', 'lib/activity.ts', 'lib/activity.test.ts']);
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(name)) {
          const rel = relative(srcRoot, path).replace(/\\/g, '/');
          if (!allowed.has(rel) && /from ['"][./]*(lib\/)?activity['"]/.test(readFileSync(path, 'utf8'))) offenders.push(rel);
        }
      }
    };
    walk(srcRoot);
    expect(offenders).toEqual([]);
  });
});
