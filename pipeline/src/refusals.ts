/**
 * Fixed identifiers for everything the staging SQL runner itself refuses, and the only way a failure reaches the
 * owner's screen (via scripts/run-with-secrets.mjs, which keeps its own copy of REFUSAL_IDS; a contract test keeps the
 * two lists equal). A failure is reported as
 *   - one of these identifiers when the runner raised it itself (RunnerRefusal), or when the database raised one of
 *     the six complete, known re-apply refusal messages (matched whole, never by prefix), and
 *   - otherwise only the generic identifier `server_or_driver_error` plus a 5-character SQLSTATE (server-chosen characters, shape
 *     checked) or one of the enumerated DRIVER_CODES. No part of any other message, however it starts, is ever forwarded.
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
  'owner_bootstrap_target_refused',
  'bootstrap_target_required',
  'target_not_recorded_production',
  'first_manager_refused',
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

/** The only non-SQLSTATE codes ever forwarded: Node/driver network error codes. Keep equal to DRIVER_CODES in scripts/run-with-secrets.mjs (a test compares them). */
export const DRIVER_CODES = ['ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EADDRNOTAVAIL'] as const;
/** A SQLSTATE is five characters chosen by the server (the shape is checked, the characters are not an enumerated list). */
const SQLSTATE = /^[0-9A-Z]{5}$/;
const isForwardableCode = (code: string): boolean => SQLSTATE.test(code) || (DRIVER_CODES as readonly string[]).includes(code);

/** What may be printed about any failure: an identifier and, for a database/driver failure, a validated code. */
export function classifyRunnerFailure(err: unknown): { refusal: RefusalId; err_code?: string } {
  if (err instanceof RunnerRefusal) return { refusal: err.id };
  const known = err instanceof Error && Object.prototype.hasOwnProperty.call(KNOWN_SERVER_REFUSALS, err.message) ? KNOWN_SERVER_REFUSALS[err.message] : undefined;
  if (known) return { refusal: known };
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
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
