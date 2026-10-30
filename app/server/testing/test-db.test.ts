// Enforces test-database isolation (Gate 2 final check 2). Runs always (no database needed).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DB_SUITES, claimSuiteDatabase, suiteDatabase } from './test-db';
// claimSuiteDatabase is exercised against a real database by the A3 suites themselves; the dropped-connection case is offline below.

const serverRoot = resolve(import.meta.dirname, '..');
const repoRoot = resolve(serverRoot, '..', '..');
const base = {
  A3_APP_URL: 'postgres://recruiter_app:x@127.0.0.1:55473/tr_signin_test',
  A3_ADMIN_URL: 'postgres://tr_test_admin:y@127.0.0.1:55473/tr_signin_test',
  A3_RUN_ID: 'm1',
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.ts$/.test(name) ? [path] : [];
  });
}

describe('test-database isolation', () => {
  it('every suite gets its own database per run; non-loopback or non-tr_ targets are refused', () => {
    const names = DB_SUITES.map((s) => new URL(suiteDatabase(s, base)!.appUrl).pathname);
    expect(names).toEqual(['/tr_signin_test_m1_store', '/tr_signin_test_m1_readiness', '/tr_signin_test_m1_e2e']);
    expect(new Set(names).size).toBe(DB_SUITES.length);
    for (const s of DB_SUITES) expect(new URL(suiteDatabase(s, base)!.adminUrl).pathname).toBe(`/tr_signin_test_m1_${s}`);
    // Two concurrent processes with different run ids never derive the same database.
    expect(new URL(suiteDatabase('store', { ...base, A3_RUN_ID: 'g1' })!.appUrl).pathname).not.toBe(new URL(suiteDatabase('store', { ...base, A3_RUN_ID: 'g2' })!.appUrl).pathname);
    expect(suiteDatabase('store', { ...base, A3_APP_URL: 'postgres://u:p@db.example.com:5432/tr_signin_test' })).toBeUndefined();
    expect(suiteDatabase('store', { ...base, A3_ADMIN_URL: 'postgres://u:p@127.0.0.1:5432/postgres' })).toBeUndefined();
    expect(suiteDatabase('store', {})).toBeUndefined();
  });

  it('with A3 settings present, a missing or invalid run id fails loudly instead of sharing a database', () => {
    for (const run of [undefined, '', 'X', 'has space', 'a'.repeat(17), '1abc']) {
      expect(() => suiteDatabase('store', { ...base, A3_RUN_ID: run })).toThrow(/A3_RUN_ID/);
    }
  });

  it('no test file reads the database settings directly, and no two files claim the same suite', () => {
    const direct: string[] = [];
    const claims = new Map<string, string[]>();
    for (const file of sourceFiles(serverRoot)) {
      const rel = relative(serverRoot, file).replace(/\\/g, '/');
      if (rel === 'testing/test-db.ts' || rel === 'testing/test-db.test.ts') continue;
      const text = readFileSync(file, 'utf8');
      if (/process\.env\.A3_(APP|ADMIN)_URL/.test(text)) direct.push(rel);
      for (const m of text.matchAll(/suiteDatabase\('([a-z0-9]+)'/g)) claims.set(m[1], [...(claims.get(m[1]) ?? []), rel]);
    }
    expect(direct).toEqual([]);
    // Every suite file also claims its database exclusively for its whole run.
    const unclaimed = [...new Set([...claims.values()].flat())].filter((rel) => !/await claimSuiteDatabase\(/.test(readFileSync(join(serverRoot, rel), 'utf8')));
    expect(unclaimed).toEqual([]);
    expect([...claims.entries()].filter(([, files]) => new Set(files).size > 1)).toEqual([]);
    // The three DB-using suites are covered, each by exactly one file.
    expect(Object.fromEntries([...claims.entries()].map(([s, files]) => [s, [...new Set(files)]]))).toEqual({
      store: ['db/pg.db.test.ts'],
      readiness: ['db/readiness.db.test.ts'],
      e2e: ['e2e.http.test.ts'],
    });
  });

  it('the owned builder creates exactly these suite databases', () => {
    const builder = readFileSync(join(repoRoot, 'scripts', 'a3-build-test-db.mjs'), 'utf8');
    const literal = /const SUITES = \[([^\]]*)\];/.exec(builder)?.[1] ?? '';
    expect(literal.split(',').map((s) => s.trim().replace(/'/g, ''))).toEqual([...DB_SUITES]);
  });
});

// A dropped connection on the claim's session must not be an uncaught exception, and it must not
// pass silently either: the advisory lock went with the connection, so the suite fails at release.
describe('claimSuiteDatabase: the claim connection drops', () => {
  afterEach(() => vi.restoreAllMocks());
  const admin = 'postgres://tr_test_admin:y@127.0.0.1:55473/tr_signin_test_m1_store';

  it('is handled, not thrown, and the release then fails loudly', async () => {
    const clients: EventEmitter[] = [];
    vi.spyOn(pg.Client.prototype, 'connect').mockImplementation(function (this: EventEmitter) {
      clients.push(this);
      return Promise.resolve() as never;
    });
    vi.spyOn(pg.Client.prototype, 'query').mockImplementation((() => Promise.resolve({ rows: [{ ok: true }] })) as never);
    vi.spyOn(pg.Client.prototype, 'end').mockImplementation((() => Promise.reject(new Error('dead connection'))) as never);
    const release = await claimSuiteDatabase(admin);
    expect(clients[0]!.listenerCount('error')).toBeGreaterThan(0);
    expect(() => clients[0]!.emit('error', new Error('Connection terminated unexpectedly'))).not.toThrow();
    await expect(release()).rejects.toThrow(/claim on test database tr_signin_test_m1_store was lost/);
  });

  it('a healthy claim releases quietly', async () => {
    vi.spyOn(pg.Client.prototype, 'connect').mockImplementation((() => Promise.resolve()) as never);
    vi.spyOn(pg.Client.prototype, 'query').mockImplementation((() => Promise.resolve({ rows: [{ ok: true }] })) as never);
    vi.spyOn(pg.Client.prototype, 'end').mockImplementation((() => Promise.resolve()) as never);
    await expect((await claimSuiteDatabase(admin))()).resolves.toBeUndefined();
  });
});
