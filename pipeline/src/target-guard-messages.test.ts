// TRUCKRECRU-63: target-guard refusal messages name the rule that failed, never a project ref, host or user.
// FAKE refs only (20 invented lowercase letters). Nothing is dialled.
// Run: tsx src/target-guard-messages.test.ts

import assert from 'node:assert/strict';
import { RECORDED_PROJECT_REFS, parseSupabaseDbTarget, verifyPipelineTarget } from './target-guard.js';

const REF_A = 'qwertyuiopasdfghjklz';
const REF_B = 'zxcvbnmlkjhgfdsapoiu';
const REF_C = 'mnbvcxzlkjhgfdsaqwer';
const api = (ref: string) => `https://${ref}.supabase.co`;
const pooler = (ref: string) => `postgresql://postgres.${ref}:Fake-Pw-NOT-REAL-1@aws-0-us-east-2.pooler.supabase.com:5432/postgres`;

const seen: string[] = [];
function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    const m = (e as Error).message;
    seen.push(m);
    return m;
  }
  throw new Error('expected a refusal');
}

const messages = {
  invalidApiRef: refusal(() => verifyPipelineTarget({ environment: 'dev', supabaseUrl: `https://${REF_A}x.supabase.co`, supabaseDbUrl: pooler(REF_A), allowedDevRefs: [REF_A] })),
  mismatch: refusal(() => verifyPipelineTarget({ environment: 'dev', supabaseUrl: api(REF_A), supabaseDbUrl: pooler(REF_B), allowedDevRefs: [REF_A, REF_B] })),
  prodWrongRef: refusal(() => verifyPipelineTarget({ environment: 'prod', supabaseUrl: api(REF_A), supabaseDbUrl: pooler(REF_A) })),
  devNotAllowed: refusal(() => verifyPipelineTarget({ environment: 'dev', supabaseUrl: api(REF_A), supabaseDbUrl: pooler(REF_A), allowedDevRefs: [REF_C] })),
  devProd: refusal(() => verifyPipelineTarget({ environment: 'dev', supabaseUrl: api((RECORDED_PROJECT_REFS.production as string)), supabaseDbUrl: pooler((RECORDED_PROJECT_REFS.production as string)), allowedDevRefs: [(RECORDED_PROJECT_REFS.production as string)] })),
  stagingWrites: refusal(() => verifyPipelineTarget({ environment: 'dev', supabaseUrl: api(RECORDED_PROJECT_REFS.staging as string), supabaseDbUrl: pooler(RECORDED_PROJECT_REFS.staging as string), allowedDevRefs: [RECORDED_PROJECT_REFS.staging as string] })),
  dbHostUserMismatch: refusal(() => parseSupabaseDbTarget(`postgresql://postgres.${REF_B}:Fake-Pw-NOT-REAL-1@db.${REF_A}.supabase.co:5432/postgres`)),
  dbInvalidRef: refusal(() => parseSupabaseDbTarget(`postgresql://postgres.${REF_A}x:Fake-Pw-NOT-REAL-1@aws-0-us-east-2.pooler.supabase.com:5432/postgres`)),
};

assert.match(messages.invalidApiRef, /invalid project ref/);
assert.match(messages.mismatch, /SUPABASE_DB_URL and SUPABASE_URL name different projects/);
assert.match(messages.prodWrongRef, /requires the recorded production Carrier Recruiter project/);
assert.match(messages.devNotAllowed, /not in PIPELINE_ALLOWED_DEV_REFS/);

const forbidden = [REF_A, REF_B, REF_C, (RECORDED_PROJECT_REFS.production as string), ...Object.values(RECORDED_PROJECT_REFS).filter(Boolean) as string[], 'supabase.co', 'pooler', 'Fake-Pw'];
for (const [name, text] of Object.entries(messages)) {
  for (const bad of forbidden) {
    assert.ok(!text.includes(bad), `${name} message leaks ${bad === REF_A || bad === REF_B || bad === REF_C ? 'a fake ref' : 'a recorded value'}`);
  }
  assert.ok(!/[a-z]{20}/.test(text), `${name} message contains a 20-letter ref-shaped word`);
}
console.log(`target-guard-messages: ${seen.length} refusal messages checked, none contains a ref/host/user`);
