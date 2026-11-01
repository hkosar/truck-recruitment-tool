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
    "'retention-run'",
    "'install-retention-fixtures'",
    "'remove-retention-fixtures'",
    "'ledger-preflight'",
    "'environment-preflight'",
    "'owner-login-check'",
    "'owner-promote'",
    'runLedgerPreflight',
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

// The recorded rebuilt staging ref (doc 16 R1 step 2): exactly one 20-letter literal, not the production or old staging ref.
const guard = read('pipeline/src/target-guard.ts');
const recordedRef = guard && /const REBUILT_STAGING_PROJECT_REF: string \| null = '([a-z]{20})';/.exec(guard);
if (!recordedRef) failures.push('target-guard.ts: REBUILT_STAGING_PROJECT_REF must be a single 20-letter literal');
else if (recordedRef[1] === PRODUCTION_REF || recordedRef[1] === OLD_STAGING_REF) failures.push('target-guard.ts: the rebuilt ref equals the production or old staging ref');

// Owner login bootstrap (doc 16 approval 4, G1): the Auth call goes only to the address derived from the recorded ref, follows no
// redirect, confirms the email and sends no invitation or mail; the promotion uses the transaction-local service-role claim and row
// locks; nothing in the module reads the environment or deletes an account.
const owner = read('pipeline/src/owner-bootstrap.ts');
if (!owner) failures.push('owner-bootstrap.ts is missing');
else {
  for (const required of ['baseUrl: `https://${input.ref}.supabase.co`', "redirect: 'error'", 'email_confirm: true', '/auth/v1/admin/users', "set_config('request.jwt.claims'", 'for update', "set local lock_timeout", 'assessOwnerPromoted', "await client.query('commit')"]) {
    if (!owner.includes(required)) failures.push(`owner-bootstrap.ts is missing: ${required}`);
  }
  for (const forbidden of [/invite/i, /generateLink/, /magiclink/i, /process.env/, /deleteUser/, /deletes+from/i, /drop/i, /truncate/i]) {
    if (forbidden.test(owner)) failures.push(`owner-bootstrap.ts must not contain ${forbidden}`);
  }
}

// Review r7: the promotion postcondition names the approver; an unacknowledged rollback is its own result; doc 16 states that the
// Data API must be on before the hosted Auth fixture seeder and that a negative check after an unknown create never authorizes a retry.
if (owner) {
  for (const required of ['owner_profile_approved_by_self', 'the_profile_is_approved_by_the_owner_account_itself', 'rollback_not_confirmed']) {
    if (!owner.includes(required)) failures.push(`owner-bootstrap.ts is missing: ${required}`);
  }
}
const doc16 = read('docs/build-plan/16-staging-and-hosting-plan.md');
for (const required of ['Data API must already be enabled with', 'never authorizes another create', 'rollback_not_confirmed']) {
  if (!doc16 || !doc16.replace(/\s+/g, ' ').includes(required)) failures.push('doc 16 is missing: ' + required);
}

// Retention fixture boundary (doc 16 section 4 step 3): seed and remove files are scoped to one exact tag, the tag literal is
// the same in the seed file, the removal file and retention-run.ts, and the seed file refuses unless nothing is aged yet.
{
  const TAG = 'ret-fixture-20261101';
  const ins = read('supabase/staging/rebuild/install-retention-fixtures.sql');
  const rem = read('supabase/staging/rebuild/remove-retention-fixtures.sql');
  const run = read('pipeline/src/retention-run.ts');
  const rules = read('pipeline/src/retention.ts');
  if (!ins || !rem || !run || !rules) failures.push('retention fixture files or retention-run.ts are missing');
  else {
    for (const [name, sql] of [['install-retention-fixtures', ins], ['remove-retention-fixtures', rem]]) {
      const c = code(sql);
      if (sql.includes(PRODUCTION_REF)) failures.push(name + ': contains the production project ref');
      if (!c.includes("current_setting('app.staging_runner_verified_ref', true) is distinct from '" + OLD_STAGING_REF + "'")) failures.push(name + ': must refuse unless the runner verified the pinned ref');
      if (!c.includes("to_regclass('staging_identity.marker') is null") || !c.includes('marker_id =')) failures.push(name + ': must require the staging identity marker');
      if (!/^begin;$/m.test(c) || !/^commit;$/m.test(c)) failures.push(name + ': must be one transaction');
      if (/password\s+'|postgres(ql)?:\/\/|truncate/i.test(c)) failures.push(name + ': contains a credential, connection string or truncate');
    }
    if (!code(ins).includes("'INSTALL TNBS RETENTION TEST FIXTURES'") || !code(rem).includes("'REMOVE TNBS RETENTION TEST FIXTURES'")) failures.push('retention fixture confirmation phrases missing');
    if (!run.includes("RETENTION_FIXTURE_TAG = '" + TAG + "'")) failures.push('retention-run.ts: tag literal differs from the seed file');
    for (const [name, sql] of [['install', ins], ['remove', rem]]) {
      if (!code(sql).includes("'" + TAG + "-aged'") || !code(sql).includes("'" + TAG + "-fresh'")) failures.push(name + '-retention-fixtures: must use the exact -aged and -fresh tags');
    }
    // Every delete in the removal file is by exact tag; none is unconditional or by age.
    const deletes = code(rem).split(';').map((x) => x.trim()).filter((x) => /^delete\s+from/i.test(x));
    if (deletes.length !== 5) failures.push('remove-retention-fixtures: expected exactly five tag-scoped deletes');
    for (const d of deletes) if (!d.includes("in ('" + TAG + "-aged', '" + TAG + "-fresh')")) failures.push('remove-retention-fixtures: delete is not scoped to the exact tags');
    // The seed file's "nothing aged yet" gate uses every retention rule predicate (text taken from retention.ts).
    const insFlat = code(ins).replace(/\s+/g, ' ');
    for (const m of rules.matchAll(/where: "([^"]+)"/g)) {
      if (!insFlat.includes(m[1])) failures.push('install-retention-fixtures: aged gate is missing a retention rule predicate: ' + m[1]);
    }
    for (const required of ['each_rule_must_match_exactly_one_row', 'aged_fixture_missing_or_duplicated', 'ledger_did_not_shrink_by_exactly_one', 'least_privilege_checks_failed']) {
      if (!run.includes(required)) failures.push('retention-run.ts is missing: ' + required);
    }
  }
}

if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  process.exit(1);
}
console.log('PASS staging rebuild tooling contract (12 shutdown fixtures, scoped removal, rebuilt-project runner guards)');
