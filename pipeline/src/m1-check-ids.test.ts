// TRUCKRECRU-127: a P0001 failure whose message is exactly one of M1's own check texts is reported with a fixed `m1_check` id;
// nothing else changes and no output ever carries the message. The contract half reads the pinned M1 file and fails if M1
// gains, loses or changes a raise text without refusals.ts M1_CHECKS (or the list of app-runtime texts below) being updated.
// Pure: no database, nothing is dialled.
// Run: tsx src/m1-check-ids.test.ts

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { M1_CHECKS, RunnerRefusal, classifyRunnerFailure, m1CheckId } from './refusals.js';

const M1_FILE = new URL('../../supabase/pending/M1_same_origin_signin.sql', import.meta.url);

/** M1's raise texts that belong to app functions/triggers it creates (run time, not apply time): deliberately not mapped. */
const M1_RUNTIME_RAISES = [
  'signin_links.send_status cannot leave definite_failure', 'signin_links.send_status cannot leave accepted except to definite_failure',
  'signin_links.send_status cannot return from unknown to pending', 'lock sequence already taken with a different lock set', 'not permitted', 'no session',
  'profile not found', 'session expired while waiting', 'email changes are paused', 'batches.created_by/created_at cannot be changed', 'batch name is required',
  'batch % not found', 'carrier % not found', 'invalid export kind: % (expected call_sheet or csv)', 'contact log must be recorded as yourself',
  'carrier % is on the global do-not-contact list; contact cannot be logged', 'unknown bucket kind', 'not eligible', 'invalid send status', 'invalid evidence status',
  'invalid role', 'you cannot change your own role or email', 'the last active manager cannot be demoted', 'invalid email', 'email already used by an active person',
  'you cannot change your own status', 'choose a role before activating this person', 'the last active manager cannot be deactivated', 'recovery codes are disabled',
  'sign in again by email link to create recovery codes', 'exactly 10 codes are required', 'carrier is do-not-contact',
];

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

const pgError = (message: string, code = 'P0001') => Object.assign(new Error(message), { code, severity: 'ERROR' });
/** What the runner prints for a failure (staging-sql-runner.ts / prod-sql-runner.ts shape). */
const printed = (err: unknown) => JSON.stringify({ msg: 'staging-sql.refused', ...classifyRunnerFailure(err) });
const fill = (raise: string, value: string) => raise.replace('%', value);

// ---- contract: the table equals M1's raise texts -------------------------------------------------------------------------
const sql = readFileSync(M1_FILE, 'utf8');
const literals = [...sql.matchAll(/raise\s+exception\s+'((?:[^']|'')*)'/gi)].map((m) => m[1]!.replace(/''/g, "'"));

check('every "raise exception" in M1 uses a plain quoted text (none built another way, so none escapes this contract)', () => {
  assert.equal((sql.match(/\braise\s+exception\b/gi) ?? []).length, literals.length);
});
check('M1\'s raise texts are exactly the M1_CHECKS texts (with inner texts) plus the listed app-runtime texts', () => {
  const tableTexts = M1_CHECKS.flatMap((c) => [c.raise, ...(typeof c.arg === 'object' ? [c.arg.inner] : [])]);
  assert.deepEqual([...new Set(literals)].sort(), [...new Set([...tableTexts, ...M1_RUNTIME_RAISES])].sort());
});
check('each "M1:" text and each inner text is raised exactly once in M1, and every "M1:" text is in the table', () => {
  for (const t of literals.filter((l) => l.startsWith('M1:'))) assert.ok(M1_CHECKS.some((c) => c.raise === t), t);
  for (const c of M1_CHECKS) {
    assert.equal(literals.filter((l) => l === c.raise).length, 1, c.raise);
    if (typeof c.arg === 'object') assert.equal(literals.filter((l) => l === (c.arg as { inner: string }).inner).length, 1, c.arg.inner);
  }
});
check('a text has one % exactly when the table gives an argument kind; ids are unique and fixed-shape', () => {
  for (const c of M1_CHECKS) assert.equal(c.raise.split('%').length - 1, c.arg === undefined ? 0 : 1, c.id);
  assert.equal(new Set(M1_CHECKS.map((c) => c.id)).size, M1_CHECKS.length);
  for (const c of M1_CHECKS) assert.match(c.id, /^m1_[a-z0-9_]{1,60}$/);
});
check('the wrapper allow-list copy (scripts/run-with-secrets.mjs M1_CHECK_IDS) equals the table ids', () => {
  const src = readFileSync(new URL('../../scripts/run-with-secrets.mjs', import.meta.url), 'utf8');
  const block = /export const M1_CHECK_IDS = \[([^\]]*)\];/.exec(src)?.[1];
  assert.ok(block !== undefined);
  assert.deepEqual([...block.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]).sort(), M1_CHECKS.map((c) => c.id).sort());
});

// ---- each text maps to its id ---------------------------------------------------------------------------------------------
const MATCHING: Array<[string, string]> = [
  ['M1: the runner has database-wide default privileges for anon/authenticated/PUBLIC on tables or sequences; refusing', 'm1_runner_global_default_privileges'],
  ['M1: expected exactly one extension (PostGIS) owning st_x', 'm1_postgis_extension_not_unique'],
  ['M1: PostGIS schema extensions is writable by an app role; refusing to trust it', 'm1_postgis_schema_writable'],
  ['M1: the runner cannot pass on USAGE on PostGIS schema extensions to recruiter_api (it needs USAGE WITH GRANT OPTION on that schema)', 'm1_postgis_schema_usage_no_grant_option'],
  ['M1: the runner cannot pass on USAGE on PostGIS schema my_gis2 to recruiter_api (it needs USAGE WITH GRANT OPTION on that schema)', 'm1_postgis_schema_usage_no_grant_option'],
  ['M1: the runner cannot pass on EXECUTE on PostGIS routine(s) st_x to recruiter_api (it needs EXECUTE WITH GRANT OPTION, or PUBLIC must keep EXECUTE)', 'm1_postgis_execute_no_grant_option'],
  ['M1: the runner cannot pass on EXECUTE on PostGIS routine(s) st_distance, st_dwithin, st_makeline, st_makepoint, st_setsrid, st_x, st_y to recruiter_api (it needs EXECUTE WITH GRANT OPTION, or PUBLIC must keep EXECUTE)', 'm1_postgis_execute_no_grant_option'],
  ['M1: recruiter_api cannot run the PostGIS functions the app uses', 'm1_postgis_not_callable'],
  ['M1: PostGIS self-check: no extension owns st_x', 'm1_postgis_self_check_no_extension'],
  ['M1: PostGIS self-check as recruiter_api failed: the runner still holds the recruiter_api SET option the self-check granted itself', 'm1_postgis_self_check_set_option_kept'],
  ['M1: PostGIS self-check as recruiter_api failed: the runner still holds the recruiter_api membership the self-check granted itself', 'm1_postgis_self_check_membership_kept'],
];
check('every table entry has a matching example here', () => {
  assert.deepEqual([...new Set(MATCHING.map(([, id]) => id))].sort(), M1_CHECKS.map((c) => c.id).sort());
});
check('each M1 check text (P0001) is printed as server_or_driver_error + P0001 + its id, and never with the message', () => {
  for (const [message, id] of MATCHING) {
    assert.deepEqual(classifyRunnerFailure(pgError(message)), { refusal: 'server_or_driver_error', err_code: 'P0001', m1_check: id }, message);
    const line = printed(pgError(message));
    assert.equal(line, `{"msg":"staging-sql.refused","refusal":"server_or_driver_error","err_code":"P0001","m1_check":"${id}"}`);
    assert.ok(!line.includes('M1:') && !line.includes('recruiter_api') && !line.includes('extensions') && !line.includes('st_'), line);
  }
});

// ---- no id, no text -------------------------------------------------------------------------------------------------------
const P0001_ONLY = '{"msg":"staging-sql.refused","refusal":"server_or_driver_error","err_code":"P0001"}';
const NO_ID: Array<[string, string]> = [
  ['unmatched P0001', 'something else went wrong secret-Zq9981'],
  ['app-runtime M1 text', 'not permitted'],
  ['inner text alone (not wrapped)', 'the runner still holds the recruiter_api SET option the self-check granted itself'],
  ['self-check wrapper with any other inner text', 'M1: PostGIS self-check as recruiter_api failed: permission denied to set role "recruiter_api"'],
  ['self-check wrapper with an empty inner text', 'M1: PostGIS self-check as recruiter_api failed: '],
  ['extra text after', 'M1: recruiter_api cannot run the PostGIS functions the app uses secret-Zq9981'],
  ['extra text before', 'x M1: recruiter_api cannot run the PostGIS functions the app uses'],
  ['trailing newline', 'M1: recruiter_api cannot run the PostGIS functions the app uses\n'],
  ['trailing space', 'M1: PostGIS self-check: no extension owns st_x '],
  ['near miss (case)', 'm1: recruiter_api cannot run the PostGIS functions the app uses'],
  ['near miss (one word)', 'M1: recruiter_api cannot run the PostGIS functions the app needs'],
  ['near miss (missing "M1: ")', 'expected exactly one extension (PostGIS) owning st_x'],
  ['default-privileges text with extra text after', 'M1: the runner has database-wide default privileges for anon/authenticated/PUBLIC on tables or sequences; refusing secret-Zq9981'],
  ['default-privileges near miss (schema-wide)', 'M1: the runner has schema-wide default privileges for anon/authenticated/PUBLIC on tables or sequences; refusing'],
  ['schema with a disallowed character', 'M1: the runner cannot pass on USAGE on PostGIS schema "Ext;drop" to recruiter_api (it needs USAGE WITH GRANT OPTION on that schema)'],
  ['schema with upper case', 'M1: PostGIS schema Extensions is writable by an app role; refusing to trust it'],
  ['schema with a space (smuggled text)', 'M1: PostGIS schema secret value is writable by an app role; refusing to trust it'],
  ['empty schema', 'M1: PostGIS schema  is writable by an app role; refusing to trust it'],
  ['schema name too long', fill('M1: PostGIS schema % is writable by an app role; refusing to trust it', 'a'.repeat(64))],
  ['routine list with an unknown name', 'M1: the runner cannot pass on EXECUTE on PostGIS routine(s) st_x, secret_value to recruiter_api (it needs EXECUTE WITH GRANT OPTION, or PUBLIC must keep EXECUTE)'],
  ['routine list empty', 'M1: the runner cannot pass on EXECUTE on PostGIS routine(s)  to recruiter_api (it needs EXECUTE WITH GRANT OPTION, or PUBLIC must keep EXECUTE)'],
  ['routine list with a bad separator', 'M1: the runner cannot pass on EXECUTE on PostGIS routine(s) st_x,st_y to recruiter_api (it needs EXECUTE WITH GRANT OPTION, or PUBLIC must keep EXECUTE)'],
  ['routine list longer than seven', `M1: the runner cannot pass on EXECUTE on PostGIS routine(s) ${Array(8).fill('st_x').join(', ')} to recruiter_api (it needs EXECUTE WITH GRANT OPTION, or PUBLIC must keep EXECUTE)`],
  ['the raw template with %', 'M1: PostGIS schema % is writable by an app role; refusing to trust it'],
];
check('an unmatched, extended, near-miss or badly filled P0001 prints exactly today\'s line (no id, no text)', () => {
  for (const [name, message] of NO_ID) {
    assert.equal(m1CheckId(message), undefined, name);
    assert.deepEqual(classifyRunnerFailure(pgError(message)), { refusal: 'server_or_driver_error', err_code: 'P0001' }, name);
    assert.equal(printed(pgError(message)), P0001_ONLY, name);
  }
});
check('an M1 check text with any other SQLSTATE, no code, or as a non-Error gets no id', () => {
  const text = MATCHING[0]![0];
  assert.deepEqual(classifyRunnerFailure(pgError(text, '42501')), { refusal: 'server_or_driver_error', err_code: '42501' });
  assert.deepEqual(classifyRunnerFailure(pgError(text, 'P0002')), { refusal: 'server_or_driver_error', err_code: 'P0002' });
  assert.deepEqual(classifyRunnerFailure(new Error(text)), { refusal: 'server_or_driver_error' });
  assert.deepEqual(classifyRunnerFailure({ code: 'P0001', message: text }), { refusal: 'server_or_driver_error', err_code: 'P0001' });
  assert.deepEqual(classifyRunnerFailure(text), { refusal: 'server_or_driver_error' });
});
check('existing classifications are unchanged (runner refusal, known re-apply message, driver code)', () => {
  assert.deepEqual(classifyRunnerFailure(new RunnerRefusal('plan_refused', MATCHING[0]![0])), { refusal: 'plan_refused' });
  assert.deepEqual(classifyRunnerFailure(pgError('re-apply M1b refused: M1b is still applied; run its backout first')), { refusal: 'reapply_m1b_still_applied' });
  assert.deepEqual(classifyRunnerFailure(Object.assign(new Error('x'), { code: 'ECONNRESET' })), { refusal: 'server_or_driver_error', err_code: 'ECONNRESET' });
});
check('no printed line ever contains a message (all cases above)', () => {
  for (const [, message] of [...MATCHING, ...NO_ID]) {
    const line = printed(pgError(message));
    assert.ok(!line.includes(message) && !line.includes('secret') && !line.includes('Zq9981'), line);
    assert.deepEqual(Object.keys(JSON.parse(line)).filter((k) => !['msg', 'refusal', 'err_code', 'm1_check'].includes(k)), []);
  }
});

console.log(`m1-check-ids: ${passed} checks passed`);
