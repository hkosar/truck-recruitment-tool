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
// Role password setup (runbook 6b build, pipeline/src/role-password.ts): the plain password never reaches the server (only a locally computed
// SCRAM-SHA-256 verifier is in the statement), the role and variable come from a fixed two-entry table, the module reads no environment, the
// change is one timed transaction, and the wrapper allows exactly these two names and one fixed result event.
const rolePw = read('pipeline/src/role-password.ts');
if (!rolePw) failures.push('role-password.ts is missing');
else {
  for (const required of ["'recruiter_app'", "'recruiter_maintenance'", "'STAGING_APP_DB_PASSWORD'", "'STAGING_MAINT_DB_PASSWORD'", 'pbkdf2Sync', "'Client Key'", "'Server Key'", 'requireRecordedRebuiltRef', 'parseSupabaseDbTarget', 'target.port !== 5432',
    'refuses the production', "set local statement_timeout = '30s'", "set local lock_timeout = '10s'", "alter role ${role} login password %L", "current_setting('${VERIFIER_GUC}')", "select pg_catalog.set_config('${VERIFIER_GUC}', $1, true)", "pg_catalog.format('alter role ${role} login password %L', pg_catalog.current_setting('${VERIFIER_GUC}')", "from pg_catalog.pg_settings", "from pg_catalog.pg_roles", "set local search_path = pg_catalog, pg_temp", "set local debug_print_parse = off", "set local debug_print_rewritten = off", "set local debug_print_plan = off", "set local exit_on_error = off", "set local jit = off", "'log_parser_stats'", "'log_planner_stats'", "'log_executor_stats'", "'log_statement_stats'", "set local client_connection_check_interval = 0", 'SENTINEL_SETTINGS', 'OTHER_KNOWN_SETTINGS', 'serverVersionProblem(settings)', 'AUDITED_SERVER_MAJOR = 16', 'role_password_server_version_unverified', 'is not classified', 'was not returned', 'MUST_BE_OFF_SETTINGS', 'HARMLESS_LOGGING_SETTINGS', "'log_lock_waits'", "'deadlock_timeout'", "await client.query(SEARCH_PATH_SQL)", "MIN_DEADLOCK_TIMEOUT_MS", 'exception when query_canceled then', 'when others then raise exception using errcode = sqlstate',
    'role_password_logging_refused', 'role_password_expiry_refused', "current_setting('pgaudit.log', true)", "current_setting('auto_explain.log_min_duration', true)", "'log_statement'", "'log_min_duration_statement'", "'log_transaction_sample_rate'", "'log_parameter_max_length'", "'log_parameter_max_length_on_error'", 'loggingProblem(settings)', 'expires_soon',
    'query_timeout: CLIENT_QUERY_TIMEOUT_MS', 'keepAlive: true', 'expired === true', 'pg_stat_statements.track', '/^[A-Za-z0-9_-]+$/', 'ROLE_PASSWORD_MIN_LENGTH = 32', '--out is not supported', 'const resultEvent', 'VERIFIER_SHAPE', 'rolsuper', "await client.query('commit')", 'rollback_not_confirmed']) {
    if (!rolePw.includes(required)) failures.push(`role-password.ts is missing: ${required}`);
  }
  const code = rolePw.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  {
    const at = (t) => code.indexOf(t);
    const order = ['await client.query(SEARCH_PATH_SQL)', 'for (const sql of SESSION_SAFETY_SQL)', 'await client.query(SETTINGS_SQL)', 'await client.query(SET_VERIFIER_SQL, [plan.verifier])'].map(at);
    if (order.some((i) => i < 0) || order.some((i, k) => k > 0 && i < order[k - 1])) failures.push('role-password.ts: search_path and the session safety settings (debug_print_*, exit_on_error, jit) must be set before the settings read, and the settings read before the verifier is bound');
  }
  for (const forbidden of [/process\.env/, /\bdrop\b/i, /delete\s+from/i, /\btruncate\b/i, /\bgrant\b/i, /\brevoke\b/i, /\b(createrole|superuser|createdb|bypassrls)\b/i, /password\s+'\$\{/, /\bline\(/, /process\.(stdout|stderr)/]) {
    if (forbidden.test(code)) failures.push(`role-password.ts must not contain ${forbidden}`);
  }
  if ((code.match(/alter role/gi) ?? []).length !== 1) failures.push('role-password.ts must contain exactly one ALTER ROLE statement');
  // The verifier is only ever a bind parameter, and no printed event can carry it: every event goes through resultEvent(role, result).
  const eventFn = /const resultEvent = [\s\S]*?\n\};/.exec(code)?.[0] ?? '';
  const printedArgs = [...code.matchAll(/resultEvent\(([^)]*)\)/g)].map((m) => m[1]);
  if (printedArgs.length < 3 || printedArgs.some((a) => /verifier|password|err|message/i.test(a))) failures.push('role-password.ts: resultEvent( arguments must never mention verifier, password or an error');
  if ((code.match(/console\./g) ?? []).length !== 1 || !eventFn.includes('console.log(JSON.stringify({ msg:') || /verifier|password/i.test(eventFn.replace(/ROLE_PASSWORD_[A-Z]+|role_password_(refused|result)/g, ''))) failures.push('role-password.ts: console may be used only inside resultEvent, which may print only msg, role and result');
  if (/\$\{[^}]*verifier[^}]*\}/.test(code)) failures.push('role-password.ts: the verifier must never be interpolated into a template string or SQL text');
}
const wrapperSrc = read('scripts/run-with-secrets.mjs');
if (wrapperSrc) {
  for (const required of ["'STAGING_APP_DB_PASSWORD', 'STAGING_MAINT_DB_PASSWORD'", "'set-app-password', 'set-maintenance-password'", "'staging-sql.role_password_result'", "'role_password_refused'", "'role_password_logging_refused'", "'role_password_expiry_refused'"]) {
    if (!wrapperSrc.includes(required)) failures.push(`run-with-secrets.mjs is missing: ${required}`);
  }
  if (/PROMPT_ONLY = \[[^\]]*(STAGING_APP_DB_PASSWORD|STAGING_MAINT_DB_PASSWORD)/.test(wrapperSrc)) failures.push('run-with-secrets.mjs: the two role passwords must be allowed through --from-env');
}
const runnerCli = read('pipeline/src/staging-sql-runner.ts');
if (runnerCli && !runnerCli.includes('ROLE_PASSWORD_ACTIONS[args.action as RolePasswordAction].passwordVariable')) failures.push('staging-sql-runner.ts: the role-password action must read only its own fixed variable');

const doc16 = read('docs/build-plan/16-staging-and-hosting-plan.md');
for (const required of ['Data API must already be enabled with', 'never authorizes another create', 'rollback_not_confirmed']) {
  if (!doc16 || !doc16.replace(/\s+/g, ' ').includes(required)) failures.push('doc 16 is missing: ' + required);
}

if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  process.exit(1);
}
console.log('PASS staging rebuild tooling contract (12 shutdown fixtures, scoped removal, rebuilt-project runner guards)');
