// Offline unit tests for the first-manager bootstrap (pipeline/src/first-manager-bootstrap.ts, first-manager-runner.ts).
// No network and no database: the executor runs against an in-memory fake client that models only the rows the tool reads.
// Run: npx tsx src/first-manager-bootstrap.test.ts   (npm run test:first-manager)

import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  FIRST_MANAGER_ACTIONS, FIRST_MANAGER_CHECK_CONFIRMATION, FIRST_MANAGER_CHECK_IDS, FIRST_MANAGER_CREATE_CONFIRMATION, FIRST_MANAGER_EMAIL, FIRST_MANAGER_NAME, FIRST_MANAGER_STATES,
  assessFirstManagerPre, executeFirstManagerPlan, firstManagerState, planFirstManager, selectFirstManagerDbUrl,
  type FirstManagerPlan, type RosterFacts, type SchemaFacts,
} from './first-manager-bootstrap.js';
import { main as runnerMain, parseFirstManagerArgs } from './first-manager-runner.js';
import { DRIVER_CODES, REFUSAL_IDS, RunnerRefusal, classifyRunnerFailure } from './refusals.js';
import { REPOSITORY_ROOT, type RebuiltSqlClient } from './staging-rebuilt.js';
import { RECORDED_PROJECT_REFS } from './target-guard.js';

const STAGING_REF = 'abcdefghijklmnopqrst';
const OTHER_REF = 'tsrqponmlkjihgfedcba';
const url = (ref: string, port = 5432) => `postgresql://postgres.${ref}:redacted-pw@aws-0-us-east-2.pooler.supabase.com:${port}/postgres`;
const STG = { recordedStagingRef: STAGING_REF };

let passed = 0;
const check = (name: string, ok: boolean) => { assert.ok(ok, name); console.log(`PASS ${name}`); passed += 1; };
const refusalOf = (fn: () => unknown): string | undefined => { try { fn(); return undefined; } catch (e) { return e instanceof RunnerRefusal ? e.id : `other:${String(e)}`; } };

// ---------------------------------------------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------------------------------------------

const planStg = (over: Partial<Parameters<typeof planFirstManager>[0]> = {}) =>
  planFirstManager({ target: 'staging', action: 'first-manager-create', dbUrl: url(STAGING_REF), confirm: FIRST_MANAGER_CREATE_CONFIRMATION.staging, ...STG, ...over });
const planProd = (over: Partial<Parameters<typeof planFirstManager>[0]> = {}) =>
  planFirstManager({ target: 'production', action: 'first-manager-create', dbUrl: url(RECORDED_PROJECT_REFS.production), confirm: FIRST_MANAGER_CREATE_CONFIRMATION.production, ...over });

check('the target is required: missing, empty and unknown targets are refused', ['undefined', '', 'prod', 'Production', 'current', 'rebuilt'].every((t) => refusalOf(() => planStg({ target: t === 'undefined' ? undefined : t })) === 'bootstrap_target_required'));
check('an unknown action is refused', refusalOf(() => planStg({ action: 'owner-promote' })) === 'unknown_action');
check('both plans verify with the right target', planStg().target === 'staging' && planProd().target === 'production');
check('confirmations differ per target and per action', new Set([FIRST_MANAGER_CHECK_CONFIRMATION, FIRST_MANAGER_CREATE_CONFIRMATION.staging, FIRST_MANAGER_CREATE_CONFIRMATION.production]).size === 3);
check('the staging create phrase does not unlock production, and the production phrase does not unlock staging',
  refusalOf(() => planProd({ confirm: FIRST_MANAGER_CREATE_CONFIRMATION.staging })) === 'confirmation_required' && refusalOf(() => planStg({ confirm: FIRST_MANAGER_CREATE_CONFIRMATION.production })) === 'confirmation_required');
check('a missing or near-miss confirmation is refused', [undefined, '', 'create tnbs production first manager', `${FIRST_MANAGER_CREATE_CONFIRMATION.production} `].every((c) => refusalOf(() => planProd({ confirm: c })) === 'confirmation_required'));
check('the check action needs its own phrase on both targets', refusalOf(() => planProd({ action: 'first-manager-check' })) === 'confirmation_required' && planProd({ action: 'first-manager-check', confirm: FIRST_MANAGER_CHECK_CONFIRMATION }).action === 'first-manager-check');
check('a staging run refuses the production project', refusalOf(() => planStg({ dbUrl: url(RECORDED_PROJECT_REFS.production) })) === 'production_refused');
check('a staging run refuses every other project, including the old staging project', refusalOf(() => planStg({ dbUrl: url(OTHER_REF) })) === 'target_not_recorded_staging' && refusalOf(() => planStg({ dbUrl: url(RECORDED_PROJECT_REFS.staging) })) === 'target_not_recorded_staging');
check('a production run refuses staging and any unrecorded project', [STAGING_REF, RECORDED_PROJECT_REFS.staging, OTHER_REF].every((r) => refusalOf(() => planProd({ dbUrl: url(r) })) === 'target_not_recorded_production'));
check('the transaction pooler port is refused on both targets', refusalOf(() => planStg({ dbUrl: url(STAGING_REF, 6543) })) === 'port_must_be_5432' && refusalOf(() => planProd({ dbUrl: url(RECORDED_PROJECT_REFS.production, 6543) })) === 'port_must_be_5432');
check('a missing connection string is refused', refusalOf(() => planStg({ dbUrl: undefined })) === 'db_url_required' && refusalOf(() => planProd({ dbUrl: '' })) === 'db_url_required');
check('an unrecorded staging ref refuses before anything else', refusalOf(() => planStg({ recordedStagingRef: null })) === 'ref_not_recorded');
check('a recorded staging ref equal to production is invalid', refusalOf(() => planStg({ recordedStagingRef: RECORDED_PROJECT_REFS.production })) === 'ref_invalid');
check('a connection string with query parameters is refused', (() => { try { planProd({ dbUrl: `${url(RECORDED_PROJECT_REFS.production)}?host=evil.example` }); return false; } catch { return true; } })());
check('arguments: only the four known options; no default target', parseFirstManagerArgs(['--action=x']).target === undefined && refusalOf(() => parseFirstManagerArgs(['--db-url=x'])) === 'unknown_argument' && parseFirstManagerArgs(['--target=production', '--action=a', '--confirm=c', '--execute']).execute === true);
check('each target reads its own variable; the other one present is a mixed environment and refused',
  selectFirstManagerDbUrl('staging', { STAGING_DB_URL: 's' }) === 's' && selectFirstManagerDbUrl('production', { PRODUCTION_DB_URL: 'p' }) === 'p'
  && refusalOf(() => selectFirstManagerDbUrl('production', { PRODUCTION_DB_URL: 'p', STAGING_DB_URL: 's' })) === 'plan_refused'
  && refusalOf(() => selectFirstManagerDbUrl('staging', { PRODUCTION_DB_URL: 'p', STAGING_DB_URL: 's' })) === 'plan_refused');
check('a staging run never reads the production variable', (() => { try { selectFirstManagerDbUrl('staging', { PRODUCTION_DB_URL: 'p' }); return false; } catch (e) { return e instanceof RunnerRefusal && e.id === 'plan_refused'; } })());
check('the address is a constant, not an input', FIRST_MANAGER_EMAIL === 'hunter@twistednail.com' && FIRST_MANAGER_NAME === 'Hunter Kosar' && FIRST_MANAGER_EMAIL === FIRST_MANAGER_EMAIL.toLowerCase());

// ---------------------------------------------------------------------------------------------------------------
// Fake client: models the rows the tool reads, keyed on the statements it sends
// ---------------------------------------------------------------------------------------------------------------

const READY_SCHEMA: SchemaFacts = { m1_tables: true, m1b_function: true, account_link_present: false };
const EMPTY: RosterFacts = { profiles_total: 0, managers: 0, email_profiles: 0, email_exact_lower: 0, email_pristine_guest: 0, owner_manager_self_approved: 0, sign_in_matches: 0, email_blocked: 0, bootstrap_events: 0 };
const PRISTINE_GUEST: RosterFacts = { ...EMPTY, profiles_total: 1, email_profiles: 1, email_exact_lower: 1, email_pristine_guest: 1 };

interface Fault { failOn?: RegExp; commitFails?: boolean; rollbackFails?: boolean; zeroRows?: boolean; breakPost?: boolean }
function fakeClient(schema: SchemaFacts, start: RosterFacts, fault: Fault = {}) {
  let roster = { ...start };
  let saved = { ...start };
  const sent: string[] = [];
  const mkOwner = (r: RosterFacts) => ({ ...r, managers: 1, email_profiles: 1, email_exact_lower: 1, email_pristine_guest: 0, owner_manager_self_approved: 1, sign_in_matches: fault.breakPost ? 2 : 1 });
  const client: RebuiltSqlClient = {
    async connect() { return undefined; },
    async end() { sent.push('<end>'); },
    async query(sql: string) {
      const text = sql.replace(/\s+/g, ' ').trim();
      sent.push(text);
      if (fault.failOn?.test(text)) throw Object.assign(new Error('boom'), { code: '40001' });
      if (text === 'begin' || text === 'begin read only') { saved = { ...roster }; return { rows: [], rowCount: 0 }; }
      if (text === 'commit') { if (fault.commitFails) throw new Error('connection lost'); return { rows: [], rowCount: 0 }; }
      if (text === 'rollback') { if (fault.rollbackFails) throw new Error('connection lost'); roster = { ...saved }; return { rows: [], rowCount: 0 }; }
      if (text.includes("to_regclass('internal.roster_lock')")) return { rows: [{ ...schema }], rowCount: 1 };
      if (text.includes('as profiles_total')) return { rows: [{ ...roster }], rowCount: 1 };
      if (text.startsWith('with n as (select gen_random_uuid()')) {
        if (fault.zeroRows) return { rows: [], rowCount: 0 };
        roster = { ...mkOwner(roster), profiles_total: roster.profiles_total + 1 };
        return { rows: [{ id: '11111111-1111-4111-8111-111111111111' }], rowCount: 1 };
      }
      if (text.startsWith('update public.profiles set role')) {
        if (fault.zeroRows) return { rows: [], rowCount: 0 };
        roster = mkOwner(roster);
        return { rows: [{ id: '22222222-2222-4222-8222-222222222222' }], rowCount: 1 };
      }
      if (text.startsWith('insert into internal.auth_events')) { roster = { ...roster, bootstrap_events: roster.bootstrap_events + 1 }; return { rows: [], rowCount: 1 }; }
      return { rows: [], rowCount: 0 };
    },
  };
  return { client, sent, roster: () => roster };
}

async function run(plan: FirstManagerPlan, f: ReturnType<typeof fakeClient>) {
  const events: Array<Record<string, unknown>> = [];
  const log = console.log; const err = console.error;
  console.log = (...a: unknown[]) => { try { events.push(JSON.parse(String(a[0]))); } catch { /* not an event */ } };
  console.error = () => undefined;
  let error: unknown;
  try { await executeFirstManagerPlan(plan, () => f.client); } catch (e) { error = e; } finally { console.log = log; console.error = err; }
  return { events, error };
}
const result = (events: Array<Record<string, unknown>>) => events.find((e) => e.msg === 'first-manager.result')?.result;
const WRITES = /^(with n as|update public\.profiles|insert into)/;
const writesOf = (sent: string[]) => sent.filter((s) => WRITES.test(s));
const create = (target: 'staging' | 'production' = 'production') => (target === 'staging' ? planStg() : planProd());

async function main(): Promise<void> {
  // ---- empty roster: insert path
  {
    const f = fakeClient(READY_SCHEMA, EMPTY);
    const { events, error } = await run(create(), f);
    check('empty roster: the manager is created and committed', error === undefined && result(events) === 'committed' && events.find((e) => e.msg === 'first-manager.result')?.path === 'insert');
    check('empty roster: exactly one profile and one audit event are written', writesOf(f.sent).length === 2 && f.roster().profiles_total === 1 && f.roster().managers === 1 && f.roster().bootstrap_events === 1);
    const idx = (re: RegExp) => f.sent.findIndex((s) => re.test(s));
    check('lock order: begin, then the roster lock (exclusive), then profiles, then the facts, then the write, then commit',
      idx(/^begin$/) < idx(/roster_lock for update/) && idx(/roster_lock for update/) < idx(/lock table public\.profiles in share row exclusive mode/) && idx(/lock table/) < idx(/as profiles_total/) && idx(/as profiles_total/) < idx(/^with n as/) && idx(/^with n as/) < idx(/^commit$/));
    check('the insert path never raises the service-role claim', !f.sent.some((s) => s.includes('request.jwt.claims')));
    check('nothing is deleted, dropped, truncated or created, and no Auth user is touched', !f.sent.some((s) => /\b(delete|drop|truncate|create|alter)\b|auth\.users/i.test(s)));
    check('the run ends the connection', f.sent[f.sent.length - 1] === '<end>');
    check('printed events never contain the address, the name or an id', !JSON.stringify(events).match(/twistednail|Hunter|Kosar|1111/i));
  }
  // ---- pristine pending guest: promote path
  {
    const f = fakeClient(READY_SCHEMA, PRISTINE_GUEST);
    const { events, error } = await run(create('staging'), f);
    const claim = f.sent.findIndex((s) => s.includes('request.jwt.claims'));
    check('a pristine pending guest for the address is promoted in place', error === undefined && result(events) === 'committed' && events.find((e) => e.msg === 'first-manager.result')?.path === 'promote' && f.roster().profiles_total === 1);
    check('the promote path raises the transaction-local service-role claim just before the update', claim > 0 && f.sent[claim]!.includes(', true)') && f.sent[claim + 1]!.startsWith('update public.profiles'));
  }
  // ---- refusals: nothing is written, the transaction is rolled back
  const refuse = async (name: string, schema: SchemaFacts, roster: RosterFacts, failedCheck: string) => {
    const f = fakeClient(schema, roster);
    const { events, error } = await run(create(), f);
    const failed = events.filter((e) => e.msg === 'first-manager.check' && e.ok === false).map((e) => e.check);
    check(`refused: ${name}`, error instanceof RunnerRefusal && error.id === 'first_manager_refused' && result(events) === 'rolled_back' && writesOf(f.sent).length === 0 && failed.includes(failedCheck) && f.sent.includes('rollback') && !f.sent.includes('commit'));
  };
  await refuse('a manager already exists (any status)', READY_SCHEMA, { ...EMPTY, profiles_total: 3, managers: 1 }, 'no_manager_profile_exists_in_any_status');
  await refuse('an earlier bootstrap event is recorded', READY_SCHEMA, { ...EMPTY, bootstrap_events: 1 }, 'no_earlier_bootstrap_event_is_recorded');
  await refuse('the address is blocked', READY_SCHEMA, { ...EMPTY, email_blocked: 1 }, 'the_owner_address_is_not_blocked');
  await refuse('the address is already an approved editor', READY_SCHEMA, { ...EMPTY, profiles_total: 1, email_profiles: 1, email_exact_lower: 1, sign_in_matches: 1 }, 'the_owner_address_is_absent_or_one_pristine_pending_guest');
  await refuse('the address appears twice', READY_SCHEMA, { ...PRISTINE_GUEST, profiles_total: 2, email_profiles: 2 }, 'the_owner_address_is_absent_or_one_pristine_pending_guest');
  await refuse('the stored address is not lower case', READY_SCHEMA, { ...PRISTINE_GUEST, email_exact_lower: 0 }, 'the_owner_address_is_absent_or_one_pristine_pending_guest');
  {
    // Schema not ready: refused BEFORE any lock or write.
    for (const [name, schema, id] of [
      ['M1 tables missing', { ...READY_SCHEMA, m1_tables: false }, 'm1_sign_in_tables_are_installed'],
      ['M1b function missing', { ...READY_SCHEMA, m1b_function: false }, 'm1b_add_person_is_installed'],
      ['the account link still present', { ...READY_SCHEMA, account_link_present: true }, 'the_profiles_account_link_is_dropped'],
    ] as const) {
      const f = fakeClient(schema, EMPTY);
      const { events, error } = await run(create(), f);
      check(`schema not ready (${name}): refused before any lock or write`, error instanceof RunnerRefusal && error.id === 'first_manager_refused' && events.some((e) => e.check === id && e.ok === false) && !f.sent.some((s) => /roster_lock for update|lock table/.test(s)) && writesOf(f.sent).length === 0 && result(events) === 'rolled_back');
    }
  }
  // ---- failures inside the transaction
  {
    const f = fakeClient(READY_SCHEMA, EMPTY, { zeroRows: true });
    const { events, error } = await run(create(), f);
    check('a write that changes no row is refused and rolled back', error instanceof RunnerRefusal && error.id === 'first_manager_refused' && result(events) === 'rolled_back' && f.roster().profiles_total === 0);
  }
  {
    const f = fakeClient(READY_SCHEMA, EMPTY, { breakPost: true });
    const { events, error } = await run(create(), f);
    check('a failed postcondition rolls back: nothing is committed and the roster is back to empty', error instanceof RunnerRefusal && result(events) === 'rolled_back' && !f.sent.includes('commit') && f.roster().profiles_total === 0
      && events.some((e) => e.msg === 'first-manager.check' && e.phase === 'after' && e.ok === false));
  }
  {
    const f = fakeClient(READY_SCHEMA, EMPTY, { failOn: /^insert into internal\.auth_events/ });
    const { events, error } = await run(create(), f);
    check('a database error on the audit write rolls back the profile too and prints only a driver/SQLSTATE class', classifyRunnerFailure(error).refusal === 'server_or_driver_error' && classifyRunnerFailure(error).err_code === '40001' && result(events) === 'rolled_back' && f.roster().profiles_total === 0);
  }
  {
    const f = fakeClient(READY_SCHEMA, EMPTY, { commitFails: true });
    const { events, error } = await run(create(), f);
    check('a failed COMMIT is reported unknown, never rolled back or repeated', error instanceof Error && result(events) === 'unknown' && f.sent.filter((s) => s === 'commit').length === 1 && !f.sent.includes('rollback') && writesOf(f.sent).length === 2);
  }
  {
    const f = fakeClient(READY_SCHEMA, { ...EMPTY, managers: 1 }, { rollbackFails: true });
    const { events } = await run(create(), f);
    check('an unacknowledged ROLLBACK is its own result', result(events) === 'rollback_not_confirmed');
  }
  // ---- the read-only check
  {
    for (const [roster, state] of [[EMPTY, 'ready_to_create'], [PRISTINE_GUEST, 'ready_to_promote'], [{ ...EMPTY, managers: 2 }, 'manager_exists']] as const) {
      const f = fakeClient(READY_SCHEMA, roster);
      const { events, error } = await run(planProd({ action: 'first-manager-check', confirm: FIRST_MANAGER_CHECK_CONFIRMATION }), f);
      check(`check action: reports ${state}, reads only, always rolls back`, error === undefined && events.find((e) => e.msg === 'first-manager.state')?.state === state && f.sent[0] === 'begin read only' && f.sent.includes('rollback') && !f.sent.includes('commit') && writesOf(f.sent).length === 0 && !f.sent.some((s) => /for update|lock table/.test(s)));
    }
    const f = fakeClient({ ...READY_SCHEMA, m1b_function: false }, EMPTY);
    const { events } = await run(planProd({ action: 'first-manager-check', confirm: FIRST_MANAGER_CHECK_CONFIRMATION }), f);
    check('check action: a missing schema is reported as schema_not_ready and the roster is not queried', events.find((e) => e.msg === 'first-manager.state')?.state === 'schema_not_ready' && !f.sent.some((s) => s.includes('as profiles_total')));
  }
  // ---- states
  check('state precedence', firstManagerState(undefined, undefined) === 'schema_not_ready' && firstManagerState(READY_SCHEMA, { ...EMPTY, managers: 1, bootstrap_events: 1 }) === 'manager_exists'
    && firstManagerState(READY_SCHEMA, { ...EMPTY, bootstrap_events: 1 }) === 'already_bootstrapped' && firstManagerState(READY_SCHEMA, { ...EMPTY, email_blocked: 1 }) === 'address_blocked'
    && firstManagerState(READY_SCHEMA, { ...PRISTINE_GUEST, email_pristine_guest: 0 }) === 'address_on_roster');
  check('an assessment with a missing fact never passes', !assessFirstManagerPre(undefined, undefined).ok && assessFirstManagerPre(undefined, undefined).checks.every((c) => c.ok === false));

  // ---- the runner: plan only by default; --execute is what connects
  {
    const lines: string[] = [];
    const log = console.log; console.log = (...a: unknown[]) => { lines.push(String(a[0])); };
    let connected = 0;
    try {
      await runnerMain(['--target=production', '--action=first-manager-create', `--confirm=${FIRST_MANAGER_CREATE_CONFIRMATION.production}`], { PRODUCTION_DB_URL: url(RECORDED_PROJECT_REFS.production) }, () => { connected += 1; throw new Error('must not connect'); });
    } finally { console.log = log; }
    check('without --execute the runner prints the plan, connects to nothing and prints no connection detail', connected === 0 && lines.length === 2 && lines[1]!.includes('plan_only') && !lines.join('').match(/pooler|redacted|postgres|supabase/i));
    const f = fakeClient(READY_SCHEMA, EMPTY);
    const lines2: string[] = [];
    console.log = (...a: unknown[]) => { lines2.push(String(a[0])); };
    try {
      await runnerMain(['--target=production', '--action=first-manager-create', `--confirm=${FIRST_MANAGER_CREATE_CONFIRMATION.production}`, '--execute'], { PRODUCTION_DB_URL: url(RECORDED_PROJECT_REFS.production) }, () => f.client);
    } finally { console.log = log; }
    check('with --execute the runner connects through the factory, writes once and says done', result(lines2.map((l) => JSON.parse(l))) === 'committed' && JSON.parse(lines2[lines2.length - 1]!).msg === 'first-manager.done');
    let refused: unknown;
    try { await runnerMain(['--action=first-manager-create', `--confirm=${FIRST_MANAGER_CREATE_CONFIRMATION.production}`, '--execute'], { PRODUCTION_DB_URL: url(RECORDED_PROJECT_REFS.production) }, () => { throw new Error('must not connect'); }); } catch (e) { refused = e; }
    check('without --target nothing connects, even with --execute and a production URL in the environment', refused instanceof RunnerRefusal && refused.id === 'bootstrap_target_required');
  }

  // ---- wrapper (scripts/run-with-secrets.mjs): enumerations equal the sources; real events pass with nothing withheld
  const w = await import(pathToFileURL(resolve(REPOSITORY_ROOT, 'scripts/run-with-secrets.mjs')).href);
  const sorted = (a: readonly string[]) => [...a].sort();
  check('wrapper: check ids, states and actions equal the sources', JSON.stringify(sorted(w.FIRST_MANAGER_CHECK_IDS)) === JSON.stringify(sorted(FIRST_MANAGER_CHECK_IDS)) && JSON.stringify(sorted(w.FIRST_MANAGER_STATES)) === JSON.stringify(sorted(FIRST_MANAGER_STATES)) && JSON.stringify(sorted(w.FIRST_MANAGER_ACTIONS)) === JSON.stringify(sorted(FIRST_MANAGER_ACTIONS)));
  check('wrapper: refusal identifiers and driver codes equal the runner lists', JSON.stringify(sorted(w.REFUSAL_IDS)) === JSON.stringify(sorted(REFUSAL_IDS)) && JSON.stringify(sorted(w.DRIVER_CODES)) === JSON.stringify(sorted(DRIVER_CODES)));
  check('wrapper: PRODUCTION_DB_URL is a prompt-only secret', w.ALLOWED.includes('PRODUCTION_DB_URL') && w.PROMPT_ONLY.includes('PRODUCTION_DB_URL') && !w.PROMPT_ONLY.includes('STAGING_DB_URL'));
  {
    const all: Array<Record<string, unknown>> = [];
    for (const [roster, fault] of [[EMPTY, {}], [PRISTINE_GUEST, {}], [{ ...EMPTY, managers: 1 }, {}], [EMPTY, { breakPost: true }], [EMPTY, { commitFails: true }]] as const) {
      for (const plan of [create(), planProd({ action: 'first-manager-check', confirm: FIRST_MANAGER_CHECK_CONFIRMATION })]) {
        const { events } = await run(plan, fakeClient(READY_SCHEMA, roster, fault));
        all.push(...events);
      }
    }
    all.push({ msg: 'first-manager.verified', action: 'first-manager-create', target: 'production' }, { msg: 'first-manager.plan_only', hint: 'add --execute to run' }, { msg: 'first-manager.done', action: 'first-manager-create', target: 'staging' });
    for (const id of REFUSAL_IDS) all.push({ msg: 'first-manager.refused', refusal: id, err_code: '40001' });
    const counter = { fields: 0 };
    const shown = all.map((e) => w.allowListLine(JSON.stringify(e), counter));
    check(`wrapper: all ${all.length} real and synthetic first-manager events pass the allow-list with no field withheld`, shown.every((s: unknown) => s !== null) && counter.fields === 0);
    const bad = { fields: 0 };
    const out = JSON.parse(w.allowListLine(JSON.stringify({ msg: 'first-manager.state', target: 'production', state: 'ready_to_create', schema_ready: true, profiles_total: 0, managers: 0, address_profiles: 0, bootstrap_events: 0, email: 'x@y.z' }), bad));
    check('wrapper: an unexpected key (an address) in a first-manager event is dropped and counted', bad.fields === 1 && !('email' in out));
    const bad2 = { fields: 0 };
    const out2 = JSON.parse(w.allowListLine(JSON.stringify({ msg: 'first-manager.check', phase: 'before', check: 'hunter@twistednail.com', ok: true }), bad2));
    check('wrapper: a check name outside the enumerated list is withheld', out2.check === '<withheld>' && bad2.fields === 1);
  }

  console.log(`first-manager bootstrap offline tests: ${passed} passed`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
