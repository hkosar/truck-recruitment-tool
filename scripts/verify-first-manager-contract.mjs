#!/usr/bin/env node
// Offline contract check for the first-manager bootstrap (cutover OPEN-2; docs/build-plan/18-first-manager-bootstrap.md):
// pipeline/src/first-manager-bootstrap.ts, first-manager-runner.ts and their wiring in refusals.ts and scripts/run-with-secrets.mjs.
// Text-level, but it checks the guard statements themselves (see 'Guard statements') and that the tests are wired into verification; the behaviour is proven by first-manager-bootstrap.test.ts (offline) and first-manager-bootstrap-a3.test.ts (real PostgreSQL 16, loopback).

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

// ---------------------------------------------------------------------------------------------------------------
// Guard statements. Each pattern below is the statement itself, not just a name that could survive in a comment or a disabled branch
// (comments are stripped first). The behaviour is proven by the offline and real-PostgreSQL tests; this check makes sure none of the
// guards was edited out, and that those tests are wired into the normal offline verification.
// ---------------------------------------------------------------------------------------------------------------
const need = (name, c, re, what) => { if (!c || !re.test(c)) failures.push(name + ' must keep: ' + what); };
if (mod) {
  const c = code(mod);
  need('first-manager-bootstrap.ts', c, /if \(input\.confirm !== wanted\) \{\s*throw new RunnerRefusal\('confirmation_required'/, 'the exact-confirmation refusal (if (input.confirm !== wanted) throw confirmation_required)');
  need('first-manager-bootstrap.ts', c, /if \(db\.port !== 5432\) throw new RunnerRefusal\('port_must_be_5432'/, 'the port 5432 refusal');
  need('first-manager-bootstrap.ts', c, /if \(!isTarget\(input\.target\)\) \{\s*throw new RunnerRefusal\('bootstrap_target_required'/, 'the required-target refusal');
  need('first-manager-bootstrap.ts', c, /if \(!pre\.ok\) throw new RunnerRefusal\('first_manager_refused'/, 'the precondition refusal (if (!pre.ok) throw first_manager_refused)');
  need('first-manager-bootstrap.ts', c, /if \(!post\.ok\) throw new RunnerRefusal\('first_manager_refused'/, 'the postcondition refusal');
  need('first-manager-bootstrap.ts', c, /if \(userId === undefined\) throw new RunnerRefusal\('first_manager_refused'/, 'the exactly-one-row write refusal');
  need('first-manager-bootstrap.ts', c, /if \(!schemaReady\(schema\)\) \{[^]*?throw new RunnerRefusal\('first_manager_refused'/, 'the schema-not-ready refusal before any lock');
  need('first-manager-bootstrap.ts', c, /const locked = await client\.query\('select 1 from internal\.roster_lock for update'\);[^]*?if \(locked\.rowCount !== 1\) \{[^]*?throw new RunnerRefusal\('first_manager_refused'/, 'the check that the locked roster control read returned exactly one row');
  need('first-manager-bootstrap.ts', c, /s\?\.m1_tables === true && s\.m1_sign_in_functions === true && s\.m1b_function === true && s\.account_link_present === false && s\.roster_lock_rows === 1/, 'schemaReady requiring the sign-in functions and exactly one roster control row');
  need('first-manager-bootstrap.ts', c, /to_regprocedure\('internal\.auth_mint_lock\(text,timestamptz,timestamptz\)'\)/, 'the schema probe for internal.auth_mint_lock');
  need('first-manager-bootstrap.ts', c, /from internal\.auth_mint_lock\(\$1,/, 'the real sign-in lookup call (internal.auth_mint_lock)');
  need('first-manager-bootstrap.ts', c, /assessFirstManagerPost\(before, await readRosterFacts\(client\), path, await readSignInLookup\(client, userId\)\)/, 'the postcondition fed by the real sign-in lookup');
  need('first-manager-bootstrap.ts', c, /ok: is\(lookup, 1\) \}/, 'the sign-in lookup postcondition');
  need('first-manager-bootstrap.ts', c, /if \(target === 'production' && value && env\[PRODUCTION_PROMPT_PROOF_VARIABLE\] !== promptProof\(value\)\) \{\s*throw new RunnerRefusal\('plan_refused'/, 'the refusal of a production URL that did not come from the hidden prompt');
  // Order inside the write transaction: the refusal comes before the first write, the postcondition refusal before COMMIT.
  const iPre = c.indexOf('if (!pre.ok) throw'); const iInsert = c.indexOf('client.query(INSERT_SQL'); const iPost = c.indexOf('if (!post.ok) throw'); const iCommit = c.indexOf("await client.query('commit')");
  if (!(iPre > 0 && iPre < iInsert && iInsert < iPost && iPost < iCommit)) failures.push('first-manager-bootstrap.ts: precondition refusal, then the write, then the postcondition refusal, then COMMIT, in that order');
}
if (runner) {
  const c = code(runner);
  const from = c.indexOf('if (!args.execute)'); const to = c.indexOf('await executeFirstManagerPlan');
  if (from < 0 || to < 0 || !/console\.log\(JSON\.stringify\(\{ msg: 'first-manager\.plan_only'[^\n]*\n\s*return;\s*\}/.test(c.slice(from, to))) failures.push('first-manager-runner.ts must keep: the plan-only block that prints plan_only and returns before executeFirstManagerPlan');
  need('first-manager-runner.ts', c, /main\(process\.argv\.slice\(2\), process\.env\)/, 'the real process environment passed only at the direct-invocation entry, into main (which enforces the prompt proof through selectFirstManagerDbUrl)');
  need('first-manager-runner.ts', c, /dbUrl: selectFirstManagerDbUrl\(args\.target, env\)/, 'the production URL selected through selectFirstManagerDbUrl');
}
if (wrapper) {
  const c = code(wrapper);
  need('run-with-secrets.mjs', c, /if \(fromEnv\) for \(const s of secrets\) if \(PROMPT_ONLY\.includes\(s\)\) throw new Error\(/, 'the PROMPT_ONLY refusal under --from-env');
  need('run-with-secrets.mjs', c, /if \(env\[name\] !== undefined && env\[name\] !== ''\) \{\s*throw new Error\(\x60refusing: \$\{name\} is already set in this terminal/, 'the refusal of a secret already set in the environment');
  need('run-with-secrets.mjs', c, /for \(const name of PROMPT_ONLY\) delete childEnv\[PROMPT_PROOF_PREFIX \+ name\];/, 'the removal of any ambient prompt proof');
  need('run-with-secrets.mjs', c, /if \(PROMPT_ONLY\.includes\(name\)\) childEnv\[PROMPT_PROOF_PREFIX \+ name\] = promptProof\(value\);/, 'the prompt proof handed to the child for a prompted PROMPT_ONLY secret');
  const proofOf = (src) => (src.match(/update\(\x60(tnbs-prompt-proof:\$\{value\})\x60\)/) ?? [])[1];
  if (!mod || proofOf(wrapper) === undefined || proofOf(wrapper) !== proofOf(mod)) failures.push('the prompt proof formula must be identical in run-with-secrets.mjs and first-manager-bootstrap.ts');
}
const a3 = read('pipeline/src/first-manager-bootstrap-a3.test.ts');
const a3urls = read('pipeline/src/first-manager-a3-urls.ts');
const unit = read('pipeline/src/first-manager-bootstrap.test.ts');
if (!a3urls) failures.push('missing pipeline/src/first-manager-a3-urls.ts');
else for (const required of ['u.search || u.hash', '!LOOPBACK.includes(u.hostname)', 'app.port !== port', 'A3_APP_ROLE', 'adminDatabase']) if (!code(a3urls).includes(required)) failures.push('first-manager-a3-urls.ts is missing: ' + required);
if (!a3) failures.push('missing the A3 test');
else {
  const c = code(a3);
  const iValidate = c.indexOf('validateA3Urls(ADMIN, APP)'); const iClient = c.indexOf('new pg.Client');
  if (iValidate < 0 || iClient < 0 || iValidate > iClient) failures.push('first-manager-bootstrap-a3.test.ts must call validateA3Urls(ADMIN, APP) before it creates any pg.Client');
  for (const required of ['the_roster_control_row_is_exactly_one', 'm1_sign_in_functions_are_installed', 'the_sign_in_lookup_finds_exactly_that_person']) if (!c.includes(required)) failures.push('first-manager-bootstrap-a3.test.ts is missing the real-PostgreSQL refusal case for ' + required);
}
if (unit) {
  for (const required of ['direct entry with an ambient PRODUCTION_DB_URL', 'the A3 test refuses ${name} before any client connects', 'the locked roster control read returns ${lockRows} rows', 'ambient PRODUCTION_DB_URL (${name}) is refused before any client is created', 'the real sign-in functions missing']) if (!unit.includes(required)) failures.push('first-manager-bootstrap.test.ts is missing the regression test: ' + required);
}
// Wiring: the behavioural tests and this contract must run in the normal offline verification route.
if (pkg) {
  const m = pkg.match(/"test": "([^"]*)"/);
  if (!m || !m[1].includes('tsx src/smoke-tests.ts') || !m[1].includes('tsx src/first-manager-bootstrap.test.ts')) failures.push('pipeline/package.json: "test" (which "build" and "verify" run) must run the smoke tests and the first-manager offline tests');
  const b = pkg.match(/"build": "([^"]*)"/); const v = pkg.match(/"verify": "([^"]*)"/);
  if (!b || !b[1].includes('npm test') || !v || !v[1].includes('npm run build')) failures.push('pipeline/package.json: "build" must run "npm test" and "verify" must run "npm run build"');
}
const ci = read('.github/workflows/ci.yml');
const safety = read('.github/ci/repository-safety.sh');
if (!ci) failures.push('missing .github/workflows/ci.yml');
else {
  if (!/npm run build/.test(ci)) failures.push('.github/workflows/ci.yml must run "npm run build" in the pipeline job (it runs the first-manager offline tests)');
  for (const required of ['node scripts/verify-first-manager-contract.mjs', 'node --test scripts/run-with-secrets.test.mjs']) if (!ci.includes(required)) failures.push('.github/workflows/ci.yml must run: ' + required);
}
if (!safety) failures.push('missing .github/ci/repository-safety.sh');
else for (const required of ['verify-first-manager-contract.mjs', 'run-with-secrets.test.mjs']) if (!safety.includes(required)) failures.push('.github/ci/repository-safety.sh must run: ' + required);

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
