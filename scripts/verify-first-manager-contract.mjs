#!/usr/bin/env node
// Offline contract check for the first-manager bootstrap (cutover OPEN-2; docs/build-plan/18-first-manager-bootstrap.md):
// pipeline/src/first-manager-bootstrap.ts, first-manager-runner.ts and their wiring in refusals.ts and scripts/run-with-secrets.mjs.
// Text-level only; the behaviour is proven by first-manager-bootstrap.test.ts (offline) and first-manager-bootstrap-a3.test.ts (real PostgreSQL 16, loopback).

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const PRODUCTION_REF = 'ejrfobddnojbijzrjbii';
const failures = [];
const read = (rel) => (existsSync(resolve(root, rel)) ? readFileSync(resolve(root, rel), 'utf8').replace(/\r\n/g, '\n') : undefined);
/** Source without comments (// and block), so a forbidden word in prose does not count and a real statement does. */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '')).join('\n');

const mod = read('pipeline/src/first-manager-bootstrap.ts');
const runner = read('pipeline/src/first-manager-runner.ts');
const refusals = read('pipeline/src/refusals.ts');
const wrapper = read('scripts/run-with-secrets.mjs');
const doc = read('docs/build-plan/18-first-manager-bootstrap.md');
const pkg = read('pipeline/package.json');
for (const [name, v] of [['first-manager-bootstrap.ts', mod], ['first-manager-runner.ts', runner], ['refusals.ts', refusals], ['run-with-secrets.mjs', wrapper], ['doc 18', doc], ['pipeline/package.json', pkg]]) {
  if (!v) failures.push(`missing ${name}`);
}
for (const f of ['pipeline/src/first-manager-bootstrap.test.ts', 'pipeline/src/first-manager-bootstrap-a3.test.ts']) if (!existsSync(resolve(root, f))) failures.push(`missing ${f}`);

if (mod) {
  const c = code(mod);
  // Target and confirmation guards.
  for (const required of [
    "'bootstrap_target_required'", "'target_not_recorded_production'", "'production_refused'", "'target_not_recorded_staging'", "'port_must_be_5432'", "'confirmation_required'",
    'RECORDED_PROJECT_REFS.production', 'requireRecordedRebuiltRef', 'parseSupabaseDbTarget', 'db.port !== 5432',
    "'CREATE TNBS STAGING FIRST MANAGER'", "'CREATE TNBS PRODUCTION FIRST MANAGER'", "'RUN TNBS FIRST MANAGER CHECK'",
    "staging: 'STAGING_DB_URL', production: 'PRODUCTION_DB_URL'",
  ]) if (!c.includes(required)) failures.push(`first-manager-bootstrap.ts is missing: ${required}`);
  // One transaction with the locks in the reviewed order, every check before and after, commit last, unknown commit never retried.
  const order = ["await client.query('begin')", 'roster_lock for update', 'lock table public.profiles in share row exclusive mode', 'assessFirstManagerPre(schema, before)', 'assessFirstManagerPost(', "await client.query('commit')"];
  let at = -1;
  for (const s of order) {
    const i = c.indexOf(s, at + 1);
    if (i < 0) failures.push(`first-manager-bootstrap.ts: missing or out of order: ${s}`); else at = i;
  }
  for (const required of ["'begin read only'", "'rollback'", 'committing = true', "result: 'unknown'", "'rollback_not_confirmed'", "set local lock_timeout", "set local statement_timeout", 'no_manager_profile_exists_in_any_status', 'no_earlier_bootstrap_event_is_recorded', 'the_profiles_account_link_is_dropped', 'the_owner_address_is_not_blocked']) {
    if (!c.includes(required)) failures.push(`first-manager-bootstrap.ts is missing: ${required}`);
  }
  // The service-role claim exists only on the promote path (once, transaction-local), never on the insert path.
  const claims = c.match(/request\.jwt\.claims/g) ?? [];
  if (claims.length !== 1 || !/path = 'promote';\n\s*await client\.query\("select set_config\('request\.jwt\.claims', '\{\\"role\\":\\"service_role\\"\}', true\)"\)/.test(c)) failures.push('first-manager-bootstrap.ts: the service-role claim must appear exactly once, transaction-local, on the promote path only');
  // Writes: exactly one profile insert, one promote update, one audit insert.
  const writes = c.match(/\b(insert\s+into|update)\s+[a-z_.]+/gi) ?? [];
  const expected = ['insert into public.profiles', 'update public.profiles', 'insert into internal.auth_events'];
  if (writes.length !== 3 || !expected.every((w, i) => writes[i]?.replace(/\s+/g, ' ').toLowerCase() === w)) failures.push(`first-manager-bootstrap.ts: the only writes must be ${expected.join(', ')} (found ${writes.join(' | ')})`);
  // The promote update is limited to one pristine pending guest and refuses when any manager exists.
  for (const required of ["email = $1 and role = 'guest' and status = 'pending' and approved_by is null and approved_at is null", "not exists (select 1 from public.profiles m where m.role = 'manager')"]) {
    if (!c.includes(required)) failures.push(`first-manager-bootstrap.ts: the promote update must contain: ${required}`);
  }
  // Nothing destructive, no Auth user, no network, no environment, no mail.
  for (const forbidden of [/\bdelete\s+from\b/i, /\bdrop\s+(table|schema|function|role|database|column|constraint|index|trigger)\b/i, /\btruncate\b/i, /\balter\s+(table|role|schema|function)\b/i, /\bcreate\s+(table|schema|function|role|extension|trigger)\b/i,
    /auth\.users/i, /\bfetch\s*\(/, /process\.env/, /invite/i, /magiclink/i, /generateLink/, /deleteUser/, /password\s*[:=]/i, /service_role_key/i, /sb_secret_|postgres(ql)?:\/\//i]) {
    if (forbidden.test(c)) failures.push(`first-manager-bootstrap.ts must not contain ${forbidden}`);
  }
  if (mod.includes(PRODUCTION_REF)) failures.push('first-manager-bootstrap.ts must read the production ref from target-guard.ts, not repeat it');
  // The reporting functions print counts and enumerated words only.
  const reporting = mod.slice(mod.indexOf('// Reporting'), mod.indexOf('// Execution'));
  if (/FIRST_MANAGER_EMAIL|FIRST_MANAGER_NAME|\.id\b|userId/.test(reporting)) failures.push('first-manager-bootstrap.ts: the reporting section must not print the address, the name or an id');
  if (/console\.(log|error)\(JSON\.stringify\(\{[^}]*(FIRST_MANAGER_EMAIL|FIRST_MANAGER_NAME|userId)/.test(mod)) failures.push('first-manager-bootstrap.ts: an event carries the address, the name or an id');
}

if (runner) {
  const c = code(runner);
  for (const required of ['let target: string | undefined;', "arg === '--execute'", "'first-manager.plan_only'", "'first-manager.refused'", 'classifyRunnerFailure', 'selectFirstManagerDbUrl(args.target, env)', 'planFirstManager(', 'if (!args.execute)']) {
    if (!c.includes(required)) failures.push(`first-manager-runner.ts is missing: ${required}`);
  }
  if (/target\s*=\s*'(staging|production)'/.test(c) || /let target[^;]*=/.test(c)) failures.push('first-manager-runner.ts: --target must have no default');
  if ((c.match(/process\.env/g) ?? []).length !== 1) failures.push('first-manager-runner.ts: process.env may be read exactly once, at the direct-invocation entry point');
  const planAt = c.indexOf('if (!args.execute)');
  const execAt = c.indexOf('await executeFirstManagerPlan');
  if (planAt < 0 || execAt < 0 || planAt > execAt) failures.push('first-manager-runner.ts: the plan-only return must come before anything connects');
  if (/(connection|dbUrl|password|host)[^\n]*console\.(log|error)|console\.(log|error)[^\n]*(dbUrl|password|\.host)/.test(c)) failures.push('first-manager-runner.ts must not print connection details');
}

// The two older runners must still refuse production and must not know about this tool.
for (const f of ['pipeline/src/staging-sql-runner.ts', 'pipeline/src/staging-rebuilt.ts']) {
  const s = read(f);
  if (!s) failures.push(`missing ${f}`);
  else {
    if (!s.includes("'production_refused'")) failures.push(`${f} must keep refusing the production project`);
    if (/first-manager|first_manager/i.test(s)) failures.push(`${f} must not reference the first-manager tool (separate runner, separate production confirmation)`);
  }
}

if (refusals && wrapper) {
  for (const id of ['bootstrap_target_required', 'target_not_recorded_production', 'first_manager_refused']) {
    if (!refusals.includes(`'${id}'`)) failures.push(`refusals.ts is missing ${id}`);
    if (!wrapper.includes(`'${id}'`)) failures.push(`run-with-secrets.mjs REFUSAL_IDS is missing ${id}`);
  }
}
if (wrapper) {
  for (const required of ["'PRODUCTION_DB_URL'", 'export const PROMPT_ONLY = [\'PRODUCTION_DB_URL\']', 'can only be entered at the hidden prompt, never taken from the environment',
    "'first-manager.verified'", "'first-manager.plan_only'", "'first-manager.state'", "'first-manager.check'", "'first-manager.checks'", "'first-manager.result'", "'first-manager.done'", "'first-manager.refused'"]) {
    if (!wrapper.includes(required)) failures.push(`run-with-secrets.mjs is missing: ${required}`);
  }
  // The --from-env scope is unchanged: staging only, project and config pinned.
  for (const required of ["FROM_ENV_PROJECT = 'truck-recruitment-tool'", "FROM_ENV_CONFIG = 'stg'"]) if (!wrapper.includes(required)) failures.push(`run-with-secrets.mjs: --from-env scope changed (${required})`);
}
if (pkg) {
  for (const required of ['"first-manager": "tsx src/first-manager-runner.ts"', '"test:first-manager": "tsx src/first-manager-bootstrap.test.ts"']) if (!pkg.includes(required)) failures.push(`pipeline/package.json is missing: ${required}`);
}

// The design note records the decisions this tool depends on.
if (doc) {
  const flat = doc.replace(/\s+/g, ' ');
  for (const required of [
    'CREATE TNBS PRODUCTION FIRST MANAGER', 'CREATE TNBS STAGING FIRST MANAGER', 'RUN TNBS FIRST MANAGER CHECK', 'there is no default target', 'refuses if any manager profile exists',
    'no Supabase Auth user', 'M1b', 'Single use', 'its own go', 'Never run against production',
  ]) if (!flat.includes(required)) failures.push(`doc 18 is missing: ${required}`);
}

if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  process.exit(1);
}
console.log('PASS first-manager bootstrap contract (explicit target, per-target confirmation, plan-only default, single use, locked single transaction, no Auth user, allow-listed output, prompt-only production URL)');
