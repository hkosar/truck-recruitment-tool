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
    // role-matrix-m1 must report its counts and refuse on a failed probe (never end in step_done on failures)
    "roleMatrix: true }",
    "msg: 'staging-sql.role_matrix'",
    "new RunnerRefusal('role_matrix_failed'",
    "new RunnerRefusal('role_matrix_result_missing'",
    'if (matrixCounts.failed > 0)',
  ]) {
    if (!runner.includes(required)) failures.push(`rebuilt runner is missing: ${required}`);
  }
  const refuseAt = runner.indexOf("new RunnerRefusal('role_matrix_failed'");
  const doneAt = runner.indexOf("msg: 'staging-sql.step_done'");
  if (refuseAt < 0 || doneAt < 0 || refuseAt > doneAt) failures.push('rebuilt runner: the role matrix refusal must come before step_done is printed');
  if (/staging-sql\.role_matrix.*(actor|test_name|observed|expected)/.test(runner)) failures.push('rebuilt runner: the role matrix event must carry counts only, no probe text');
  const refusalsSrc = read('pipeline/src/refusals.ts') ?? '';
  const wrapperSrc = read('scripts/run-with-secrets.mjs') ?? '';
  for (const id of ['role_matrix_failed', 'role_matrix_result_missing']) {
    if (!refusalsSrc.includes(`'${id}'`)) failures.push(`refusals.ts REFUSAL_IDS is missing ${id}`);
    if (!wrapperSrc.includes(`'${id}'`)) failures.push(`run-with-secrets.mjs REFUSAL_IDS is missing ${id}`);
  }
  if (!wrapperSrc.includes("'staging-sql.role_matrix': { ok: bool, total: int, passed: int, failed: int }")) failures.push('run-with-secrets.mjs must allow-list staging-sql.role_matrix with exactly ok, total, passed, failed');
}

// batch-delete-compare (doc 16 section 3.3): read-only, pinned file, fixed event, fixed refusal, never prints the definition.
const compare = read('pipeline/src/batch-delete-compare.ts');
if (!compare) failures.push('batch-delete-compare.ts is missing');
else {
  for (const required of ['pg_get_functiondef(to_regprocedure', 'staging-sql.batch_delete_compare', 'shortHash', 'slice(0, 12)', 'match: cmp.match', 'expected_hash: cmp.expected_hash', 'live_hash: cmp.live_hash', 'proconfig', 'expectedProconfig', 'LIVE_SEARCH_PATH', 'FILE_SEARCH_PATH', "statement_timeout', '30s', true", 'client.query(BATCH_DELETE_STATEMENT_TIMEOUT_SQL)']) {
    if (!compare.includes(required)) failures.push(`batch-delete-compare.ts is missing: ${required}`);
  }
  const compareCode = compare.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  for (const forbidden of [/process\.env/, /\binsert\s+into\b/i, /\bupdate\s+\w+\s+set\b/i, /\bdelete\s+from\b/i, /\bdrop\s+\w+/i, /\btruncate\b/i, /\balter\s+\w+/i]) {
    if (forbidden.test(compareCode.replace(/^export const BATCH_DELETE_LIVE_SQL.*$/m, ''))) failures.push(`batch-delete-compare.ts must not contain ${forbidden}`);
  }
  // The search_path is compared exactly (review finding B1): no case folding and no splitting of free text anywhere in the code,
  // and the live body is never line-end normalised (only the pinned file text is).
  if (compareCode.includes(".split(',')")) failures.push('batch-delete-compare.ts must not split search_path free text on commas');
  if (compareCode.split('\n').some((l) => l.includes('_SEARCH_PATH = new RegExp(') && /, ?'[a-z]*i[a-z]*'\)/.test(l))) failures.push('the search_path patterns must be case-sensitive (no i flag)');
  if (!compareCode.includes("splitHeaderBody(form === 'file' ? lf(def) : def, form === 'file')")) failures.push('batch-delete-compare.ts must normalise line ends of the pinned file text only, never of the live definition');
  // The only console output is the one fixed event.
  const logs = compareCode.match(/console\.(log|error)\(.*\)/g) ?? [];
  if (logs.length !== 1 || !logs[0].includes('msg: BATCH_DELETE_COMPARE_EVENT, match: cmp.match, expected_hash: cmp.expected_hash, live_hash: cmp.live_hash }')) failures.push('batch-delete-compare.ts must print exactly one fixed event (match and two short hashes)');
}
if (runner) {
  const action = /'batch-delete-compare': \{([^}]*)\}/.exec(runner)?.[1] ?? '';
  for (const required of ["kind: 'batch-delete-compare'", "file: 'supabase/pending/M1c_batch_delete_audit.sql'", "sha256: '86cd3de2ab4f1b2283c344088e31d05fbc8e719ebaa17318987a7082c42dfb26'", "confirmation: 'COMPARE TNBS BATCH DELETE DEFINITION'"]) {
    if (!action.includes(required)) failures.push(`batch-delete-compare action is missing: ${required}`);
  }
  const block = /if \(plan\.kind === 'batch-delete-compare'\) \{([\s\S]*?)\n    \}\n/.exec(runner)?.[1] ?? '';
  for (const required of ["'begin read only'", 'runBatchDeleteCompare', "'batch_delete_definition_mismatch'", "'rollback'"]) {
    if (!block.includes(required)) failures.push(`batch-delete-compare executor is missing: ${required}`);
  }
  if (/query\('commit'\)/.test(block)) failures.push('batch-delete-compare executor must never commit');
}
const refusalList = read('pipeline/src/refusals.ts');
if (!refusalList || !refusalList.includes("'batch_delete_definition_mismatch'")) failures.push('refusals.ts must list batch_delete_definition_mismatch');

// Backout rehearsal (doc 16 section 3.3, approval 15; manager runbook v3 section 7 gaps): retire-app-credentials, identity-alignment-check,
// postgis-placement and the window read-back line. Each goes through the same planner (target guard, typed phrase) and the same executor
// client (newSecurePgClient); every printed line is a fixed event; the wrapper allow-lists exactly those events and refusal ids.
const rehearsal = read('pipeline/src/backout-rehearsal.ts');
if (!rehearsal) failures.push('pipeline/src/backout-rehearsal.ts is missing');
if (runner && rehearsal) {
  const entry = (name) => new RegExp(`'${name}': \\{([^}]*)\\}`).exec(runner)?.[1] ?? '';
  for (const [name, required] of [
    ['retire-app-credentials', ["kind: 'retire'", "file: 'supabase/backout/retire-app-credentials.sql'", "sha256: '3e716371979ffb876bb54f7ab91753eced9b89df15276c9d6d4ba7cc0ef7fa15'", "confirmation: 'RETIRE TNBS STAGING APP CREDENTIALS'"]],
    ['identity-alignment-check', ["kind: 'identity-alignment'", "file: 'supabase/rollout/read-only-inventory.sql'", "sha256: '50e6cd622a4d34fe9d50c53ef95205f517af82e8b365878a29a878d4b73d48e1'", "confirmation: 'RUN TNBS IDENTITY ALIGNMENT CHECK'"]],
    ['postgis-placement', ["kind: 'postgis-placement'", "confirmation: 'RECORD TNBS POSTGIS PLACEMENT'"]],
  ]) {
    const e = entry(name);
    for (const r of required) if (!e.includes(r)) failures.push(`${name} action is missing: ${r}`);
  }
  if (!/'window-on': \{[^}]*windowExpect: true,/.test(runner) || !/'window-off': \{[^}]*windowExpect: false,/.test(runner)) failures.push('window-on / window-off must carry windowExpect true / false');
  const execBlock = (kind) => new RegExp(`if \\(plan\\.kind === '${kind}'\\) \\{([\\s\\S]*?)\\n    \\}\\n`).exec(runner)?.[1] ?? '';
  for (const kind of ['identity-alignment', 'postgis-placement']) {
    const block = execBlock(kind);
    if (!block.includes("'begin read only'") || !block.includes("'rollback'") || /query\('commit'\)/.test(block)) failures.push(`${kind} executor must run in begin read only ... rollback and never commit`);
  }
  if (!execBlock('retire').includes('runRetireAppCredentials(client, plan.retireStages as RetireStages, retireOptions)')) failures.push('retire executor must call runRetireAppCredentials with the verified stages');
  // The window read-back is printed and checked inside the step's try (so a wrong value rolls back) and before step_done.
  const readBackAt = runner.indexOf("msg: 'staging-sql.backout_window'");
  const windowRefuseAt = runner.indexOf("new RunnerRefusal('backout_window_not_expected'");
  const stepDoneAt = runner.indexOf("msg: 'staging-sql.step_done'");
  const commitAt = runner.indexOf("if (step.transaction) await client.query('commit');");
  if (readBackAt < 0 || windowRefuseAt < readBackAt || commitAt < windowRefuseAt || stepDoneAt < commitAt) failures.push('rebuilt runner: the window read-back line and its refusal must come before the commit and before step_done');
  // The new code sends nothing it did not verify: the retire stages are pinned (same pins as prod-sql.ts), no other SQL text in the module writes.
  for (const required of ["RETIRE_FILE_SHA256 = '3e716371979ffb876bb54f7ab91753eced9b89df15276c9d6d4ba7cc0ef7fa15'", 'retireStageDigest(statements) !== stage.sha256', 'RETIRE_ZERO_READS_REQUIRED = 3', 'RETIRE_MAX_WAIT_MS = 60_000', 'RETIRE_POLL_INTERVAL_MS = 1000',
    "new RunnerRefusal('retire_backends_not_gone'", "new RunnerRefusal('retire_checks_failed'", "new RunnerRefusal('identity_alignment_failed'", "new RunnerRefusal('identity_alignment_result_missing'", "await client.query('rollback')", "IDENTITY_ALIGNMENT_SHA256 = '50e6cd622a4d34fe9d50c53ef95205f517af82e8b365878a29a878d4b73d48e1'"]) {
    if (!rehearsal.includes(required)) failures.push(`backout-rehearsal.ts is missing: ${required}`);
  }
  const rehearsalCode = rehearsal.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  for (const forbidden of [/process\.env/, /new\s+pg\.Client/, /from 'pg'/, /rejectUnauthorized/, /\bssl\s*:/, /\binsert\s+into\b/i, /\bupdate\s+\w+\s+set\b/i, /\bdelete\s+from\b/i, /\bdrop\s+\w+/i, /\balter\s+role\b/i, /\bgrant\b/i]) {
    if (forbidden.test(rehearsalCode)) failures.push(`backout-rehearsal.ts must not contain ${forbidden} (its only SQL is the pinned files and one catalogue select; the client comes from the runner)`);
  }
  // Every console line in the module is a fixed event: an object literal with msg and named fields (never a row, an error or SQL text).
  for (const m of rehearsalCode.matchAll(/console\.(log|error)\(([^;]*)\);/g)) {
    if (!/^JSON\.stringify\(\{ msg: 'staging-sql\.[a-z_]+'/.test(m[2]) && !/^(event|JSON\.stringify\(event\))$/.test(m[2].trim())) failures.push(`backout-rehearsal.ts prints something that is not a fixed event: ${m[2].slice(0, 60)}`);
    if (/\b(err|error|message|stack)\b|\.raw\b|\.clean\b|rows\[/.test(m[2])) failures.push(`backout-rehearsal.ts must not print an error, SQL text or a row: ${m[2].slice(0, 60)}`);
  }
  const refusalsSrc = read('pipeline/src/refusals.ts') ?? '';
  const wrapperSrc = read('scripts/run-with-secrets.mjs') ?? '';
  for (const id of ['retire_backends_not_gone', 'retire_checks_failed', 'identity_alignment_failed', 'identity_alignment_result_missing', 'backout_window_not_expected']) {
    if (!refusalsSrc.includes(`'${id}'`)) failures.push(`refusals.ts REFUSAL_IDS is missing ${id}`);
    if (!wrapperSrc.includes(`'${id}'`)) failures.push(`run-with-secrets.mjs REFUSAL_IDS is missing ${id}`);
  }
  for (const line of [
    "'staging-sql.backout_window': { action: oneOf(['window-on', 'window-off']), email_edits_paused: (v) => bool(v) || v === 'unknown', rows: int, ok: bool }",
    "'staging-sql.retire_terminate': { backends_signalled: int }",
    "'staging-sql.retire_checks': { ok: bool, backends: count, live_sessions: count, live_links: count, live_codes: count, email_mismatches: count }",
    "'staging-sql.identity_alignment': { ok: bool, approved_profiles: count, email_mismatches: count, approved_profiles_without_auth_user: count, approved_auth_email_null: count }",
    "'staging-sql.postgis_placement': { schema: oneOf(['public', 'extensions', 'other', 'absent']) }",
    "'retire-app-credentials', 'identity-alignment-check', 'postgis-placement'",
  ]) {
    if (!wrapperSrc.includes(line)) failures.push(`run-with-secrets.mjs is missing: ${line}`);
  }
  const doc16text = (read('docs/build-plan/16-staging-and-hosting-plan.md') ?? '').replace(/\s+/g, ' ');
  for (const phrase of ['`retire-app-credentials`', 'RETIRE TNBS STAGING APP CREDENTIALS', '`identity-alignment-check`', 'RUN TNBS IDENTITY ALIGNMENT CHECK', '`postgis-placement`', 'RECORD TNBS POSTGIS PLACEMENT', 'staging-sql.backout_window']) {
    if (!doc16text.includes(phrase)) failures.push(`doc 16 must list the backout-rehearsal action/phrase/event: ${phrase}`);
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
  // The connection goes through the TLS-hardened client only (verify-full against the pinned root for a hosted target, SCRAM-only): no own pg client, no TLS override.
  for (const forbidden of [/new\s+pg\.Client/, /new\s+Client\s*\(/, /rejectUnauthorized/, /\bssl\s*:/, /from 'pg'/]) {
    if (forbidden.test(code)) failures.push(`role-password.ts must not contain ${forbidden} (use newSecurePgClient from pg-secure.ts)`);
  }
  if (!/import \{ newSecurePgClient \} from '\.\/pg-secure\.js';/.test(code) || !/newSecurePgClient\(target, rolePasswordClientOptions\(\)\)/.test(code) || !/clientFactory: \(target: SupabaseDbTarget\) => RebuiltSqlClient = newRolePasswordClient\)/.test(code)) {
    failures.push('role-password.ts: the executor\'s default client must be newSecurePgClient(target, rolePasswordClientOptions()) from pg-secure.ts');
  }
  if (!rolePw.includes('keepAliveInitialDelayMillis: 10_000') || !rolePw.includes('connectionTimeoutMillis: 10_000')) failures.push('role-password.ts: the client keeps its connect timeout and keep-alive delay');
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
    for (const required of ['due_row_is_not_the_tagged_fixture', 'fresh_control_is_due', 'lock table', 'in share row exclusive mode nowait', 'lock_busy_nothing_deleted', "55P03", "client.query('begin')", "client.query('commit')", "client.query('rollback')", 'deleteTaggedFixtures']) {
      if (!run.includes(required)) failures.push('retention-run.ts is missing (one locked transaction, identity pre-check): ' + required);
    }
    // The least-privilege checks run INSIDE the delete transaction (after begin and the lock, before the delete); the COMMIT answer is verified.
    const runCode = run.replace(/\/\/.*$/gm, '');
    const at = (needle) => runCode.indexOf(needle);
    if (!(at("client.query('begin')") >= 0 && at("client.query('begin')") < at('in share row exclusive mode') && at('in share row exclusive mode') < at('runLeastPrivilegeChecks(client') && at('runLeastPrivilegeChecks(client') < at('deleteRun(client'))) failures.push('retention-run.ts: the least-privilege checks must run inside the delete transaction (begin, lock, checks, delete)');
    if (/runRetentionDryRun/.test(runCode)) failures.push('retention-run.ts: must not run the dry run in its own transactions before the delete transaction');
    for (const required of ['isRollbackTag(answer)', 'isDefiniteCommitRefusal(', 'clientUsable(client)', "from './commit-outcome.js'", 'commit_answered_rollback']) {
      if (!run.includes(required)) failures.push('retention-run.ts: COMMIT answer not verified (missing ' + required + ')');
    }
    // The real delete filters on the exact fixture tag and never on a retention rule predicate ("whatever is due"); the generic runRetention is not used.
    const delFn = /export const deleteTaggedFixtures[\s\S]*?\n};/.exec(run)?.[0] ?? '';
    if (!delFn.includes('delete from ${rule.table} where ${FIXTURE_KEY_COLUMN[rule.table]!} = $1') || delFn.includes('rule.where')) failures.push('retention-run.ts: the real delete must filter on the exact fixture tag only');
    if (/\brunRetention\b/.test(run.replace(/\/\/.*$/gm, ''))) failures.push('retention-run.ts: must not use the generic runRetention (it deletes whatever is due)');
    // Least-privilege checks are derived from the catalogue. Pinned count: 32 (asserted in smoke-tests.ts and the procedure PASS rule).
    const dry = read('pipeline/src/retention-dry-run.ts') ?? '';
    for (const required of ['aclexplode', "has_schema_privilege(current_user, oid, 'CREATE')", 'has_sequence_privilege', "has_database_privilege(current_user, current_database(), 'CREATE')", 'direct_function_grants', 'exec_public_internal', 'direct_relation_grants_outside', 'direct_column_grants_outside', 'pg_shdepend', 'other_object_acls', 'owned_objects', 'file_functions', 'secret_catalogues', 'ledger_grant_options', 'database_acls', 'value_leaking_catalogues', 'is_grantable', 'all_rels', 'all_funcs']) {
      if (!dry.includes(required)) failures.push('retention-dry-run.ts is missing catalogue check: ' + required);
    }
    // 21 line-start check() calls: counted-every-rule, session, the per-ledger loop (5 checks) and 18 catalogue checks; the denied-statement loop (a one-line for, 7 checks) is not line-start: 1+1+7+5+18 = 32 checks.
    if ((dry.match(/^\s+check\(/gm) ?? []).length !== 21) failures.push('retention-dry-run.ts: expected 21 line-start check() calls (32 checks in all); change the procedure PASS rule and smoke-tests.ts with it');
  }
}

if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  process.exit(1);
}
console.log('PASS staging rebuild tooling contract (12 shutdown fixtures, scoped removal, rebuilt-project runner guards)');
