// Tests for scripts/legacy-rehearsal-config.mjs. Run: node --test scripts/legacy-rehearsal-config.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { OLD_STAGING_REF, PRODUCTION_REF, checkBuildEnv, checkNewRef, proveBundle } from './legacy-rehearsal-config.mjs';

const NEW_REF = 'abcdefghijklmnopqrst';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (claims) => `eyJ${b64({ alg: 'HS256' }).slice(3)}.${b64(claims)}.c2lnbmF0dXJlMTIzNDU2`;
const goodEnv = () => ({
  VITE_SUPABASE_URL: `https://${NEW_REF}.supabase.co`,
  VITE_SUPABASE_ANON_KEY: jwt({ role: 'anon', ref: NEW_REF }),
  VITE_EXPECTED_SUPABASE_REF: NEW_REF,
  VITE_APP_ENV: 'staging',
});

test('the new ref must be well formed and neither production nor the old staging project', () => {
  assert.doesNotThrow(() => checkNewRef(NEW_REF));
  assert.throws(() => checkNewRef(PRODUCTION_REF), /production/);
  assert.throws(() => checkNewRef(OLD_STAGING_REF), /OLD staging/);
  assert.throws(() => checkNewRef('short'), /20-letter/);
  assert.throws(() => checkNewRef(undefined), /20-letter/);
});

test('a correct build environment passes, and never needs the key printed', () => {
  assert.deepEqual(checkBuildEnv(goodEnv(), NEW_REF), []);
  assert.deepEqual(checkBuildEnv({ ...goodEnv(), VITE_SUPABASE_ANON_KEY: 'sb_publishable_abcdefghijkl' }, NEW_REF), []);
});

test('the build environment is refused for every wrong target, key or label', () => {
  const bad = (patch, pattern) => assert.ok(checkBuildEnv({ ...goodEnv(), ...patch }, NEW_REF).some((f) => pattern.test(f)), JSON.stringify(patch).slice(0, 60));
  bad({ VITE_SUPABASE_URL: `https://${OLD_STAGING_REF}.supabase.co` }, /VITE_SUPABASE_URL/);
  bad({ VITE_SUPABASE_URL: `https://${PRODUCTION_REF}.supabase.co` }, /VITE_SUPABASE_URL/);
  bad({ VITE_SUPABASE_URL: `https://${NEW_REF}.supabase.co.evil.example` }, /VITE_SUPABASE_URL/);
  bad({ VITE_EXPECTED_SUPABASE_REF: OLD_STAGING_REF }, /EXPECTED/);
  bad({ VITE_APP_ENV: 'production' }, /VITE_APP_ENV/);
  bad({ VITE_SUPABASE_ANON_KEY: jwt({ role: 'service_role', ref: NEW_REF }) }, /not anon/);
  bad({ VITE_SUPABASE_ANON_KEY: jwt({ role: 'anon', ref: OLD_STAGING_REF }) }, /different project/);
  bad({ VITE_SUPABASE_ANON_KEY: 'sb_secret_abcdefghijkl' }, /secret key/);
  bad({ VITE_SUPABASE_ANON_KEY: 'not-a-key' }, /neither/);
  bad({ VITE_SUPABASE_ANON_KEY: '' }, /missing/);
  bad({ VITE_SERVICE_ROLE_KEY: 'x' }, /no secret/);
  assert.ok(checkBuildEnv(goodEnv(), PRODUCTION_REF)[0].includes('production'));
});

function bundle(files) {
  const dir = mkdtempSync(join(tmpdir(), 'legacy-proof-'));
  mkdirSync(join(dir, 'assets'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

test('proof passes only when the new ref is present and no other project or secret is', () => {
  const dir = bundle({ 'assets/index.js': `const u="https://${NEW_REF}.supabase.co";const k="${jwt({ role: 'anon', ref: NEW_REF })}";`, 'index.html': '<html></html>' });
  try {
    const ok = proveBundle(dir, NEW_REF);
    assert.deepEqual(ok.failures, []);
    assert.equal(ok.filesScanned, 2);
    assert.equal(ok.filesWithNewRef, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('proof fails on the old staging ref, the production ref, a service key, or a missing ref', () => {
  const cases = [
    [`https://${NEW_REF}.supabase.co https://${OLD_STAGING_REF}.supabase.co`, /OLD staging ref/],
    [`https://${NEW_REF}.supabase.co ${PRODUCTION_REF}`, /production ref/],
    [`${NEW_REF} sb_secret_abcdefghijklmnop`, /secret key/],
    [`${NEW_REF} ${jwt({ role: 'service_role', ref: NEW_REF })}`, /role "service_role"/],
    [`${NEW_REF} ${jwt({ role: 'anon', ref: OLD_STAGING_REF })}`, /different project/],
    ['nothing here', /does not appear/],
  ];
  for (const [body, pattern] of cases) {
    const dir = bundle({ 'assets/index.js': body });
    try {
      assert.ok(proveBundle(dir, NEW_REF).failures.some((f) => pattern.test(f)), body.slice(0, 40));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const empty = mkdtempSync(join(tmpdir(), 'legacy-proof-empty-'));
  try {
    assert.ok(proveBundle(empty, NEW_REF).failures.some((f) => /empty/.test(f)));
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
