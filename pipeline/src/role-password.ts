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
 * they are user-settable and would log the parse tree, with the verifier, on every run), exit_on_error to off (user-settable; when on, any
 * error inside the ALTER, including this module's own lock and statement timeouts, becomes a FATAL whose CONTEXT quotes the statement) and
 * jit to off; a SET LOCAL that is not permitted is an error, so the run rolls back before the verifier is bound, and each of them must
 * then read off. log_lock_waits (superuser-only to change) cannot be switched off: when it is not
 * off, the lock_timeout is set to deadlock_timeout minus 100 ms (a stricter one already in force is kept), so a lock wait is cancelled
 * before the "still waiting" line, whose CONTEXT quotes the statement, can be written; a deadlock_timeout under 200 ms or unreadable is
 * refused.
 * The transaction READS the logging settings and REFUSES (nothing changed) when the bound parameter could be written to the server
 * log: unless log_parameter_max_length = 0, it refuses for log_statement = 'all', log_min_duration_statement other than -1, a
 * log_min_duration_sample other than -1 together with a log_statement_sample_rate above 0, or a log_transaction_sample_rate above 0; it
 * also refuses when log_parameter_max_length_on_error is not 0, when pgaudit.log is anything but none, when
 * auto_explain.log_min_duration is anything but -1, and when log_parser_stats, log_planner_stats, log_executor_stats or
 * log_statement_stats is not off (superuser-only; log_parser_stats writes the statement in CONTEXT). pg_stat_statements.track = 'all' is
 * refused when track_utility is also on (with track_utility off no utility statement is recorded).
 * Every visible row of pg_settings is read and compared BY NAME (never by category: the category text is translated by lc_messages, which
 * a role or database can set to a non-English value). A name without a dot that is not in CHECKED_SETTINGS, HARMLESS_LOGGING_SETTINGS (of
 * its 68 entries, 43 were probed on a real server and 25 were judged harmless by kind, by reading, and not tested) or OTHER_KNOWN_SETTINGS
 * (the other PostgreSQL 16.15 settings) is refused, and a set of sentinel names must come back or the read is not trusted. Any server major
 * version other than 16 is refused first (role_password_server_version_unverified) until it has been audited: for 17 that audit must cover
 * transaction_timeout (a FATAL like exit_on_error) and every other new setting. client_connection_check_interval is set to 0 (a dropped
 * client would otherwise end the session with a FATAL whose CONTEXT quotes the statement; Linux only, accepted everywhere).
 * What remains (exactly): (1) a FATAL termination of the session while the ALTER runs (an administrator command, a crash or a
 * shutdown; PL/pgSQL cannot catch FATAL and ALTER ROLE accepts no bind parameter): the log's CONTEXT line then quotes the statement;
 * (2) any other LOG or WARNING raised inside the ALTER by code this module does not name (an extension, a preloaded library or a host
 * hook, e.g. Supabase supautils, not verified): it carries the same CONTEXT at the default log_min_messages = warning; (3) a setting
 * in those groups that a role without pg_read_all_settings cannot see (in PostgreSQL 16 only log_directory and log_filename, both
 * destination-only) is not read. The window for (1) and (2) is at most the lock wait (10 s, or less as above) plus the statement's run
 * time; any rollback_not_confirmed or unknown result is a STOP. The node-postgres error then holds the text in its `where` field in
 * memory; it is never printed (only the classifier's id and SQLSTATE are). Extension settings other than pgaudit.log and
 * auto_explain.log_min_duration are not covered.
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
/** The first statements after begin: only pg_catalog (then pg_temp) on the search path, then the user-settable settings that could write the statement, with the verifier, to the log are switched off. */
export const SEARCH_PATH_SQL = 'set local search_path = pg_catalog, pg_temp';
/** debug_print_* log the parse tree; exit_on_error turns an error inside the ALTER into a FATAL, whose CONTEXT the DO block cannot replace; jit = off keeps JIT (and jit_dump_bitcode) out of the transaction; client_connection_check_interval = 0 (Linux; accepted on every platform) stops a client that drops during the lock wait from becoming a FATAL connection to client lost whose CONTEXT quotes the statement. PostgreSQL 17's transaction_timeout is not handled: that major version is refused until audited. */
export const SESSION_SAFETY_SQL: readonly string[] = ['set local debug_print_parse = off', 'set local debug_print_rewritten = off', 'set local debug_print_plan = off', 'set local exit_on_error = off', 'set local jit = off', 'set local client_connection_check_interval = 0'];
export const lockTimeoutSql = (ms: number): string => `set local lock_timeout = '${Math.floor(ms)}ms'`;
/** Must read off after SESSION_SAFETY_SQL; the four *_stats settings are superuser-only (cannot be switched off here), and log_parser_stats writes the statement in CONTEXT. Missing counts as on. */
export const MUST_BE_OFF_SETTINGS: readonly string[] = ['debug_print_parse', 'debug_print_rewritten', 'debug_print_plan', 'exit_on_error', 'jit', 'log_parser_stats', 'log_planner_stats', 'log_executor_stats', 'log_statement_stats'];
/** Every setting read by name. */
export const CHECKED_SETTINGS: readonly string[] = ['statement_timeout', 'lock_timeout', 'deadlock_timeout', 'log_lock_waits', 'pg_stat_statements.track', 'pg_stat_statements.track_utility',
  'log_statement', 'log_min_duration_statement', 'log_min_duration_sample', 'log_statement_sample_rate', 'log_transaction_sample_rate', 'log_parameter_max_length', 'log_parameter_max_length_on_error', 'client_connection_check_interval', ...MUST_BE_OFF_SETTINGS];
/**
 * The rest of PostgreSQL 16's settings in those groups: a real-server probe as a non-superuser runner (each at its loudest value, then all at
 * once on the success, error and lock-wait paths) found no part of the verifier in the server log, pg_stat_statements or pg_stat_activity,
 * or the setting cannot change what one session writes (server-wide or destination only). Evidence: scram-6b r5 settings audit.
 */
export const HARMLESS_LOGGING_SETTINGS: readonly string[] = ['allow_in_place_tablespaces', 'allow_system_table_mods', 'application_name', 'backtrace_functions', 'cluster_name', 'compute_query_id', 'data_sync_retry',
  'debug_discard_caches', 'debug_io_direct', 'debug_logical_replication_streaming', 'debug_parallel_query', 'debug_pretty_print', 'event_source', 'ignore_checksum_failure', 'ignore_invalid_pages', 'ignore_system_indexes',
  'jit_debugging_support', 'jit_dump_bitcode', 'jit_expressions', 'jit_profiling_support', 'jit_tuple_deforming', 'log_autovacuum_min_duration', 'log_checkpoints', 'log_connections', 'log_destination', 'log_directory',
  'log_disconnections', 'log_duration', 'log_error_verbosity', 'log_file_mode', 'log_filename', 'log_hostname', 'log_line_prefix', 'log_min_error_statement', 'log_min_messages', 'log_recovery_conflict_waits',
  'log_replication_commands', 'log_rotation_age', 'log_rotation_size', 'log_startup_progress_interval', 'log_temp_files', 'log_timezone', 'log_truncate_on_rotation', 'logging_collector', 'post_auth_delay', 'pre_auth_delay',
  'recovery_init_sync_method', 'remove_temp_files_after_crash', 'restart_after_crash', 'send_abort_for_crash', 'send_abort_for_kill', 'stats_fetch_consistency', 'syslog_facility', 'syslog_ident', 'syslog_sequence_numbers',
  'syslog_split_messages', 'trace_notify', 'trace_recovery_messages', 'trace_sort', 'track_activities', 'track_activity_query_size', 'track_counts', 'track_functions', 'track_io_timing', 'track_wal_io_timing',
  'update_process_title', 'wal_consistency_checking', 'zero_damaged_pages'];
/**
 * The remaining PostgreSQL 16.15 settings (every other name in pg_settings without a dot, taken from a full 368-row listing), none of which
 * is about logging. Together with CHECKED_SETTINGS and HARMLESS_LOGGING_SETTINGS this is the full list of names the tool knows; a name outside
 * it (a setting of a newer server, a build-only setting, a renamed one) is refused. Names are compared, never categories, because pg_settings.category
 * is translated by lc_messages (superuser-only to set, so a role or database can carry a translated one).
 */
export const OTHER_KNOWN_SETTINGS: readonly string[] = `archive_cleanup_command archive_command archive_library archive_mode archive_timeout array_nulls authentication_timeout autovacuum autovacuum_analyze_scale_factor autovacuum_analyze_threshold autovacuum_freeze_max_age autovacuum_max_workers autovacuum_multixact_freeze_max_age autovacuum_naptime autovacuum_vacuum_cost_delay autovacuum_vacuum_cost_limit autovacuum_vacuum_insert_scale_factor autovacuum_vacuum_insert_threshold autovacuum_vacuum_scale_factor autovacuum_vacuum_threshold autovacuum_work_mem backend_flush_after backslash_quote bgwriter_delay bgwriter_flush_after bgwriter_lru_maxpages bgwriter_lru_multiplier block_size bonjour bonjour_name bytea_output check_function_bodies checkpoint_completion_target checkpoint_flush_after checkpoint_timeout checkpoint_warning client_encoding client_min_messages commit_delay commit_siblings config_file constraint_exclusion cpu_index_tuple_cost cpu_operator_cost cpu_tuple_cost createrole_self_grant cursor_tuple_fraction data_checksums data_directory data_directory_mode DateStyle db_user_namespace debug_assertions default_statistics_target default_table_access_method default_tablespace default_text_search_config default_toast_compression default_transaction_deferrable default_transaction_isolation default_transaction_read_only dynamic_library_path dynamic_shared_memory_type effective_cache_size effective_io_concurrency enable_async_append enable_bitmapscan enable_gathermerge enable_hashagg enable_hashjoin enable_incremental_sort enable_indexonlyscan enable_indexscan enable_material enable_memoize enable_mergejoin enable_nestloop enable_parallel_append enable_parallel_hash enable_partition_pruning enable_partitionwise_aggregate enable_partitionwise_join enable_presorted_aggregate enable_seqscan enable_sort enable_tidscan escape_string_warning external_pid_file extra_float_digits file_extend_method from_collapse_limit fsync full_page_writes geqo geqo_effort geqo_generations geqo_pool_size geqo_seed geqo_selection_bias geqo_threshold gin_fuzzy_search_limit gin_pending_list_limit gss_accept_delegation hash_mem_multiplier hba_file hot_standby hot_standby_feedback huge_page_size huge_pages icu_validation_level ident_file idle_in_transaction_session_timeout idle_session_timeout in_hot_standby integer_datetimes IntervalStyle jit_above_cost jit_inline_above_cost jit_optimize_above_cost jit_provider join_collapse_limit krb_caseins_users krb_server_keyfile lc_messages lc_monetary lc_numeric lc_time listen_addresses lo_compat_privileges local_preload_libraries logical_decoding_work_mem maintenance_io_concurrency maintenance_work_mem max_connections max_files_per_process max_function_args max_identifier_length max_index_keys max_locks_per_transaction max_logical_replication_workers max_parallel_apply_workers_per_subscription max_parallel_maintenance_workers max_parallel_workers max_parallel_workers_per_gather max_pred_locks_per_page max_pred_locks_per_relation max_pred_locks_per_transaction max_prepared_transactions max_replication_slots max_slot_wal_keep_size max_stack_depth max_standby_archive_delay max_standby_streaming_delay max_sync_workers_per_subscription max_wal_senders max_wal_size max_worker_processes min_dynamic_shared_memory min_parallel_index_scan_size min_parallel_table_scan_size min_wal_size old_snapshot_threshold output_plugin_libraries parallel_leader_participation parallel_setup_cost parallel_tuple_cost password_encryption plan_cache_mode port primary_conninfo primary_slot_name quote_all_identifiers random_page_cost recovery_end_command recovery_min_apply_delay recovery_prefetch recovery_target recovery_target_action recovery_target_inclusive recovery_target_lsn recovery_target_name recovery_target_time recovery_target_timeline recovery_target_xid recursive_worktable_factor reserved_connections restore_command restrict_nonsystem_relation_kind row_security scram_iterations search_path segment_size seq_page_cost server_encoding server_version server_version_num session_preload_libraries session_replication_role shared_buffers shared_memory_size shared_memory_size_in_huge_pages shared_memory_type shared_preload_libraries ssl ssl_ca_file ssl_cert_file ssl_ciphers ssl_crl_dir ssl_crl_file ssl_dh_params_file ssl_ecdh_curve ssl_key_file ssl_library ssl_max_protocol_version ssl_min_protocol_version ssl_passphrase_command ssl_passphrase_command_supports_reload ssl_prefer_server_ciphers standard_conforming_strings superuser_reserved_connections synchronize_seqscans synchronous_commit synchronous_standby_names tcp_keepalives_count tcp_keepalives_idle tcp_keepalives_interval tcp_user_timeout temp_buffers temp_file_limit temp_tablespaces TimeZone timezone_abbreviations track_commit_timestamp transaction_deferrable transaction_isolation transaction_read_only transform_null_equals unix_socket_directories unix_socket_group unix_socket_permissions vacuum_buffer_usage_limit vacuum_cost_delay vacuum_cost_limit vacuum_cost_page_dirty vacuum_cost_page_hit vacuum_cost_page_miss vacuum_failsafe_age vacuum_freeze_min_age vacuum_freeze_table_age vacuum_multixact_failsafe_age vacuum_multixact_freeze_min_age vacuum_multixact_freeze_table_age wal_block_size wal_buffers wal_compression wal_decode_buffer_size wal_init_zero wal_keep_size wal_level wal_log_hints wal_receiver_create_temp_slot wal_receiver_status_interval wal_receiver_timeout wal_recycle wal_retrieve_retry_interval wal_segment_size wal_sender_timeout wal_skip_threshold wal_sync_method wal_writer_delay wal_writer_flush_after work_mem xmlbinary xmloption`.split(' ');
/** Supported server: only this major version has been audited (any other is refused until it is). */
export const AUDITED_SERVER_MAJOR = 16;
/** Must come back from the settings read, or the read is not trusted (a locale or a rename must not make it silently empty). */
export const SENTINEL_SETTINGS: readonly string[] = ['server_version_num', 'log_statement', 'log_min_duration_statement', 'log_min_messages', 'debug_print_parse', 'track_activities', 'client_connection_check_interval'];
/** All of pg_settings (visible rows), compared by name only. */
export const SETTINGS_SQL = 'select name, setting from pg_catalog.pg_settings '
  + "union all select 'pgaudit.log', coalesce(pg_catalog.current_setting('pgaudit.log', true), 'none') "
  + "union all select 'auto_explain.log_min_duration', coalesce(pg_catalog.current_setting('auto_explain.log_min_duration', true), '-1')";
const CLASSIFIED_SETTINGS: ReadonlySet<string> = new Set([...CHECKED_SETTINGS, ...HARMLESS_LOGGING_SETTINGS, ...OTHER_KNOWN_SETTINGS, 'pgaudit.log', 'auto_explain.log_min_duration']);
/** Customized options of extensions always contain a dot; they are not covered (see the header) except the two read by name. */
const isExtensionSetting = (name: string): boolean => name.includes('.');
/** Null when the server is the audited major version; a reason word otherwise (a missing or unreadable number counts as not audited). */
export function serverVersionProblem(settings: Map<string, string>): string | null {
  const v = Number(settings.get('server_version_num'));
  return Number.isInteger(v) && Math.floor(v / 10000) === AUDITED_SERVER_MAJOR ? null : 'server_version_num is not an audited major version';
}
export const EXPIRY_MARGIN_HOURS = 24;
/** Why the server settings let the verifier reach the log, or null when they do not. A setting that cannot be read or is not classified counts as unsafe. */
export function loggingProblem(settings: Map<string, string>): string | null {
  for (const name of SENTINEL_SETTINGS) if (!settings.has(name)) return `${name} was not returned`;
  for (const name of settings.keys()) if (!CLASSIFIED_SETTINGS.has(name) && !isExtensionSetting(name)) return `${name} is not classified`;
  if (Number(settings.get('client_connection_check_interval')) !== 0) return 'client_connection_check_interval is not 0';
  for (const name of MUST_BE_OFF_SETTINGS) if ((settings.get(name) ?? 'missing').trim().toLowerCase() !== 'off') return `${name} is not off`;
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
 * One transaction: search_path and session safety settings, timeouts (stricter existing ones kept), the role must exist exactly once, not be a superuser and not have an expired
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
    // Search path and session safety first: nothing below can resolve a look-alike object, debug_print_* cannot log the statement, and no error inside the ALTER becomes a FATAL.
    await client.query(SEARCH_PATH_SQL);
    for (const sql of SESSION_SAFETY_SQL) await client.query(sql);
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
    if (serverVersionProblem(settings) !== null) {
      throw new RunnerRefusal('role_password_server_version_unverified', 'the server is not PostgreSQL 16, the only major version whose settings have been audited for this action; refusing; nothing changed');
    }
    if (loggingProblem(settings) !== null) {
      throw new RunnerRefusal('role_password_logging_refused', 'a server logging setting would write the bound verifier to the server log, or is not one this tool has classified; refusing; nothing changed');
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
