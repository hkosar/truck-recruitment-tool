import { RunnerRefusal } from './refusals.js';
import type { RebuiltSqlClient } from './staging-rebuilt.js';

/**
 * Owner login bootstrap for the REBUILT staging project (doc 16 approval 4, G1, Codex "option 1").
 *
 * The reset (supabase/staging/reset-fictional-data.sql) needs exactly one auth account that has a password and one
 * approved manager profile for the owner, but nothing there proves they are the SAME account. This builds that
 * account in two separate, individually reviewed commits and never retries or cleans up on its own:
 *
 *   1. owner-auth-create: the supported Supabase Auth Admin create-user call (email confirmed; no invitation or other
 *      message is sent) for exactly APPROVED_OWNER_EMAIL, at the base address derived from the recorded rebuilt ref.
 *      The existing auth trigger then creates that user's pending guest profile.
 *   2. owner-promote: one database transaction that locks the exact auth user and its profile, requires every check in
 *      assessOwnerPromotion(), changes only that profile's role/status/approval fields, and requires every joined
 *      postcondition before it commits. The privileged column change uses the reviewed transaction-local service-role
 *      claim (profile-fixtures.sql; 20260723004500_profile_service_bootstrap.sql: auth.role() reads the JWT claim, not
 *      the SQL role).
 *
 * The two commits are not atomic. Any failure or unknown result STOPS: run owner-login-check (read-only) and let the
 * manager decide. Nothing here deletes an account or creates a second one.
 */

export const APPROVED_OWNER_EMAIL = 'hunter@twistednail.com';
export const OWNER_AUTH_CREATE_ACTION = 'owner-auth-create';
export const OWNER_AUTH_CREATE_CONFIRMATION = 'CREATE TNBS STAGING OWNER LOGIN';
export const OWNER_CHECK_CONFIRMATION = 'RUN TNBS OWNER LOGIN CHECK';
export const OWNER_PROMOTE_CONFIRMATION = 'PROMOTE TNBS STAGING OWNER';
export const OWNER_PASSWORD_MIN_LENGTH = 16;
/** The fixture identities profile-fixtures.sql creates (explicit auth metadata and the reserved domain). */
export const FIXTURE_RUN_ID = 'stg-db-20260723-0042';
export const FIXTURE_EMAIL_SUFFIX = '@tnbs-recruiter.example.invalid';
export const EXPECTED_FIXTURE_PROFILES = 7;
const AUTH_TIMEOUT_MS = 30_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ---------------------------------------------------------------------------------------------------------------
// Step 1: Auth Admin create-user
// ---------------------------------------------------------------------------------------------------------------

export interface OwnerAuthCreatePlan {
  /** https://<recorded rebuilt ref>.supabase.co -- always derived from the recorded ref, never from input. */
  baseUrl: string;
  email: string;
  password: string;
  serviceRoleKey: string;
}

export type OwnerAuthResult = 'created' | 'not_created' | 'unknown';
export interface OwnerAuthOutcome { result: OwnerAuthResult; httpStatus: number; emailMatches: boolean; idPresent: boolean }

/** Pure, offline verification. `ref` is the already-verified recorded rebuilt ref (staging-rebuilt.ts requireRecordedRebuiltRef). */
export function planOwnerAuthCreate(input: { ref: string; confirm: string | undefined; serviceRoleKey: string | undefined; password: string | undefined }): OwnerAuthCreatePlan {
  if (input.confirm !== OWNER_AUTH_CREATE_CONFIRMATION) {
    throw new RunnerRefusal('confirmation_required', `Staging SQL runner requires --confirm="${OWNER_AUTH_CREATE_CONFIRMATION}" for ${OWNER_AUTH_CREATE_ACTION}`);
  }
  if (!input.serviceRoleKey || /\s/.test(input.serviceRoleKey) || input.serviceRoleKey.length < 20) {
    throw new RunnerRefusal('plan_refused', 'SUPABASE_SERVICE_ROLE_KEY is required (entered through the hidden prompt)');
  }
  if (!input.password || input.password.length < OWNER_PASSWORD_MIN_LENGTH || input.password !== input.password.trim()) {
    throw new RunnerRefusal('owner_password_too_short', `OWNER_STAGING_PASSWORD must be at least ${OWNER_PASSWORD_MIN_LENGTH} characters without leading or trailing spaces`);
  }
  return { baseUrl: `https://${input.ref}.supabase.co`, email: APPROVED_OWNER_EMAIL, password: input.password, serviceRoleKey: input.serviceRoleKey };
}

export type OwnerFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal; redirect: 'error' }) => Promise<{ status: number; text(): Promise<string> }>;

/**
 * One POST, no retry. 2xx with a body that names the approved email and a UUID = created. A definite client-error
 * rejection = not created (still a STOP: read the state). Anything else, including a lost connection, a timeout, a
 * redirect, a 5xx or a 2xx whose body does not match, is UNKNOWN: the account may exist. The response body is never
 * printed or returned.
 */
export async function createOwnerAuthUser(plan: OwnerAuthCreatePlan, fetchImpl: OwnerFetch = (u, i) => fetch(u, i)): Promise<OwnerAuthOutcome> {
  let status = 0;
  let bodyText = '';
  try {
    const res = await fetchImpl(`${plan.baseUrl}/auth/v1/admin/users`, {
      method: 'POST',
      headers: { apikey: plan.serviceRoleKey, Authorization: `Bearer ${plan.serviceRoleKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: plan.email, password: plan.password, email_confirm: true }),
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
      redirect: 'error',
    });
    status = res.status;
    bodyText = await res.text();
  } catch {
    return { result: 'unknown', httpStatus: status, emailMatches: false, idPresent: false };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(bodyText); } catch { parsed = undefined; }
  const obj = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const emailMatches = typeof obj.email === 'string' && obj.email.toLowerCase() === plan.email;
  const idPresent = typeof obj.id === 'string' && UUID.test(obj.id);
  if (status >= 200 && status < 300) {
    return { result: emailMatches && idPresent ? 'created' : 'unknown', httpStatus: status, emailMatches, idPresent };
  }
  if ([400, 401, 403, 404, 409, 422].includes(status)) return { result: 'not_created', httpStatus: status, emailMatches: false, idPresent: false };
  return { result: 'unknown', httpStatus: status, emailMatches: false, idPresent: false };
}

/** Runs step 1 and prints one fixed event; throws a RunnerRefusal unless the account was created. */
export async function runOwnerAuthCreate(plan: OwnerAuthCreatePlan, fetchImpl?: OwnerFetch): Promise<void> {
  const out = await createOwnerAuthUser(plan, fetchImpl);
  console.log(JSON.stringify({ msg: 'staging-sql.owner_auth_create', result: out.result, http_status: out.httpStatus, email_matches: out.emailMatches, id_present: out.idPresent }));
  if (out.result === 'created') return;
  if (out.result === 'not_created') throw new RunnerRefusal('owner_auth_not_created', 'the Auth Admin API rejected the create request; nothing is known to have been created');
  throw new RunnerRefusal('owner_auth_unknown_result', 'the Auth Admin create result is unknown; run owner-login-check before anything else');
}

// ---------------------------------------------------------------------------------------------------------------
// Step 2 and the read-only check: catalogue facts about the exact owner identity
// ---------------------------------------------------------------------------------------------------------------

export interface OwnerFacts {
  marker_ok: boolean;
  owner_users: number;
  owner_id: string | null;
  owner_has_password: boolean;
  owner_email_confirmed: boolean;
  owner_sso_or_anonymous: boolean;
  password_users: number;
  auth_users_total: number;
  owner_profiles: number;
  owner_profile_email_exact: boolean;
  owner_profile_role: string | null;
  owner_profile_status: string | null;
  owner_profile_approved_by_null: boolean;
  owner_profile_approved_at_null: boolean;
  profiles_total: number;
  fixture_profiles: number;
  other_profiles: number;
  owner_manager_approved: number;
}

// Two statements, because a query that names staging_identity.marker fails to PLAN when the schema does not exist, even in an
// unexecuted branch; a missing marker must be a failed check, not a raw database error.
const MARKER_PRESENT_SQL = "select to_regclass('staging_identity.marker') is not null as present";
const MARKER_SQL = "select count(*) filter (where environment = 'staging' and marker_id = 'a8512f81-fe47-485d-95cd-092c46e4920b'::uuid and project_ref = $1)::int as ok_rows, count(*)::int as all_rows from staging_identity.marker";

/** $1 = approved owner email (lower case). The owner is counted case-insensitively so a duplicate that differs only by case is seen. */
const FACTS_SQL = `with u as (
  select * from auth.users where lower(email) = $1
), me as (
  select * from u where (select count(*) from u) = 1
), p as (
  select * from public.profiles where id = (select id from me)
), fx as (
  select pr.id from public.profiles pr join auth.users au on au.id = pr.id
   where au.raw_user_meta_data->>'test_only' = 'true' and au.raw_user_meta_data->>'test_run_id' = '${FIXTURE_RUN_ID}'
     and au.encrypted_password is null and pr.email like '%${FIXTURE_EMAIL_SUFFIX}' and au.email like '%${FIXTURE_EMAIL_SUFFIX}'
)
select (select count(*) from u)::int as owner_users,
  (select id::text from me) as owner_id,
  coalesce((select encrypted_password is not null and encrypted_password <> '' from me), false) as owner_has_password,
  coalesce((select email_confirmed_at is not null from me), false) as owner_email_confirmed,
  coalesce((select coalesce(is_sso_user, false) or coalesce(is_anonymous, false) from me), true) as owner_sso_or_anonymous,
  (select count(*) from auth.users where encrypted_password is not null)::int as password_users,
  (select count(*) from auth.users)::int as auth_users_total,
  (select count(*) from p)::int as owner_profiles,
  coalesce((select email = (select email from me) from p), false) as owner_profile_email_exact,
  (select role::text from p) as owner_profile_role,
  (select status::text from p) as owner_profile_status,
  coalesce((select approved_by is null from p), false) as owner_profile_approved_by_null,
  coalesce((select approved_at is null from p), false) as owner_profile_approved_at_null,
  (select count(*) from public.profiles)::int as profiles_total,
  (select count(*) from fx)::int as fixture_profiles,
  (select count(*) from public.profiles where id not in (select id from fx) and id is distinct from (select id from me))::int as other_profiles,
  (select count(*) from public.profiles where email = '${APPROVED_OWNER_EMAIL}' and role = 'manager' and status = 'approved')::int as owner_manager_approved`;
const LOCK_USERS_SQL = 'select 1 from auth.users where lower(email) = $1 for update';
const LOCK_PROFILES_SQL = 'select 1 from public.profiles where id in (select id from auth.users where lower(email) = $1) for update';

export async function readOwnerFacts(client: RebuiltSqlClient, ref: string, lock: boolean): Promise<OwnerFacts> {
  if (lock) {
    await client.query(LOCK_USERS_SQL, [APPROVED_OWNER_EMAIL]);
    await client.query(LOCK_PROFILES_SQL, [APPROVED_OWNER_EMAIL]);
  }
  const present = ((await client.query(MARKER_PRESENT_SQL)).rows[0] as { present: boolean }).present === true;
  const marker = present ? ((await client.query(MARKER_SQL, [ref])).rows[0] as { ok_rows: number; all_rows: number }) : { ok_rows: 0, all_rows: 0 };
  const facts = (await client.query(FACTS_SQL, [APPROVED_OWNER_EMAIL])).rows[0] as Omit<OwnerFacts, 'marker_ok'>;
  return { ...facts, marker_ok: marker.ok_rows === 1 && marker.all_rows === 1 };
}

export interface OwnerCheck { check: string; ok: boolean }
export interface OwnerAssessment { ok: boolean; checks: OwnerCheck[] }

const finish = (checks: OwnerCheck[]): OwnerAssessment => ({ ok: checks.every((c) => c.ok), checks });

/** Everything that must hold BEFORE the promotion. A missing fact is a failure, never a pass. */
export function assessOwnerPromotion(f: OwnerFacts): OwnerAssessment {
  return finish([
    { check: 'staging_marker_names_this_project', ok: f.marker_ok === true },
    { check: 'exactly_one_auth_user_with_the_approved_email', ok: f.owner_users === 1 && typeof f.owner_id === 'string' },
    { check: 'owner_has_a_nonempty_password_and_confirmed_email', ok: f.owner_has_password === true && f.owner_email_confirmed === true },
    { check: 'owner_is_not_sso_or_anonymous', ok: f.owner_sso_or_anonymous === false },
    { check: 'the_owner_is_the_only_password_account', ok: f.password_users === 1 },
    { check: 'auth_users_are_the_owner_plus_seven_fixtures', ok: f.auth_users_total === 1 + EXPECTED_FIXTURE_PROFILES },
    { check: 'exactly_one_profile_joined_to_the_owner_auth_user', ok: f.owner_profiles === 1 && f.owner_profile_email_exact === true },
    { check: 'owner_profile_is_still_pristine_pending_guest', ok: f.owner_profile_role === 'guest' && f.owner_profile_status === 'pending' && f.owner_profile_approved_by_null === true && f.owner_profile_approved_at_null === true },
    { check: 'exactly_seven_passwordless_fixture_profiles', ok: f.fixture_profiles === EXPECTED_FIXTURE_PROFILES },
    { check: 'no_other_profiles', ok: f.other_profiles === 0 && f.profiles_total === 1 + EXPECTED_FIXTURE_PROFILES },
    { check: 'no_approved_manager_profile_for_the_owner_yet', ok: f.owner_manager_approved === 0 },
  ]);
}

/** Joined postconditions: the same single account is now the approved manager, and nothing else moved. */
export function assessOwnerPromoted(f: OwnerFacts): OwnerAssessment {
  return finish([
    { check: 'staging_marker_names_this_project', ok: f.marker_ok === true },
    { check: 'exactly_one_auth_user_with_the_approved_email', ok: f.owner_users === 1 && typeof f.owner_id === 'string' },
    { check: 'owner_has_a_nonempty_password_and_confirmed_email', ok: f.owner_has_password === true && f.owner_email_confirmed === true },
    { check: 'the_owner_is_the_only_password_account', ok: f.password_users === 1 },
    { check: 'auth_users_are_the_owner_plus_seven_fixtures', ok: f.auth_users_total === 1 + EXPECTED_FIXTURE_PROFILES },
    { check: 'the_same_account_has_the_approved_manager_profile', ok: f.owner_profiles === 1 && f.owner_profile_email_exact === true && f.owner_profile_role === 'manager' && f.owner_profile_status === 'approved' && f.owner_profile_approved_at_null === false && f.owner_manager_approved === 1 },
    { check: 'exactly_seven_passwordless_fixture_profiles', ok: f.fixture_profiles === EXPECTED_FIXTURE_PROFILES },
    { check: 'no_other_profiles', ok: f.other_profiles === 0 && f.profiles_total === 1 + EXPECTED_FIXTURE_PROFILES },
  ]);
}

export type OwnerState = 'ready_to_promote' | 'promoted' | 'no_owner_login' | 'other';
export function ownerState(f: OwnerFacts): OwnerState {
  if (assessOwnerPromotion(f).ok) return 'ready_to_promote';
  if (assessOwnerPromoted(f).ok) return 'promoted';
  return f.owner_users === 0 ? 'no_owner_login' : 'other';
}

const word = (v: unknown): string => (typeof v === 'string' && /^[a-z_]{1,20}$/.test(v) ? v : 'other');
const count = (v: unknown): number => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : -1);
const line = (o: Record<string, unknown>) => console.log(JSON.stringify(o));

function reportFacts(f: OwnerFacts): void {
  line({
    msg: 'staging-sql.owner_state', state: ownerState(f), marker_ok: f.marker_ok === true,
    owner_auth_users: count(f.owner_users), owner_has_password: f.owner_has_password === true, owner_email_confirmed: f.owner_email_confirmed === true,
    password_users: count(f.password_users), auth_users_total: count(f.auth_users_total),
    owner_profiles: count(f.owner_profiles), owner_profile_role: word(f.owner_profile_role), owner_profile_status: word(f.owner_profile_status),
    fixture_profiles: count(f.fixture_profiles), other_profiles: count(f.other_profiles), owner_manager_approved: count(f.owner_manager_approved),
  });
}
function reportAssessment(phase: 'before' | 'after', a: OwnerAssessment): void {
  for (const c of a.checks) line({ msg: 'staging-sql.owner_check', phase, check: c.check, ok: c.ok });
  line({ msg: 'staging-sql.owner_checks', phase, ok: a.ok, checks: a.checks.length, failed: a.checks.filter((c) => !c.ok).length });
}

/** Read-only (the caller wraps it in begin read only / rollback). Reports; it neither passes nor fails. */
export async function runOwnerLoginCheck(client: RebuiltSqlClient, ref: string): Promise<void> {
  const facts = await readOwnerFacts(client, ref, false);
  reportFacts(facts);
  reportAssessment('before', assessOwnerPromotion(facts));
  reportAssessment('after', assessOwnerPromoted(facts));
}

/**
 * The promotion transaction. Any refusal or error rolls back and leaves the account exactly as it was. If the commit
 * itself fails, the outcome is unknown: an event says so and the caller must STOP and read the state.
 */
export async function runOwnerPromotion(client: RebuiltSqlClient, ref: string): Promise<void> {
  await client.query('begin');
  let committing = false;
  try {
    await client.query("set local lock_timeout = '10s'");
    await client.query("select set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true)");
    const before = await readOwnerFacts(client, ref, true);
    const pre = assessOwnerPromotion(before);
    reportAssessment('before', pre);
    if (!pre.ok) throw new RunnerRefusal('owner_promotion_refused', `owner promotion refused: ${pre.checks.filter((c) => !c.ok).length} check(s) failed; nothing changed`);
    const updated = await client.query(
      "update public.profiles set role = 'manager', status = 'approved', approved_by = id, approved_at = now() where id = $1::uuid and email = (select email from auth.users where id = $1::uuid) and role = 'guest' and status = 'pending' returning id::text",
      [before.owner_id],
    );
    if (updated.rowCount !== 1) throw new RunnerRefusal('owner_promotion_refused', 'owner promotion refused: the update did not change exactly one profile; nothing changed');
    const post = assessOwnerPromoted(await readOwnerFacts(client, ref, false));
    reportAssessment('after', post);
    if (!post.ok) throw new RunnerRefusal('owner_promotion_refused', `owner promotion refused: ${post.checks.filter((c) => !c.ok).length} postcondition(s) failed; rolled back`);
    committing = true;
    await client.query('commit');
  } catch (err) {
    if (committing) {
      // The commit may or may not have happened. Say so; do not try to roll back or repeat anything.
      line({ msg: 'staging-sql.owner_promote_result', result: 'unknown' });
      throw err;
    }
    await client.query('rollback').catch(() => undefined);
    line({ msg: 'staging-sql.owner_promote_result', result: 'rolled_back' });
    throw err;
  }
  line({ msg: 'staging-sql.owner_promote_result', result: 'committed' });
}
