import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RETENTION_RULES, runRetention, type Queryable } from './retention';

const M1 = readFileSync(resolve(import.meta.dirname, '../../../supabase/pending/M1_same_origin_signin.sql'), 'utf8');

function fakeDb(counts: Record<string, number[]>, failOn?: string): Queryable & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    async query(sql: string) {
      log.push(sql);
      const table = /delete from ([\w.]+)/.exec(sql)?.[1];
      if (!table) return { rowCount: null };
      if (table === failOn) throw new Error('boom');
      const queue = counts[table] ?? [];
      return { rowCount: queue.length ? queue.shift()! : 0 };
    },
  };
}

describe('retention', () => {
  it('events are kept longer than links, and the link foreign key cannot block link deletion', () => {
    const days = (rule: string) => Number(/interval '(\d+) (days|hours)'/.exec(RETENTION_RULES.find((r) => r.name === rule)!.where)![1]);
    expect(days('email_events')).toBe(180);
    expect(days('signin_links')).toBe(30);
    // The schema side of the same guarantee: the event's link reference is SET NULL and the
    // event keeps its own recipient and message-id snapshot.
    expect(M1).toMatch(/link_id\s+uuid references internal\.signin_links\(id\) on delete set null/);
    expect(M1).toMatch(/create table internal\.email_events \([\s\S]*recipient_email\s+text not null/);
  });

  it('never deletes events by link, and every rule uses the wall clock', () => {
    for (const rule of RETENTION_RULES) {
      expect(rule.where).toContain('clock_timestamp()');
      expect(rule.where).not.toMatch(/\bnow\(\)/);
    }
    expect(RETENTION_RULES.find((r) => r.name === 'email_events')!.where).not.toContain('link');
  });

  it('deletes in bounded batches until a short batch, per table', async () => {
    const db = fakeDb({ 'internal.signin_links': [5000, 5000, 12], 'internal.email_events': [3] });
    const result = await runRetention(db, { batchSize: 5000 });
    expect(result.deleted.signin_links).toBe(10_012);
    expect(result.deleted.email_events).toBe(3);
    expect(result.failed).toEqual([]);
    expect(db.log[0]).toBe("set statement_timeout = '30s'");
  });

  it('a failing rule is reported and the others still run', async () => {
    const db = fakeDb({ 'internal.app_sessions': [2] }, 'internal.signin_links');
    const result = await runRetention(db);
    expect(result.failed).toEqual(['signin_links']);
    expect(result.deleted.app_sessions).toBe(2);
  });

  it('stops after the per-rule batch cap', async () => {
    const db = fakeDb({ 'internal.auth_request_buckets': Array(10).fill(1) });
    const result = await runRetention(db, { batchSize: 1, maxBatchesPerRule: 3 });
    expect(result.deleted.request_buckets).toBe(3);
  });
});
