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
 * Before anything else the transaction sets search_path = pg_catalog, pg_temp (SET LOCAL) and every statement names its pg_catalog objects
 * explicitly, so a look-alike pg_settings, pg_roles, set_config, current_setting or format earlier on the runner's search_path cannot hide
 * a logging setting or receive the verifier. It then sets debug_print_parse, debug_print_rewritten and debug_print_plan to off (SET LOCAL;
 * they are user-settable and would log the parse tree, with the verifier, on every run); a SET LOCAL that is not permitted is an error,
 * so the run rolls back before the verifier is bound. log_lock_waits (superuser-only to change) cannot be switched off: when it is not
 * off, the lock_timeout is set to deadlock_timeout minus 100 ms (a stricter one already in force is kept), so a lock wait is cancelled
 * before the "still waiting" line, whose CONTEXT quotes the statement, can be written; a deadlock_timeout under 200 ms or unreadable is
 * refused.
 * The transaction READS the logging settings and REFUSES (nothing changed) when the bound parameter could be written to the server
 * log: unless log_parameter_max_length = 0, it refuses for log_statement = 'all', log_min_duration_statement other than -1, a
 * log_min_duration_sample other than -1 together with a log_statement_sample_rate above 0, or a log_transaction_sample_rate above 0; it
 * also refuses when log_parameter_max_length_on_error is not 0, when pgaudit.log is anything but none, and when
 * auto_explain.log_min_duration is anything but -1. pg_stat_statements.track = 'all' (with track_utility on) is refused too.
 * What remains (exactly): (1) a FATAL termination of the session while the ALTER runs (an administrator command, a crash or a
 * shutdown; PL/pgSQL cannot catch FATAL and ALTER ROLE accepts no bind parameter): the log's CONTEXT line then quotes the statement;
 * (2) any other LOG or WARNING raised inside the ALTER by something this module does not name (an extension or a host hook): it carries
 * the same CONTEXT at the default log_min_messages = warning. The window for both is at most the lock wait (10 s, or less as above) plus
 * the statement's run time; any rollback_not_confirmed or unknown result is a STOP. The node-postgres error then holds the text in its `where` field in memory; it is never printed (only the classifier's id and
 * SQLSTATE are). Settings this module cannot see (an extension that is not named above) are not covered.
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
export const LOCK_WAIT_LOG_MARGIN_MS = 100;
export const MIN_DEADLOCK_TIMEOUT_MS = 200;
/** The first statements after begin: only pg_catalog (then pg_temp) on the search path, and the settings that would log the parse tree off. */
export const SEARCH_PATH_SQL = 'set local search_path = pg_catalog, pg_temp';
export const DEBUG_PRINT_OFF_SQL: readonly string[] = ['set local debug_print_parse = off', 'set local debug_print_rewritten = off', 'set local debug_print_plan = off'];
export const lockTimeoutSql = (ms: number): string => `set local lock_timeout = '${Math.floor(ms)}ms'`;
export const SETTINGS_SQL = "select name, setting from pg_catalog.pg_settings where name in ('statement_timeout', 'lock_timeout', 'deadlock_timeout', 'log_lock_waits', 'pg_stat_statements.track', 'pg_stat_statements.track_utility', "
  + "'log_statement', 'log_min_duration_statement', 'log_min_duration_sample', 'log_statement_sample_rate', 'log_transaction_sample_rate', 'log_parameter_max_length', 'log_parameter_max_length_on_error') "
  + "union all select 'pgaudit.log', coalesce(pg_catalog.current_setting('pgaudit.log', true), 'none') "
  + "union all select 'auto_explain.log_min_duration', coalesce(pg_catalog.current_setting('auto_explain.log_min_duration', true), '-1')";
export const EXPIRY_MARGIN_HOURS = 24;
/** Why the server settings let the verifier reach the log, or null when they do not. A setting that cannot be read counts as unsafe. */
export function loggingProblem(settings: Map<string, string>): string | null {
  const num = (name: string): number => { const v = settings.get(name); return v === undefined || v.trim() === '' ? Number.NaN : Number(v); };
  if (num('log_parameter_max_length_on_error') !== 0) return 'log_parameter_max_length_on_error is not 0';
  const audit = (settings.get('pgaudit.log') ?? 'missing').trim().toLowerCase();
  if (audit !== '' && audit !== 'none') return 'pgaudit.log is not none';
  if (num('auto_explain.log_min_duration') !== -1) return 'auto_explain.log_min_duration is not -1';
  if (num('log_parameter_max_length') === 0) return null;
  if (settings.get('log_statement') === undefined || settings.get('log_statement') === 'all') return 'log_statement is all';
  if (num('log_min_duration_statement') !== -1) return 'log_min_duration_statement is not -1';
  if (!(num('log_min_duration_sample') === -1 || num('log_statement_sample_rate') === 0)) return 'statement sampling is on';
  if (num('log_transaction_sample_rate') !== 0) return 'log_transaction_sample_rate is not 0';
  return null;
}
export const VERIFIER_GUC = 'bb_rolepw.verifier';
export const SET_VERIFIER_SQL = `select pg_catalog.set_config('${VERIFIER_GUC}', $1, true)`;
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
  rolvaliduntil is not null as has_valid_until, coalesce(rolvaliduntil <= pg_catalog.now(), false) as expired, coalesce(rolvaliduntil <= pg_catalog.now() + interval '${EXPIRY_MARGIN_HOURS} hours', false) as expires_soon, coalesce(rolconfig::text, '') as config, (select pg_catalog.count(*)::int from pg_catalog.pg_roles where rolname = $1) as matches
  from pg_catalog.pg_roles where rolname = $1`;

type RoleFacts = Record<string, unknown>;
const stable = (f: RoleFacts): string => JSON.stringify({ ...f, rolcanlogin: undefined });

/** The only thing this module prints: one fixed result event whose two fields are checked against fixed lists. */
const resultEvent = (role: string, result: string): void => {
  if (!ROLE_PASSWORD_ROLES.includes(role) || !(ROLE_PASSWORD_RESULTS as readonly string[]).includes(result)) throw new RunnerRefusal('role_password_refused', 'internal check failed before any output');
  console.log(JSON.stringify({ msg: 'staging-sql.role_password_result', role, result }));
};

/** The ALTER is built server-side from the bound verifier; the handlers re-raise with the same SQLSTATE and a fixed message (no CONTEXT quoting the statement). */
export const doAlterSql = (role: string): string => `do $$ begin execute pg_catalog.format('alter role ${role} login password %L', pg_catalog.current_setting('${VERIFIER_GUC}')); `
  + "exception when query_canceled then raise exception using errcode = 'query_canceled', message = 'role password statement failed'; "
  + "when others then raise exception using errcode = sqlstate, message = 'role password statement failed'; end $$";

/**
 * One transaction: search_path and debug_print_* settings, timeouts (stricter existing ones kept), the role must exist exactly once, not be a superuser and not have an expired
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
    // Search path and parse-tree logging first: nothing below can resolve a look-alike object, and the debug_print_* settings cannot log the statement.
    await client.query(SEARCH_PATH_SQL);
    for (const sql of DEBUG_PRINT_OFF_SQL) await client.query(sql);
    // Keep a stricter timeout that is already in force (0 means none); otherwise set ours for this transaction only.
    const settings = new Map(((await client.query(SETTINGS_SQL)).rows as { name: string; setting: string }[]).map((r) => [r.name, r.setting]));
    const needsOurs = (name: string, limitMs: number): boolean => { const ms = Number(settings.get(name)); return !(Number.isFinite(ms) && ms > 0 && ms <= limitMs); };
    if (needsOurs('statement_timeout', STATEMENT_TIMEOUT_MS)) await client.query(STATEMENT_TIMEOUT_SQL);
    // log_lock_waits cannot be switched off by a non-superuser: keep the lock wait shorter than deadlock_timeout so the wait line (with the statement in its CONTEXT) is never written.
    const lockWaitsLogged = (settings.get('log_lock_waits') ?? 'on').trim().toLowerCase() !== 'off';
    const deadlockMs = Number(settings.get('deadlock_timeout'));
    let lockLimitMs = LOCK_TIMEOUT_MS;
    if (lockWaitsLogged) {
      if (!Number.isFinite(deadlockMs) || deadlockMs < MIN_DEADLOCK_TIMEOUT_MS) {
        throw new RunnerRefusal('role_password_logging_refused', 'log_lock_waits is on and deadlock_timeout leaves no room for a shorter lock_timeout; refusing; nothing changed');
      }
      lockLimitMs = Math.min(LOCK_TIMEOUT_MS, deadlockMs - LOCK_WAIT_LOG_MARGIN_MS);
    }
    if (needsOurs('lock_timeout', lockLimitMs)) await client.query(lockLimitMs === LOCK_TIMEOUT_MS ? LOCK_TIMEOUT_SQL : lockTimeoutSql(lockLimitMs));
    if (settings.get('pg_stat_statements.track') === 'all' && settings.get('pg_stat_statements.track_utility') !== 'off') {
      throw new RunnerRefusal('role_password_refused', 'pg_stat_statements.track is "all" with track_utility on, which would record the nested role statement; refusing; nothing changed');
    }
    if (loggingProblem(settings) !== null) {
      throw new RunnerRefusal('role_password_logging_refused', 'a server logging setting would write the bound verifier to the server log; refusing; nothing changed');
    }
    const before = (await client.query(ROLE_FACTS_SQL, [plan.role])).rows as RoleFacts[];
    if (before.length !== 1 || before[0]!.matches !== 1) throw new RunnerRefusal('role_password_refused', 'the role does not exist exactly once; nothing changed');
    if (before[0]!.rolsuper !== false) throw new RunnerRefusal('role_password_refused', 'the role is not an ordinary login role; refusing; nothing changed');
    if (before[0]!.expired === true) throw new RunnerRefusal('role_password_refused', 'the role has an expired VALID UNTIL, so it could not log in; refusing; nothing changed');
    if (before[0]!.expires_soon === true) throw new RunnerRefusal('role_password_expiry_refused', `the role's VALID UNTIL is within ${EXPIRY_MARGIN_HOURS} hours; refusing; nothing changed`);
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
