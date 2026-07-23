#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');
const reset = readFileSync(resolve(repositoryRoot, 'supabase/staging/reset-fictional-data.sql'), 'utf8');

const STAGING_REF = 'yhyoxhtguyturgdhwywc';
const PRODUCTION_REF = 'ejrfobddnojbijzrjbii';
const CONFIRMATION = 'RESET FICTIONAL TNBS RECRUITER DATA';
const failures = [];

for (const required of [
  "current_setting('app.staging_project_ref', true)",
  STAGING_REF,
  "current_setting('app.staging_reset_confirmation', true)",
  CONFIRMATION,
  "select setseed(0.42)",
  "v_carriers <> 800",
  "v_batches <> 2",
  "v_password_users <> 1",
  "email = 'hunter@twistednail.com'",
  "v_fixture_profiles <> 7",
  "v_warning_codes <> 9",
  "drop trigger trg_bc_delete on public.batch_carriers",
  "create trigger trg_bc_delete before delete on public.batch_carriers",
]) {
  if (!reset.includes(required)) failures.push(`reset is missing required guard or assertion: ${required}`);
}

if (reset.includes(PRODUCTION_REF)) failures.push('reset contains the production project ref');
if (/delete\s+from\s+auth\.users/i.test(reset)) failures.push('reset must preserve auth.users');
if (/delete\s+from\s+public\.profiles/i.test(reset)) failures.push('reset must preserve profiles');
if (/drop\s+(?:table|schema|database)|alter\s+table|truncate/gi.test(reset)) {
  failures.push('reset must not drop, alter, or truncate tables, schemas, or databases');
}
if ((reset.match(/drop trigger trg_bc_delete/gi) ?? []).length !== 1 || (reset.match(/create trigger trg_bc_delete/gi) ?? []).length !== 1) {
  failures.push('reset must remove and restore the batch-carrier delete audit trigger exactly once');
}

const beginIndex = reset.indexOf('begin;');
const commitIndex = reset.lastIndexOf('commit;');
const guardIndex = reset.indexOf("current_setting('app.staging_project_ref', true)");
const firstDeleteIndex = reset.indexOf('delete from public.');
const assertionIndex = reset.indexOf('staging reset verification failed');
if (!(beginIndex >= 0 && guardIndex > beginIndex && firstDeleteIndex > guardIndex && assertionIndex > firstDeleteIndex && commitIndex > assertionIndex)) {
  failures.push('guard, deletes, assertions, and commit are not in fail-closed transaction order');
}

if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exit(1);
}

console.log('PASS staging reset is exact-ref gated, confirmation gated, transactional, identity preserving, production-ref free, and contract asserting');
