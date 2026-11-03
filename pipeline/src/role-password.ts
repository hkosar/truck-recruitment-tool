import pg from 'pg';
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { RunnerRefusal } from './refusals.js';
import { requireRecordedRebuiltRef, type RebuiltSqlClient } from './staging-rebuilt.js';
import { roleOf } from './retention-step.js';
import { RECORDED_PROJECT_REFS, parseSupabaseDbTarget, type SupabaseDbTarget } from './target-guard.js';

/**
 * LOGIN password setup for the two application roles of the REBUILT staging project (runbook 6a-11 v2 section 5, proposed 6b).
 *
 * The plain password never reaches the server. It is read from one fixed environment variable (supplied through
 * scripts/run-with-secrets.mjs --from-env), a PostgreSQL SCRAM-SHA-256 verifier is computed here with Node crypto (RFC 5802 /
 * RFC 7677; PostgreSQL's stored form SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>), and only the verifier is sent.
 *
 * The verifier travels as a bind PARAMETER of `select set_config('bb_rolepw.verifier', $1, true)` (transaction-local), and a constant
 * DO block builds
 *
 *   ALTER ROLE <fixed role> LOGIN PASSWORD '<verifier>'
 *
 * server-side with format('%L') and EXECUTE. The statement text the client sends, pg_stat_statements (default top-level tracking) and
 * the server error log's STATEMENT line therefore hold only a placeholder or constant text. The DO block's exception handlers
 * (query_canceled separately, because `when others` does not catch it) re-raise with the same SQLSTATE and a fixed message, so the
 * CONTEXT line that would quote the dynamic ALTER is never written.
 * Residual exposure that a non-superuser session cannot switch off: log_statement='all' or pgaudit (they log bound parameters);
 * pg_stat_statements.track='all' (this module REFUSES to run then); a FATAL termination of the session while the ALTER runs (its
 * CONTEXT would quote the statement).
 *
 * One transaction with a statement and a lock timeout (a stricter timeout already in force is kept) and a client-side query timeout.
 * The role name comes from a fixed two-entry table, never from input. The verifier is itself sensitive: it is never printed, returned
 * in an event or put in an error. Nothing here reads the environment (the caller passes the value in) or touches anything other than
 * the one role's LOGIN attribute and password.
 * The password must come from the URL-safe set A-Z a-z 0-9 _ - (so it can go into a connection URL without percent-encoding), 32 to
 * 128 characters, at least 12 distinct; generate it randomly, e.g.
 *   node -e "console.log(require('crypto').randomBytes(36).toString('base64url'))"
 * SASLprep leaves such ASCII unchanged, so no normalisation has to be reimplemented.
 *
 * The database change and the later storage of the connection address are not atomic: after any `unknown` or `rollback_not_confirmed`
 * result (including Ctrl-C or a network loss during COMMIT) the caller STOPS and reads the role state; a repeated ALTER is harmless
 * only because it just replaces the verifier, but the stored secret must then be the password that matches the LAST successful run.
 */

export const ROLE_PASSWORD_ACTIONS = {
  'set-app-password': { role: 'recruiter_app', passwordVariable: 'STAGING_APP_DB_PASSWORD', confirmation: 'SET TNBS STAGING APP LOGIN PASSWORD' },
  'set-maintenance-password': { role: 'recruiter_maintenance', passwordVariable: 'STAGING_MAINT_DB_PASSWORD', confirmation: 'SET TNBS STAGING MAINTENANCE LOGIN PASSWORD' },
} as const;
export type RolePasswordAction = keyof typeof ROLE_PASSWORD_ACTIONS;
export const ROLE_PASSWORD_ACTION_IDS: readonly string[] = Object.keys(ROLE_PASSWORD_ACTIONS);
export const ROLE_PASSWORD_ROLES: readonly string[] = Object.values(ROLE_PASSWORD_ACTIONS).map((a) => a.role);
export const ROLE_PASSWORD_VARIABLES: readonly string[] = Object.values(ROLE_PASSWORD_ACTIONS).map((a) => a.passwordVariable);
export const ROLE_PASSWORD_MIN_LENGTH = 32;
export const ROLE_PASSWORD_MAX_LENGTH = 128;
export const SCRAM_ITERATIONS = 4096; // PostgreSQL's scram_iterations default (and the value libpq's PQencryptPasswordConn uses)
export const SCRAM_SALT_BYTES = 16;
export const STATEMENT_TIMEOUT_MS = 30_000;
export const LOCK_TIMEOUT_MS = 10_000;
export const CLIENT_QUERY_TIMEOUT_MS = 45_000; // client side, above the server's statement timeout, so a silent network failure cannot wait forever
export const STATEMENT_TIMEOUT_SQL = "set local statement_timeout = '30s'";
export const LOCK_TIMEOUT_SQL = "set local lock_timeout = '10s'";
export const SETTINGS_SQL = "select name, setting from pg_settings where name in ('statement_timeout', 'lock_timeout', 'pg_stat_statements.track', 'pg_stat_statements.track_utility')";
export const VERIFIER_GUC = 'bb_rolepw.verifier';
export const SET_VERIFIER_SQL = `select set_config('${VERIFIER_GUC}', $1, true)`;
export const ROLE_PASSWORD_RESULTS = ['committed', 'rolled_back', 'rollback_not_confirmed', 'unknown'] as const;

const VERIFIER_SHAPE = /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/;
const ROLE_SHAPE = /^[a-z_]{1,30}$/;

/** PostgreSQL SCRAM verifier (src/common/scram-common.c scram_build_secret). `salt` is for tests only. */
export function scramSha256Verifier(password: string, salt: Buffer = randomBytes(SCRAM_SALT_BYTES), iterations: number = SCRAM_ITERATIONS): string {
  const salted = pbkdf2Sync(Buffer.from(password, 'utf8'), salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

/** The password rule: URL-safe characters A-Za-z0-9_-, 32 to 128, at least 12 distinct. Returns a reason word, never the value. */
export function passwordProblem(password: string | undefined): string | null {
  if (password === undefined || password === '') return 'missing';
  if (password.length < ROLE_PASSWORD_MIN_LENGTH) return 'too_short';
  if (password.length > ROLE_PASSWORD_MAX_LENGTH) return 'too_long';
  if (!/^[A-Za-z0-9_-]+$/.test(password)) return 'not_url_safe';
  if (new Set(password).size < 12) return 'too_repetitive';
  return null;
}

export interface RolePasswordPlan {
  action: RolePasswordAction;
  role: string;
  target: SupabaseDbTarget;
  /** Sensitive: never print, log or return. */
  verifier: string;
}

/** Pure, offline verification (no connection). `recordedRebuiltRef` and `salt` are for tests only. */
export function planRolePassword(input: {
  action: string;
  dbUrl: string | undefined;
  confirm: string | undefined;
  password: string | undefined;
  out?: string | undefined;
  recordedRebuiltRef?: string | null;
  salt?: Buffer;
}): RolePasswordPlan {
  if (!Object.prototype.hasOwnProperty.call(ROLE_PASSWORD_ACTIONS, input.action)) {
    throw new RunnerRefusal('unknown_action', 'Unknown role-password action');
  }
  const action = input.action as RolePasswordAction;
  const spec = ROLE_PASSWORD_ACTIONS[action];
  const rebuiltRef = requireRecordedRebuiltRef(input.recordedRebuiltRef);
  if (!input.dbUrl) throw new RunnerRefusal('db_url_required', 'STAGING_DB_URL is required');
  const target = parseSupabaseDbTarget(input.dbUrl);
  if (target.projectRef === RECORDED_PROJECT_REFS.production) {
    throw new RunnerRefusal('production_refused', 'Staging SQL runner refuses the production Carrier Recruiter project');
  }
  if (target.projectRef !== rebuiltRef) {
    throw new RunnerRefusal('target_not_recorded_staging', 'Staging SQL runner only targets the recorded rebuilt staging project');
  }
  if (target.port !== 5432) {
    throw new RunnerRefusal('port_must_be_5432', 'Staging SQL runner requires a session connection on port 5432 (not the 6543 transaction pooler)');
  }
  if (input.out !== undefined) throw new RunnerRefusal('role_password_refused', '--out is not supported for the role-password actions');
  if (input.confirm !== spec.confirmation) {
    throw new RunnerRefusal('confirmation_required', `Staging SQL runner requires --confirm="${spec.confirmation}" for ${action}`);
  }
  // The runner login must be the privileged one: never one of the two application logins (their own password is what changes).
  if (ROLE_PASSWORD_ROLES.includes(roleOf(target.user))) {
    throw new RunnerRefusal('role_password_refused', 'role password setup must connect as the privileged runner login, not as an application role');
  }
  if (passwordProblem(input.password) !== null) {
    throw new RunnerRefusal('role_password_refused', `${spec.passwordVariable} is missing or does not meet the password rule (${ROLE_PASSWORD_MIN_LENGTH}-${ROLE_PASSWORD_MAX_LENGTH} random characters from A-Z a-z 0-9 _ -)`);
  }
  const verifier = scramSha256Verifier(input.password as string, input.salt);
  if (!VERIFIER_SHAPE.test(verifier) || !ROLE_SHAPE.test(spec.role)) throw new RunnerRefusal('role_password_refused', 'internal check failed before any connection');
  return { action, role: spec.role, target, verifier };
}

/** Everything except LOGIN and the password that the statement must leave unchanged (pg_roles has no password column). */
const ROLE_FACTS_SQL = `select rolcanlogin, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls, rolconnlimit,
  rolvaliduntil is not null as has_valid_until, coalesce(rolvaliduntil <= now(), false) as expired, coalesce(rolconfig::text, '') as config, (select count(*)::int from pg_roles where rolname = $1) as matches
  from pg_roles where rolname = $1`;

type RoleFacts = Record<string, unknown>;
const stable = (f: RoleFacts): string => JSON.stringify({ ...f, rolcanlogin: undefined });

/** The only thing this module prints: one fixed result event whose two fields are checked against fixed lists. */
const resultEvent = (role: string, result: string): void => {
  if (!ROLE_PASSWORD_ROLES.includes(role) || !(ROLE_PASSWORD_RESULTS as readonly string[]).includes(result)) throw new RunnerRefusal('role_password_refused', 'internal check failed before any output');
  console.log(JSON.stringify({ msg: 'staging-sql.role_password_result', role, result }));
};

/** The ALTER is built server-side from the bound verifier; the handlers re-raise with the same SQLSTATE and a fixed message (no CONTEXT quoting the statement). */
export const doAlterSql = (role: string): string => `do $$ begin execute format('alter role ${role} login password %L', current_setting('${VERIFIER_GUC}')); `
  + "exception when query_canceled then raise exception using errcode = 'query_canceled', message = 'role password statement failed'; "
  + "when others then raise exception using errcode = sqlstate, message = 'role password statement failed'; end $$";

/**
 * One transaction: timeouts (stricter existing ones kept), the role must exist exactly once, not be a superuser and not have an expired
 * VALID UNTIL, the verifier is bound to a transaction-local setting, a constant DO block runs the ALTER ROLE ... LOGIN PASSWORD,
 * then LOGIN must be on and every other attribute unchanged before COMMIT. Any refusal or error rolls back. A failed COMMIT is
 * `unknown` (the caller STOPS). One fixed result event; nothing sensitive is printed.
 */
export async function runRolePassword(client: RebuiltSqlClient, plan: RolePasswordPlan): Promise<void> {
  if (!ROLE_SHAPE.test(plan.role) || !ROLE_PASSWORD_ROLES.includes(plan.role) || !VERIFIER_SHAPE.test(plan.verifier)) {
    throw new RunnerRefusal('role_password_refused', 'internal check failed before any statement');
  }
  await client.query('begin');
  let committing = false;
  try {
    // Keep a stricter timeout that is already in force (0 means none); otherwise set ours for this transaction only.
    const settings = new Map(((await client.query(SETTINGS_SQL)).rows as { name: string; setting: string }[]).map((r) => [r.name, r.setting]));
    const needsOurs = (name: string, limitMs: number): boolean => { const ms = Number(settings.get(name)); return !(Number.isFinite(ms) && ms > 0 && ms <= limitMs); };
    if (needsOurs('statement_timeout', STATEMENT_TIMEOUT_MS)) await client.query(STATEMENT_TIMEOUT_SQL);
    if (needsOurs('lock_timeout', LOCK_TIMEOUT_MS)) await client.query(LOCK_TIMEOUT_SQL);
    if (settings.get('pg_stat_statements.track') === 'all' && settings.get('pg_stat_statements.track_utility') !== 'off') {
      throw new RunnerRefusal('role_password_refused', 'pg_stat_statements.track is "all" with track_utility on, which would record the nested role statement; refusing; nothing changed');
    }
    const before = (await client.query(ROLE_FACTS_SQL, [plan.role])).rows as RoleFacts[];
    if (before.length !== 1 || before[0]!.matches !== 1) throw new RunnerRefusal('role_password_refused', 'the role does not exist exactly once; nothing changed');
    if (before[0]!.rolsuper !== false) throw new RunnerRefusal('role_password_refused', 'the role is not an ordinary login role; refusing; nothing changed');
    if (before[0]!.expired === true) throw new RunnerRefusal('role_password_refused', 'the role has an expired VALID UNTIL, so it could not log in; refusing; nothing changed');
    // ALTER ROLE accepts no bind parameter: the verifier is bound to set_config and a constant DO block builds the statement server-side.
    await client.query(SET_VERIFIER_SQL, [plan.verifier]);
    await client.query(doAlterSql(plan.role));
    const after = (await client.query(ROLE_FACTS_SQL, [plan.role])).rows as RoleFacts[];
    if (after.length !== 1 || after[0]!.rolcanlogin !== true) throw new RunnerRefusal('role_password_refused', 'the role cannot log in after the change; rolled back');
    if (stable(after[0]!) !== stable(before[0]!)) throw new RunnerRefusal('role_password_refused', 'another role attribute changed; rolled back');
    committing = true;
    await client.query('commit');
  } catch (err) {
    if (committing) {
      resultEvent(plan.role, 'unknown');
      throw err;
    }
    let acknowledged = true;
    await client.query('rollback').catch(() => { acknowledged = false; });
    resultEvent(plan.role, acknowledged ? 'rolled_back' : 'rollback_not_confirmed');
    throw err;
  }
  resultEvent(plan.role, 'committed');
}

/** Client options (exported for the test): connect and query limits on the client side as well as the server's, and TCP keep-alive. */
export const rolePasswordClientOptions = (target: SupabaseDbTarget) => ({
  host: target.host,
  port: target.port,
  user: target.user,
  password: target.password,
  database: target.database,
  // Same relaxed pooler TLS setting as the other runner actions (see db.ts TODO(live-db)).
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10_000,
  query_timeout: CLIENT_QUERY_TIMEOUT_MS,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
});

const defaultClientFactory = (target: SupabaseDbTarget): RebuiltSqlClient => new pg.Client(rolePasswordClientOptions(target));

/** Connects as the runner login (nothing is sent before the plan is verified) and runs the one transaction. */
export async function executeRolePassword(plan: RolePasswordPlan, clientFactory: (target: SupabaseDbTarget) => RebuiltSqlClient = defaultClientFactory): Promise<void> {
  const client = clientFactory(plan.target);
  client.on?.('error', () => undefined); // the query in flight (or the next one) rejects and is reported as server_or_driver_error
  await client.connect();
  try {
    await runRolePassword(client, plan);
  } finally {
    await client.end().catch(() => undefined);
  }
}
