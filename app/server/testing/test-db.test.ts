// Enforces test-database isolation (Gate 2 final check 2). Runs always (no database needed).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DB_SUITES, suiteDatabase } from './test-db';

const serverRoot = resolve(import.meta.dirname, '..');
const repoRoot = resolve(serverRoot, '..', '..');
const base = {
  A3_APP_URL: 'postgres://recruiter_app:x@127.0.0.1:55473/tr_signin_test',
  A3_ADMIN_URL: 'postgres://tr_test_admin:y@127.0.0.1:55473/tr_signin_test',
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.ts$/.test(name) ? [path] : [];
  });
}

describe('test-database isolation', () => {
  it('every suite gets its own database; non-loopback or non-tr_ targets are refused', () => {
    const names = DB_SUITES.map((s) => new URL(suiteDatabase(s, base)!.appUrl).pathname);
    expect(names).toEqual(['/tr_signin_test_store', '/tr_signin_test_readiness', '/tr_signin_test_e2e']);
    expect(new Set(names).size).toBe(DB_SUITES.length);
    for (const s of DB_SUITES) expect(new URL(suiteDatabase(s, base)!.adminUrl).pathname).toBe(`/tr_signin_test_${s}`);
    expect(suiteDatabase('store', { ...base, A3_APP_URL: 'postgres://u:p@db.example.com:5432/tr_signin_test' })).toBeUndefined();
    expect(suiteDatabase('store', { ...base, A3_ADMIN_URL: 'postgres://u:p@127.0.0.1:5432/postgres' })).toBeUndefined();
    expect(suiteDatabase('store', {})).toBeUndefined();
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
