import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RunnerRefusal } from './refusals.js';
import { PRODUCTION_PROMPT_PROOF_VARIABLE, promptProof, selectFirstManagerDbUrl } from './first-manager-bootstrap.js';
import { REPOSITORY_ROOT, type RebuiltSqlClient } from './staging-rebuilt.js';
import { RECORDED_PROJECT_REFS, parseSupabaseDbTarget, type SupabaseDbTarget } from './target-guard.js';
import { SqlSplitError, splitSqlStatements, transactionShape, unsupportedReason, type SqlStatement } from './prod-sql-split.js';

/**
 * Guarded production SQL runner (Route A of docs/build-plan/18-production-sql-route-options.md; cutover gap OPEN-1).
 * BUILT, PENDING REVIEW AND HUNTER'S OPEN-1 CHOICE: nothing here has touched any database.
 *
 * Safety shape (each property is pinned by prod-sql.test.ts and scripts/verify-prod-sql-runner-contract.mjs):
 *   - one ACTION per approved file or stage (the table below); each pins the file's SHA-256 (and, for a stage, the SHA-256 of that
 *     stage's statements) and refuses on any mismatch; the bytes that were hashed are the bytes that are parsed and sent;
 *   - the target is the one recorded production project only, on the session port, through the same target-guard parser the
 *     first-manager tool uses; staging, local and anything else are refused;
 *   - the connection string is accepted only from the hidden prompt of scripts/run-with-secrets.mjs (the prompt proof), never ambient;
 *   - every action has its own exact typed phrase; without --execute nothing connects (plan only is the default);
 *   - a file with no top-level begin/commit/rollback is wrapped in ONE transaction; a file that has its own begin ... commit is run as
 *     written and never wrapped again; any other shape is refused; a read-only action runs in a read-only transaction that is rolled back;
 *   - output is fixed events (counts, enumerated words, the pinned hash), never an address, a value or driver text;
 *   - COMMIT (CR17): a COMMIT that fails is an UNKNOWN outcome and is never retried or rolled back; a COMMIT that returns the ROLLBACK
 *     tag is a definite failure; severity or message text is never read.
 */

export const PROD_SQL_TARGET = 'production' as const;
export type ProdSqlMode = 'read_only' | 'write';
/**
 * What a finished statement may report: nothing, the row count, the row count plus a digest of the rows (for before/after comparison), pinned count columns,
 * or 'shape': the row count, and the rows are checked in the runner against the reviewed L1 inventory (see evaluateL1Shape) and stop the run when it fails.
 */
export type ProdSqlReport = 'none' | 'rows' | 'digest' | 'counts' | 'shape';

export interface ProdSqlAction {
  id: string;
  /** Where doc 17 names this step (documentation only). */
  step: string;
  /** Repository-relative path. */
  file: string;
  /** SHA-256 of the whole file (raw bytes). */
  sha256: string;
  /** For the migrations: the file name whose hash docs/build-plan/migration-checksums.sha256 must also agree with. */
  manifestName?: string;
  /** 1-based inclusive range of top-level statements; absent = the whole file. */
  statements?: readonly [number, number];
  /** SHA-256 of the stage's statements (see stageDigest); required when `statements` is present. */
  stageSha256?: string;
  mode: ProdSqlMode;
  report: ProdSqlReport;
  /** For report 'counts': the only column names that are ever printed (the values are numbers). */
  countNames?: readonly string[];
  /**
   * The id of an action whose statements (a 'shape' stage of the same file) run FIRST, inside this action's own transaction, and must pass
   * evaluateL1Shape before any statement of this action runs. The gate is part of the plan, so it is the same run.
   */
  gate?: string;
  /** The exact words the operator must type with --confirm for this action. */
  phrase: string;
}

const MIGRATION = (id: string, step: string, name: string, sha256: string): ProdSqlAction => ({
  id, step, file: `supabase/migrations/${name}`, sha256, manifestName: name, mode: 'write', report: 'none', phrase: `RUN TNBS PRODUCTION SQL ${id.toUpperCase()}`,
});

/** The approved production actions, in doc 17 order. Hashes were taken from the repository files on this branch. */
export const PROD_SQL_ACTIONS: readonly ProdSqlAction[] = [
  // A2: the four July migrations, one at a time (doc 17 A2).
  MIGRATION('migration-security-hardening', 'A2', '20260722223300_security_hardening.sql', '93e0cfe23ac916a8a1601739671b48093cf47345c1ea1557297c5807c08312c0'),
  MIGRATION('migration-profile-service-bootstrap', 'A2', '20260723004500_profile_service_bootstrap.sql', '371e79c2fd81c635ecdf601c08ebf63ebf84cfabcdf12d919434fcf4993de777'),
  MIGRATION('migration-dnc-activity-enum-cast', 'A2', '20260723010400_dnc_activity_enum_cast.sql', '9c6677418675cc6f26d092608abd5e1934633e55fd409f5845190a0b1fe00967'),
  MIGRATION('migration-contact-logs-dnc-guard', 'A2', '20260723020000_contact_logs_dnc_guard.sql', '8a3eb323db74ac0d871bf8ecdd32bf92f83b8da87ce59b665cc769185ddd27eb'),
  // A3: the read-only permission snapshot. Each statement reports a digest so the before/after outputs can be compared without printing rows.
  { id: 'snapshot', step: 'A3, BO8', file: 'supabase/backout/pre-cutover-snapshot.sql', sha256: 'a8ef562db0047b4c58beb3ecd52bdfc0ae53385aa2dee40f30e153085dd04ece', mode: 'read_only', report: 'digest', phrase: 'RUN TNBS PRODUCTION SQL SNAPSHOT' },
  // B2-B5: M1, M1b, M1c.
  { id: 'm1', step: 'B2', file: 'supabase/pending/M1_same_origin_signin.sql', sha256: 'ac5bc26385ec106e8f2f093d00e22a1ff8501b8ff8363bf0444e08b7ee504d19', mode: 'write', report: 'none', phrase: 'RUN TNBS PRODUCTION SQL M1' },
  { id: 'm1b', step: 'B3', file: 'supabase/pending/M1b_add_person.sql', sha256: '82724e06f0393adf82bbe7222f2a9ae55dbe2443c2fffdf98a8bebabcbc44768', mode: 'write', report: 'none', phrase: 'RUN TNBS PRODUCTION SQL M1B' },
  { id: 'm1c', step: 'B4', file: 'supabase/pending/M1c_batch_delete_audit.sql', sha256: '86cd3de2ab4f1b2283c344088e31d05fbc8e719ebaa17318987a7082c42dfb26', mode: 'write', report: 'none', phrase: 'RUN TNBS PRODUCTION SQL M1C' },
  // B13: L1, in its own stages (doc 17 B13 steps 1-4). Stage 2 is also the recount of steps 4 and 7; stage 3 is also the second sweep of step 6.
  { id: 'l1-shape', step: 'B13 stage 1', file: 'supabase/rollout/L1-close-legacy-auth.sql', sha256: '3f6e2c70f52c0f3b462769af6aa43c04b24a3984fe6d099c4184a7a4283223d5', statements: [1, 2], stageSha256: '9fb09b8013f719119d024c17a8246b6f96a18b3b8f5ef3a1ac1049c7fc03bd40', mode: 'read_only', report: 'shape', phrase: 'RUN TNBS PRODUCTION SQL L1-SHAPE' },
  { id: 'l1-counts', step: 'B13 stages 2, 4, 7', file: 'supabase/rollout/L1-close-legacy-auth.sql', sha256: '3f6e2c70f52c0f3b462769af6aa43c04b24a3984fe6d099c4184a7a4283223d5', statements: [3, 3], stageSha256: '991ccc9c661fd08ff076130d4bea321798bee54398631a609fa7c97eaf13a3e2', mode: 'read_only', report: 'counts', countNames: ['sessions', 'refresh_tokens', 'one_time_tokens', 'flow_state', 'users_with_tokens'], phrase: 'RUN TNBS PRODUCTION SQL L1-COUNTS' },
  { id: 'l1-sweep', step: 'B13 stages 3, 6', file: 'supabase/rollout/L1-close-legacy-auth.sql', sha256: '3f6e2c70f52c0f3b462769af6aa43c04b24a3984fe6d099c4184a7a4283223d5', statements: [4, 10], stageSha256: 'b0c4997d598809dd05f22e88fd81132b58e3d0439ee69353216feded075a1e09', mode: 'write', report: 'rows', gate: 'l1-shape', phrase: 'RUN TNBS PRODUCTION SQL L1-SWEEP' },
  // BO2: retire-app-credentials.sql, stage by stage (its own steps 2-6).
  { id: 'retire-nologin', step: 'BO2 step 2', file: 'supabase/backout/retire-app-credentials.sql', sha256: '3e716371979ffb876bb54f7ab91753eced9b89df15276c9d6d4ba7cc0ef7fa15', statements: [1, 1], stageSha256: '6df1df01d959cec06fa2f00c92114f91ff38a4ab422534b70051089cbc257f6f', mode: 'write', report: 'rows', phrase: 'RUN TNBS PRODUCTION SQL RETIRE-NOLOGIN' },
  { id: 'retire-terminate', step: 'BO2 step 3', file: 'supabase/backout/retire-app-credentials.sql', sha256: '3e716371979ffb876bb54f7ab91753eced9b89df15276c9d6d4ba7cc0ef7fa15', statements: [2, 2], stageSha256: 'c9442fb30289dbf20fc87d8dfc35b37bbd68effaca248b85353b555e61cc343d', mode: 'write', report: 'rows', phrase: 'RUN TNBS PRODUCTION SQL RETIRE-TERMINATE' },
  { id: 'retire-backends', step: 'BO2 step 3 (poll)', file: 'supabase/backout/retire-app-credentials.sql', sha256: '3e716371979ffb876bb54f7ab91753eced9b89df15276c9d6d4ba7cc0ef7fa15', statements: [3, 3], stageSha256: '44029a911f4c244209dae3539bac1bf7748ccea2caca5ca1aa6d1050db5f96d9', mode: 'read_only', report: 'counts', countNames: ['recruiter_app_backends'], phrase: 'RUN TNBS PRODUCTION SQL RETIRE-BACKENDS' },
  { id: 'retire-revoke', step: 'BO2 step 4', file: 'supabase/backout/retire-app-credentials.sql', sha256: '3e716371979ffb876bb54f7ab91753eced9b89df15276c9d6d4ba7cc0ef7fa15', statements: [4, 10], stageSha256: 'e3e17e9e9a22c367c76b8682bd72ef993c6099cfa2f20e86fc5a3e9d1a5a2e24', mode: 'write', report: 'rows', phrase: 'RUN TNBS PRODUCTION SQL RETIRE-REVOKE' },
  { id: 'retire-checks', step: 'BO2 step 5', file: 'supabase/backout/retire-app-credentials.sql', sha256: '3e716371979ffb876bb54f7ab91753eced9b89df15276c9d6d4ba7cc0ef7fa15', statements: [11, 11], stageSha256: 'd46b5cd6f8b6991178dedfb8d545b533835d4e834b7406db05e65d87af319a96', mode: 'read_only', report: 'counts', countNames: ['backends', 'live_sessions', 'live_links', 'live_codes'], phrase: 'RUN TNBS PRODUCTION SQL RETIRE-CHECKS' },
  { id: 'retire-email', step: 'BO2 step 6', file: 'supabase/backout/retire-app-credentials.sql', sha256: '3e716371979ffb876bb54f7ab91753eced9b89df15276c9d6d4ba7cc0ef7fa15', statements: [12, 12], stageSha256: '86a09b805eebd79a673415a77492bd2d50cd38211ba8677b0dd6b3e1088af0f2', mode: 'read_only', report: 'counts', countNames: ['email_mismatches'], phrase: 'RUN TNBS PRODUCTION SQL RETIRE-EMAIL' },
  // BO4-BO6: the backouts, each with its own begin ... commit (run as written, never wrapped again).
  { id: 'backout-m1c', step: 'BO4', file: 'supabase/backout/M1c-backout.sql', sha256: '7714a74e7d26ab0829b0a0aa44dfcfec8685220447295927012504f6b8774435', mode: 'write', report: 'none', phrase: 'RUN TNBS PRODUCTION SQL BACKOUT-M1C' },
  { id: 'backout-m1b', step: 'BO5', file: 'supabase/backout/M1b-backout.sql', sha256: 'f4f0a853a1a4cd8c28bc29019556776f11ad5b5f67dc5461edd4fbba8d1341c8', mode: 'write', report: 'none', phrase: 'RUN TNBS PRODUCTION SQL BACKOUT-M1B' },
  { id: 'backout-m1', step: 'BO6', file: 'supabase/backout/M1-backout.sql', sha256: '7686946e27331b69acfd91ad3d43c94b5b07e9228d1a0b6ac2a75f6c85c39d09', mode: 'write', report: 'none', phrase: 'RUN TNBS PRODUCTION SQL BACKOUT-M1' },
];

/**
 * Things doc 17 names that are NOT runnable here, and why. Each is refused ('prod_sql_action_not_built'); none was invented.
 * scripts/verify-prod-sql-runner-contract.mjs fails if a listed file appears in the repository without the table being updated.
 */
export const PROD_SQL_MISSING: readonly { id: string; step: string; reason: string; file?: string }[] = [
  { id: 'security-hardening-backout', step: 'A2 backout, BO10', file: 'supabase/backout/security-hardening-backout.sql', reason: 'the file exists only on the cutover-prep branch, not on this branch; add it by its own reviewed commit and pin it' },
  { id: 'profile-bootstrap-backout', step: 'A2 backout', reason: 'doc 17 says no file is prepared' },
  { id: 'dnc-enum-cast-backout', step: 'A2 backout', reason: 'doc 17 says no file is prepared' },
  { id: 'window-on', step: 'B10', reason: 'an inline statement in doc 16 section 3.1, not a file in this repository' },
  { id: 'window-off', step: 'B10 / after the window', reason: 'an inline statement in doc 16 section 3.1, not a file in this repository' },
  { id: 'read-only-inventory', step: 'A1, BO3', reason: 'doc 17 says the query text is not recorded in the repository' },
  { id: 'reconciliation', step: 'doc 18 / 09 ledger', file: 'docs/build-plan/09-production-baseline-reconciliation.sql', reason: 'marked PROPOSAL ONLY (owner decision pending); not an approved production action' },
];

export const PROD_SQL_ACTION_IDS: readonly string[] = PROD_SQL_ACTIONS.map((a) => a.id);

const MANIFEST_PATH = ['docs', 'build-plan', 'migration-checksums.sha256'] as const;
const sha256Hex = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');
/** The pin of a stage: SHA-256 over the stage's statements as sent, separated by a NUL character. */
export const stageDigest = (statements: readonly SqlStatement[]): string => sha256Hex(statements.map((s) => s.raw).join('\u0000'));

export interface ProdSqlFiles {
  /** Reads a repository-relative file; the default reads from the repository root. Tests inject changed bytes. */
  readFile(rel: string): Buffer;
}
const defaultFiles: ProdSqlFiles = { readFile: (rel) => readFileSync(resolve(REPOSITORY_ROOT, rel)) };

export type ProdSqlShape = 'wrapped' | 'own' | 'read_only';
export interface ProdSqlPlan {
  action: ProdSqlAction;
  target: typeof PROD_SQL_TARGET;
  db: SupabaseDbTarget;
  statements: readonly SqlStatement[];
  /** The verified shape-gate statements (the 'gate' action's stage of the same file); they run first, inside the transaction, and must pass. */
  gate?: readonly SqlStatement[];
  shape: ProdSqlShape;
  /** The pinned file hash (public, repository content). */
  sha256: string;
}

const find = (id: string): ProdSqlAction | undefined => PROD_SQL_ACTIONS.find((a) => a.id === id);

/** True when the staged actions of `file` cover statements 1..total with no gap and no overlap, in order. */
export function stagesTile(file: string, total: number, actions: readonly ProdSqlAction[] = PROD_SQL_ACTIONS): boolean {
  const stages = actions.filter((a) => a.file === file && a.statements !== undefined).map((a) => a.statements!).sort((x, y) => x[0] - y[0]);
  let next = 1;
  for (const [from, to] of stages) {
    if (from !== next || to < from) return false;
    next = to + 1;
  }
  return stages.length > 0 && next === total + 1;
}

/** Pure, offline verification (it reads only the pinned repository file). Throws before anything could connect. */
export function planProdSql(input: { target: string | undefined; action: string; dbUrl: string | undefined; confirm: string | undefined; files?: ProdSqlFiles }): ProdSqlPlan {
  if (input.target === undefined) {
    throw new RunnerRefusal('bootstrap_target_required', 'The production SQL runner requires --target=production (there is no default)');
  }
  if (input.target !== PROD_SQL_TARGET) {
    throw new RunnerRefusal('prod_sql_target_refused', 'The production SQL runner only accepts --target=production (staging, local and anything else are refused)');
  }
  const action = find(input.action);
  if (action === undefined) {
    if (PROD_SQL_MISSING.some((m) => m.id === input.action)) throw new RunnerRefusal('prod_sql_action_not_built', `Action "${input.action}" is named in doc 17 but is not a runnable file here`);
    throw new RunnerRefusal('unknown_action', `Unknown production SQL action "${input.action}"`);
  }
  if (!input.dbUrl) throw new RunnerRefusal('db_url_required', 'PRODUCTION_DB_URL is required');
  const db = parseSupabaseDbTarget(input.dbUrl);
  if (db.projectRef !== RECORDED_PROJECT_REFS.production) {
    throw new RunnerRefusal('target_not_recorded_production', 'A production SQL run only targets the recorded production project');
  }
  if (db.port !== 5432) throw new RunnerRefusal('port_must_be_5432', 'The production SQL runner requires a session connection on port 5432 (not the 6543 transaction pooler)');

  const files = input.files ?? defaultFiles;
  let bytes: Buffer;
  try {
    bytes = files.readFile(action.file);
  } catch {
    throw new RunnerRefusal('prod_sql_file_unreadable', 'The approved file could not be read');
  }
  // The bytes hashed here are the bytes parsed and sent below; nothing is read a second time.
  if (sha256Hex(bytes) !== action.sha256) throw new RunnerRefusal('prod_sql_hash_mismatch', 'The file does not match its pinned SHA-256; refusing');
  if (action.manifestName !== undefined) {
    let manifest: string;
    try {
      manifest = files.readFile(MANIFEST_PATH.join('/')).toString('utf8');
    } catch {
      throw new RunnerRefusal('prod_sql_file_unreadable', 'The migration checksum manifest could not be read');
    }
    const line = manifest.split(/\r?\n/).map((l) => l.split('\t')).find((cols) => cols[0] === action.manifestName);
    if (line?.[1] !== action.sha256) throw new RunnerRefusal('prod_sql_hash_mismatch', 'The pinned SHA-256 does not agree with docs/build-plan/migration-checksums.sha256; refusing');
  }

  let all: SqlStatement[];
  try {
    all = splitSqlStatements(bytes.toString('utf8'));
  } catch (err) {
    if (err instanceof SqlSplitError) throw new RunnerRefusal('prod_sql_shape_refused', 'The file could not be split into statements; refusing');
    throw err;
  }
  let statements: readonly SqlStatement[] = all;
  if (action.statements !== undefined) {
    const [from, to] = action.statements;
    if (from < 1 || to < from || to > all.length) throw new RunnerRefusal('prod_sql_shape_refused', 'The stage range does not fit the file; refusing');
    statements = all.slice(from - 1, to);
    if (stageDigest(statements) !== action.stageSha256) throw new RunnerRefusal('prod_sql_hash_mismatch', 'The stage does not match its pinned SHA-256; refusing');
    // The stages of one file must tile it exactly, from statement 1 through the parsed final statement: an appended statement that no stage runs is refused.
    if (!stagesTile(action.file, all.length)) throw new RunnerRefusal('prod_sql_shape_refused', 'The stages do not cover the file exactly (gap, overlap or an unexecuted tail); refusing');
  }
  let gate: readonly SqlStatement[] | undefined;
  if (action.gate !== undefined) {
    const gateAction = find(action.gate);
    if (gateAction?.statements === undefined || gateAction.report !== 'shape' || gateAction.file !== action.file) throw new RunnerRefusal('prod_sql_shape_refused', 'The shape gate is not a shape stage of the same file; refusing');
    gate = all.slice(gateAction.statements[0] - 1, gateAction.statements[1]);
    if (stageDigest(gate) !== gateAction.stageSha256) throw new RunnerRefusal('prod_sql_hash_mismatch', 'The shape gate does not match its pinned SHA-256; refusing');
    if (gate.length !== 2 || gate.some((g) => unsupportedReason(g) !== null || commandOf(g) !== 'select')) throw new RunnerRefusal('prod_sql_shape_refused', 'The shape gate must be the two select statements; refusing');
  }
  if (statements.length === 0) throw new RunnerRefusal('prod_sql_shape_refused', 'The action has no statements; refusing');
  if (statements.some((s) => unsupportedReason(s) !== null)) throw new RunnerRefusal('prod_sql_shape_refused', 'The action holds a statement that cannot run in one transaction; refusing');

  const found = transactionShape(statements);
  if (found === 'invalid') throw new RunnerRefusal('prod_sql_shape_refused', 'The action mixes statements with partial transaction control; refusing (never guessed)');
  if (action.mode === 'read_only' && found !== 'wrapped') throw new RunnerRefusal('prod_sql_shape_refused', 'A read-only action must not carry its own transaction control; refusing');
  const shape: ProdSqlShape = action.mode === 'read_only' ? 'read_only' : found;

  if (input.confirm !== action.phrase) {
    throw new RunnerRefusal('confirmation_required', `Action ${action.id} requires --confirm="${action.phrase}"`);
  }
  return { action, target: PROD_SQL_TARGET, db, statements, ...(gate === undefined ? {} : { gate }), shape, sha256: action.sha256 };
}

/** Production credential entry: the first-manager rule, unchanged. A PRODUCTION_DB_URL without the hidden prompt's proof is refused; STAGING_DB_URL must be absent. */
export function selectProdSqlDbUrl(env: Readonly<Record<string, string | undefined>>): string | undefined {
  return selectFirstManagerDbUrl('production', env);
}
export { PRODUCTION_PROMPT_PROOF_VARIABLE, promptProof };

// ---------------------------------------------------------------------------------------------------------------
// The L1 shape gate (doc 17 B13 stage 1; the shape-check instructions at the top of supabase/rollout/L1-close-legacy-auth.sql)
// ---------------------------------------------------------------------------------------------------------------

/** The auth tables L1 clears or reads, named by the file's shape check and doc 17 B13: all must exist. users holds the six token columns. */
export const L1_AUTH_TABLES = ['users', 'sessions', 'refresh_tokens', 'one_time_tokens', 'flow_state'] as const;
/** The six auth.users token columns the L1 file clears; each must exist. */
export const L1_USERS_TOKEN_COLUMNS = ['confirmation_token', 'recovery_token', 'email_change_token_new', 'email_change_token_current', 'phone_change_token', 'reauthentication_token'] as const;
/**
 * Other auth tables whose review is on record as holding no credential (a plain list of schema versions). Any auth table that is neither in
 * L1_AUTH_TABLES nor here is unreviewed: the gate stops, a person reviews it, and only a reviewed change to this list (and the contract) lets it pass.
 * The runner never deletes or reads an unlisted table; it only counts it.
 */
export const L1_REVIEWED_OTHER_AUTH_TABLES = ['schema_migrations'] as const;
/** Every check name the shape gate can print (fixed words; the wrapper enumerates exactly these). */
export const PROD_SQL_SHAPE_CHECKS: readonly string[] = ['results_read', ...L1_AUTH_TABLES.map((t) => `table_${t}`), ...L1_USERS_TOKEN_COLUMNS.map((c) => `users_${c}`), 'no_unreviewed_auth_tables'];

export interface L1ShapeResult { checks: Record<string, boolean>; authTables: number; unreviewedAuthTables: number; passed: boolean }

const rowsOfResult = (v: unknown): Array<Record<string, unknown>> | undefined =>
  Array.isArray(v) ? v.filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null && !Array.isArray(r)) : undefined;

/**
 * Judges the two L1 shape results (the column listing and the table listing). Only booleans and counts come out; a table or column name
 * from the database is compared with the fixed lists and never kept. A result that is not a list of rows fails every check.
 */
export function evaluateL1Shape(columnResult: unknown, tableResult: unknown): L1ShapeResult {
  const columns = rowsOfResult(columnResult);
  const tables = rowsOfResult(tableResult);
  const tableNames = new Set((tables ?? []).map((r) => r.table_name).filter((n): n is string => typeof n === 'string'));
  const columnTables = new Set((columns ?? []).map((r) => r.table_name).filter((n): n is string => typeof n === 'string'));
  const userColumns = new Set((columns ?? []).filter((r) => r.table_name === 'users').map((r) => r.column_name).filter((n): n is string => typeof n === 'string'));
  const known = new Set<string>([...L1_AUTH_TABLES, ...L1_REVIEWED_OTHER_AUTH_TABLES]);
  const authTables = tables === undefined ? 0 : tables.length;
  const unreviewedAuthTables = tables === undefined ? 0 : tables.filter((r) => typeof r.table_name !== 'string' || !known.has(r.table_name)).length;
  const checks: Record<string, boolean> = { results_read: columns !== undefined && tables !== undefined };
  for (const t of L1_AUTH_TABLES) checks[`table_${t}`] = tableNames.has(t) && (t === 'users' || columnTables.has(t));
  for (const c of L1_USERS_TOKEN_COLUMNS) checks[`users_${c}`] = userColumns.has(c);
  checks.no_unreviewed_auth_tables = tables !== undefined && unreviewedAuthTables === 0;
  return { checks, authTables, unreviewedAuthTables, passed: Object.values(checks).every((v) => v) };
}

// ---------------------------------------------------------------------------------------------------------------
// Reporting (fixed keys only; counts, enumerated words and the pinned hash; never an address, a value or driver text)
// ---------------------------------------------------------------------------------------------------------------

export const PROD_SQL_COMMANDS = ['select', 'insert', 'update', 'delete', 'create', 'alter', 'drop', 'grant', 'revoke', 'do', 'set', 'comment', 'other'] as const;
export const PROD_SQL_RESULTS = ['committed', 'rolled_back', 'rollback_not_confirmed', 'unknown', 'read_only_done'] as const;
export type ProdSqlResult = (typeof PROD_SQL_RESULTS)[number];
export const PROD_SQL_WRAPS = ['wrapped', 'own', 'read_only'] as const;
/** Every count column name that can ever be printed (derived from the table; the wrapper enumerates exactly these). */
export const PROD_SQL_COUNT_NAMES: readonly string[] = [...new Set(PROD_SQL_ACTIONS.flatMap((a) => a.countNames ?? []))];

const line = (o: Record<string, unknown>) => console.log(JSON.stringify(o));
const commandOf = (s: SqlStatement): (typeof PROD_SQL_COMMANDS)[number] => {
  const first = s.clean.toLowerCase().split(/[^a-z]+/)[0] ?? '';
  return (PROD_SQL_COMMANDS as readonly string[]).includes(first) && first !== 'other' ? (first as (typeof PROD_SQL_COMMANDS)[number]) : 'other';
};
const intOrMinusOne = (v: unknown): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : -1;
  return Number.isSafeInteger(n) && n >= 0 ? n : -1;
};

function reportStatement(plan: ProdSqlPlan, index: number, statement: SqlStatement, result: { rows?: unknown; rowCount?: unknown } | undefined): void {
  const { action } = plan;
  if (action.report === 'none') return;
  if (action.report === 'counts') {
    const rows = Array.isArray(result?.rows) ? (result.rows as Array<Record<string, unknown>>) : [];
    const counts: Record<string, number> = {};
    for (const name of action.countNames ?? []) counts[name] = rows.length === 1 ? intOrMinusOne(rows[0]?.[name]) : -1;
    line({ msg: 'prod-sql.counts', action: action.id, index, counts });
    return;
  }
  // 'shape' prints only the row count here; the rows themselves are judged by evaluateL1Shape and never printed.
  const event: Record<string, unknown> = { msg: 'prod-sql.statement', action: action.id, index, command: commandOf(statement), rows: intOrMinusOne(result?.rowCount) };
  if (action.report === 'digest') {
    try { event.digest = sha256Hex(JSON.stringify(result?.rows ?? [])); } catch { /* no digest rather than a wrong one */ }
  }
  line(event);
}

/** Prints the fixed shape event and stops (refuses) unless every check passed. */
function enforceL1Shape(action: ProdSqlAction, columnResult: unknown, tableResult: unknown): void {
  const shape = evaluateL1Shape(columnResult, tableResult);
  line({ msg: 'prod-sql.shape', action: action.id, checks: shape.checks, auth_tables: shape.authTables, auth_tables_unreviewed: shape.unreviewedAuthTables, passed: shape.passed });
  if (!shape.passed) throw new RunnerRefusal('prod_sql_l1_shape_not_ok', 'The L1 shape check did not pass (a required table or column is missing, or an auth table is unreviewed); stopping');
}

// ---------------------------------------------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------------------------------------------

/** The existing unknown result event is the final report; the executable must not relabel it as refused. */
export class ProdSqlResultUnknown extends Error {
  constructor(cause: unknown) {
    super('Production SQL COMMIT result is unknown; do not retry', { cause });
    this.name = 'ProdSqlResultUnknown';
  }
}

const LOCK_TIMEOUT_SQL = "set local lock_timeout = '10s'";

/**
 * Runs the planned statements one at a time. Any refusal or error rolls back. If the COMMIT itself fails the outcome is unknown: an event
 * says so and the caller must STOP and read the state; it is never retried and never rolled back. A COMMIT that answers with the ROLLBACK
 * tag is a definite failure. Message and severity text are never read.
 */
export async function runProdSqlPlan(client: RebuiltSqlClient, plan: ProdSqlPlan): Promise<void> {
  const { action, shape, statements } = plan;
  let ran = 0;
  let committing = false;
  const body = shape === 'own' ? statements.slice(1, -1) : statements;
  await client.query(shape === 'read_only' ? 'begin read only' : shape === 'own' ? statements[0]!.raw : 'begin');
  try {
    if (shape !== 'read_only') await client.query(LOCK_TIMEOUT_SQL);
    if (plan.gate !== undefined) {
      // The gate: the two shape selects run inside this transaction before any change; a failed check refuses and the rollback below undoes nothing but the begin.
      const gateResults: unknown[] = [];
      for (const statement of plan.gate) gateResults.push((await client.query(statement.raw))?.rows);
      enforceL1Shape(action, gateResults[0], gateResults[1]);
    }
    const shapeRows: unknown[] = [];
    for (const [i, statement] of body.entries()) {
      const result = await client.query(statement.raw);
      ran += 1;
      if (action.report === 'shape') shapeRows.push(result?.rows);
      reportStatement(plan, (shape === 'own' ? 1 : 0) + i + 1, statement, result);
    }
    if (action.report === 'shape') enforceL1Shape(action, shapeRows[0], shapeRows[1]);
    if (shape === 'read_only') {
      await client.query('rollback');
      line({ msg: 'prod-sql.result', action: action.id, result: 'read_only_done', statements: ran });
      return;
    }
    committing = true;
    const committed = await client.query(shape === 'own' ? statements[statements.length - 1]!.raw : 'commit');
    if (committed?.command === 'ROLLBACK') {
      committing = false;
      throw new RunnerRefusal('prod_sql_commit_rolled_back', 'COMMIT returned ROLLBACK; nothing committed');
    }
  } catch (err) {
    if (committing) {
      line({ msg: 'prod-sql.result', action: action.id, result: 'unknown', statements: ran });
      throw new ProdSqlResultUnknown(err);
    }
    // 'rolled_back' only when the server acknowledged the ROLLBACK; otherwise the caller still STOPS and reads the state.
    let acknowledged = true;
    await client.query('rollback').catch(() => { acknowledged = false; });
    line({ msg: 'prod-sql.result', action: action.id, result: acknowledged ? 'rolled_back' : 'rollback_not_confirmed', statements: ran });
    throw err;
  }
  line({ msg: 'prod-sql.result', action: action.id, result: 'committed', statements: ran });
}

export async function executeProdSqlPlan(plan: ProdSqlPlan, clientFactory: (db: SupabaseDbTarget) => RebuiltSqlClient): Promise<void> {
  const client = clientFactory(plan.db);
  // Without an 'error' listener a dropped connection becomes an uncaught exception. Keep it silent: only the fixed events pass the wrapper.
  (client as { on?: (event: 'error', listener: () => void) => unknown }).on?.('error', () => undefined);
  await client.connect();
  try {
    await runProdSqlPlan(client, plan);
  } finally {
    // Closing a dead connection can fail; that must never replace the real failure.
    await client.end().catch(() => undefined);
  }
}
