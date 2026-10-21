import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLIENT_PING_INTERVAL_MS, createActivityReporter, type NavigationTrigger } from './activity';

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
