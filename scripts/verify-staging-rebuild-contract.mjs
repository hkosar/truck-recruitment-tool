#!/usr/bin/env node
// Offline contract check for the REBUILT staging project tooling (doc 16 section 5 item 1):
// supabase/staging/rebuild/ (12 T-SHUTDOWN fixtures) and pipeline/src/staging-rebuilt.ts.
// Text-level only; the behaviour is proven by the local-database run (doc 16 section 1.5 row 10).

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const PRODUCTION_REF = 'ejrfobddnojbijzrjbii';
const OLD_STAGING_REF = 'yhyoxhtguyturgdhwywc';
const failures = [];
const read = (rel) => (existsSync(resolve(root, rel)) ? readFileSync(resolve(root, rel), 'utf8').replace(/\r\n/g, '\n') : undefined);
const code = (sql) => sql.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

const install = read('supabase/staging/rebuild/install-shutdown-fixtures.sql');
const remove = read('supabase/staging/rebuild/remove-shutdown-fixtures.sql');
const runner = read('pipeline/src/staging-rebuilt.ts');
if (!install) failures.push('missing install-shutdown-fixtures.sql');
if (!remove) failures.push('missing remove-shutdown-fixtures.sql');
if (!runner) failures.push('missing pipeline/src/staging-rebuilt.ts');

for (const [name, sql] of [['install', install], ['remove', remove]]) {
  if (!sql) continue;
  const c = code(sql);
  if (sql.includes(PRODUCTION_REF)) failures.push(`${name}: contains the production project ref`);
  if (!c.includes(`current_setting('app.staging_runner_verified_ref', true) is distinct from '${OLD_STAGING_REF}'`)) {
    failures.push(`${name}: must refuse unless the runner verified the pinned ref (re-pinned by the runner for the rebuilt project)`);
  }
  if (!c.includes("to_regclass('staging_identity.marker') is null")) failures.push(`${name}: must require the staging identity marker`);
  if (/password\s+'|postgres(ql)?:\/\/|sb_secret_|service_role_key/i.test(sql)) failures.push(`${name}: contains a credential or connection string`);
  if (!/^begin;$/m.test(c) || !/^commit;$/m.test(c)) failures.push(`${name}: must be one transaction (begin ... commit)`);
}

if (install) {
  const c = code(install);
  if (!c.includes("'INSTALL TNBS SHUTDOWN TEST FIXTURES'")) failures.push('install: confirmation phrase missing');
  if (!c.includes('generate_series(1, 12)')) failures.push('install: must create exactly 12 identities');
  if ((c.match(/generate_series\(1, 12\)/g) ?? []).length !== 2) failures.push('install: auth.users and profiles must both be created for 12 fixtures');
  if (!c.includes("<> 12")) failures.push('install: must verify the 12 approved editors afterwards');
  if (!c.includes('.example.invalid')) failures.push('install: fixture addresses must be at the reserved .example.invalid domain');
  if (/@(?!tnbs-recruiter\.example\.invalid)[a-z0-9.-]+\.[a-z]{2,}/i.test(c.replace(/'shutdown-' \|\| /g, ''))) failures.push('install: an address outside the reserved fixture domain');
  if (!c.includes("case when n <= 6 then 'A' else 'B' end")) failures.push('install: two sets of 6 (A = 01-06, B = 07-12) must be recorded in the metadata');
  if (!c.includes("'stg-db-20260723-0042'")) failures.push('install: must use the same test_run_id the marker installer and reset recognise');
  if (!/encrypted_password[\s\S]*?null/.test(c)) failures.push('install: fixtures must have no password');
  if (/\bdelete\s+from\b|\btruncate\b|\bdrop\b/i.test(c)) failures.push('install: must not delete or drop anything');
  if (!c.includes('already installed')) failures.push('install: must refuse when already installed (idempotent, no overwrite)');
}

if (remove) {
  const c = code(remove);
  if (!c.includes("'REMOVE TNBS SHUTDOWN TEST FIXTURES'")) failures.push('remove: confirmation phrase missing');
  if (/\btruncate\b|\bdrop\s+(table|schema|function|role|database|column|constraint|index)\b/i.test(c)) failures.push('remove: must not truncate or drop');
  // Scope: the twelve exact identities, each with its own expected id, label, address and metadata.
  for (const required of [
    "from generate_series(1, 12) n",
    "on u.id = ('71000000-0000-4000-8000-0000000002' || lpad(n::text, 2, '0'))::uuid",
    "u.raw_user_meta_data->>'label' = 'shutdown-' || lpad(n::text, 2, '0')",
    "u.email = 'shutdown-' || lpad(n::text, 2, '0') || '@tnbs-recruiter.example.invalid'",
    "u.raw_user_meta_data->>'test_only' = 'true'",
    "u.raw_user_meta_data->>'test_run_id' = 'stg-db-20260723-0042'",
    "(select count(*) from tmp_shutdown_fixtures) not in (0, 12)",
  ]) {
    if (!c.includes(required)) failures.push(`remove: missing fixture scope condition: ${required}`);
  }
  // No wildcard selection of identities (like) in the selection.
  if (/u\.(id::text|email)\s+like|raw_user_meta_data->>'label'\s+like/.test(c)) failures.push('remove: fixtures must be selected by exact id, label and address, not by wildcard');
  // Every delete is limited to the temp list of fixture ids.
  for (const match of c.matchAll(/delete\s+from\s+([\s\S]*?);/gi)) {
    if (!match[0].includes('tmp_shutdown_fixtures')) failures.push(`remove: unscoped delete: ${match[0].slice(0, 80)}`);
  }
  // It must refuse, changing nothing, when business rows reference the fixtures.
  for (const ref of ['contact_logs', 'batch_activity', 'batches', 'batch_carriers', 'contact_suppressions', 'carriers', 'blocked_email_addresses', 'approved_by']) {
    if (!c.includes(ref)) failures.push(`remove: must check business references (${ref})`);
  }
  // Email events are delivery evidence and are not deleted.
  if (/delete\s+from\s+internal\.email_events/i.test(c)) failures.push('remove: must keep email events');
}

if (runner) {
  for (const required of [
    "'app.staging_runner_verified_ref'",
    'refuses the production',
    'parseSupabaseDbTarget',
    'target.port !== 5432',
    'RECORDED_PROJECT_REFS.stagingRebuilt',
    "'install-shutdown-fixtures'",
    "'remove-shutdown-fixtures'",
    "'apply-migrations'",
    'migration-checksums.sha256',
    'supabase_migrations.schema_migrations',
    'ledger?: { version: string; name: string }',
    "'retention-dry-run'",
    "'reapply-m1'",
    "'reapply-m1b'",
    "'reapply-m1c'",
    "'window-on'",
    "'window-off'",
    "'backout-m1c'",
    "'backout-m1b'",
    "'backout-m1'",
    "'role-matrix-m1'",
    'snapshot',
  ]) {
    if (!runner.includes(required)) failures.push(`rebuilt runner is missing: ${required}`);
  }
}

if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  process.exit(1);
}
console.log('PASS staging rebuild tooling contract (12 shutdown fixtures, scoped removal, rebuilt-project runner guards)');
