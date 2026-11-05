import { isDbSecurityFailure } from './db-tls.js';

/**
 * Fixed identifiers for everything the staging SQL runner itself refuses, and the only way a failure reaches the
 * owner's screen (via scripts/run-with-secrets.mjs, which keeps its own copy of REFUSAL_IDS; a contract test keeps the
 * two lists equal). A failure is reported as
 *   - one of these identifiers when the runner raised it itself (RunnerRefusal), or when the database raised one of
 *     the six complete, known re-apply refusal messages (matched whole, never by prefix), and
 *   - otherwise only the generic identifier `server_or_driver_error` plus a 5-character SQLSTATE (server-chosen characters, shape
 *     checked) or one of the enumerated DRIVER_CODES, plus, for P0001 only, a fixed `m1_check` id when the message is
 *     exactly one of M1's own check texts (M1_CHECKS). No part of any other message, however it starts, is ever forwarded.
 */
export const REFUSAL_IDS = [
  'plan_refused',
  'ref_not_recorded',
  'ref_invalid',
  'db_url_required',
  'production_refused',
  'target_not_recorded_staging',
  'port_must_be_5432',
  'confirmation_required',
  'unknown_action',
  'unknown_argument',
  'bad_project_option',
  'ledger_preflight_failed',
  'profiles_already_exist',
  'ledger_not_empty',
  'ledger_not_exact',
  'm1c_state_unrecognised',
  'm1c_postcondition_failed',
  'retention_dry_run_failed',
  'role_matrix_failed',
  'role_matrix_result_missing',
  'batch_delete_definition_mismatch',
  'retention_run_refused',
  'retire_backends_not_gone',
  'retire_checks_failed',
  'retire_privileges_missing',
  'identity_alignment_failed',
  'identity_alignment_result_missing',
  'backout_window_not_expected',
  'reapply_m1_not_backed_out',
  'reapply_m1_still_applied',
  'reapply_m1b_not_backed_out',
  'reapply_m1b_still_applied',
  'reapply_m1c_not_backed_out',
  'reapply_m1c_still_applied',
  'owner_email_invalid',
  'owner_password_too_short',
  'owner_auth_not_created',
  'owner_auth_unknown_result',
  'owner_promotion_refused',
  'role_password_refused',
  'role_password_logging_refused',
  'role_password_expiry_refused',
  'role_password_server_version_unverified',
  'owner_bootstrap_target_refused',
  'bootstrap_target_required',
  'target_not_recorded_production',
  'first_manager_refused',
  'prod_sql_target_refused',
  'prod_sql_action_not_built',
  'prod_sql_action_do_not_use',
  'prod_sql_file_unreadable',
  'prod_sql_hash_mismatch',
  'prod_sql_shape_refused',
  'prod_sql_commit_rolled_back',
  'prod_sql_l1_shape_not_ok',
  'prod_sql_flag_not_expected',
  'prod_sql_l1_stop_table_populated',
  'prod_sql_l1_stop_table_lock_failed',
  'prod_sql_l1_statement_timeout',
  'db_tls_refused',
  'staging2_pooler_required',
  'server_or_driver_error',
] as const;
export type RefusalId = (typeof REFUSAL_IDS)[number];

export class RunnerRefusal extends Error {
  constructor(readonly id: RefusalId, message: string) {
    super(message);
    this.name = 'RunnerRefusal';
  }
}

/** The complete messages the re-apply prechecks (reapply.ts REAPPLY_PRECHECKS) raise inside the database. */
export const KNOWN_SERVER_REFUSALS: Readonly<Record<string, RefusalId>> = {
  're-apply M1 refused: the retained sign-in tables are missing (this is not a backed-out database); use the plain apply action': 'reapply_m1_not_backed_out',
  're-apply M1 refused: M1 is still applied (public.team_list exists); run the backouts first': 'reapply_m1_still_applied',
  're-apply M1b refused: the retained table is missing (this is not a backed-out database); use the plain apply action': 'reapply_m1b_not_backed_out',
  're-apply M1b refused: M1b is still applied; run its backout first': 'reapply_m1b_still_applied',
  're-apply M1c refused: the retained audit table is missing (this is not a backed-out database); use the plain apply action': 'reapply_m1c_not_backed_out',
  're-apply M1c refused: M1c is still applied; run its backout first': 'reapply_m1c_still_applied',
};

/**
 * M1's own fixed checks (supabase/pending/M1_same_origin_signin.sql), as short ids (TRUCKRECRU-127). A P0001 failure whose
 * message is exactly one of these texts gets `m1_check: <id>` next to `err_code`; the message itself is never forwarded.
 * `raise` is the literal as written in the M1 file; its one `%` (if any) may only be filled by `arg`: a PostGIS schema name
 * (lower-case identifier), a list of the seven app PostGIS routine names joined by ", ", or one exact inner text that M1
 * itself raises and the self-check re-raises. A contract test (src/m1-check-ids.test.ts) fails if M1 gains, loses or
 * changes a raise text without this table being updated. Keep the ids equal to M1_CHECK_IDS in scripts/run-with-secrets.mjs.
 */
export const M1_CHECKS: ReadonlyArray<{ id: string; raise: string; arg?: 'schema' | 'routines' | { inner: string } }> = [
  { id: 'm1_runner_global_default_privileges', raise: 'M1: the runner has database-wide default privileges for anon/authenticated/PUBLIC on tables or sequences; refusing' },
  { id: 'm1_postgis_extension_not_unique', raise: 'M1: expected exactly one extension (PostGIS) owning st_x' },
  { id: 'm1_postgis_schema_writable', raise: 'M1: PostGIS schema % is writable by an app role; refusing to trust it', arg: 'schema' },
  { id: 'm1_postgis_schema_usage_no_grant_option', raise: 'M1: the runner cannot pass on USAGE on PostGIS schema % to recruiter_api (it needs USAGE WITH GRANT OPTION on that schema)', arg: 'schema' },
  { id: 'm1_postgis_execute_no_grant_option', raise: 'M1: the runner cannot pass on EXECUTE on PostGIS routine(s) % to recruiter_api (it needs EXECUTE WITH GRANT OPTION, or PUBLIC must keep EXECUTE)', arg: 'routines' },
  { id: 'm1_postgis_not_callable', raise: 'M1: recruiter_api cannot run the PostGIS functions the app uses' },
  { id: 'm1_postgis_self_check_no_extension', raise: 'M1: PostGIS self-check: no extension owns st_x' },
  { id: 'm1_postgis_self_check_set_option_kept', raise: 'M1: PostGIS self-check as recruiter_api failed: %', arg: { inner: 'the runner still holds the recruiter_api SET option the self-check granted itself' } },
  { id: 'm1_postgis_self_check_membership_kept', raise: 'M1: PostGIS self-check as recruiter_api failed: %', arg: { inner: 'the runner still holds the recruiter_api membership the self-check granted itself' } },
];
const M1_ROUTINE = '(?:st_x|st_y|st_dwithin|st_makepoint|st_setsrid|st_makeline|st_distance)';
const M1_ARG = { schema: '[a-z_][a-z0-9_]{0,62}', routines: `${M1_ROUTINE}(?:, ${M1_ROUTINE}){0,6}` } as const;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const M1_CHECK_PATTERNS: ReadonlyArray<{ id: string; re: RegExp }> = M1_CHECKS.map(({ id, raise, arg }) => {
  const [head, tail = ''] = raise.split('%');
  const fill = arg === undefined ? '' : typeof arg === 'string' ? M1_ARG[arg] : escapeRe(arg.inner);
  return { id, re: new RegExp(`^${escapeRe(head!)}${arg === undefined ? '' : fill + escapeRe(tail)}$`) };
});
/** The M1 check id for a P0001 message, or undefined. Whole-message match only; nothing of the message is returned. */
export function m1CheckId(message: string): string | undefined {
  return M1_CHECK_PATTERNS.find(({ re }) => re.test(message))?.id;
}

/** The only non-SQLSTATE codes ever forwarded: Node/driver network error codes. Keep equal to DRIVER_CODES in scripts/run-with-secrets.mjs (a test compares them). */
export const DRIVER_CODES = ['ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EADDRNOTAVAIL'] as const;
/** A SQLSTATE is five characters chosen by the server (the shape is checked, the characters are not an enumerated list). */
const SQLSTATE = /^[0-9A-Z]{5}$/;
const isForwardableCode = (code: string): boolean => SQLSTATE.test(code) || (DRIVER_CODES as readonly string[]).includes(code);

/** What may be printed about any failure: an identifier and, for a database/driver failure, a validated code. */
export function classifyRunnerFailure(err: unknown): { refusal: RefusalId; err_code?: string; m1_check?: string } {
  if (err instanceof RunnerRefusal) return { refusal: err.id };
  // No pinned root, a TLS verification failure, or a cleartext/MD5/unfinished-SCRAM request (db-tls.ts): one fixed reason.
  if (isDbSecurityFailure(err)) return { refusal: 'db_tls_refused' };
  const known = err instanceof Error && Object.prototype.hasOwnProperty.call(KNOWN_SERVER_REFUSALS, err.message) ? KNOWN_SERVER_REFUSALS[err.message] : undefined;
  if (known) return { refusal: known };
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  const m1Check = code === 'P0001' && err instanceof Error && typeof err.message === 'string' ? m1CheckId(err.message) : undefined;
  if (m1Check !== undefined) return { refusal: 'server_or_driver_error', err_code: 'P0001', m1_check: m1Check };
  return typeof code === 'string' && isForwardableCode(code) ? { refusal: 'server_or_driver_error', err_code: code } : { refusal: 'server_or_driver_error' };
}

/** Runs a pure planning step; any failure that is not already a RunnerRefusal becomes `plan_refused` (its message is kept off the screen). */
export function asPlanRefusal<T>(plan: () => T): T {
  try {
    return plan();
  } catch (err) {
    if (err instanceof RunnerRefusal) throw err;
    throw new RunnerRefusal('plan_refused', err instanceof Error ? err.message : String(err));
  }
}
