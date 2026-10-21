#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');
// Optional argument: a directory holding the staging SQL files (defaults to supabase/staging).
const stagingDir = resolve(process.argv[2] ?? resolve(repositoryRoot, 'supabase/staging'));
const reset = readFileSync(resolve(stagingDir, 'reset-fictional-data.sql'), 'utf8');
const installerPath = resolve(stagingDir, 'install-staging-identity-marker.sql');
const installer = existsSync(installerPath) ? readFileSync(installerPath, 'utf8') : '';

// Optional second argument: path to seed.sql (defaults to supabase/seed.sql).
const seedPath = resolve(process.argv[3] ?? resolve(repositoryRoot, 'supabase/seed.sql'));
const seed = readFileSync(seedPath, 'utf8');

const STAGING_REF = 'yhyoxhtguyturgdhwywc';
const PRODUCTION_REF = 'ejrfobddnojbijzrjbii';
const CONFIRMATION = 'RESET FICTIONAL TNBS RECRUITER DATA';
const MARKER_GATE = "to_regclass('staging_identity.marker')";
const RUNNER_GATE = "current_setting('app.staging_runner_verified_ref', true) is distinct from 'yhyoxhtguyturgdhwywc'";
const failures = [];

for (const required of [
  RUNNER_GATE,
  MARKER_GATE,
  "project_ref = %L",
  "current_setting('app.staging_project_ref', true)",
  STAGING_REF,
  "current_setting('app.staging_reset_confirmation', true)",
  CONFIRMATION,
  "v_other_profiles <> 0",
  "v_unregistered_carriers <> 0",
  "v_unregistered_cargo <> 0",
  "v_unowned_batches <> 0",
  "insert into staging_identity.fixture_rows",
  "alter sequence %s restart with 1",
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

// The reset must be bound to the database it is connected to (Codex finding 3).
const markerId = /insert into staging_identity\.marker[\s\S]*?'staging',\s*'([0-9a-f-]{36})'/i.exec(installer)?.[1];
if (!markerId) failures.push('install-staging-identity-marker.sql is missing or has no marker UUID');
else if (!reset.includes(markerId)) failures.push('reset must require the exact installed marker UUID');

// Sequence changes made with setval() survive ROLLBACK (Codex finding 4).
if (/\bsetval\s*\(/i.test(reset)) failures.push('reset must not use setval(); it is not rolled back with a failed reset');

if (reset.includes(PRODUCTION_REF)) failures.push('reset contains the production project ref');
if (/delete\s+from\s+auth\.users/i.test(reset)) failures.push('reset must preserve auth.users');
if (/delete\s+from\s+public\.profiles/i.test(reset)) failures.push('reset must preserve profiles');
if (/drop\s+(?:table|schema|database)|alter\s+table|truncate/gi.test(reset)) {
  failures.push('reset must not drop, alter, or truncate tables, schemas, or databases');
}
// The reset may read the marker and maintain the fixture registry, but never change the marker.
if (/(?:insert\s+into|update|delete\s+from)\s+staging_identity\.marker|drop\s+schema|alter\s+table\s+staging_identity/i.test(reset)) {
  failures.push('reset may only read the staging identity marker, never change it');
}
const FIRST_LINE = /\r?\n/;
// Every delete is scoped by explicit fixture ownership (round 2), never by DOT range or owner.
for (const statement of [...reset.matchAll(/delete\s+from\s+[\s\S]*?;/gi)].map((match) => match[0])) {
  if (!/\bwhere\b/i.test(statement)) failures.push(`reset contains an unscoped delete: ${statement.split(FIRST_LINE)[0]}`);
  else if (!/tmp_reset_|staging_identity\.fixture_rows/.test(statement)) {
    failures.push(`reset delete is not scoped by explicit fixture ownership: ${statement.split(FIRST_LINE)[0]}`);
  }
}
if ((reset.match(/drop trigger trg_bc_delete/gi) ?? []).length !== 1 || (reset.match(/create trigger trg_bc_delete/gi) ?? []).length !== 1) {
  failures.push('reset must remove and restore the batch-carrier delete audit trigger exactly once');
}

const beginIndex = reset.indexOf('begin;');
const commitIndex = reset.lastIndexOf('commit;');
const runnerIndex = reset.indexOf(RUNNER_GATE);
const guardIndex = reset.indexOf(MARKER_GATE);
const scopeIndex = reset.indexOf('v_unowned_batches <> 0');
const registerIndex = reset.indexOf('insert into staging_identity.fixture_rows');
const firstDeleteIndex = reset.indexOf('delete from public.');
const sequenceIndex = reset.indexOf('alter sequence %s restart with 1');
const assertionIndex = reset.indexOf('staging reset verification failed');
if (!(beginIndex >= 0 && runnerIndex > beginIndex && guardIndex > runnerIndex && scopeIndex > guardIndex && firstDeleteIndex > scopeIndex
  && sequenceIndex > firstDeleteIndex && registerIndex > sequenceIndex && assertionIndex > registerIndex && commitIndex > assertionIndex)) {
  failures.push('runner gate, marker gate, ownership check, deletes, sequence restarts, registration, assertions, and commit are not in fail-closed transaction order');
}

// contact_logs_dnc_guard rejects contact logs for carriers that are DNC at insert time.
// Historical fixture contacts must be written while DNC is withheld, and DNC re-applied after.
function checkDncOrdering(sql, name) {
  const withhold = sql.search(/update public\.carriers\s+set do_not_contact = false/i);
  const reapply = sql.search(/update public\.carriers c\s+set do_not_contact = true/i);
  const logInserts = [...sql.matchAll(/insert into public\.contact_logs/gi)].map((m) => m.index ?? -1);
  if (withhold < 0 || reapply < 0) {
    failures.push(`${name} must withhold global DNC before historical contacts and re-apply it afterwards`);
    return;
  }
  if (logInserts.length === 0 || logInserts.some((index) => index < withhold || index > reapply)) {
    failures.push(`${name} inserts a contact log while global DNC is in force (contact_logs_dnc_guard would abort it)`);
  }
  if (/contact_logs_dnc_guard\s+on|disable\s+trigger/i.test(sql)) {
    failures.push(`${name} must not drop or disable the contact-log DNC guard`);
  }
}
checkDncOrdering(reset, 'reset');
checkDncOrdering(seed, 'seed.sql');

if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exit(1);
}

console.log('PASS staging reset is runner and database-marker gated, ownership scoped, confirmation gated, real-data refusing, transactional (no setval), identity preserving, production-ref free, and contract asserting');
