// OFFLINE TESTS (TRUCKRECRU-49 review B1): the app's Database refuses a staging-2 URL that is not the Supabase session pooler
// before its pg.Pool exists (pipeline/src/staging2-pooler.ts, refusal staging2_pooler_required). Nothing is dialled: each pool
// that is built is closed unused. FAKE URLs and passwords only.

import { describe, expect, it } from 'vitest';
import { RunnerRefusal } from '../../../pipeline/src/refusals';
import { RECORDED_PROJECT_REFS } from '../../../pipeline/src/target-guard';
import { Database } from './database';

const STG2 = RECORDED_PROJECT_REFS.stagingRebuilt as string;
const PROD = RECORDED_PROJECT_REFS.production;
const PW = 'Fake-App-Pooler-Pw-4410-not-real';
const POOLER = 'aws-0-us-east-2.pooler.supabase.com'; // fake label in the shape this repository's tests use
const FORBIDDEN = [PW, STG2, 'supabase.co', 'pooler.supabase.com', 'postgresql://', '10.0.0.5'];

const refusalOf = (connectionString: string): RunnerRefusal | 'built' | unknown => {
  try {
    void new Database({ connectionString }).close();
    return 'built';
  } catch (e) {
    return e;
  }
};

describe('Database: staging-2 only through the session pooler', () => {
  it.each([
    ['the direct host, plain login (review reproduction)', `postgresql://recruiter_app:${PW}@db.${STG2}.supabase.co:5432/postgres`],
    ['the direct host, pooler-style login', `postgresql://recruiter_app.${STG2}:${PW}@db.${STG2}.supabase.co:5432/postgres`],
    ['a multi-label pooler host', `postgresql://recruiter_app.${STG2}:${PW}@a.b.pooler.supabase.com:5432/postgres`],
    ['the pooler host on the transaction port', `postgresql://recruiter_app.${STG2}:${PW}@${POOLER}:6543/postgres`],
    ['an IP host with an upper-case staging-2 ref in the login', `postgresql://recruiter_app.${STG2.toUpperCase()}:${PW}@10.0.0.5:5432/postgres`],
    ['a look-alike .invalid name that does not end in .invalid', `postgresql://recruiter_app.${STG2}:${PW}@x.invalid.example:5432/postgres`],
  ])('refuses %s with staging2_pooler_required and no part of the URL', (_name, url) => {
    const e = refusalOf(url);
    expect(e).toBeInstanceOf(RunnerRefusal);
    expect((e as RunnerRefusal).id).toBe('staging2_pooler_required');
    const text = `${(e as Error).message} ${(e as Error).stack ?? ''}`.toLowerCase();
    for (const f of FORBIDDEN) expect(text.includes(f.toLowerCase()), `leaks ${f}`).toBe(false);
  });

  it('builds the pool (unused) for the staging-2 pooler, production and loopback: other targets are unaffected', () => {
    expect(refusalOf(`postgresql://recruiter_app.${STG2}:${PW}@${POOLER}:5432/postgres`)).toBe('built');
    expect(refusalOf(`postgresql://recruiter_app:${PW}@db.${PROD}.supabase.co:5432/postgres`)).toBe('built');
    expect(refusalOf(`postgresql://recruiter_app.${PROD}:${PW}@${POOLER}:6543/postgres`)).toBe('built');
    expect(refusalOf(`postgresql://recruiter_app.${STG2}:${PW}@127.0.0.1:54329/postgres`)).toBe('built');
  });
});
