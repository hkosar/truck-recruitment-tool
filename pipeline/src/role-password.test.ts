// Tests for the role-password action (role-password.ts): offline refusals and verifier vectors always run; the real-PostgreSQL half
// (verifier equals the server's own, a client logs in after ALTER ROLE with the verifier) runs only when ROLE_PASSWORD_PG_URL is set.
// ROLE_PASSWORD_PG_URL must be a LOOPBACK superuser URL on a throwaway cluster the test owner started, a tr_ database whose comment starts
// "role-password-owned:". No hosted service is contacted.
// Run: npx tsx src/role-password.test.ts   (real PG: ROLE_PASSWORD_PG_URL=postgresql://postgres@127.0.0.1:<port>/tr_role_password npx tsx src/role-password.test.ts)

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import {
  CHECKED_SETTINGS, CLIENT_QUERY_TIMEOUT_MS, HARMLESS_LOGGING_SETTINGS, OTHER_KNOWN_SETTINGS, SENTINEL_SETTINGS, MUST_BE_OFF_SETTINGS, SESSION_SAFETY_SQL, LOCK_TIMEOUT_SQL, SEARCH_PATH_SQL, lockTimeoutSql, ROLE_PASSWORD_RESULTS, ROLE_PASSWORD_ACTIONS, ROLE_PASSWORD_ROLES, ROLE_PASSWORD_VARIABLES, SETTINGS_SQL, SET_VERIFIER_SQL, STATEMENT_TIMEOUT_SQL, doAlterSql, executeRolePassword, loggingProblem, passwordProblem, newRolePasswordClient, planRolePassword, rolePasswordClientOptions, runRolePassword, scramSha256Verifier,
} from './role-password.js';
import { DbTlsRefusal, isDbSecurityFailure, isLoopbackHost } from './db-tls.js';
import { TEST_HOST, makeTestPki, redirectHosts, startFakePg, withRepoPins, type FakeAuth, type FakePgRecord, type TestCert } from './db-tls-testkit.js';
import { REFUSAL_IDS, RunnerRefusal, classifyRunnerFailure } from './refusals.js';
import { REPOSITORY_ROOT, type RebuiltSqlClient } from './staging-rebuilt.js';
import type { PinnedRootCa } from './supabase-root-ca.js';
import { RECORDED_PROJECT_REFS } from './target-guard.js';

const REBUILT = RECORDED_PROJECT_REFS.stagingRebuilt as string;
const pooler = (ref: string, user = 'postgres', port = 5432) => `postgresql://${user}.${ref}:runner-pw-not-real@aws-0-us-east-2.pooler.supabase.com:${port}/postgres`;
const PW = 'Zx9-test-password-NOT-A-REAL-SECRET-4471'; // fixture only; 40 URL-safe characters
const APP = ROLE_PASSWORD_ACTIONS['set-app-password'];
const MAINT = ROLE_PASSWORD_ACTIONS['set-maintenance-password'];
let n = 0;
const check = (name: string, ok: boolean) => { assert.ok(ok, name); console.log(`PASS ${name}`); n += 1; };
const refusalOf = (fn: () => unknown): string | undefined => { try { fn(); return undefined; } catch (e) { return e instanceof RunnerRefusal ? e.id : `other:${(e as Error).message}`; } };
const SAFE_LOGGING: Record<string, string> = { log_statement: 'none', log_min_duration_statement: '-1', log_min_duration_sample: '-1', log_statement_sample_rate: '1', log_transaction_sample_rate: '0', log_parameter_max_length: '-1', log_parameter_max_length_on_error: '0', 'pgaudit.log': 'none', 'auto_explain.log_min_duration': '-1', log_lock_waits: 'off', deadlock_timeout: '1000',
  ...Object.fromEntries(MUST_BE_OFF_SETTINGS.map((s) => [s, 'off'])), log_min_messages: 'warning', track_activities: 'on', server_version_num: '160015', client_connection_check_interval: '0' };
const settingsMap = (o: Record<string, string>) => new Map(Object.entries({ ...SAFE_LOGGING, ...o }));
const base = { action: 'set-app-password', dbUrl: pooler(REBUILT), confirm: APP.confirmation, password: PW };

/** Every line any captured run printed (checked at the end: no verifier-shaped or password-shaped value). */
const everyLine: string[] = [];
/** Anything written straight to process.stdout / process.stderr while a captured run was active (must stay empty). */
const rawWrites: string[] = [];
/** Captures console.log lines while `fn` runs. */
async function captured<T>(fn: () => Promise<T>): Promise<{ lines: string[]; value?: T; error?: unknown }> {
  const lines: string[] = [];
  const orig = console.log;
  const out = process.stdout.write;
  const errw = process.stderr.write;
  console.log = (...a: unknown[]) => { const l = a.map(String).join(' '); lines.push(l); everyLine.push(l); };
  // A direct stdout/stderr write by the module is a leak channel: record it (the tests assert rawWrites stays empty).
  process.stdout.write = ((chunk: unknown) => { rawWrites.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => { rawWrites.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try { return { lines, value: await fn() }; } catch (error) { return { lines, error }; } finally { console.log = orig; process.stdout.write = out; process.stderr.write = errw; }
}

async function main(): Promise<void> {
  // ---- verifier format and vectors (offline)
  const v = scramSha256Verifier(PW, Buffer.alloc(16, 7));
  check('verifier has the PostgreSQL form SCRAM-SHA-256$4096:<salt>$<StoredKey>:<ServerKey>', /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/.test(v));
  // RFC 7677 section 3 example (user "user", password "pencil", salt W22ZaJ0SNY7soEsUEjb6gQ==, 4096 iterations): its SaltedPassword/keys are fixed; the stored-key and
  // server-key below were computed independently with Python hashlib/hmac (pbkdf2_hmac, 'Client Key', 'Server Key') and are checked into this test as the vector.
  const rfc = scramSha256Verifier('pencil', Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64'));
  check('RFC 7677 example salt and password (pencil) give the independently computed (Python hashlib/hmac) StoredKey and ServerKey', rfc === 'SCRAM-SHA-256$4096:W22ZaJ0SNY7soEsUEjb6gQ==$WG5d8oPm3OtcPnkdi4Uo7BkeZkBFzpcXkuLmtbsT4qY=:wfPLwcE6nTWhTAmQ7tl2KeoiWGPlZqQxSrmfPwDl2dU=');
  check('fresh random salt each time, same password', scramSha256Verifier(PW) !== scramSha256Verifier(PW));
  check('verifier never contains the password', !scramSha256Verifier(PW).includes(PW));
  const urlSafe = (n: number) => 'aB3_-xY9kQ2mZ7pL4wR8sT1vN5cD6fGhJ0bEuHiOyAtUeSoIqKlMnPrVzWjXdC'.slice(0, n);
  check('password rule: short, long, space, control, non-ASCII, URL-unsafe (@ : / ? # % [ ] ! + =), repetitive, empty and missing are rejected; 32 and 128 random URL-safe characters are accepted',
    ['short', urlSafe(31), urlSafe(60) + urlSafe(60) + urlSafe(9), `${urlSafe(40)} y`, `${urlSafe(40)}\n`, `${urlSafe(40)}é`, ...[...'@:/?#%[]!+='].map((c) => urlSafe(40) + c), 'x'.repeat(40), 'ab'.repeat(20), '', undefined].every((p) => passwordProblem(p as string | undefined) !== null)
    && passwordProblem(urlSafe(32)) === null && passwordProblem(urlSafe(60) + urlSafe(60) + urlSafe(8)) === null && passwordProblem(randomBytes(36).toString('base64url')) === null);
  check('every accepted password is URL-safe: it survives encodeURIComponent unchanged', encodeURIComponent(PW) === PW && encodeURIComponent(urlSafe(40)) === urlSafe(40));

  // ---- planning and refusals (offline, before any connection)
  const plan = planRolePassword(base);
  check('plan for the recorded rebuilt project, session port, exact phrase: role recruiter_app, verifier ready, no connection made', plan.role === 'recruiter_app' && plan.target.projectRef === REBUILT && /^SCRAM-SHA-256\$/.test(plan.verifier));
  check('maintenance action maps to recruiter_maintenance with its own variable and phrase', planRolePassword({ ...base, action: 'set-maintenance-password', confirm: MAINT.confirmation }).role === 'recruiter_maintenance'
    && APP.passwordVariable === 'STAGING_APP_DB_PASSWORD' && MAINT.passwordVariable === 'STAGING_MAINT_DB_PASSWORD' && (APP.confirmation as string) !== (MAINT.confirmation as string));
  check('exactly two roles and two variables are possible', ROLE_PASSWORD_ROLES.join() === 'recruiter_app,recruiter_maintenance' && ROLE_PASSWORD_VARIABLES.join() === 'STAGING_APP_DB_PASSWORD,STAGING_MAINT_DB_PASSWORD');
  check('wrong role / arbitrary action names are refused (unknown_action)', ['set-postgres-password', 'set-authenticator-password', 'set-app-password ', '__proto__', 'constructor', ''].every((a) => refusalOf(() => planRolePassword({ ...base, action: a })) === 'unknown_action'));
  check('wrong target: production, the old staging project and an unrecorded project are refused', refusalOf(() => planRolePassword({ ...base, dbUrl: pooler(RECORDED_PROJECT_REFS.production) })) === 'production_refused'
    && refusalOf(() => planRolePassword({ ...base, dbUrl: pooler(RECORDED_PROJECT_REFS.staging) })) === 'target_not_recorded_staging'
    && refusalOf(() => planRolePassword({ ...base, dbUrl: pooler('zzzzzzzzzzzzzzzzzzzz') })) === 'target_not_recorded_staging');
  check('production is refused even if it were (wrongly) the recorded rebuilt ref', refusalOf(() => planRolePassword({ ...base, dbUrl: pooler(RECORDED_PROJECT_REFS.production), recordedRebuiltRef: RECORDED_PROJECT_REFS.production })) === 'ref_invalid');
  check('an unrecorded rebuilt ref refuses everything', refusalOf(() => planRolePassword({ ...base, recordedRebuiltRef: null })) === 'ref_not_recorded');
  check('transaction pooler port 6543 and a missing URL are refused', refusalOf(() => planRolePassword({ ...base, dbUrl: pooler(REBUILT, 'postgres', 6543) })) === 'port_must_be_5432' && refusalOf(() => planRolePassword({ ...base, dbUrl: undefined })) === 'db_url_required');
  check('missing, wrong, partial and wrong-case confirmation are refused', [undefined, '', APP.confirmation.toLowerCase(), `${APP.confirmation} `, MAINT.confirmation, 'yes'].every((c) => refusalOf(() => planRolePassword({ ...base, confirm: c })) === 'confirmation_required'));
  check('missing or weak password variable is refused (role_password_refused)', [undefined, '', 'short', `${'x'.repeat(40)} y`, `${PW}!`, `${PW}@`].every((p) => refusalOf(() => planRolePassword({ ...base, password: p })) === 'role_password_refused'));
  check('--out is refused for the role-password actions (not silently ignored)', refusalOf(() => planRolePassword({ ...base, out: 'x.json' })) === 'role_password_refused' && refusalOf(() => planRolePassword({ ...base, out: '' })) === 'role_password_refused');
  check('connecting as an application role is refused (the runner must be the privileged login)', ['recruiter_app', 'recruiter_maintenance'].every((u) => refusalOf(() => planRolePassword({ ...base, dbUrl: pooler(REBUILT, u) })) === 'role_password_refused'));
  check('the refusal id is a registered fixed identifier and the wrapper copy agrees', (REFUSAL_IDS as readonly string[]).includes('role_password_refused')
    && (await import(pathToFileURL(resolve(REPOSITORY_ROOT, 'scripts/run-with-secrets.mjs')).href) as { REFUSAL_IDS: string[] }).REFUSAL_IDS.join() === REFUSAL_IDS.join());
  const msg = (() => { try { planRolePassword({ ...base, password: 'short-secret' }); } catch (e) { return String((e as Error).message); } return ''; })();
  check('a refusal message never carries the password value', msg !== '' && !msg.includes('short-secret') && !msg.includes('runner-pw-not-real'));

  // ---- executor against a fake client: statements, events, rollback, unknown commit, redaction
  const sent: string[] = [];
  const bound: [string, unknown[]][] = [];
  const fake = (over: { settings?: Record<string, string>; expired?: boolean; rows?: (sql: string, call: number) => unknown[]; failOn?: RegExp; failCommit?: boolean; failRollback?: boolean } = {}): RebuiltSqlClient => {
    let facts = 0;
    return {
      connect: async () => undefined,
      end: async () => undefined,
      query: async (sql: string, args?: unknown[]) => {
        sent.push(sql);
        if (args && /set_config/.test(sql)) bound.push([sql, args]);
        if (/pg_catalog.pg_settings/.test(sql)) return { rows: [...settingsMap(over.settings ?? {})].map(([name, setting]) => ({ name, setting })) };
        if (over.failOn?.test(sql)) throw Object.assign(new Error(`boom ${PW} ${plan.verifier}`), { code: '42501' });
        if (sql === 'commit' && over.failCommit) throw Object.assign(new Error('commit lost'), { code: '08006' });
        if (sql === 'rollback' && over.failRollback) throw new Error('no answer');
        if (/from pg_catalog.pg_roles/.test(sql)) { facts += 1; return { rows: over.rows ? over.rows(sql, facts) : [{ rolcanlogin: facts > 1, rolsuper: false, rolinherit: true, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolbypassrls: false, rolconnlimit: -1, has_valid_until: over.expired === true, expired: over.expired === true, config: '', matches: 1 }] }; }
        return { rows: [], rowCount: 0 };
      },
    };
  };
  let r = await captured(() => runRolePassword(fake(), plan));
  const alter = sent.filter((s) => /^do \$\$/.test(s));
  const k = SESSION_SAFETY_SQL.length;
  check('success: begin, search_path = pg_catalog, debug_print_* / exit_on_error / jit off / client_connection_check_interval 0, settings read, statement_timeout, lock_timeout, verifier bound to set_config, one constant DO block, commit; one committed event', r.error === undefined && sent[0] === 'begin' && sent[1] === SEARCH_PATH_SQL && sent.slice(2, 2 + k).join() === SESSION_SAFETY_SQL.join() && k === 6 && /pg_settings/.test(sent[2 + k]!) && sent[3 + k] === STATEMENT_TIMEOUT_SQL && sent[4 + k] === LOCK_TIMEOUT_SQL
    && sent.includes(SET_VERIFIER_SQL) && alter.length === 1 && alter[0] === doAlterSql('recruiter_app') && sent[sent.length - 1] === 'commit' && r.lines.length === 1 && JSON.parse(r.lines[0]!).result === 'committed');
  check('the verifier and the plain password are in NO statement text sent to the server (the verifier is only a bind parameter); the DO text has both handlers', !sent.some((s) => s.includes(PW) || s.includes(plan.verifier) || /SCRAM-SHA-256/.test(s))
    && /exception when query_canceled then raise exception using errcode = 'query_canceled', message = 'role password statement failed'; when others then raise exception using errcode = sqlstate, message = 'role password statement failed'/.test(alter[0]!)
    && /format\('alter role recruiter_app login password %L'/.test(alter[0]!) && !/\$1|\$2/.test(alter[0]!));
  check('the verifier is passed as the one bind parameter of set_config, and no event line holds the password or the verifier', bound.length === 1 && bound[0]![0] === SET_VERIFIER_SQL && bound[0]![1]!.length === 1 && bound[0]![1]![0] === plan.verifier && !r.lines.join('\n').includes(PW) && !r.lines.join('\n').includes(plan.verifier));
  sent.length = 0;
  r = await captured(() => runRolePassword(fake({ rows: () => [] }), plan));
  check('role missing: refused, rolled back, no ALTER ever sent', r.error instanceof RunnerRefusal && sent.every((s) => !/^do \$\$/.test(s)) && sent.includes('rollback') && JSON.parse(r.lines[0]!).result === 'rolled_back');
  sent.length = 0;
  r = await captured(() => runRolePassword(fake({ rows: () => [{ rolsuper: true, matches: 1 }] }), plan));
  check('superuser role: refused before ALTER, rolled back', r.error instanceof RunnerRefusal && sent.every((s) => !/^do \$\$/.test(s)) && sent.includes('rollback'));
  sent.length = 0;
  r = await captured(() => runRolePassword(fake({ rows: (_s, call) => [{ rolcanlogin: call > 1, rolsuper: false, rolcreatedb: call > 1, matches: 1 }] }), plan));
  check('another attribute changed: refused after ALTER, rolled back, never committed', r.error instanceof RunnerRefusal && !sent.includes('commit') && sent.includes('rollback') && JSON.parse(r.lines[0]!).result === 'rolled_back');
  sent.length = 0;
  r = await captured(() => runRolePassword(fake({ rows: () => [{ rolcanlogin: false, rolsuper: false, matches: 1 }] }), plan));
  check('LOGIN not on after the statement: refused, rolled back', r.error instanceof RunnerRefusal && !sent.includes('commit') && sent.includes('rollback'));
  sent.length = 0;
  r = await captured(() => runRolePassword(fake({ failOn: /^do \$\$/ }), plan));
  check('ALTER (DO block) failure: rolled back; the driver message (which here carries both secrets) is not printed and classifies to a fixed id plus SQLSTATE', JSON.parse(r.lines[0]!).result === 'rolled_back' && !r.lines.join('\n').includes(PW)
    && JSON.stringify(classifyRunnerFailure(r.error)) === JSON.stringify({ refusal: 'server_or_driver_error', err_code: '42501' }));
  sent.length = 0;
  r = await captured(() => runRolePassword(fake({ failOn: /^do \$\$/, failRollback: true }), plan));
  check('ALTER failure and rollback not acknowledged: rollback_not_confirmed', JSON.parse(r.lines[0]!).result === 'rollback_not_confirmed');
  sent.length = 0;
  r = await captured(() => runRolePassword(fake({ failCommit: true }), plan));
  check('COMMIT failure: result unknown, no rollback and no second ALTER (nothing is retried)', JSON.parse(r.lines[0]!).result === 'unknown' && !sent.includes('rollback') && sent.filter((s) => /^do \$\$/.test(s)).length === 1);
  sent.length = 0;
  r = await captured(() => runRolePassword(fake({ settings: { statement_timeout: '5000', lock_timeout: '2000' } }), plan));
  check('a stricter statement_timeout (5s) and lock_timeout (2s) already in force are kept: no SET LOCAL is sent for either', r.error === undefined && !sent.includes(STATEMENT_TIMEOUT_SQL) && !sent.includes(LOCK_TIMEOUT_SQL));
  sent.length = 0;
  r = await captured(() => runRolePassword(fake({ settings: { statement_timeout: '600000', lock_timeout: '0' } }), plan));
  check('a looser statement_timeout (10 min) or a lock_timeout of 0 (none) is tightened to ours', r.error === undefined && sent.includes(STATEMENT_TIMEOUT_SQL) && sent.includes(LOCK_TIMEOUT_SQL));
  sent.length = 0;
  r = await captured(() => runRolePassword(fake({ settings: { 'pg_stat_statements.track': 'all', 'pg_stat_statements.track_utility': 'on' } }), plan));
  check('pg_stat_statements.track=all with track_utility on is refused before the verifier is bound; rolled back', r.error instanceof RunnerRefusal && !sent.some((x) => /set_config|^do /.test(x)) && JSON.parse(r.lines[0]!).result === 'rolled_back');
  sent.length = 0;
  r = await captured(() => runRolePassword(fake({ settings: { 'pg_stat_statements.track': 'all', 'pg_stat_statements.track_utility': 'off' } }), plan));
  check('track=all with track_utility off records no utility statement and is allowed', r.error === undefined);
  sent.length = 0;
  r = await captured(() => runRolePassword(fake({ expired: true }), plan));
  check('a role with an expired VALID UNTIL is refused before the verifier is bound (it could not log in); rolled back, never committed', r.error instanceof RunnerRefusal && !sent.some((x) => /set_config|^do |^commit/.test(x)) && JSON.parse(r.lines[0]!).result === 'rolled_back');
  sent.length = 0;
  r = await captured(() => runRolePassword(fake(), plan));
  const unqualified = /(?<!pg_catalog\.)\b(pg_settings|pg_roles|set_config|current_setting|format|now|count)(?=\s*[(,)]|\s+(where|as)\b|\s*$)/;
  check('the unqualified-name pattern itself catches unqualified relations and functions and passes qualified ones', ['select 1 from pg_roles where rolname = $1', 'select x from pg_settings where name', 'select * from pg_settings', 'select format(1)', 'select now()']
    .every((x) => unqualified.test(x)) && !['select 1 from pg_catalog.pg_roles where rolname = $1', 'select pg_catalog.format(1)', 'select pg_catalog.now()'].some((x) => unqualified.test(x)));
  check('every statement names its pg_catalog objects: no unqualified pg_settings, pg_roles, set_config, current_setting or format in anything sent', sent.length > 0 && !sent.some((x) => unqualified.test(x)) && !/(?<!pg_catalog\.)pg_settings/.test(SETTINGS_SQL));
  sent.length = 0;
  r = await captured(() => runRolePassword(fake(), plan));
  const before = (re: RegExp, other: RegExp): boolean => sent.findIndex((x) => re.test(x)) >= 0 && sent.findIndex((x) => re.test(x)) < sent.findIndex((x) => other.test(x));
  check('search_path and the session safety settings (debug_print_*, exit_on_error, jit) are set before the settings read, and all before the verifier is bound', before(/^set local search_path = pg_catalog, pg_temp$/, /pg_settings/) && before(/^set local debug_print_plan = off$/, /pg_settings/) && before(/^set local debug_print_parse = off$/, /set_config/) && before(/^set local debug_print_rewritten = off$/, /set_config/)
    && before(/^set local exit_on_error = off$/, /pg_settings/) && before(/^set local exit_on_error = off$/, /set_config/) && before(/^set local jit = off$/, /set_config/));
  for (const re of [/debug_print_parse/, /debug_print_rewritten/, /debug_print_plan/, /exit_on_error/, /jit/, /search_path/]) {
    sent.length = 0;
    r = await captured(() => runRolePassword(fake({ failOn: new RegExp(`^set local ${re.source}`) }), plan));
    check(`a refused SET LOCAL ${re.source} fails closed: rolled back, verifier never bound, no ALTER sent, no commit`, r.error !== undefined && !sent.some((x) => /set_config|^do |^commit/.test(x)) && sent.includes('rollback') && JSON.parse(r.lines[0]!).result === 'rolled_back');
  }
  sent.length = 0;
  r = await captured(() => runRolePassword(fake({ settings: { log_lock_waits: 'on' } }), plan));
  check('log_lock_waits on, deadlock_timeout 1s: lock_timeout is set to 900ms (below deadlock_timeout), not 10s; the run proceeds', r.error === undefined && sent.includes(lockTimeoutSql(900)) && sent.includes("set local lock_timeout = '900ms'") && !sent.includes(LOCK_TIMEOUT_SQL));
  sent.length = 0;
  r = await captured(() => runRolePassword(fake({ settings: { log_lock_waits: 'on', deadlock_timeout: '60000' } }), plan));
  check('log_lock_waits on, deadlock_timeout 60s: the usual 10s lock_timeout is already below it and is used', r.error === undefined && sent.includes(LOCK_TIMEOUT_SQL) && !sent.some((x) => /ms'$/.test(x)));
  sent.length = 0;
  r = await captured(() => runRolePassword(fake({ settings: { log_lock_waits: 'on', lock_timeout: '500' } }), plan));
  check('log_lock_waits on and a stricter lock_timeout (500ms) already in force: kept', r.error === undefined && !sent.some((x) => /^set local lock_timeout/.test(x)));
  sent.length = 0;
  r = await captured(() => runRolePassword(fake({ settings: { log_lock_waits: 'on', lock_timeout: '2000' } }), plan));
  check('log_lock_waits on and a lock_timeout of 2s (above deadlock_timeout) in force: tightened to 900ms', r.error === undefined && sent.includes(lockTimeoutSql(900)));
  for (const [label, settings] of [['deadlock_timeout 150ms', { log_lock_waits: 'on', deadlock_timeout: '150' }], ['deadlock_timeout unreadable', { log_lock_waits: 'on', deadlock_timeout: 'x' }], ['log_lock_waits unrecognised value', { log_lock_waits: 'maybe', deadlock_timeout: '150' }]] as [string, Record<string, string>][]) {
    sent.length = 0;
    r = await captured(() => runRolePassword(fake({ settings }), plan));
    check(`log_lock_waits on with ${label}: refused (role_password_logging_refused) before the verifier is bound; rolled back`, r.error instanceof RunnerRefusal && r.error.id === 'role_password_logging_refused' && !sent.some((x) => /set_config|^do |^commit/.test(x)) && JSON.parse(r.lines[0]!).result === 'rolled_back');
  }
  sent.length = 0;
  r = await captured(() => runRolePassword(fake({ settings: { log_lock_waits: 'off', deadlock_timeout: '10' } }), plan));
  check('log_lock_waits off: a tiny deadlock_timeout does not matter and the usual 10s lock_timeout is used', r.error === undefined && sent.includes(LOCK_TIMEOUT_SQL));
  check('loggingProblem treats a missing pgaudit.log row as unsafe (fail closed)', loggingProblem(new Map(Object.entries({ ...SAFE_LOGGING })) .set('pgaudit.log', '')) === null && (() => { const m = settingsMap({}); m.delete('pgaudit.log'); return loggingProblem(m) !== null; })());
  // ---- logging settings that would write the bound verifier to the server log are refused before it is bound
  const unsafe: [string, Record<string, string>][] = [
    ['log_statement=all', { log_statement: 'all' }], ['log_min_duration_statement=0', { log_min_duration_statement: '0' }], ['log_min_duration_statement=250', { log_min_duration_statement: '250' }],
    ['log_min_duration_sample=0 with log_statement_sample_rate=1', { log_min_duration_sample: '0', log_statement_sample_rate: '1' }], ['log_transaction_sample_rate=1', { log_transaction_sample_rate: '1' }],
    ['log_transaction_sample_rate=0.01', { log_transaction_sample_rate: '0.01' }], ['pgaudit.log=all', { 'pgaudit.log': 'all' }], ['pgaudit.log=role', { 'pgaudit.log': 'role' }], ['pgaudit.log=ddl, role', { 'pgaudit.log': 'ddl, role' }],
    ['auto_explain.log_min_duration=0', { 'auto_explain.log_min_duration': '0' }], ['log_parameter_max_length_on_error=-1', { log_parameter_max_length_on_error: '-1' }], ['log_parameter_max_length_on_error=64', { log_parameter_max_length_on_error: '64' }],
    ['log_parser_stats=on', { log_parser_stats: 'on' }], ['log_planner_stats=on', { log_planner_stats: 'on' }], ['log_executor_stats=on', { log_executor_stats: 'on' }], ['log_statement_stats=on', { log_statement_stats: 'on' }],
    ['exit_on_error still on after SET LOCAL', { exit_on_error: 'on' }], ['jit still on after SET LOCAL', { jit: 'on' }], ['debug_print_plan still on after SET LOCAL', { debug_print_plan: 'on' }],
    ['log_parser_stats unreadable value', { log_parser_stats: 'maybe' }],
    ['an unclassified setting in the logging groups (a newer server: log_lock_failures)', { log_lock_failures: 'off' }], ['an unclassified build-only debug setting (wal_debug)', { wal_debug: 'off' }],
  ];
  for (const [label, settings] of unsafe) {
    sent.length = 0;
    r = await captured(() => runRolePassword(fake({ settings }), plan));
    check(`${label}: refused (role_password_logging_refused) before the verifier is bound; nothing changed; rolled back`, r.error instanceof RunnerRefusal && r.error.id === 'role_password_logging_refused' && !sent.some((x) => /set_config|^do |^commit/.test(x)) && sent.includes('rollback') && JSON.parse(r.lines[0]!).result === 'rolled_back');
  }
  sent.length = 0;
  r = await captured(() => runRolePassword(fake({ settings: { log_parameter_max_length: '0', log_statement: 'all', log_min_duration_statement: '0', log_statement_sample_rate: '1', log_min_duration_sample: '0', log_transaction_sample_rate: '1' } }), plan));
  check('with log_parameter_max_length = 0 the statement-logging settings are harmless and the run proceeds (log_statement=all, duration 0, both samplings on)', r.error === undefined && sent.includes('commit'));
  check('a missing row for any must-be-off setting (log_parser_stats, exit_on_error, jit, ...) counts as on and is refused', MUST_BE_OFF_SETTINGS.length === 9 && MUST_BE_OFF_SETTINGS.every((s) => { const m = settingsMap({}); m.delete(s); return loggingProblem(m) !== null; }));
  check('log_parameter_max_length = 0 does NOT excuse the *_stats settings, exit_on_error or an unclassified setting', ['log_parser_stats', 'log_planner_stats', 'log_executor_stats', 'log_statement_stats', 'exit_on_error'].every((s) => loggingProblem(settingsMap({ log_parameter_max_length: '0', [s]: 'on' })) !== null)
    && loggingProblem(settingsMap({ log_parameter_max_length: '0', trace_connection_negotiation: 'off' })) !== null);
  check('every harmless setting at any value is accepted, and the classified lists do not overlap', HARMLESS_LOGGING_SETTINGS.length === 68 && loggingProblem(settingsMap(Object.fromEntries(HARMLESS_LOGGING_SETTINGS.map((s) => [s, 'on'])))) === null
    && !HARMLESS_LOGGING_SETTINGS.some((s) => MUST_BE_OFF_SETTINGS.includes(s) || ['log_statement', 'log_lock_waits', 'log_parameter_max_length', 'log_parameter_max_length_on_error', 'log_min_duration_statement', 'log_min_duration_sample', 'log_statement_sample_rate', 'log_transaction_sample_rate'].includes(s)));
  check('log_parameter_max_length = 0 does NOT excuse log_parameter_max_length_on_error, pgaudit or auto_explain', loggingProblem(settingsMap({ log_parameter_max_length: '0', log_parameter_max_length_on_error: '5' })) !== null
    && loggingProblem(settingsMap({ log_parameter_max_length: '0', 'pgaudit.log': 'all' })) !== null && loggingProblem(settingsMap({ log_parameter_max_length: '0', 'auto_explain.log_min_duration': '5' })) !== null);
  check('safe combinations proceed: the defaults, log_statement=ddl and mod, sampling rate 0 with a duration, pgaudit.log empty or none', ([{},{ log_statement: 'ddl' }, { log_statement: 'mod' }, { log_min_duration_sample: '100', log_statement_sample_rate: '0' }, { 'pgaudit.log': '' }, { log_parameter_max_length: '0' }] as Record<string, string>[]).every((o) => loggingProblem(settingsMap(o)) === null));
  check('a setting that cannot be read fails closed (nothing returned, on-error length or duration non-numeric)', loggingProblem(new Map()) !== null
    && loggingProblem(settingsMap({ log_parameter_max_length_on_error: 'x' })) !== null && loggingProblem(settingsMap({ log_min_duration_statement: 'x' })) !== null);
  check('the settings query reads all of pg_settings by name (no category filter, no name filter), uses current_setting(..., true) for pgaudit and auto_explain, every checked name is listed, and the refusal ids are registered', !/category|where/i.test(SETTINGS_SQL)
    && ["current_setting('pgaudit.log', true)", "current_setting('auto_explain.log_min_duration', true)"].every((x) => SETTINGS_SQL.includes(x))
    && ['log_statement', 'log_min_duration_statement', 'log_min_duration_sample', 'log_statement_sample_rate', 'log_transaction_sample_rate', 'log_parameter_max_length', 'log_parameter_max_length_on_error', 'log_parser_stats', 'log_planner_stats', 'log_executor_stats', 'log_statement_stats', 'exit_on_error', 'jit', 'debug_print_plan', 'client_connection_check_interval'].every((x) => CHECKED_SETTINGS.includes(x))
    && ['role_password_logging_refused', 'role_password_expiry_refused', 'role_password_server_version_unverified'].every((id) => (REFUSAL_IDS as readonly string[]).includes(id)));
  check('classified lists are disjoint bare names; each sentinel missing from the read (what an empty or locale-filtered read looks like) is refused; an empty read is refused', new Set([...CHECKED_SETTINGS, ...HARMLESS_LOGGING_SETTINGS, ...OTHER_KNOWN_SETTINGS]).size === CHECKED_SETTINGS.length + HARMLESS_LOGGING_SETTINGS.length + OTHER_KNOWN_SETTINGS.length
    && OTHER_KNOWN_SETTINGS.every((s) => /^[A-Za-z_0-9]+$/.test(s)) && SENTINEL_SETTINGS.length >= 7 && SENTINEL_SETTINGS.every((s) => { const m = settingsMap({}); m.delete(s); return loggingProblem(m) !== null; })
    && ['log_statement', 'log_min_duration_statement', 'debug_print_parse', 'log_min_messages', 'track_activities'].every((s) => SENTINEL_SETTINGS.includes(s)));
  check('client_connection_check_interval must read 0 (SET LOCAL sets it); a name nobody classified is refused, a dotted extension setting is not', loggingProblem(settingsMap({ client_connection_check_interval: '1000' })) !== null
    && loggingProblem(settingsMap({ transaction_timeout: '0' })) !== null && loggingProblem(settingsMap({ 'supautils.something': 'x', 'pg_stat_statements.max': '5000' })) === null
    && OTHER_KNOWN_SETTINGS.every((s) => loggingProblem(settingsMap({ [s]: 'x' })) === null));
  for (const [label, ver] of [['PostgreSQL 17.6 (160006 = 170006)', '170006'], ['PostgreSQL 15', '150013'], ['PostgreSQL 18', '180000'], ['an unreadable version', 'x'], ['an empty version', '']] as [string, string][]) {
    sent.length = 0;
    r = await captured(() => runRolePassword(fake({ settings: { server_version_num: ver } }), plan));
    check(`server_version_num on ${label}: refused with role_password_server_version_unverified before the verifier is bound; rolled back`, r.error instanceof RunnerRefusal && r.error.id === 'role_password_server_version_unverified' && !sent.some((x) => /set_config|^do |^commit/.test(x)) && JSON.parse(r.lines[0]!).result === 'rolled_back');
  }
  {
    sent.length = 0;
    const noVer = fake(); const q0 = noVer.query.bind(noVer);
    r = await captured(() => runRolePassword({ ...noVer, query: async (sql: string, a?: unknown[]) => { const res = await q0(sql, a); return /pg_catalog.pg_settings/.test(sql) ? { rows: (res.rows as { name: string }[]).filter((x) => x.name !== 'server_version_num') } : res; } } as RebuiltSqlClient, plan));
    check('server_version_num missing from the read: refused (role_password_server_version_unverified), rolled back', r.error instanceof RunnerRefusal && r.error.id === 'role_password_server_version_unverified' && !sent.some((x) => /set_config|^do |^commit/.test(x)));
  }  sent.length = 0;
  r = await captured(() => runRolePassword(fake({ rows: (_s, call) => [{ rolcanlogin: call > 1, rolsuper: false, expired: false, expires_soon: true, matches: 1 }] }), plan));
  check('a VALID UNTIL within 24 hours is refused (role_password_expiry_refused) before the verifier is bound; rolled back, never committed', r.error instanceof RunnerRefusal && r.error.id === 'role_password_expiry_refused' && !sent.some((x) => /set_config|^do |^commit/.test(x)) && JSON.parse(r.lines[0]!).result === 'rolled_back');
  // The pg error's `where` field (on a FATAL it holds the ALTER text) must never be printed: only the classifier's id and SQLSTATE leave the process.
  const whereErr = Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01', severity: 'FATAL', where: `SQL statement "alter role recruiter_app login password '${plan.verifier}'"`, detail: plan.verifier, internalQuery: plan.verifier });
  sent.length = 0;
  const rWhere = await captured(() => runRolePassword({ ...fake(), query: async (q: string, a?: unknown[]) => { if (/^do \$\$/.test(q)) throw whereErr; return fake().query(q, a); } }, plan));
  check('a pg error whose where/detail/internalQuery hold the verifier is never printed: only the fixed event, no raw stdout/stderr write, and the classifier gives id plus SQLSTATE', !rWhere.lines.join('\n').includes(plan.verifier) && rawWrites.length === 0
    && JSON.stringify(classifyRunnerFailure(whereErr)) === JSON.stringify({ refusal: 'server_or_driver_error', err_code: '57P01' }) && JSON.parse(rWhere.lines[0]!).result === 'rolled_back');
  const opts = rolePasswordClientOptions();
  check('the real client has a client-side query timeout above the 30s statement timeout, a connect timeout and TCP keep-alive', opts.query_timeout === CLIENT_QUERY_TIMEOUT_MS && CLIENT_QUERY_TIMEOUT_MS > 30_000 && opts.connectionTimeoutMillis === 10_000 && opts.keepAlive === true && opts.keepAliveInitialDelayMillis === 10_000);
  {
    // The client the executor really builds (pg-secure.ts) carries those limits: checked on the pg client itself, for a loopback target (no TLS needed to build it).
    const real = newRolePasswordClient({ ...plan.target, host: '127.0.0.1' }) as unknown as { connectionParameters: Record<string, unknown>; _connectionTimeoutMillis: unknown; connection: { _keepAlive: unknown; _keepAliveInitialDelayMillis: unknown } };
    check('the executor\'s real client is built by pg-secure.ts with the query timeout, connect timeout and keep-alive reaching the pg client', real.connectionParameters.query_timeout === CLIENT_QUERY_TIMEOUT_MS && real.connection._keepAlive === true && real.connection._keepAliveInitialDelayMillis === 10_000
      && real._connectionTimeoutMillis === 10_000 && real.connectionParameters.ssl === false);
  }
  // ---- TLS: a hosted-looking target goes through the TLS-hardened client. A fake PostgreSQL server on 127.0.0.1 stands in for the host (socket redirect, no DNS, no network).
  {
    const pki = makeTestPki();
    const rootPin = pki.pin(pki.root);
    const RUNNER_PW = 'runner-pw-not-real';
    const secrets = [RUNNER_PW, PW, plan.verifier, ...(/^SCRAM-SHA-256\$4096:([^$]+)\$([^:]+):(.+)$/.exec(plan.verifier)!.slice(1))].map((s) => Buffer.from(s, 'utf8'));
    const leaked = (rec: FakePgRecord) => rec.afterStartup.some((b) => secrets.some((s) => b.includes(s)));
    const viaFake = async (o: { tlsCert: TestCert | null; auth: FakeAuth; pins: PinnedRootCa[]; host: string }) => {
      const server = await startFakePg({ tlsCert: o.tlsCert, auth: o.auth });
      const undo = redirectHosts([o.host], server.port);
      const p = { ...plan, target: { ...plan.target, host: o.host } };
      let run: Awaited<ReturnType<typeof captured>>;
      try { run = await withRepoPins(o.pins, () => captured(() => executeRolePassword(p))); } finally { undo(); await new Promise((r2) => setTimeout(r2, 50)); await server.close(); }
      return { run, record: server.record };
    };
    const hostedHost = plan.target.host;
    check('test setup: the plan target is a hosted-looking (non-loopback) host', !isLoopbackHost(hostedHost) && /pooler\.supabase\.com$/.test(hostedHost));
    const noCa = await viaFake({ tlsCert: pki.server, auth: 'trust', pins: [], host: hostedHost });
    check('hosted-looking target with NO pinned CA: refused (no_trusted_ca, db_tls_refused) before anything is dialled: 0 connections, 0 bytes, 0 password messages, no event printed',
      noCa.run.error instanceof DbTlsRefusal && noCa.run.error.reason === 'no_trusted_ca' && JSON.stringify(classifyRunnerFailure(noCa.run.error)) === JSON.stringify({ refusal: 'db_tls_refused' })
      && noCa.record.connections === 0 && noCa.record.afterStartup.length === 0 && noCa.record.passwordMessages === 0 && noCa.run.lines.length === 0);
    const wrongCa = await viaFake({ tlsCert: pki.server, auth: 'trust', pins: [pki.pin(pki.otherRoot)], host: TEST_HOST });
    check('hosted-looking target whose certificate chains to a different CA than the pin: refused by TLS (db_tls_refused) before the startup message; no password, runner password or verifier byte sent',
      isDbSecurityFailure(wrongCa.run.error) && !(wrongCa.run.error instanceof DbTlsRefusal) && JSON.stringify(classifyRunnerFailure(wrongCa.run.error)) === JSON.stringify({ refusal: 'db_tls_refused' })
      && wrongCa.record.connections === 1 && wrongCa.record.plaintextStartups === 0 && wrongCa.record.afterStartup.length === 0 && wrongCa.record.passwordMessages === 0 && !leaked(wrongCa.record) && wrongCa.run.lines.length === 0);
    const wrongName = await viaFake({ tlsCert: pki.server, auth: 'trust', pins: [rootPin], host: hostedHost });
    check('hosted-looking target presenting a valid certificate for another host name: refused (ERR_TLS_CERT_ALTNAME_INVALID, db_tls_refused) before the startup message; nothing sensitive sent',
      (wrongName.run.error as { code?: string } | undefined)?.code === 'ERR_TLS_CERT_ALTNAME_INVALID' && JSON.stringify(classifyRunnerFailure(wrongName.run.error)) === JSON.stringify({ refusal: 'db_tls_refused' })
      && wrongName.record.connections === 1 && wrongName.record.plaintextStartups === 0 && wrongName.record.afterStartup.length === 0 && !leaked(wrongName.record) && wrongName.run.lines.length === 0);
    const control = await viaFake({ tlsCert: pki.server, auth: 'scram-no-final', pins: [rootPin], host: TEST_HOST });
    check('control: with the right pinned CA and host name the client completes TLS and starts SCRAM (so the refusals above are TLS, not a dead server); the unfinished SCRAM is refused, and no password, runner password or verifier byte is sent',
      control.record.tlsHandshakes === 1 && control.record.plaintextStartups === 0 && control.record.passwordMessages >= 1 && control.run.error instanceof DbTlsRefusal && control.run.error.reason === 'scram_incomplete' && !leaked(control.record));
    const plain = await viaFake({ tlsCert: null, auth: 'trust', pins: [rootPin], host: TEST_HOST });
    check('a hosted-looking server that refuses TLS gets no startup message and nothing sensitive', isDbSecurityFailure(plain.run.error) && plain.record.sslRequests === 1 && plain.record.plaintextStartups === 0 && plain.record.afterStartup.length === 0 && !leaked(plain.record));
  }
  const bad = { ...plan, role: 'postgres' };
  sent.length = 0;
  r = await captured(() => runRolePassword(fake(), bad));
  check('a tampered plan (other role, bad verifier) sends nothing', r.error instanceof RunnerRefusal && sent.length === 0
    && (await captured(() => runRolePassword(fake(), { ...plan, verifier: `${plan.verifier}'; drop role x; --` }))).error instanceof RunnerRefusal);
  sent.length = 0;
  let connected = 0;
  await captured(() => executeRolePassword(plan, () => ({ ...fake(), connect: async () => { connected += 1; } })));
  check('the executor connects once and only runs the one transaction', connected === 1 && sent.filter((s) => s === 'begin').length === 1);

  // ---- the real command line, plan-only: verifies, prints only fixed events, never connects (the URL's host is not reachable) and never prints a secret
  const cli = (env: Record<string, string>, ...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', resolve(import.meta.dirname, 'staging-sql-runner.ts'), '--project=rebuilt', ...args], { env: { PATH: process.env.PATH ?? '', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), ...env }, encoding: 'utf8', cwd: resolve(import.meta.dirname, '..'), timeout: 60_000 });
  const confirmArg = `--confirm=${APP.confirmation}`;
  const planOnly = cli({ STAGING_DB_URL: pooler(REBUILT), STAGING_APP_DB_PASSWORD: PW }, '--action=set-app-password', confirmArg);
  const planLines = planOnly.stdout.trim().split(/\r?\n/).map((l) => JSON.parse(l) as Record<string, unknown>);
  check('command line plan-only: exit 0, exactly the verified and plan_only events, nothing connected or sent', planOnly.status === 0 && planLines.length === 2 && planLines[0]!.msg === 'staging-sql.verified' && planLines[0]!.action === 'set-app-password' && planLines[1]!.msg === 'staging-sql.plan_only');
  check('command line output carries neither the password, the runner password, the host nor a verifier', !/Zx9-test|runner-pw-not-real|pooler\.supabase|SCRAM-SHA/.test(planOnly.stdout + planOnly.stderr));
  const noPw = cli({ STAGING_DB_URL: pooler(REBUILT) }, '--action=set-app-password', confirmArg);
  const wrongVar = cli({ STAGING_DB_URL: pooler(REBUILT), STAGING_MAINT_DB_PASSWORD: PW }, '--action=set-app-password', confirmArg);
  const prod = cli({ STAGING_DB_URL: pooler(RECORDED_PROJECT_REFS.production), STAGING_APP_DB_PASSWORD: PW }, '--action=set-app-password', confirmArg);
  check('command line refusals: missing password env, the other role\'s variable, and production each exit 1 with one fixed refusal', ([[noPw, 'role_password_refused'], [wrongVar, 'role_password_refused'], [prod, 'production_refused']] as const).every(([r, id]) => r.status === 1 && JSON.parse(r.stderr.trim()).refusal === id && !r.stderr.includes('Zx9-test')));

  // ---- source contract: the module reads no environment, prints no secret, builds the statement only from checked constants
  const src = readFileSync(resolve(import.meta.dirname, 'role-password.ts'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  const printed = [...code.matchAll(/resultEvent\(([^)]*)\)/g)].map((m) => m[1]);
  const eventFn = /const resultEvent = [\s\S]*?\n\};/.exec(code)?.[0] ?? '';
  check('every printed event goes through resultEvent(role, result): its arguments never mention verifier or password, console is used only inside it, and it allows only the fixed role and result lists',
    printed.length === 3 && printed.every((a) => !/verifier|password|err|message/i.test(a!)) && (code.match(/console\./g) ?? []).length === 1 && eventFn.includes('console.log(JSON.stringify({ msg:') && !/verifier|password/i.test(eventFn.replace(/ROLE_PASSWORD_[A-Z]+|role_password_(refused|result)/g, ''))
    && /ROLE_PASSWORD_ROLES\.includes\(role\)/.test(eventFn) && /ROLE_PASSWORD_RESULTS/.test(eventFn) && !/\bline\(/.test(code));
  check('module never writes to process.stdout / process.stderr directly (console is used only in resultEvent), and no raw write happened in any captured run', !/process\.(stdout|stderr)/.test(code) && rawWrites.length === 0);
  check('module does not read process.env, never logs the password/verifier, has no drop/delete/grant/revoke SQL', !/process\.env/.test(src) && !/console\.(log|error)\([^)]*(password|verifier)/i.test(code.replace(/const resultEvent = [\s\S]*?\n\};/, '')) && !/\b(drop|delete from|truncate|grant|revoke)\b/i.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')));

  check('module builds its connection only through newSecurePgClient (pg-secure.ts): no own pg client, no ssl option, no rejectUnauthorized', /newSecurePgClient\(target, rolePasswordClientOptions\(\)\)/.test(code) && !/new\s+pg\.Client|new\s+Client\s*\(|rejectUnauthorized|\bssl\s*:|from 'pg'/.test(code));

  const eventsClean = (): boolean => everyLine.length > 0 && everyLine.every((l) => {
    let o: Record<string, unknown>;
    try { o = JSON.parse(l) as Record<string, unknown>; } catch { return false; }
    return Object.keys(o).sort().join() === 'msg,result,role' && o.msg === 'staging-sql.role_password_result' && (ROLE_PASSWORD_ROLES as readonly string[]).includes(o.role as string)
      && (ROLE_PASSWORD_RESULTS as readonly string[]).includes(o.result as string) && !/SCRAM-SHA-256|[A-Za-z0-9+/_-]{32,}|\$\d+:/.test(l);
  });
  check('every event line printed by every run above (success, each refusal, rollback, unknown commit) has exactly the fields msg, role, result with fixed values and nothing verifier-shaped (SCRAM-SHA-256, long base64) or password-shaped', eventsClean());
  const cliOut = cli({ STAGING_DB_URL: pooler(REBUILT), STAGING_APP_DB_PASSWORD: PW }, '--action=set-app-password', confirmArg, '--out=x.json');
  check('command line: --out with a role-password action is refused with one fixed refusal (exit 1), not ignored', cliOut.status === 1 && JSON.parse(cliOut.stderr.trim()).refusal === 'role_password_refused' && !cliOut.stdout.includes('plan_only'));

  // ---- real PostgreSQL (throwaway loopback cluster only)
  const URL_ENV = process.env.ROLE_PASSWORD_PG_URL;
  if (!URL_ENV) {
    console.log('skip real-PostgreSQL half (set ROLE_PASSWORD_PG_URL, loopback only)');
    console.log(`role-password offline: ${n} checks passed`);
    return;
  }
  const u = new URL(URL_ENV);
  assert.ok(['127.0.0.1', 'localhost'].includes(u.hostname) && u.port !== '' && u.port !== '5432' && u.port !== '6543' && u.search === '', 'refusing: ROLE_PASSWORD_PG_URL must be a plain loopback URL on the owned cluster port');
  assert.match(decodeURIComponent(u.pathname.slice(1)), /^tr_[a-z0-9_]+$/, 'refusing: database name must start with tr_');
  const admin = new pg.Client({ connectionString: URL_ENV });
  admin.on('error', () => undefined);
  await admin.connect();
  assert.match((await admin.query("select shobj_description(oid, 'pg_database') as c from pg_database where datname = current_database()")).rows[0].c as string, /^role-password-owned:/, 'refusing: database is not task-owned');
  assert.equal((await admin.query('show password_encryption')).rows[0].password_encryption, 'scram-sha-256');
  const loginAs = async (role: string, password: string): Promise<{ ok: boolean; who?: string; code?: string }> => {
    const c = new pg.Client({ host: u.hostname, port: Number(u.port), user: role, password, database: decodeURIComponent(u.pathname.slice(1)) });
    c.on('error', () => undefined);
    try { await c.connect(); const who = (await c.query('select current_user as u')).rows[0].u as string; return { ok: true, who }; } catch (e) { return { ok: false, code: (e as { code?: string }).code }; } finally { await c.end().catch(() => undefined); }
  };
  const asClient = (): RebuiltSqlClient => admin as unknown as RebuiltSqlClient;
  const attrs = async (role: string) => JSON.stringify((await admin.query('select rolcanlogin, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls, rolconnlimit, rolvaliduntil, rolconfig from pg_roles where rolname = $1', [role])).rows[0]);
  const rolePw = async (role: string) => (await admin.query('select rolpassword as p from pg_authid where rolname = $1', [role])).rows[0].p as string | null;

  // PostgreSQL's own verifier for the same password and salt equals ours.
  await admin.query('drop role if exists tr_ref_role');
  await admin.query(`create role tr_ref_role login password '${PW}'`); // the server hashes it (scram-sha-256); the fixture value is not a secret
  const server = (await rolePw('tr_ref_role'))!;
  const [, iter, salt] = /^SCRAM-SHA-256\$(\d+):([^$]+)\$/.exec(server)!;
  check('local verifier equals the one PostgreSQL computed for the same password and salt (byte for byte)', scramSha256Verifier(PW, Buffer.from(salt!, 'base64'), Number(iter)) === server);
  await admin.query('drop role tr_ref_role');

  for (const [action, spec] of Object.entries(ROLE_PASSWORD_ACTIONS)) {
    const role = spec.role;
    await admin.query(`drop role if exists ${role}`);
    await admin.query(`create role ${role} nologin nocreatedb connection limit 7`);
    await admin.query(`comment on role ${role} is 'keep me'`);
    await admin.query(`alter role ${role} set search_path = pg_catalog`);
    const before = await attrs(role);
    check(`${role}: starts NOLOGIN and cannot log in`, !(await loginAs(role, PW)).ok);
    const p = planRolePassword({ action, dbUrl: pooler(REBUILT), confirm: spec.confirmation, password: PW });
    const run = await captured(() => executeRolePassword(p, () => ({ connect: async () => undefined, end: async () => undefined, query: (s: string, a?: unknown[]) => admin.query(s, a) })));
    check(`${role}: committed through the real executor path`, run.error === undefined && JSON.parse(run.lines[0]!).result === 'committed');
    const stored = (await rolePw(role))!;
    check(`${role}: stored password is the local SCRAM verifier, not the plain password`, stored === p.verifier && !stored.includes(PW));
    const login = await loginAs(role, PW);
    check(`${role}: a real client logs in with the original password (SCRAM) as ${role}`, login.ok && login.who === role);
    check(`${role}: wrong password and a one-character-off password are refused (28P01)`, (await loginAs(role, `${PW}x`)).code === '28P01' && (await loginAs(role, PW.slice(0, -1))).code === '28P01');
    const after = JSON.parse(await attrs(role)) as Record<string, unknown>;
    check(`${role}: only LOGIN changed; other attributes, connection limit and role settings unchanged`, JSON.stringify({ ...after, rolcanlogin: false }) === JSON.stringify({ ...JSON.parse(before), rolcanlogin: false }) && after.rolcanlogin === true && after.rolconnlimit === 7);
    check(`${role}: unrelated role comment kept`, (await admin.query("select shobj_description(oid, 'pg_authid') as c from pg_roles where rolname = $1", [role])).rows[0].c === 'keep me');
  }
  // Re-run replaces the verifier (new salt); the new password works and the old one stops.
  const NEW_PW = `${PW}-second`;
  await captured(() => runRolePassword(asClient(), planRolePassword({ ...base, password: NEW_PW })));
  check('a second run replaces the password: new works, old refused', (await loginAs('recruiter_app', NEW_PW)).ok && (await loginAs('recruiter_app', PW)).code === '28P01');
  // Failure paths on a real server.
  await admin.query('drop role if exists recruiter_app');
  const miss = await captured(() => runRolePassword(asClient(), planRolePassword(base)));
  check('role absent on the real server: refused, rolled back, no role created', miss.error instanceof RunnerRefusal && JSON.parse(miss.lines[0]!).result === 'rolled_back' && (await admin.query("select count(*)::int as c from pg_roles where rolname = 'recruiter_app'")).rows[0].c === 0);
  await admin.query("create role recruiter_app nologin superuser");
  const sup = await captured(() => runRolePassword(asClient(), planRolePassword(base)));
  check('a superuser role named recruiter_app is refused and stays NOLOGIN with no password', sup.error instanceof RunnerRefusal && (await rolePw('recruiter_app')) === null && !(await loginAs('recruiter_app', PW)).ok);
  await admin.query('drop role recruiter_app');
  // statement_timeout is applied inside the transaction only.
  await admin.query('create role recruiter_app nologin');
  const seen: string[] = [];
  await captured(() => runRolePassword({ connect: async () => undefined, end: async () => undefined, query: async (s: string, a?: unknown[]) => { const res = await admin.query(s, a); if (/^do \$\$/.test(s)) seen.push(String((await admin.query("select current_setting('statement_timeout') as t, current_setting('lock_timeout') as l")).rows[0].t)); return res; } }, planRolePassword(base)));
  check('statement timeout 30s is in force while the ALTER runs and is gone after commit', seen[0] === '30s' && (await admin.query("select current_setting('statement_timeout') as t")).rows[0].t === '0');
  await admin.query('drop role recruiter_app');

  // Stricter timeout already in force is kept (real server): a 5s session statement_timeout stays 5s during the DO block.
  await admin.query('create role recruiter_app nologin');
  const seenStrict: string[] = [];
  await admin.query("set statement_timeout = '5s'");
  const strict = await captured(() => runRolePassword({ connect: async () => undefined, end: async () => undefined, query: async (q: string, a?: unknown[]) => { const res = await admin.query(q, a); if (/^do \$\$/.test(q)) seenStrict.push(String((await admin.query("select current_setting('statement_timeout') as t")).rows[0].t)); return res; } }, planRolePassword(base)));
  await admin.query('reset statement_timeout');
  check('a stricter session statement_timeout (5s) is kept during the ALTER; a looser one is not what stays', strict.error === undefined && seenStrict[0] === '5s' && (await admin.query("select current_setting('statement_timeout') as t")).rows[0].t === '0');
  await admin.query('drop role recruiter_app');

  // Expired VALID UNTIL is refused (it would be "committed" but unusable).
  await admin.query("create role recruiter_app nologin valid until '2000-01-01'");
  const expired = await captured(() => runRolePassword(asClient(), planRolePassword(base)));
  check('a role with an expired VALID UNTIL is refused on the real server: rolled back, no password stored, still cannot log in', expired.error instanceof RunnerRefusal && JSON.parse(expired.lines[0]!).result === 'rolled_back' && (await rolePw('recruiter_app')) === null && !(await loginAs('recruiter_app', PW)).ok);
  await admin.query("alter role recruiter_app valid until 'infinity'");
  const futureOk = await captured(() => runRolePassword(asClient(), planRolePassword(base)));
  check('the same role with a future / infinite VALID UNTIL is accepted and logs in', futureOk.error === undefined && (await loginAs('recruiter_app', PW)).ok);
  await admin.query('drop role recruiter_app');

  // pg_stat_statements.track = all would record the nested ALTER ROLE: refused.
  const hasPss = (await admin.query("select count(*)::int as c from pg_extension where extname = 'pg_stat_statements'")).rows[0].c === 1;
  if (hasPss) {
    await admin.query('create role recruiter_app nologin');
    await admin.query("set pg_stat_statements.track = 'all'");
    const trackAll = await captured(() => runRolePassword(asClient(), planRolePassword(base)));
    await admin.query('reset pg_stat_statements.track');
    check('pg_stat_statements.track=all (real server): refused before the verifier is bound; rolled back; no password stored', trackAll.error instanceof RunnerRefusal && JSON.parse(trackAll.lines[0]!).result === 'rolled_back' && (await rolePw('recruiter_app')) === null);
    await admin.query('drop role recruiter_app');
  }

  // ---- the verifier must not reach pg_stat_statements or the server error log: after success AND after forced failures.
  // ROLE_PASSWORD_PG_LOG = the server log file of the owned cluster (started with pg_ctl -l; log_min_error_statement=error, pg_stat_statements preloaded).
  const LOG = process.env.ROLE_PASSWORD_PG_LOG;
  if (LOG) assert.ok(hasPss && existsSync(LOG), 'ROLE_PASSWORD_PG_LOG needs pg_stat_statements created in the test database and an existing log file');
  if (hasPss) {
    const LEAK_PW = randomBytes(36).toString('base64url');
    const leakPlan = planRolePassword({ ...base, password: LEAK_PW });
    const vm = /^SCRAM-SHA-256\$4096:([^$]+)\$([^:]+):(.+)$/.exec(leakPlan.verifier)!;
    const parts = [leakPlan.verifier, vm[1]!, vm[2]!, vm[3]!, LEAK_PW];
    assert.ok(parts.every((x) => x.length >= 20), 'test setup: verifier parts');
    await admin.query('create role recruiter_app nologin');
    await admin.query('select pg_stat_statements_reset()');
    const logBefore = LOG ? readFileSync(LOG, 'utf8').length : 0;
    const via = (replace: Record<string, string>): RebuiltSqlClient => ({ connect: async () => undefined, end: async () => undefined, query: (q: string, a?: unknown[]) => admin.query(replace[q] ?? q, a) });
    const ok1 = await captured(() => runRolePassword(asClient(), leakPlan));
    check('leak test, success: committed and the role logs in with the random password', ok1.error === undefined && JSON.parse(ok1.lines[0]!).result === 'committed' && (await loginAs('recruiter_app', LEAK_PW)).ok);
    const holder = new pg.Client({ connectionString: URL_ENV });
    holder.on('error', () => undefined);
    await holder.connect();
    await holder.query('begin');
    await holder.query('alter role recruiter_app connection limit 3'); // row lock on the role: the next ALTER waits
    const lockFail = await captured(() => runRolePassword(via({ [LOCK_TIMEOUT_SQL]: "set local lock_timeout = '1s'" }), leakPlan));
    const stmtFail = await captured(() => runRolePassword(via({ [STATEMENT_TIMEOUT_SQL]: "set local statement_timeout = '1s'" }), leakPlan));
    await holder.query('rollback');
    await holder.end();
    check('leak test, forced failures: lock timeout gives SQLSTATE 55P03 and statement timeout gives 57014 (query_canceled, the path "when others" misses); both rolled back with a fixed message',
      JSON.stringify(classifyRunnerFailure(lockFail.error)) === JSON.stringify({ refusal: 'server_or_driver_error', err_code: '55P03' })
      && JSON.stringify(classifyRunnerFailure(stmtFail.error)) === JSON.stringify({ refusal: 'server_or_driver_error', err_code: '57014' })
      && [lockFail, stmtFail].every((f) => JSON.parse(f.lines[0]!).result === 'rolled_back' && (f.error as Error).message === 'role password statement failed'));
    const stats = (await admin.query('select query from pg_stat_statements')).rows.map((x: { query: string }) => x.query);
    check('pg_stat_statements holds no part of the verifier (whole, salt, StoredKey, ServerKey) or the password after success and failures', stats.length > 0 && stats.every((q) => parts.every((x) => !q.includes(x))));
    check('pg_stat_statements control: it did record the constant DO text and the normalised set_config text (the check can see statements)', stats.some((q) => q.startsWith('do $$')) && stats.some((q) => /set_config\(.*\$1.*\)/.test(q)));
    if (LOG) {
      await new Promise((r2) => setTimeout(r2, 1500));
      const log = readFileSync(LOG, 'utf8').slice(logBefore);
      check('server error log holds no part of the verifier or the password after success and both forced failures', parts.every((x) => !log.includes(x)));
      check('server error log control: the failures were logged (fixed message and the constant DO statement), so the log was being written', (log.match(/role password statement failed/g) ?? []).length >= 2 && /STATEMENT:\s+do \$\$/.test(log) && !/CONTEXT:\s+SQL statement/.test(log));
      // Negative control: the OLD form (verifier as a literal in a top-level ALTER) is caught by exactly these checks.
      const oldV = scramSha256Verifier(randomBytes(36).toString('base64url'));
      const oldSalt = /\$([^$]+)\$/.exec(oldV)![1]!.split(':')[1]!;
      await admin.query('select pg_stat_statements_reset()');
      const mark = readFileSync(LOG, 'utf8').length;
      await admin.query(`alter role recruiter_app login password '${oldV}'`);
      const holder2 = new pg.Client({ connectionString: URL_ENV });
      holder2.on('error', () => undefined);
      await holder2.connect();
      await holder2.query('begin');
      await holder2.query('alter role recruiter_app connection limit 3');
      await admin.query("set lock_timeout = '1s'");
      await admin.query(`alter role recruiter_app login password '${oldV}'`).catch(() => undefined);
      await admin.query('reset lock_timeout');
      await holder2.query('rollback');
      await holder2.end();
      await new Promise((r2) => setTimeout(r2, 1500));
      const oldStats = (await admin.query('select query from pg_stat_statements')).rows.map((x: { query: string }) => x.query);
      check('negative control: the old literal-in-ALTER form IS visible in pg_stat_statements and in the error log (so the clean results above are meaningful)', oldStats.some((q) => q.includes(oldSalt)) && readFileSync(LOG, 'utf8').slice(mark).includes(oldSalt));
    }
    await admin.query('drop role recruiter_app');
  }
  // ---- logging settings seen by a NON-superuser runner session (set per role by the superuser, as a hosted provider or admin could): refused or harmless, and never in the log.
  {
    const RUNNER_PW = randomBytes(18).toString('hex');
    const dbName = decodeURIComponent(u.pathname.slice(1));
    await admin.query('drop role if exists recruiter_app');
    await admin.query('drop role if exists tr_runner');
    await admin.query(`create role tr_runner login createrole password '${RUNNER_PW}'`);
    await admin.query('create role recruiter_app nologin');
    await admin.query('grant recruiter_app to tr_runner with admin option');
    const sleep = (ms: number) => new Promise((r2) => setTimeout(r2, ms));
    const LPW = randomBytes(36).toString('base64url');
    const lplan = planRolePassword({ ...base, password: LPW });
    const lm = /^SCRAM-SHA-256\$4096:([^$]+)\$([^:]+):(.+)$/.exec(lplan.verifier)!;
    const lparts = [lplan.verifier, lm[1]!, lm[2]!, lm[3]!, LPW];
    const runAsRunner = async (settings: string[], plan = lplan, direct = false, options?: string, during?: () => Promise<void>) => {
      for (const st of settings) await admin.query(`alter role tr_runner set ${st}`);
      const c = new pg.Client({ host: u.hostname, port: Number(u.port), user: 'tr_runner', password: RUNNER_PW, database: dbName, ...(options ? { options } : {}) });
      c.on('error', () => undefined);
      await c.connect();
      try {
        // direct = negative control: the old shape (bind parameter to set_config) with no refusal, to prove the log setting WOULD write it.
        if (direct) { await c.query('begin'); await c.query(SET_VERIFIER_SQL, [plan.verifier]); await c.query('rollback'); return undefined; }
        const run = captured(() => runRolePassword(c as unknown as RebuiltSqlClient, plan));
        if (during) await during();
        return await run;
      } finally {
        await c.end().catch(() => undefined);
        for (const st of settings) await admin.query(`alter role tr_runner reset ${st.split(/\s*=\s*/)[0]}`);
      }
    };
    const logSince = async (mark: number): Promise<string> => { await sleep(1500); return readFileSync(LOG!, 'utf8').slice(mark); };
    const visible = async () => { const c = new pg.Client({ host: u.hostname, port: Number(u.port), user: 'tr_runner', password: RUNNER_PW, database: dbName }); c.on('error', () => undefined); await c.connect(); try { return (await c.query(SETTINGS_SQL)).rows as { name: string; setting: string }[]; } finally { await c.end(); } };
    const seenRows = await visible();
    // jit is on by default outside the module's transaction (the module switches it off before it reads).
    check('a non-superuser runner can read every setting checked by name (pg_stat_statements rows when present), and every setting it sees in the logging, statistics, developer and error-handling groups is classified', CHECKED_SETTINGS.filter((s) => hasPss || !s.startsWith('pg_stat_statements.')).every((s) => seenRows.some((x) => x.name === s))
      && loggingProblem(new Map([...seenRows.map((x) => [x.name, x.setting] as [string, string]), ['jit', 'off']])) === null);
    // r5 review B1: the unknown-setting refusal must not depend on lc_messages (pg_settings.category is translated). A mutant copy of the module with
    // log_min_messages taken off the classified lists stands in for a newer server's unclassified setting; it must refuse under a German lc_messages too.
    {
      const modPath = resolve(REPOSITORY_ROOT, 'pipeline/src/role-password.ts');
      const mutPath = resolve(REPOSITORY_ROOT, 'pipeline/src/role-password-mutant.tmp.ts');
      const src = readFileSync(modPath, 'utf8');
      const mutSrc = src.replace("'log_min_messages', ", '');
      check('the mutant module differs from the real one only by one classified name', mutSrc !== src && src.length - mutSrc.length === "'log_min_messages', ".length);
      writeFileSync(mutPath, mutSrc);
      try {
        const mut = await import(pathToFileURL(mutPath).href) as { runRolePassword: typeof runRolePassword };
        const deOk = await admin.query("alter role tr_runner set lc_messages = 'de'").then(() => true, () => false);
        await admin.query('alter role tr_runner reset lc_messages');
        const caseRun = async (label: string, lc: string | null, which: { runRolePassword: typeof runRolePassword }, expectRefusal: boolean) => {
          if (lc) await admin.query(`alter role tr_runner set lc_messages = '${lc}'`);
          const c = new pg.Client({ host: u.hostname, port: Number(u.port), user: 'tr_runner', password: RUNNER_PW, database: dbName });
          c.on('error', () => undefined);
          await c.connect();
          const rows = lc ? (await c.query("select count(*)::int as n from pg_catalog.pg_settings where category ~ '^(Reporting and Logging|Statistics|Developer Options|Error Handling)'")).rows[0].n as number : -1;
          const res = await captured(() => which.runRolePassword(c as unknown as RebuiltSqlClient, lplan));
          await c.end().catch(() => undefined);
          if (lc) await admin.query('alter role tr_runner reset lc_messages');
          const refused = res.error instanceof RunnerRefusal && res.error.id === 'role_password_logging_refused' && JSON.parse(res.lines[0]!).result === 'rolled_back';
          check(`real server, ${label}${lc ? ` (the English group-name pattern matches ${rows} rows)` : ''}: ${expectRefusal ? 'refused (role_password_logging_refused), rolled back' : 'commits'}`, expectRefusal ? refused : (res.error === undefined && JSON.parse(res.lines[0]!).result === 'committed'));
        };
        await caseRun('mutant (unclassified log_min_messages), default lc_messages', null, mut, true);
        if (deOk) {
          await caseRun('mutant (unclassified log_min_messages), per-role lc_messages = de', 'de', mut, true);
          await caseRun('real module, per-role lc_messages = de', 'de', { runRolePassword }, false);
        } else console.log('SKIP lc_messages = de cases: this server has no German messages (not counted as passed)');
      } finally { unlinkSync(mutPath); await admin.query('alter role recruiter_app password null'); }
    }
    const refusedCases: [string, string[]][] = [
      ['log_statement = all', ["log_statement = 'all'"]], ['log_min_duration_statement = 0', ['log_min_duration_statement = 0']], ['log_transaction_sample_rate = 1', ['log_transaction_sample_rate = 1']],
      ['log_min_duration_sample = 0 with log_statement_sample_rate = 1', ['log_min_duration_sample = 0', 'log_statement_sample_rate = 1']],
      ['log_parameter_max_length_on_error = -1', ['log_parameter_max_length_on_error = -1']], ["pgaudit.log = 'all'", ["pgaudit.log = 'all'"]], ["pgaudit.log = 'role'", ["pgaudit.log = 'role'"]], ['auto_explain.log_min_duration = 0', ['auto_explain.log_min_duration = 0']],
    ];
    for (const [label, settings] of refusedCases) {
      const mark = LOG ? readFileSync(LOG, 'utf8').length : 0;
      const res = await runAsRunner(settings);
      check(`real server, runner session with ${label}: refused with role_password_logging_refused, rolled back, no password stored${LOG ? ', and no part of the verifier in the server log' : ''}`,
        res!.error instanceof RunnerRefusal && res!.error.id === 'role_password_logging_refused' && JSON.parse(res!.lines[0]!).result === 'rolled_back' && (await rolePw('recruiter_app')) === null
        && (!LOG || lparts.every((x) => !readFileSync(LOG, 'utf8').slice(mark).includes(x))));
    }
    // B1 (r3 review): settings that logged the verifier on a normal run before the fix.
    const logMark = (): number => (LOG ? readFileSync(LOG, 'utf8').length : 0);
    const logClean = async (mark: number): Promise<boolean> => !LOG || (await logSince(mark), lparts.every((x) => !readFileSync(LOG, 'utf8').slice(mark).includes(x)));
    const holdRole = async (): Promise<pg.Client> => { const h = new pg.Client({ connectionString: URL_ENV }); h.on('error', () => undefined); await h.connect(); await h.query('begin'); await h.query('alter role recruiter_app connection limit 3'); return h; };
    for (const [label, settings, options] of [['debug_print_parse = on (per role)', ['debug_print_parse = on'], undefined], ['debug_print_rewritten = on (per role)', ['debug_print_rewritten = on'], undefined], ['debug_print_plan = on (per role)', ['debug_print_plan = on'], undefined],
      ['debug_print_parse = on as a client startup option', [], '-c debug_print_parse=on'], ['debug_print_parse and debug_print_rewritten on, with log_min_messages = debug1', ['debug_print_parse = on', 'debug_print_rewritten = on', 'log_min_messages = debug1'], undefined]] as [string, string[], string | undefined][]) {
      const mark = logMark();
      const res = await runAsRunner(settings, lplan, false, options);
      check(`real server, runner session with ${label}: the module switches them off for its transaction, commits, and the log holds no part of the verifier${LOG ? '' : ' (log not checked: ROLE_PASSWORD_PG_LOG unset)'}`, res!.error === undefined && JSON.parse(res!.lines[0]!).result === 'committed' && (await logClean(mark)));
    }
    {
      const mark = logMark();
      const held = await holdRole();
      const res = await runAsRunner(['log_lock_waits = on'], lplan, false, undefined, async () => { await sleep(3000); await held.query('rollback'); });
      await held.end();
      const lg = LOG ? await logSince(mark) : '';
      check(`real server, log_lock_waits = on and the role row locked for 3 s: the lock wait is cut at 900 ms (55P03, below deadlock_timeout), rolled back, and the log has no "still waiting" line and no part of the verifier${LOG ? '' : ' (log not checked)'}`,
        res!.error !== undefined && JSON.stringify(classifyRunnerFailure(res!.error)) === JSON.stringify({ refusal: 'server_or_driver_error', err_code: '55P03' }) && JSON.parse(res!.lines[0]!).result === 'rolled_back' && !/still waiting/.test(lg) && lparts.every((x) => !lg.includes(x)));
      const mark2 = logMark();
      const held2 = await holdRole();
      const quick = await runAsRunner(['log_lock_waits = on'], lplan, false, undefined, async () => { await sleep(300); await held2.query('rollback'); });
      await held2.end();
      check('real server, log_lock_waits = on and a lock released within 300 ms: the run waits, commits, and the log holds no part of the verifier', quick!.error === undefined && JSON.parse(quick!.lines[0]!).result === 'committed' && (await logClean(mark2)));
    }
    {
      const res = await runAsRunner(['log_lock_waits = on'], lplan);
      check('control: with log_lock_waits = on and no lock held the run commits', res!.error === undefined);
    }
    // B1 (r4 review): exit_on_error turned an error inside the ALTER into a FATAL whose CONTEXT quoted the statement; log_parser_stats logged it on every run.
    for (const [label, settings, options] of [['exit_on_error = on and default_transaction_read_only = on (per role)', ['exit_on_error = on', 'default_transaction_read_only = on'], undefined],
      ['exit_on_error = on and default_transaction_read_only = on as a client startup option', [], '-c exit_on_error=on -c default_transaction_read_only=on']] as [string, string[], string | undefined][]) {
      const mark = logMark();
      await admin.query('alter role recruiter_app nologin password null'); const res = await runAsRunner(settings, lplan, false, options);
      check(`real server, runner session with ${label}: the module switches exit_on_error off, so the read-only error (25006) is caught and re-raised with the fixed message; rolled back (not a FATAL), no password stored, and the log holds no part of the verifier${LOG ? '' : ' (log not checked)'}`,
        JSON.stringify(classifyRunnerFailure(res!.error)) === JSON.stringify({ refusal: 'server_or_driver_error', err_code: '25006' }) && (res!.error as Error).message === 'role password statement failed' && JSON.parse(res!.lines[0]!).result === 'rolled_back'
        && (await rolePw('recruiter_app')) === null && (await logClean(mark)));
    }
    {
      const mark = logMark();
      await admin.query('alter role recruiter_app nologin password null'); const held = await holdRole();
      const res = await runAsRunner(['exit_on_error = on', 'log_lock_waits = on'], lplan, false, undefined, async () => { await sleep(3000); await held.query('rollback'); });
      await held.end();
      check(`real server, exit_on_error = on with log_lock_waits = on and the role row locked for 3 s: the module's own 900 ms lock timeout (55P03) is caught, rolled back (not a FATAL), and the log holds no part of the verifier${LOG ? '' : ' (log not checked)'}`,
        JSON.stringify(classifyRunnerFailure(res!.error)) === JSON.stringify({ refusal: 'server_or_driver_error', err_code: '55P03' }) && JSON.parse(res!.lines[0]!).result === 'rolled_back' && (await rolePw('recruiter_app')) === null && (await logClean(mark)));
    }
    for (const st of ['log_parser_stats', 'log_planner_stats', 'log_executor_stats', 'log_statement_stats']) {
      const mark = logMark();
      await admin.query('alter role recruiter_app nologin password null'); const res = await runAsRunner([`${st} = on`]);
      check(`real server, runner session with ${st} = on (superuser-only, cannot be switched off here): refused with role_password_logging_refused before the verifier is bound, no password stored, and the log holds no part of the verifier${LOG ? '' : ' (log not checked)'}`,
        res!.error instanceof RunnerRefusal && res!.error.id === 'role_password_logging_refused' && JSON.parse(res!.lines[0]!).result === 'rolled_back' && (await rolePw('recruiter_app')) === null && (await logClean(mark)));
    }
    {
      // Settings classified harmless, at their loudest, all at once (plus exit_on_error and debug_print_*, which the module switches off).
      const loud = ['log_min_messages = debug5', 'log_error_verbosity = verbose', 'log_min_error_statement = debug5', "backtrace_functions = 'AlterRole,PreventCommandIfReadOnly'", "track_functions = 'all'", 'client_min_messages = debug5',
        'debug_parallel_query = on', 'trace_sort = on', 'jit_above_cost = 0', 'log_duration = on', 'log_temp_files = 0', "log_statement = 'mod'", 'exit_on_error = on', 'debug_print_parse = on', 'debug_print_plan = on'];
      const mark = logMark();
      const ok = await runAsRunner(loud);
      check(`real server, the harmless settings at their loudest all at once: committed, the role logs in, and the log holds no part of the verifier${LOG ? '' : ' (log not checked)'}`, ok!.error === undefined && JSON.parse(ok!.lines[0]!).result === 'committed' && (await loginAs('recruiter_app', LPW)).ok && (await logClean(mark)));
      await admin.query('alter role recruiter_app nologin password null');
      const mark2 = logMark();
      const ro = await runAsRunner([...loud, 'default_transaction_read_only = on']);
      check(`real server, the same loud settings with a read-only error inside the ALTER: rolled back with the fixed message, and the log holds no part of the verifier${LOG ? '' : ' (log not checked)'}`, JSON.parse(ro!.lines[0]!).result === 'rolled_back' && (ro!.error as Error).message === 'role password statement failed' && (await logClean(mark2)));
    }
    // B2 (r3 review): look-alike objects earlier on the runner's search_path.
    {
      const lookalike = ['create schema if not exists shadow authorization tr_runner',
        "create or replace view shadow.pg_settings as select name, case name when 'log_statement' then 'none' else setting end as setting from pg_catalog.pg_settings",
        "create or replace function shadow.set_config(text, text, boolean) returns text language plpgsql as $f$ begin raise exception 'shadow set_config called'; end $f$",
        "create or replace function shadow.current_setting(text) returns text language plpgsql as $f$ begin raise exception 'shadow current_setting called'; end $f$",
        'grant usage on schema shadow to tr_runner', 'grant select on shadow.pg_settings to tr_runner'];
      for (const q of lookalike) await admin.query(q);
      const mark = logMark();
      const hidden = await runAsRunner(['search_path = shadow, pg_catalog', "log_statement = 'all'"]);
      check(`real server, a look-alike shadow.pg_settings that hides log_statement = all (search_path = shadow, pg_catalog): still refused (role_password_logging_refused), rolled back, and the log holds no part of the verifier${LOG ? '' : ' (log not checked)'}`,
        hidden!.error instanceof RunnerRefusal && hidden!.error.id === 'role_password_logging_refused' && JSON.parse(hidden!.lines[0]!).result === 'rolled_back' && (await logClean(mark)));
      const mark2 = logMark();
      const fns = await runAsRunner(['search_path = shadow, pg_catalog'], lplan);
      check('real server, look-alike shadow.set_config and shadow.current_setting earlier on the search_path are never called: the run commits and the new password works', fns!.error === undefined && JSON.parse(fns!.lines[0]!).result === 'committed' && (await loginAs('recruiter_app', LPW)).ok && (await logClean(mark2)));
      await admin.query('drop schema shadow cascade');
    }
    {
      const pss = (await admin.query('select query from pg_stat_statements')).rows.map((x: { query: string }) => x.query);
      check('pg_stat_statements holds no part of any runner-session verifier or password from the runs above', pss.length > 0 && pss.every((q) => lparts.every((x) => !q.includes(x))));
    }
    if (LOG) {
      const mark = readFileSync(LOG, 'utf8').length;
      await runAsRunner(["log_statement = 'all'"], lplan, true);
      const lg = await logSince(mark);
      check('negative control: with log_statement = all a plain bound set_config of the verifier IS written to the server log (so the refusals above protect something real)', lg.includes(lm[2]!));
      const mark2 = readFileSync(LOG, 'utf8').length;
      const safe = await runAsRunner(["log_statement = 'all'", 'log_parameter_max_length = 0']);
      const lg2 = await logSince(mark2);
      check('log_statement = all with log_parameter_max_length = 0 is harmless: committed, the role logs in, and the log holds no part of the verifier', safe!.error === undefined && JSON.parse(safe!.lines[0]!).result === 'committed' && (await loginAs('recruiter_app', LPW)).ok && lparts.every((x) => !lg2.includes(x)));
      const mark3 = readFileSync(LOG, 'utf8').length;
      const dflt = await runAsRunner([], planRolePassword({ ...base, password: `${LPW}b` }));
      check('with default logging settings a second run commits and the log holds no part of either verifier', dflt!.error === undefined && JSON.parse(dflt!.lines[0]!).result === 'committed' && lparts.every((x) => !readFileSync(LOG, 'utf8').slice(mark3).includes(x)));
    } else {
      const safe = await runAsRunner(["log_statement = 'all'", 'log_parameter_max_length = 0']);
      check('log_statement = all with log_parameter_max_length = 0 is harmless: committed and the role logs in', safe!.error === undefined && (await loginAs('recruiter_app', LPW)).ok);
    }
    // VALID UNTIL within 24 hours is refused; further out is accepted.
    await admin.query(`alter role recruiter_app valid until '${new Date(Date.now() + 2 * 3600_000).toISOString()}'`);
    const soon = await runAsRunner([], planRolePassword({ ...base, password: `${LPW}c` }));
    check('real server: a VALID UNTIL two hours away is refused (role_password_expiry_refused), rolled back, and the earlier password still works', soon!.error instanceof RunnerRefusal && soon!.error.id === 'role_password_expiry_refused' && JSON.parse(soon!.lines[0]!).result === 'rolled_back');
    await admin.query(`alter role recruiter_app valid until '${new Date(Date.now() + 3 * 86400_000).toISOString()}'`);
    const later = await runAsRunner([], planRolePassword({ ...base, password: `${LPW}d` }));
    check('real server: a VALID UNTIL three days away is accepted', later!.error === undefined && (await loginAs('recruiter_app', `${LPW}d`)).ok);
    {
      // The executor's own client (no factory passed: newSecurePgClient via pg-secure.ts) reaches the loopback test database through the loopback exemption (no TLS, SCRAM-only).
      const secPlan = planRolePassword({ ...base, password: `${LPW}e` });
      const sec = await captured(() => executeRolePassword({ ...secPlan, target: { ...secPlan.target, host: u.hostname, port: Number(u.port), user: 'tr_runner', password: RUNNER_PW, database: dbName } }));
      check('real server, the executor\'s default TLS-hardened client (loopback exemption) as the runner login: committed, the new password works and the previous one is refused',
        sec.error === undefined && JSON.parse(sec.lines[0]!).result === 'committed' && (await loginAs('recruiter_app', `${LPW}e`)).ok && (await loginAs('recruiter_app', `${LPW}d`)).code === '28P01');
    }
    await admin.query('drop role recruiter_app');
    await admin.query('drop role tr_runner');
  }
  check('every event line printed during the real-PostgreSQL runs too is a fixed, verifier-free and password-free event', eventsClean());
  await admin.query('drop role if exists recruiter_maintenance');
  await admin.end();
  console.log(`role-password: ${n} checks passed (offline and real PostgreSQL)`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
