import { createHash } from 'node:crypto';
import { RunnerRefusal } from './refusals.js';
import { APPROVED_OWNER_EMAIL } from './owner-bootstrap.js';
import { requireRecordedRebuiltRef, type RebuiltSqlClient } from './staging-rebuilt.js';
import { RECORDED_PROJECT_REFS, parseSupabaseDbTarget, type SupabaseDbTarget } from './target-guard.js';

/**
 * First-manager bootstrap for the same-origin sign-in (cutover gap OPEN-2; docs/build-plan/18-first-manager-bootstrap.md).
 *
 * After M1 + M1b the sign-in identity IS one public.profiles row: the sign-in link lookup (internal.auth_mint_lock) finds a
 * person by email where status = 'approved' and role is manager/edit/view, and team_add_person (M1b) needs an existing manager
 * session. There is no Auth user, no password and no Auth Admin call. On an empty roster nobody can add anyone, so this
 * module writes exactly ONE row (or promotes exactly one pristine pending-guest row) for the approved owner address.
 *
 * Safety shape (each property is pinned by first-manager-bootstrap.test.ts and scripts/verify-first-manager-contract.mjs):
 *   - the target must be named (--target=staging|production, no default) and must match the one recorded project of that kind;
 *   - the typed confirmation differs per target; without --execute nothing connects (plan only);
 *   - one transaction: roster lock exclusive (I1, as every team operation), profiles share-row-exclusive, every precondition
 *     re-read under those locks, every postcondition checked before COMMIT;
 *   - single use: refused when ANY manager profile exists (any status) or an earlier bootstrap event is recorded;
 *   - the address is a constant in the repository, never input; the email is never printed;
 *   - an unknown commit result is reported as unknown and never retried.
 */

export const FIRST_MANAGER_EMAIL = APPROVED_OWNER_EMAIL;
export const FIRST_MANAGER_NAME = 'Hunter Kosar';
export const FIRST_MANAGER_EVENT_KIND = 'first_manager_bootstrap';

export const FIRST_MANAGER_TARGETS = ['staging', 'production'] as const;
export type FirstManagerTarget = (typeof FIRST_MANAGER_TARGETS)[number];
export const FIRST_MANAGER_ACTIONS = ['first-manager-check', 'first-manager-create'] as const;
export type FirstManagerAction = (typeof FIRST_MANAGER_ACTIONS)[number];

export const FIRST_MANAGER_CHECK_CONFIRMATION = 'RUN TNBS FIRST MANAGER CHECK';
export const FIRST_MANAGER_CREATE_CONFIRMATION: Readonly<Record<FirstManagerTarget, string>> = {
  staging: 'CREATE TNBS STAGING FIRST MANAGER',
  production: 'CREATE TNBS PRODUCTION FIRST MANAGER',
};
/** Which environment variable carries the connection string for each target (a hidden-prompt secret in both cases). */
export const FIRST_MANAGER_DB_URL_VARIABLE: Readonly<Record<FirstManagerTarget, string>> = { staging: 'STAGING_DB_URL', production: 'PRODUCTION_DB_URL' };

export interface FirstManagerPlan {
  action: FirstManagerAction;
  target: FirstManagerTarget;
  db: SupabaseDbTarget;
}

const isTarget = (v: unknown): v is FirstManagerTarget => typeof v === 'string' && (FIRST_MANAGER_TARGETS as readonly string[]).includes(v);
const isAction = (v: unknown): v is FirstManagerAction => typeof v === 'string' && (FIRST_MANAGER_ACTIONS as readonly string[]).includes(v);

/** Pure, offline verification. Throws before anything could connect. The two `recorded*` inputs are for tests only. */
export function planFirstManager(input: {
  target: string | undefined;
  action: string;
  dbUrl: string | undefined;
  confirm: string | undefined;
  recordedStagingRef?: string | null;
  recordedProductionRef?: string;
}): FirstManagerPlan {
  if (!isTarget(input.target)) {
    throw new RunnerRefusal('bootstrap_target_required', 'First-manager bootstrap requires --target=staging or --target=production (there is no default)');
  }
  if (!isAction(input.action)) {
    throw new RunnerRefusal('unknown_action', `Unknown first-manager action "${input.action}" (expected ${FIRST_MANAGER_ACTIONS.join(', ')})`);
  }
  const target = input.target;
  const recordedProduction = input.recordedProductionRef ?? RECORDED_PROJECT_REFS.production;
  // The staging ref is resolved first so an unrecorded staging project refuses even a production-looking request clearly.
  const stagingRef = target === 'staging' ? requireRecordedRebuiltRef(input.recordedStagingRef) : null;
  if (!input.dbUrl) throw new RunnerRefusal('db_url_required', `${FIRST_MANAGER_DB_URL_VARIABLE[target]} is required`);
  const db = parseSupabaseDbTarget(input.dbUrl);
  if (target === 'staging') {
    if (db.projectRef === recordedProduction) throw new RunnerRefusal('production_refused', 'A staging first-manager run refuses the production project');
    if (db.projectRef !== stagingRef) throw new RunnerRefusal('target_not_recorded_staging', 'A staging first-manager run only targets the recorded rebuilt staging project');
  } else if (db.projectRef !== recordedProduction) {
    throw new RunnerRefusal('target_not_recorded_production', 'A production first-manager run only targets the recorded production project');
  }
  if (db.port !== 5432) throw new RunnerRefusal('port_must_be_5432', 'First-manager bootstrap requires a session connection on port 5432 (not the 6543 transaction pooler)');
  const wanted = input.action === 'first-manager-check' ? FIRST_MANAGER_CHECK_CONFIRMATION : FIRST_MANAGER_CREATE_CONFIRMATION[target];
  if (input.confirm !== wanted) {
    throw new RunnerRefusal('confirmation_required', `First-manager bootstrap requires --confirm="${wanted}" for ${input.action} on ${target}`);
  }
  return { action: input.action, target, db };
}

/**
 * Production credential entry. scripts/run-with-secrets.mjs (hidden prompt) puts PRODUCTION_DB_URL in the child's environment AND
 * a proof variable holding this hash of the value it just read from the prompt. A PRODUCTION_DB_URL that was merely sitting in
 * the environment (a profile, a shell, a CI variable) has no matching proof and is refused here, at the executable boundary.
 * (The proof stops accidents; it is not a defence against someone who deliberately forges it.) A test keeps this equal to the wrapper's copy.
 */
export const PRODUCTION_PROMPT_PROOF_VARIABLE = 'TNBS_PROMPT_PROOF_PRODUCTION_DB_URL';
export const promptProof = (value: string): string => createHash('sha256').update(`tnbs-prompt-proof:${value}`).digest('hex');

/** One URL variable per target; the other target's variable must not be present at all (a mixed environment is refused). */
export function selectFirstManagerDbUrl(target: string | undefined, env: Readonly<Record<string, string | undefined>>): string | undefined {
  if (!isTarget(target)) return undefined;
  const other: FirstManagerTarget = target === 'staging' ? 'production' : 'staging';
  if (env[FIRST_MANAGER_DB_URL_VARIABLE[other]]) {
    throw new RunnerRefusal('plan_refused', `${FIRST_MANAGER_DB_URL_VARIABLE[other]} is set although the target is ${target}; refusing a mixed environment`);
  }
  const value = env[FIRST_MANAGER_DB_URL_VARIABLE[target]];
  if (target === 'production' && value && env[PRODUCTION_PROMPT_PROOF_VARIABLE] !== promptProof(value)) {
    throw new RunnerRefusal('plan_refused', 'PRODUCTION_DB_URL is only accepted from the hidden prompt of scripts/run-with-secrets.mjs; a value already present in the environment is refused');
  }
  return value;
}

// ---------------------------------------------------------------------------------------------------------------
// Facts and assessments
// ---------------------------------------------------------------------------------------------------------------

export interface SchemaFacts { m1_tables: boolean; m1_sign_in_functions: boolean; m1b_function: boolean; account_link_present: boolean; roster_lock_rows: number }
export interface RosterFacts {
  profiles_total: number;
  managers: number;
  email_profiles: number;
  email_exact_lower: number;
  email_pristine_guest: number;
  owner_manager_self_approved: number;
  email_blocked: number;
  bootstrap_events: number;
}

const SCHEMA_SQL = `select
  (to_regclass('internal.roster_lock') is not null and to_regclass('internal.auth_events') is not null and to_regclass('internal.blocked_email_addresses') is not null and to_regclass('internal.app_sessions') is not null and to_regclass('internal.signin_links') is not null and to_regclass('public.profiles') is not null) as m1_tables,
  (to_regprocedure('internal.auth_mint_lock(text,timestamptz,timestamptz)') is not null and to_regprocedure('internal.auth_mint_insert(uuid,text,text,uuid)') is not null and to_regprocedure('internal.auth_link_check(text)') is not null and to_regprocedure('internal.auth_link_redeem(text,text)') is not null and to_regprocedure('internal.auth_session_info()') is not null) as m1_sign_in_functions,
  (to_regprocedure('public.team_add_person(text,text,public.user_role,text)') is not null) as m1b_function,
  exists (select 1 from pg_constraint where conname = 'profiles_id_fkey' and conrelid = to_regclass('public.profiles')) as account_link_present`;

/** $1 = the approved address (lower case), $2 = the event kind. */
const ROSTER_SQL = `select
  (select count(*) from public.profiles)::int as profiles_total,
  (select count(*) from public.profiles where role = 'manager')::int as managers,
  (select count(*) from public.profiles where lower(email) = $1)::int as email_profiles,
  (select count(*) from public.profiles where lower(email) = $1 and email = $1)::int as email_exact_lower,
  (select count(*) from public.profiles where lower(email) = $1 and role = 'guest' and status = 'pending' and approved_by is null and approved_at is null)::int as email_pristine_guest,
  (select count(*) from public.profiles where email = $1 and role = 'manager' and status = 'approved' and approved_by = id and approved_at is not null)::int as owner_manager_self_approved,
  (select count(*) from internal.blocked_email_addresses where normalized_email = $1 and cleared_at is null)::int as email_blocked,
  (select count(*) from internal.auth_events where kind = $2)::int as bootstrap_events`;

/** Rows in the roster control table. Only asked when that table exists (the schema query says so first). */
const ROSTER_LOCK_ROWS_SQL = 'select count(*)::int as n from internal.roster_lock';
/** The REAL sign-in lookup, exactly as the Node server calls it (pg-auth-store.ts), with a wide day window. Takes row locks, so it runs only inside the write transaction. */
const SIGN_IN_LOOKUP_SQL = "select user_id::text as user_id from internal.auth_mint_lock($1, now() - interval '1 day', now() + interval '1 day')";

export async function readSchemaFacts(client: RebuiltSqlClient): Promise<SchemaFacts> {
  const facts = (await client.query(SCHEMA_SQL)).rows[0] as SchemaFacts;
  const rows = facts.m1_tables === true ? Number(((await client.query(ROSTER_LOCK_ROWS_SQL)).rows[0] as { n: unknown } | undefined)?.n) : 0;
  return { ...facts, roster_lock_rows: Number.isSafeInteger(rows) ? rows : -1 };
}
/** 1 only when the real lookup returns exactly one row and it is the person just written; otherwise 0. */
export async function readSignInLookup(client: RebuiltSqlClient, userId: string): Promise<number> {
  const rows = (await client.query(SIGN_IN_LOOKUP_SQL, [FIRST_MANAGER_EMAIL])).rows as Array<{ user_id?: unknown }>;
  return rows.length === 1 && rows[0]!.user_id === userId ? 1 : 0;
}
export async function readRosterFacts(client: RebuiltSqlClient): Promise<RosterFacts> {
  return (await client.query(ROSTER_SQL, [FIRST_MANAGER_EMAIL, FIRST_MANAGER_EVENT_KIND])).rows[0] as RosterFacts;
}

export interface FirstManagerCheck { check: string; ok: boolean }
export interface FirstManagerAssessment { ok: boolean; checks: FirstManagerCheck[] }
const finish = (checks: FirstManagerCheck[]): FirstManagerAssessment => ({ ok: checks.every((c) => c.ok), checks });
const is = (v: unknown, n: number): boolean => v === n;

export function schemaReady(s: SchemaFacts | undefined): boolean {
  return s?.m1_tables === true && s.m1_sign_in_functions === true && s.m1b_function === true && s.account_link_present === false && s.roster_lock_rows === 1;
}

/** Everything that must hold BEFORE the write. A missing fact (undefined) is a failure, never a pass. */
export function assessFirstManagerPre(schema: SchemaFacts | undefined, roster: RosterFacts | undefined): FirstManagerAssessment {
  const r = roster;
  return finish([
    { check: 'm1_sign_in_tables_are_installed', ok: schema?.m1_tables === true },
    { check: 'm1_sign_in_functions_are_installed', ok: schema?.m1_sign_in_functions === true },
    { check: 'the_roster_control_row_is_exactly_one', ok: is(schema?.roster_lock_rows, 1) },
    { check: 'm1b_add_person_is_installed', ok: schema?.m1b_function === true },
    { check: 'the_profiles_account_link_is_dropped', ok: schema !== undefined && schema.account_link_present === false },
    { check: 'no_manager_profile_exists_in_any_status', ok: is(r?.managers, 0) },
    { check: 'no_earlier_bootstrap_event_is_recorded', ok: is(r?.bootstrap_events, 0) },
    { check: 'the_owner_address_is_not_blocked', ok: is(r?.email_blocked, 0) },
    { check: 'the_owner_address_is_absent_or_one_pristine_pending_guest', ok: is(r?.email_profiles, 0) || (is(r?.email_profiles, 1) && is(r?.email_pristine_guest, 1) && is(r?.email_exact_lower, 1)) },
  ]);
}

/** Joined postconditions; `before` is the roster read under the same locks; `lookup` is readSignInLookup (the real M1 sign-in lookup). */
export function assessFirstManagerPost(before: RosterFacts, after: RosterFacts | undefined, path: FirstManagerPath, lookup: number | undefined): FirstManagerAssessment {
  const a = after;
  return finish([
    { check: 'exactly_one_manager_profile_exists', ok: is(a?.managers, 1) },
    { check: 'it_is_the_owner_address_approved_by_itself', ok: is(a?.owner_manager_self_approved, 1) && is(a?.email_profiles, 1) },
    { check: 'the_sign_in_lookup_finds_exactly_that_person', ok: is(lookup, 1) },
    { check: 'the_roster_changed_by_exactly_the_expected_count', ok: a !== undefined && a.profiles_total === before.profiles_total + (path === 'insert' ? 1 : 0) },
    { check: 'exactly_one_bootstrap_event_is_recorded', ok: is(a?.bootstrap_events, 1) },
    { check: 'the_owner_address_is_not_blocked', ok: is(a?.email_blocked, 0) },
  ]);
}

/** Every check id any assessment can print (derived, not hand-copied); the output wrapper enumerates exactly these. */
const DUMMY: RosterFacts = { profiles_total: 0, managers: 0, email_profiles: 0, email_exact_lower: 0, email_pristine_guest: 0, owner_manager_self_approved: 0, email_blocked: 0, bootstrap_events: 0 };
export const FIRST_MANAGER_CHECK_IDS: readonly string[] = [...new Set([...assessFirstManagerPre(undefined, undefined).checks, ...assessFirstManagerPost(DUMMY, undefined, 'insert', undefined).checks].map((c) => c.check))];

export type FirstManagerPath = 'insert' | 'promote';
export const FIRST_MANAGER_STATES = ['schema_not_ready', 'manager_exists', 'already_bootstrapped', 'address_blocked', 'address_on_roster', 'ready_to_create', 'ready_to_promote'] as const;
export type FirstManagerState = (typeof FIRST_MANAGER_STATES)[number];

export function firstManagerState(schema: SchemaFacts | undefined, r: RosterFacts | undefined): FirstManagerState {
  if (!schemaReady(schema) || r === undefined) return 'schema_not_ready';
  if (r.managers !== 0) return 'manager_exists';
  if (r.bootstrap_events !== 0) return 'already_bootstrapped';
  if (r.email_blocked !== 0) return 'address_blocked';
  if (r.email_profiles === 0) return 'ready_to_create';
  return assessFirstManagerPre(schema, r).ok ? 'ready_to_promote' : 'address_on_roster';
}

// ---------------------------------------------------------------------------------------------------------------
// Reporting (fixed keys only; counts and enumerated words; never the address, the name or an id)
// ---------------------------------------------------------------------------------------------------------------

const count = (v: unknown): number => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : -1);
const line = (o: Record<string, unknown>) => console.log(JSON.stringify(o));

export function reportFirstManagerState(target: FirstManagerTarget, schema: SchemaFacts | undefined, r: RosterFacts | undefined): void {
  line({
    msg: 'first-manager.state', target, state: firstManagerState(schema, r), schema_ready: schemaReady(schema),
    profiles_total: count(r?.profiles_total), managers: count(r?.managers), address_profiles: count(r?.email_profiles), bootstrap_events: count(r?.bootstrap_events),
  });
}
export function reportFirstManagerAssessment(phase: 'before' | 'after', a: FirstManagerAssessment): void {
  for (const c of a.checks) line({ msg: 'first-manager.check', phase, check: c.check, ok: c.ok });
  line({ msg: 'first-manager.checks', phase, ok: a.ok, checks: a.checks.length, failed: a.checks.filter((c) => !c.ok).length });
}

// ---------------------------------------------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------------------------------------------

/** Read-only (begin read only / rollback). Reports; it neither passes nor fails. */
export async function runFirstManagerCheck(client: RebuiltSqlClient, target: FirstManagerTarget): Promise<void> {
  await client.query('begin read only');
  try {
    const schema = await readSchemaFacts(client);
    const roster = schemaReady(schema) ? await readRosterFacts(client) : undefined;
    reportFirstManagerState(target, schema, roster);
    reportFirstManagerAssessment('before', assessFirstManagerPre(schema, roster));
  } finally {
    await client.query('rollback');
  }
}

const INSERT_SQL = `with n as (select gen_random_uuid() as id)
  insert into public.profiles (id, email, full_name, role, status, approved_by, approved_at)
  select n.id, $1, $2, 'manager', 'approved', n.id, now() from n returning id::text`;
/** The privileged column change passes guard_profile_update through the transaction-local service-role claim, exactly as owner-promote does. */
const PROMOTE_SQL = `update public.profiles set role = 'manager', status = 'approved', approved_by = id, approved_at = now()
  where lower(email) = $1 and email = $1 and role = 'guest' and status = 'pending' and approved_by is null and approved_at is null
    and not exists (select 1 from public.profiles m where m.role = 'manager') returning id::text`;
const EVENT_SQL = 'insert into internal.auth_events (user_id, kind, detail) values ($1::uuid, $2, jsonb_build_object($3::text, $4::text))';

/**
 * The write. Any refusal or error rolls back and leaves the roster exactly as it was. If the commit itself fails the outcome is
 * unknown: an event says so and the caller must STOP, read the state with first-manager-check, and decide. Never retried.
 */
export async function runFirstManagerCreate(client: RebuiltSqlClient, target: FirstManagerTarget): Promise<void> {
  await client.query('begin');
  let committing = false;
  let path: FirstManagerPath = 'insert';
  try {
    await client.query("set local lock_timeout = '10s'");
    await client.query("set local statement_timeout = '60s'");
    const schema = await readSchemaFacts(client);
    if (!schemaReady(schema)) {
      reportFirstManagerAssessment('before', assessFirstManagerPre(schema, undefined));
      throw new RunnerRefusal('first_manager_refused', 'first-manager refused: the M1/M1b schema is not in place; nothing changed');
    }
    // I1 exclusive (every team operation takes it first; sign-in paths take it shared), then I2 (profiles).
    const locked = await client.query('select 1 from internal.roster_lock for update');
    // The unlocked schema read already wanted one row; the locked read is the one that counts. Zero rows would lock nothing.
    if (locked.rowCount !== 1) {
      reportFirstManagerAssessment('before', assessFirstManagerPre({ ...schema, roster_lock_rows: locked.rowCount ?? -1 }, undefined));
      throw new RunnerRefusal('first_manager_refused', 'first-manager refused: the roster control table must hold exactly one row; nothing changed');
    }
    await client.query('lock table public.profiles in share row exclusive mode');
    const before = await readRosterFacts(client);
    const pre = assessFirstManagerPre(schema, before);
    reportFirstManagerState(target, schema, before);
    reportFirstManagerAssessment('before', pre);
    if (!pre.ok) throw new RunnerRefusal('first_manager_refused', `first-manager refused: ${pre.checks.filter((c) => !c.ok).length} check(s) failed; nothing changed`);

    let userId: string | undefined;
    if (before.email_profiles === 0) {
      path = 'insert';
      const inserted = await client.query(INSERT_SQL, [FIRST_MANAGER_EMAIL, FIRST_MANAGER_NAME]);
      userId = inserted.rowCount === 1 ? (inserted.rows[0] as { id: string }).id : undefined;
    } else {
      path = 'promote';
      await client.query("select set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true)");
      const promoted = await client.query(PROMOTE_SQL, [FIRST_MANAGER_EMAIL]);
      userId = promoted.rowCount === 1 ? (promoted.rows[0] as { id: string }).id : undefined;
    }
    if (userId === undefined) throw new RunnerRefusal('first_manager_refused', 'first-manager refused: the write did not change exactly one profile; nothing changed');
    await client.query(EVENT_SQL, [userId, FIRST_MANAGER_EVENT_KIND, 'target', target]);

    const post = assessFirstManagerPost(before, await readRosterFacts(client), path, await readSignInLookup(client, userId));
    reportFirstManagerAssessment('after', post);
    if (!post.ok) throw new RunnerRefusal('first_manager_refused', `first-manager refused: ${post.checks.filter((c) => !c.ok).length} postcondition(s) failed; rolled back`);
    committing = true;
    await client.query('commit');
  } catch (err) {
    if (committing) {
      line({ msg: 'first-manager.result', result: 'unknown', path });
      throw err;
    }
    // 'rolled_back' only when the server acknowledged the ROLLBACK; otherwise no COMMIT was sent and the caller still STOPS and reads the state.
    let acknowledged = true;
    await client.query('rollback').catch(() => { acknowledged = false; });
    line({ msg: 'first-manager.result', result: acknowledged ? 'rolled_back' : 'rollback_not_confirmed', path });
    throw err;
  }
  line({ msg: 'first-manager.result', result: 'committed', path });
}

export async function executeFirstManagerPlan(plan: FirstManagerPlan, clientFactory: (db: SupabaseDbTarget) => RebuiltSqlClient): Promise<void> {
  const client = clientFactory(plan.db);
  await client.connect();
  try {
    if (plan.action === 'first-manager-check') await runFirstManagerCheck(client, plan.target);
    else await runFirstManagerCreate(client, plan.target);
  } finally {
    await client.end();
  }
}
