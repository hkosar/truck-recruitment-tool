// Offline test of the backout-rehearsal runner actions (backout-rehearsal.ts, staging-rebuilt.ts): retire-app-credentials,
// identity-alignment-check, postgis-placement, and the window-on / window-off read-back line. No database and no network: the
// executor runs against a recording fake client. The real-catalogue proof is backout-rehearsal-a3.test.ts.
// Run: npx tsx src/backout-rehearsal.test.ts

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  IDENTITY_ALIGNMENT_FILE, IDENTITY_ALIGNMENT_SHA256, POSTGIS_PLACEMENT_SQL, RETIRE_FILE, RETIRE_FILE_SHA256, RETIRE_STAGES, classifyPostgisPlacement, readBackoutWindowFlag, readIdentityAlignment, splitRetireFile,
} from './backout-rehearsal.js';
import { PROD_SQL_ACTIONS } from './prod-sql.js';
import { REFUSAL_IDS, RunnerRefusal, classifyRunnerFailure } from './refusals.js';
import { REBUILT_STAGING_SQL_ACTIONS, REPOSITORY_ROOT, executeRebuiltSqlPlan, planRebuiltSqlRun, type RebuiltSqlPlan } from './staging-rebuilt.js';
import { RECORDED_PROJECT_REFS } from './target-guard.js';

let n = 0;
const check = (name: string, ok: boolean) => { assert.ok(ok, name); console.log(`PASS ${name}`); n += 1; };
const REF = 'abcdefghijklmnopqrst';
const pooler = (ref: string, port = 5432, user = 'postgres') => `postgresql://${user}.${ref}:redacted-pw@aws-0-us-east-2.pooler.supabase.com:${port}/postgres`;
const NEW_ACTIONS = { 'retire-app-credentials': 'RETIRE TNBS STAGING APP CREDENTIALS', 'identity-alignment-check': 'RUN TNBS IDENTITY ALIGNMENT CHECK', 'postgis-placement': 'RECORD TNBS POSTGIS PLACEMENT' } as const;
const plan = (action: string, over: Partial<Parameters<typeof planRebuiltSqlRun>[0]> = {}): RebuiltSqlPlan =>
  planRebuiltSqlRun({ action, dbUrl: pooler(REF), confirm: REBUILT_STAGING_SQL_ACTIONS[action]!.confirmation, recordedRebuiltRef: REF, ...over });
const refusalOf = (fn: () => unknown): string | undefined => { try { fn(); } catch (e) { return e instanceof RunnerRefusal ? e.id : `error:${(e as Error).message}`; } return undefined; };

// ---- 1. The action table: the three new actions with their own phrases; the window actions carry their expected read-back.
for (const [action, phrase] of Object.entries(NEW_ACTIONS)) check(`${action}: present with its own confirmation phrase "${phrase}"`, REBUILT_STAGING_SQL_ACTIONS[action]?.confirmation === phrase);
const phrases = Object.values(REBUILT_STAGING_SQL_ACTIONS).map((s) => s.confirmation);
check('every rebuilt confirmation phrase is unique (no new phrase reuses another action\'s)', new Set(phrases).size === phrases.length);
check('window-on expects true and window-off expects false', REBUILT_STAGING_SQL_ACTIONS['window-on']!.windowExpect === true && REBUILT_STAGING_SQL_ACTIONS['window-off']!.windowExpect === false);

// ---- 2. Target guard: the same refusals as every rebuilt action, for each new action and the window actions.
for (const action of [...Object.keys(NEW_ACTIONS), 'window-on', 'window-off']) {
  check(`${action}: production refused`, refusalOf(() => plan(action, { dbUrl: pooler(RECORDED_PROJECT_REFS.production) })) === 'production_refused');
  check(`${action}: old staging refused`, refusalOf(() => plan(action, { dbUrl: pooler(RECORDED_PROJECT_REFS.staging) })) === 'target_not_recorded_staging');
  check(`${action}: any other ref refused`, refusalOf(() => plan(action, { dbUrl: pooler('zzzzzzzzzzzzzzzzzzzz') })) === 'target_not_recorded_staging');
  check(`${action}: port 6543 refused`, refusalOf(() => plan(action, { dbUrl: pooler(REF, 6543) })) === 'port_must_be_5432');
  check(`${action}: wrong or missing confirmation refused`, refusalOf(() => plan(action, { confirm: 'yes' })) === 'confirmation_required' && refusalOf(() => plan(action, { confirm: undefined })) === 'confirmation_required');
  check(`${action}: unrecorded rebuilt ref refused`, refusalOf(() => plan(action, { recordedRebuiltRef: null })) === 'ref_not_recorded');
  check(`${action}: missing STAGING_DB_URL refused`, refusalOf(() => plan(action, { dbUrl: undefined })) === 'db_url_required');
  check(`${action}: a query string override refused`, refusalOf(() => plan(action, { dbUrl: `${pooler(REF)}?host=example.invalid` })) !== undefined);
  check(`${action}: --out refused`, /only valid for snapshot/.test(String(refusalOf(() => plan(action, { out: 'C:/tmp/x.json' })))));
}

// ---- 3. retire-app-credentials: the same file pin, stage ranges and stage pins as the production runner's retire-* actions.
const prodRetire = PROD_SQL_ACTIONS.filter((a) => a.file === RETIRE_FILE);
check('retire: the production runner has exactly the six retire stages this action runs', prodRetire.length === 6 && RETIRE_STAGES.every((s) => prodRetire.some((a) => a.id === s.prodAction)));
check('retire: file SHA-256, statement ranges and stage SHA-256 equal the production retire-* actions', RETIRE_STAGES.every((s) => {
  const a = prodRetire.find((p) => p.id === s.prodAction)!;
  return a.sha256 === RETIRE_FILE_SHA256 && a.statements?.[0] === s.statements[0] && a.statements?.[1] === s.statements[1] && a.stageSha256 === s.sha256;
}) && REBUILT_STAGING_SQL_ACTIONS['retire-app-credentials']!.sha256 === RETIRE_FILE_SHA256);
const retireBytes = readFileSync(resolve(REPOSITORY_ROOT, RETIRE_FILE));
const stages = splitRetireFile(retireBytes);
check('retire: the pinned file splits into the six verified stages (1 + 1 + 1 + 7 + 1 + 1 statements)', [stages.nologin, stages.terminate, stages.backends, stages.revoke, stages.checks, stages.email].map((s) => s.length).join() === '1,1,1,7,1,1');
check('retire: a changed byte in the file is refused before anything connects', /pinned SHA-256/.test(String(refusalOf(() => splitRetireFile(Buffer.concat([retireBytes, Buffer.from('\n')]))))));
const rp = plan('retire-app-credentials');
check('retire: the plan has six labelled steps, the session settings, and no confirmation setting the file does not read', rp.steps.map((s) => s.label).join() === RETIRE_STAGES.map((s) => s.label).join() && rp.settings.length === 2 && rp.retireStages !== undefined);

interface Run { sent: string[]; out: string[]; err: string[]; error?: unknown }
type Responder = (sql: string, i: number) => unknown;
async function exec(p: RebuiltSqlPlan, respond: Responder, opts: Parameters<typeof executeRebuiltSqlPlan>[2] = {}): Promise<Run> {
  const sent: string[] = []; const out: string[] = []; const err: string[] = [];
  let i = 0;
  const client = {
    connect: async () => undefined,
    query: async (sql: string) => { if (/^select set_config\(\$1, \$2, false\)$/.test(sql)) return { rows: [] }; sent.push(sql); const r = respond(sql, i++); if (r instanceof Error) throw r; return r; },
    end: async () => undefined,
  };
  const log = console.log; const error = console.error;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(' ')); };
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(' ')); };
  try {
    await executeRebuiltSqlPlan(p, () => client, opts);
    return { sent, out, err };
  } catch (e) {
    return { sent, out, err, error: e };
  } finally {
    console.log = log; console.error = error;
  }
}
const events = (r: Run) => [...r.out, ...r.err].map((l) => JSON.parse(l) as Record<string, unknown>);
const ev = (r: Run, msg: string) => events(r).find((e) => e.msg === msg);
const idOf = (r: Run) => (r.error === undefined ? undefined : classifyRunnerFailure(r.error).refusal);

const raw = (name: keyof typeof stages) => stages[name].map((s) => s.raw);
/** A fake server for the retire run: counts per poll, the update row counts, the check row and the email count. */
const retireServer = (o: { polls?: unknown[]; checks?: Record<string, unknown>; email?: unknown; failAt?: string; commitCommand?: string } = {}): Responder => {
  let poll = 0;
  return (sql) => {
    if (o.failAt !== undefined && sql === o.failAt) return Object.assign(new Error('server said no, with a secret-looking text postgres://u:p@h'), { code: '42501' });
    if (sql === raw('terminate')[0]) return { rows: [{ pid: 424242, terminated: true }, { pid: 434343, terminated: true }] };
    if (sql === raw('backends')[0]) { const v = (o.polls ?? ['0', '0', '0'])[Math.min(poll, (o.polls ?? ['0']).length - 1)]; poll += 1; return { rows: [{ recruiter_app_backends: v }] }; }
    if (/^\s*update\b/i.test(stages.revoke.find((s) => s.raw === sql)?.clean ?? '')) return { rowCount: 2, command: 'UPDATE', rows: [] };
    if (sql === raw('revoke')[raw('revoke').length - 1]) return { command: o.commitCommand ?? 'COMMIT', rows: [] };
    if (sql === raw('checks')[0]) return { rows: [o.checks ?? { backends: '0', live_sessions: '0', live_links: '0', live_codes: '0' }] };
    if (sql === raw('email')[0]) return { rows: [{ email_mismatches: o.email ?? '0' }] };
    return { rows: [], command: 'OK' };
  };
};
let clock = 0;
const fastClock = { sleep: async (ms: number) => { clock += ms; }, now: () => clock };
const allStatements = [...raw('nologin'), ...raw('terminate'), ...raw('backends'), ...raw('backends'), ...raw('backends'), ...raw('revoke'), ...raw('checks'), ...raw('email')];

{
  const r = await exec(rp, retireServer(), fastClock);
  check('retire: happy path sends exactly the file\'s statements in order (three zero polls), nothing else', r.error === undefined && JSON.stringify(r.sent) === JSON.stringify(allStatements));
  check('retire: fixed events only: terminate count, poll result, revoke counts, checks all 0, six step_done lines', JSON.stringify(ev(r, 'staging-sql.retire_terminate')) === JSON.stringify({ msg: 'staging-sql.retire_terminate', backends_signalled: 2 })
    && JSON.stringify(ev(r, 'staging-sql.retire_backends')) === JSON.stringify({ msg: 'staging-sql.retire_backends', ok: true, polls: 3, zero_reads_in_a_row: 3, last_count: 0 })
    && JSON.stringify(ev(r, 'staging-sql.retire_revoked')) === JSON.stringify({ msg: 'staging-sql.retire_revoked', sessions: 2, links: 2, recovery_sets: 2, codes: 2 })
    && JSON.stringify(ev(r, 'staging-sql.retire_checks')) === JSON.stringify({ msg: 'staging-sql.retire_checks', ok: true, backends: 0, live_sessions: 0, live_links: 0, live_codes: 0, email_mismatches: 0 })
    && events(r).filter((e) => e.msg === 'staging-sql.step_done').map((e) => e.step).join() === RETIRE_STAGES.map((s) => s.label).join());
  check('retire: no pid from the terminate rows is printed', ![...r.out, ...r.err].some((l) => l.includes('424242') || l.includes('434343') || l.includes('pid')));
}
{
  clock = 0;
  const r = await exec(rp, retireServer({ polls: ['0', '0', '1', '0', '0', '0'] }), fastClock);
  check('retire: a non-zero read resets the run of zeros (0,0,1,0,0,0 passes after six polls with one-second waits)', r.error === undefined && (ev(r, 'staging-sql.retire_backends')!.polls as number) === 6 && clock === 5000);
}
{
  clock = 0;
  const r = await exec(rp, retireServer({ polls: ['1'] }), fastClock);
  check('retire: still-connected app role for 60 seconds: refused retire_backends_not_gone, no revoke and no check statement sent', idOf(r) === 'retire_backends_not_gone' && !r.sent.some((s) => raw('revoke').includes(s) || s === raw('checks')[0]) && clock === 60_000
    && JSON.stringify(ev(r, 'staging-sql.retire_backends')) === JSON.stringify({ msg: 'staging-sql.retire_backends', ok: false, polls: 61, zero_reads_in_a_row: 0, last_count: 1 }));
}
{
  clock = 0;
  const r = await exec(rp, retireServer({ polls: ['not-a-number'] }), fastClock);
  check('retire: an unreadable poll count never counts as zero (refused, last_count unreadable)', idOf(r) === 'retire_backends_not_gone' && ev(r, 'staging-sql.retire_backends')!.last_count === 'unreadable');
}
{
  clock = 0;
  const r = await exec(rp, retireServer({ failAt: raw('revoke')[2] }), fastClock);
  check('retire: a failure inside the revoke transaction sends rollback, names only the step, forwards only the SQLSTATE, and runs no check', r.sent[r.sent.length - 1] === 'rollback' && JSON.stringify(ev(r, 'staging-sql.step_failed')) === JSON.stringify({ msg: 'staging-sql.step_failed', step: 'retire-step-4-revoke' })
    && JSON.stringify(classifyRunnerFailure(r.error)) === JSON.stringify({ refusal: 'server_or_driver_error', err_code: '42501' }) && !r.sent.includes(raw('checks')[0]!) && ![...r.out, ...r.err].some((l) => l.includes('postgres://')));
}
{
  clock = 0;
  const r = await exec(rp, retireServer({ commitCommand: 'ROLLBACK' }), fastClock);
  check('retire: a COMMIT answered with the ROLLBACK tag is a failure, never success', r.error !== undefined && ev(r, 'staging-sql.retire_checks') === undefined);
}
{
  clock = 0;
  const r = await exec(rp, retireServer({ failAt: raw('nologin')[0] }), fastClock);
  check('retire: a refused NOLOGIN stops before the terminate step', r.error !== undefined && r.sent.length === 1 && JSON.stringify(ev(r, 'staging-sql.step_failed')) === JSON.stringify({ msg: 'staging-sql.step_failed', step: 'retire-step-2-nologin' }));
}
for (const [name, o] of [['a live session', { checks: { backends: '0', live_sessions: '1', live_links: '0', live_codes: '0' } }], ['a reconnected backend', { checks: { backends: '1', live_sessions: '0', live_links: '0', live_codes: '0' } }], ['an email mismatch', { email: '1' }], ['an unreadable check row', { checks: {} }]] as const) {
  clock = 0;
  const r = await exec(rp, retireServer(o), fastClock);
  check(`retire: ${name} after the revoke: refused retire_checks_failed with ok=false, the last two step_done lines not printed`, idOf(r) === 'retire_checks_failed' && ev(r, 'staging-sql.retire_checks')!.ok === false && !events(r).some((e) => e.step === 'retire-step-5-checks' || e.step === 'retire-step-6-email'));
}

// ---- 4. identity-alignment-check: the pinned read-only inventory, read-only transaction, five counts, fixed pass rule.
check('identity: the action runs the pinned read-only inventory file', REBUILT_STAGING_SQL_ACTIONS['identity-alignment-check']!.file === IDENTITY_ALIGNMENT_FILE && REBUILT_STAGING_SQL_ACTIONS['identity-alignment-check']!.sha256 === IDENTITY_ALIGNMENT_SHA256);
const ip = plan('identity-alignment-check');
const inventory = readFileSync(resolve(REPOSITORY_ROOT, IDENTITY_ALIGNMENT_FILE), 'utf8');
check('identity: the plan sends the file text unchanged as one step', ip.steps.length === 1 && ip.steps[0]!.sql === inventory);
const inventoryRow = (over: Record<string, unknown> = {}) => ({ rows: [{ profiles_total: '9', auth_users_total: '8', profiles_manager_approved: '1', profiles_edit_approved: '3', profiles_view_approved: '2', profiles_guest_approved: '0', email_mismatches: '0', approved_profiles_without_auth_user: '1', approved_auth_email_null: '0', ...over }] });
const identityServer = (row: unknown): Responder => (sql) => (sql === inventory ? row : { rows: [] });
{
  const r = await exec(ip, identityServer(inventoryRow()));
  check('identity: aligned: begin read only, the file, rollback; never a commit', r.error === undefined && JSON.stringify(r.sent) === JSON.stringify(['begin read only', inventory, 'rollback']));
  check('identity: aligned: one fixed line with five numbers', JSON.stringify(events(r)) === JSON.stringify([{ msg: 'staging-sql.identity_alignment', ok: true, approved_profiles: 6, email_mismatches: 0, approved_profiles_without_auth_user: 1, approved_auth_email_null: 0 }]));
}
for (const [name, over, id] of [['an email mismatch', { email_mismatches: '1' }, 'identity_alignment_failed'], ['an approved Auth row with a null email', { approved_auth_email_null: '2' }, 'identity_alignment_failed'], ['a count that is not a number', { email_mismatches: 'x' }, 'identity_alignment_result_missing']] as const) {
  const r = await exec(ip, identityServer(inventoryRow(over)));
  check(`identity: ${name}: refused ${id}, rolled back, never committed`, idOf(r) === id && r.sent[r.sent.length - 1] === 'rollback' && !r.sent.includes('commit') && events(r).some((e) => e.msg === 'staging-sql.identity_alignment' && e.ok === false));
}
{
  const r = await exec(ip, identityServer({ rows: [] }));
  check('identity: no row: refused identity_alignment_result_missing', idOf(r) === 'identity_alignment_result_missing');
  check('identity: approved_profiles_without_auth_user is printed but not judged (a value of 5 still passes when emails align)', readIdentityAlignment(inventoryRow({ approved_profiles_without_auth_user: '5' }))?.approved_profiles_without_auth_user === 5);
}

// ---- 5. window-on / window-off: the read-back flag is printed as one fixed line before the commit; a wrong value rolls back.
for (const [action, expect] of [['window-on', true], ['window-off', false]] as const) {
  const wp = plan(action);
  const windowServer = (rows: unknown[]): Responder => (sql) => (sql === wp.steps[0]!.sql ? [{ command: 'UPDATE', rowCount: 1, rows: [] }, { command: 'SELECT', rows }] : { rows: [], command: sql.toUpperCase() });
  const good = await exec(wp, windowServer([{ email_edits_paused: expect }]));
  check(`${action}: begin, the update + read-back, commit; the read-back line says ${expect} before step_done`, good.error === undefined && JSON.stringify(good.sent) === JSON.stringify(['begin', wp.steps[0]!.sql, 'commit'])
    && JSON.stringify(events(good)) === JSON.stringify([{ msg: 'staging-sql.backout_window', action, email_edits_paused: expect, rows: 1, ok: true }, { msg: 'staging-sql.step_done', step: action }]));
  const wrong = await exec(wp, windowServer([{ email_edits_paused: !expect }]));
  check(`${action}: the flag reads ${!expect}: refused backout_window_not_expected, rolled back, no commit, no step_done`, idOf(wrong) === 'backout_window_not_expected' && wrong.sent.includes('rollback') && !wrong.sent.includes('commit')
    && ev(wrong, 'staging-sql.backout_window')!.ok === false && ev(wrong, 'staging-sql.step_done') === undefined);
  const none = await exec(wp, windowServer([]));
  check(`${action}: an empty control table reads as unknown with rows 0 and is refused`, idOf(none) === 'backout_window_not_expected' && ev(none, 'staging-sql.backout_window')!.email_edits_paused === 'unknown' && ev(none, 'staging-sql.backout_window')!.rows === 0);
  const two = await exec(wp, windowServer([{ email_edits_paused: expect }, { email_edits_paused: expect }]));
  check(`${action}: two rows read as unknown (the control table must hold exactly one)`, idOf(two) === 'backout_window_not_expected' && ev(two, 'staging-sql.backout_window')!.rows === 2);
}
check('window read-back: a non-boolean value is unknown', readBackoutWindowFlag({ rows: [{ email_edits_paused: 't' }] }).value === 'unknown');

// ---- 6. postgis-placement: read-only, one enumerated word.
const pp = plan('postgis-placement');
check('postgis: the plan sends the fixed catalogue select only', pp.steps.length === 1 && pp.steps[0]!.sql === POSTGIS_PLACEMENT_SQL && !/\b(insert|update|delete|create|alter|drop|grant|revoke)\b/i.test(POSTGIS_PLACEMENT_SQL));
for (const [rows, word] of [[[{ schema_name: 'extensions' }], 'extensions'], [[{ schema_name: 'public' }], 'public'], [[{ schema_name: 'tiger_secret_schema' }], 'other'], [[], 'absent']] as const) {
  const r = await exec(pp, (sql) => (sql === POSTGIS_PLACEMENT_SQL ? { rows } : { rows: [] }));
  check(`postgis: ${JSON.stringify(rows)} -> "${word}", read-only transaction rolled back, and the schema text itself is never printed`, r.error === undefined && JSON.stringify(r.sent) === JSON.stringify(['begin read only', POSTGIS_PLACEMENT_SQL, 'rollback'])
    && JSON.stringify(events(r)) === JSON.stringify([{ msg: 'staging-sql.postgis_placement', schema: word }]) && !r.out.join('').includes('tiger'));
}
check('postgis: two rows (impossible for one extension) are other, not a guess', classifyPostgisPlacement({ rows: [{ schema_name: 'public' }, { schema_name: 'public' }] }) === 'other');

// ---- 7. The secrets wrapper shows every new line unchanged and knows every new action and refusal id.
const wrapper = await import(pathToFileURL(resolve(REPOSITORY_ROOT, 'scripts/run-with-secrets.mjs')).href);
const NEW_IDS = ['retire_backends_not_gone', 'retire_checks_failed', 'identity_alignment_failed', 'identity_alignment_result_missing', 'backout_window_not_expected'];
check('refusals.ts and the wrapper list every new refusal id', NEW_IDS.every((id) => (REFUSAL_IDS as readonly string[]).includes(id) && wrapper.REFUSAL_IDS.includes(id)));
check('the wrapper lists the three new actions', Object.keys(NEW_ACTIONS).every((a) => wrapper.ACTIONS.includes(a)));
const sample = [
  { msg: 'staging-sql.retire_terminate', backends_signalled: 2 },
  { msg: 'staging-sql.retire_backends', ok: true, polls: 3, zero_reads_in_a_row: 3, last_count: 0 },
  { msg: 'staging-sql.retire_backends', ok: false, polls: 61, zero_reads_in_a_row: 0, last_count: 'unreadable' },
  { msg: 'staging-sql.retire_revoked', sessions: 2, links: 0, recovery_sets: 1, codes: -1 },
  { msg: 'staging-sql.retire_checks', ok: false, backends: 0, live_sessions: 1, live_links: 0, live_codes: 0, email_mismatches: 'unreadable' },
  { msg: 'staging-sql.identity_alignment', ok: true, approved_profiles: 6, email_mismatches: 0, approved_profiles_without_auth_user: 1, approved_auth_email_null: 0 },
  { msg: 'staging-sql.backout_window', action: 'window-on', email_edits_paused: true, rows: 1, ok: true },
  { msg: 'staging-sql.backout_window', action: 'window-off', email_edits_paused: 'unknown', rows: 0, ok: false },
  { msg: 'staging-sql.postgis_placement', schema: 'extensions' },
  ...RETIRE_STAGES.map((s) => ({ msg: 'staging-sql.step_done', step: s.label })),
  ...Object.keys(NEW_ACTIONS).map((action) => ({ msg: 'staging-sql.verified', action, steps: 1, target: 'recorded rebuilt staging project' })),
  ...NEW_IDS.map((refusal) => ({ msg: 'staging-sql.refused', refusal })),
];
for (const e of sample) {
  const counter = { fields: 0 };
  check(`wrapper shows ${e.msg} ${JSON.stringify(e).slice(0, 80)} unchanged`, wrapper.allowListLine(JSON.stringify(e), counter) === JSON.stringify(e) && counter.fields === 0);
}
{
  const counter = { fields: 0 };
  const shownLine = wrapper.allowListLine(JSON.stringify({ msg: 'staging-sql.postgis_placement', schema: 'my_schema', pid: 4242 }), counter);
  check('wrapper withholds a schema name that is not one of the four words and drops an unknown pid field', shownLine === JSON.stringify({ msg: 'staging-sql.postgis_placement', schema: '<withheld>' }) && counter.fields === 2);
  const c2 = { fields: 0 };
  check('wrapper withholds an email text in a count field', wrapper.allowListLine(JSON.stringify({ msg: 'staging-sql.identity_alignment', ok: true, email_mismatches: 'a@b.example' }), c2) === JSON.stringify({ msg: 'staging-sql.identity_alignment', ok: true, email_mismatches: '<withheld>' }) && c2.fields === 1);
}
console.log(`${n} checks passed`);
