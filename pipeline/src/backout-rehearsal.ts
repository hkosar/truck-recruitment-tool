import { createHash } from 'node:crypto';
import { RunnerRefusal } from './refusals.js';
import { splitSqlStatements, sqlControl, type SqlStatement } from './prod-sql-split.js';
import type { RebuiltSqlClient } from './staging-rebuilt.js';

/**
 * Backout-rehearsal pieces of the REBUILT staging runner (doc 16 section 3.3, approval 15, T-REPLAY; manager runbook v3 section 7 gaps):
 *   - retire-app-credentials: supabase/backout/retire-app-credentials.sql, its own steps 2-6 in the file's fixed order (step 1, stopping
 *     the pool, is outside SQL and is the operator's). Same file pin and the same stage boundaries and stage pins as the production
 *     runner's retire-* actions (prod-sql.ts; a test keeps them equal), so both runners send the identical reviewed statements;
 *   - identity-alignment-check: supabase/rollout/read-only-inventory.sql (pinned), read-only, reduced to the identity-alignment counts;
 *   - the backout-window read-back (window-on / window-off): the flag is read inside the transaction and printed as one fixed line;
 *   - postgis-placement: the schema of the PostGIS extension, read-only, as one enumerated word (doc 16 section 1.4 step 5).
 * Every printed line is a fixed event of counts, booleans and enumerated words: never a URL, password, id, email, pid or row text.
 */

const sha256Hex = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');
/** The same stage pin as prod-sql.ts stageDigest: SHA-256 over the stage's statements as sent, separated by a NUL character. */
export const retireStageDigest = (statements: readonly SqlStatement[]): string => sha256Hex(statements.map((s) => s.raw).join('\u0000'));

export const RETIRE_FILE = 'supabase/backout/retire-app-credentials.sql';
export const RETIRE_FILE_SHA256 = '3e716371979ffb876bb54f7ab91753eced9b89df15276c9d6d4ba7cc0ef7fa15';
export const RETIRE_STATEMENT_COUNT = 12;

export type RetireStageName = 'nologin' | 'terminate' | 'backends' | 'revoke' | 'checks' | 'email';
/** The file's own steps, by 1-based statement range; each range and pin equals the production runner's retire-* action of the same step. */
export const RETIRE_STAGES: ReadonlyArray<{ name: RetireStageName; label: string; statements: readonly [number, number]; sha256: string; prodAction: string }> = [
  { name: 'nologin', label: 'retire-step-2-nologin', statements: [1, 1], sha256: '6df1df01d959cec06fa2f00c92114f91ff38a4ab422534b70051089cbc257f6f', prodAction: 'retire-nologin' },
  { name: 'terminate', label: 'retire-step-3-terminate', statements: [2, 2], sha256: 'c9442fb30289dbf20fc87d8dfc35b37bbd68effaca248b85353b555e61cc343d', prodAction: 'retire-terminate' },
  { name: 'backends', label: 'retire-step-3-poll', statements: [3, 3], sha256: '44029a911f4c244209dae3539bac1bf7748ccea2caca5ca1aa6d1050db5f96d9', prodAction: 'retire-backends' },
  { name: 'revoke', label: 'retire-step-4-revoke', statements: [4, 10], sha256: 'e3e17e9e9a22c367c76b8682bd72ef993c6099cfa2f20e86fc5a3e9d1a5a2e24', prodAction: 'retire-revoke' },
  { name: 'checks', label: 'retire-step-5-checks', statements: [11, 11], sha256: 'd46b5cd6f8b6991178dedfb8d545b533835d4e834b7406db05e65d87af319a96', prodAction: 'retire-checks' },
  { name: 'email', label: 'retire-step-6-email', statements: [12, 12], sha256: '86a09b805eebd79a673415a77492bd2d50cd38211ba8677b0dd6b3e1088af0f2', prodAction: 'retire-email' },
];

export type RetireStages = Readonly<Record<RetireStageName, readonly SqlStatement[]>>;

/** Pure: verifies the pinned file and splits it into its six stages. Throws (plan_refused) on any mismatch. */
export function splitRetireFile(bytes: Buffer): RetireStages {
  if (sha256Hex(bytes) !== RETIRE_FILE_SHA256) throw new Error(`${RETIRE_FILE} does not match its pinned SHA-256; refusing`);
  const all = splitSqlStatements(bytes.toString('utf8'));
  if (all.length !== RETIRE_STATEMENT_COUNT) throw new Error(`${RETIRE_FILE} does not split into the reviewed ${RETIRE_STATEMENT_COUNT} statements; refusing`);
  const out = {} as Record<RetireStageName, SqlStatement[]>;
  for (const stage of RETIRE_STAGES) {
    const statements = all.slice(stage.statements[0] - 1, stage.statements[1]);
    if (retireStageDigest(statements) !== stage.sha256) throw new Error(`${RETIRE_FILE} stage ${stage.label} does not match its pinned SHA-256; refusing`);
    out[stage.name] = statements;
  }
  // The revoke stage is the file's own one transaction (begin ... commit); every other stage is one statement with no transaction control.
  const revoke = out.revoke.map(sqlControl);
  if (revoke[0] !== 'begin' || revoke[revoke.length - 1] !== 'commit' || revoke.slice(1, -1).some((c) => c !== null)) throw new Error('the revoke stage is not one begin ... commit transaction; refusing');
  if (RETIRE_STAGES.some((s) => s.name !== 'revoke' && out[s.name].some((st) => sqlControl(st) !== null))) throw new Error('a single-statement retire stage carries transaction control; refusing');
  return out;
}

/** A whole-number count from a pg result cell (bigint arrives as text). Null when it is anything else. */
export function countOf(v: unknown): number | null {
  const x = typeof v === 'string' && /^\d{1,9}$/.test(v) ? Number(v) : v;
  return typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 && x <= 1_000_000_000 ? x : null;
}
const lastResult = (result: unknown): { rows?: Array<Record<string, unknown>>; rowCount?: number | null; command?: string } | undefined => {
  const list = Array.isArray(result) ? result : [result];
  return list[list.length - 1] as { rows?: Array<Record<string, unknown>>; rowCount?: number | null; command?: string } | undefined;
};
const shown = (n: number | null): number | 'unreadable' => (n === null ? 'unreadable' : n);

export interface RetireOptions {
  /** Waits between polls (real: setTimeout). */
  sleep?: (ms: number) => Promise<void>;
  /** Monotonic milliseconds (real: performance.now). */
  now?: () => number;
  pollIntervalMs?: number;
  maxWaitMs?: number;
}
/** The file's own rule: poll once a second, continue only after three zero reads in a row, stop after 60 seconds without that. */
export const RETIRE_POLL_INTERVAL_MS = 1000;
export const RETIRE_MAX_WAIT_MS = 60_000;
export const RETIRE_ZERO_READS_REQUIRED = 3;

const done = (label: string) => console.log(JSON.stringify({ msg: 'staging-sql.step_done', step: label }));
const labelOf = (name: RetireStageName) => RETIRE_STAGES.find((s) => s.name === name)!.label;

/**
 * Runs the file's steps 2-6 in order on one connection. Step 2 commits on its own; step 3 ends the app role's connections (cannot be
 * undone) and then polls until the count reads 0 three times in a row (else refuses: nothing after it runs); step 4 is the file's own
 * transaction (any failure is rolled back); steps 5 and 6 are the read checks, all of which must be 0.
 */
export async function runRetireAppCredentials(client: RebuiltSqlClient, stages: RetireStages, opts: RetireOptions = {}): Promise<void> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => performance.now());
  const interval = opts.pollIntervalMs ?? RETIRE_POLL_INTERVAL_MS;
  const maxWait = opts.maxWaitMs ?? RETIRE_MAX_WAIT_MS;
  const single = async (name: RetireStageName): Promise<unknown> => {
    try {
      return await client.query(stages[name][0]!.raw);
    } catch (err) {
      console.error(JSON.stringify({ msg: 'staging-sql.step_failed', step: labelOf(name) }));
      throw err;
    }
  };

  await single('nologin');
  done(labelOf('nologin'));

  const terminated = lastResult(await single('terminate'));
  // Only how many backends were signalled; the pids and per-row flags are dropped here.
  console.log(JSON.stringify({ msg: 'staging-sql.retire_terminate', backends_signalled: Array.isArray(terminated?.rows) ? terminated!.rows.length : 0 }));
  done(labelOf('terminate'));

  const started = now();
  let zeros = 0;
  let polls = 0;
  let last: number | null = null;
  for (;;) {
    last = countOf(lastResult(await single('backends'))?.rows?.[0]?.recruiter_app_backends);
    polls += 1;
    zeros = last === 0 ? zeros + 1 : 0;
    if (zeros >= RETIRE_ZERO_READS_REQUIRED) break;
    if (now() - started >= maxWait) {
      console.error(JSON.stringify({ msg: 'staging-sql.retire_backends', ok: false, polls, zero_reads_in_a_row: zeros, last_count: shown(last) }));
      throw new RunnerRefusal('retire_backends_not_gone', 'retire-app-credentials: the app role still had connections (or the count was unreadable) after the wait limit; steps 4-6 were not run; STOP and escalate');
    }
    await sleep(interval);
  }
  console.log(JSON.stringify({ msg: 'staging-sql.retire_backends', ok: true, polls, zero_reads_in_a_row: zeros, last_count: 0 }));
  done(labelOf('backends'));

  // The file's own transaction, statement by statement; the four update row counts are kept (numbers only).
  const revoked: number[] = [];
  try {
    for (const st of stages.revoke) {
      const r = lastResult(await client.query(st.raw));
      if (/^\s*update\b/i.test(st.clean)) revoked.push(typeof r?.rowCount === 'number' ? r.rowCount : -1);
      if (sqlControl(st) === 'commit' && r?.command !== undefined && r.command !== 'COMMIT') throw new Error('the revoke transaction did not commit');
    }
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    console.error(JSON.stringify({ msg: 'staging-sql.step_failed', step: labelOf('revoke') }));
    throw err;
  }
  console.log(JSON.stringify({ msg: 'staging-sql.retire_revoked', sessions: revoked[0] ?? -1, links: revoked[1] ?? -1, recovery_sets: revoked[2] ?? -1, codes: revoked[3] ?? -1 }));
  done(labelOf('revoke'));

  const checkRow = lastResult(await single('checks'))?.rows?.[0] ?? {};
  const emailRow = lastResult(await single('email'))?.rows?.[0] ?? {};
  const counts = {
    backends: countOf(checkRow.backends), live_sessions: countOf(checkRow.live_sessions), live_links: countOf(checkRow.live_links), live_codes: countOf(checkRow.live_codes),
    email_mismatches: countOf(emailRow.email_mismatches),
  };
  const ok = Object.values(counts).every((n) => n === 0);
  const event = { msg: 'staging-sql.retire_checks', ok, backends: shown(counts.backends), live_sessions: shown(counts.live_sessions), live_links: shown(counts.live_links), live_codes: shown(counts.live_codes), email_mismatches: shown(counts.email_mismatches) };
  if (!ok) {
    console.error(JSON.stringify(event));
    throw new RunnerRefusal('retire_checks_failed', 'retire-app-credentials: a step 5 or step 6 check is not 0 (or unreadable); do not continue the backout');
  }
  console.log(JSON.stringify(event));
  done(labelOf('checks'));
  done(labelOf('email'));
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Identity alignment (doc 16 section 3.3: "profiles.email = auth.users.email for every approved profile"; doc 14 section 11.5 step 3;
// doc 17 BO3). The reviewed read-only file is read-only-inventory.sql (pinned; it references no M1 object, so it runs the same before
// and after the backouts). Only five numbers leave this function.

export const IDENTITY_ALIGNMENT_FILE = 'supabase/rollout/read-only-inventory.sql';
export const IDENTITY_ALIGNMENT_SHA256 = '50e6cd622a4d34fe9d50c53ef95205f517af82e8b365878a29a878d4b73d48e1';
const APPROVED_COLUMNS = ['profiles_manager_approved', 'profiles_edit_approved', 'profiles_view_approved', 'profiles_guest_approved'] as const;

export interface IdentityAlignment { approved_profiles: number; email_mismatches: number; approved_profiles_without_auth_user: number; approved_auth_email_null: number }

/** The counts from the inventory's one row; null when the row is missing or any needed count is not a whole number. */
export function readIdentityAlignment(result: unknown): IdentityAlignment | null {
  const r = lastResult(result);
  if (!Array.isArray(r?.rows) || r!.rows.length !== 1) return null;
  const row = r!.rows[0]!;
  const approved = APPROVED_COLUMNS.map((c) => countOf(row[c]));
  const mismatches = countOf(row.email_mismatches);
  const without = countOf(row.approved_profiles_without_auth_user);
  const nullEmail = countOf(row.approved_auth_email_null);
  if (approved.some((n) => n === null) || mismatches === null || without === null || nullEmail === null) return null;
  return { approved_profiles: (approved as number[]).reduce((a, b) => a + b, 0), email_mismatches: mismatches, approved_profiles_without_auth_user: without, approved_auth_email_null: nullEmail };
}

/**
 * Pass rule: email_mismatches = 0 and approved_auth_email_null = 0 (both are STOPs in doc 17 BO3). approved_profiles_without_auth_user is
 * printed but not judged here: the expected staging value is not pinned by any reviewed doc (people added under M1b and an owner without
 * an Auth user are outside the join by construction; doc 15 section 32, doc 17 BO3), so the manager reads it.
 */
export function reportIdentityAlignment(a: IdentityAlignment | null): void {
  if (a === null) {
    console.error(JSON.stringify({ msg: 'staging-sql.identity_alignment', ok: false, approved_profiles: 'unreadable', email_mismatches: 'unreadable', approved_profiles_without_auth_user: 'unreadable', approved_auth_email_null: 'unreadable' }));
    throw new RunnerRefusal('identity_alignment_result_missing', 'identity alignment: no well-formed result row came back; nothing was proved');
  }
  const ok = a.email_mismatches === 0 && a.approved_auth_email_null === 0;
  const event = JSON.stringify({ msg: 'staging-sql.identity_alignment', ok, ...a });
  if (!ok) {
    console.error(event);
    throw new RunnerRefusal('identity_alignment_failed', `identity alignment: ${a.email_mismatches} mismatch(es), ${a.approved_auth_email_null} approved profile(s) with a null Auth email`);
  }
  console.log(event);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Backout window read-back (doc 16 section 3.1 "Verify": select email_edits_paused from internal.backout_window -> true / false).

export interface BackoutWindowReadBack { value: boolean | 'unknown'; rows: number }

/** The verify select is the last result of the inline batch; exactly one boolean row is a definite value, anything else is 'unknown'. */
export function readBackoutWindowFlag(result: unknown): BackoutWindowReadBack {
  const r = lastResult(result);
  const rows = Array.isArray(r?.rows) ? r!.rows : [];
  const v = rows.length === 1 ? rows[0]!.email_edits_paused : undefined;
  return { value: typeof v === 'boolean' ? v : 'unknown', rows: rows.length };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// PostGIS placement (doc 16 section 1.4 step 5; doc 15 "Live placement check"). The schema name is reduced to one enumerated word.

export const POSTGIS_PLACEMENT_SQL = "select n.nspname::text as schema_name from pg_catalog.pg_extension e join pg_catalog.pg_namespace n on n.oid = e.extnamespace where e.extname = 'postgis'";
export const POSTGIS_SCHEMAS = ['public', 'extensions', 'other', 'absent'] as const;
export type PostgisSchema = (typeof POSTGIS_SCHEMAS)[number];

export function classifyPostgisPlacement(result: unknown): PostgisSchema {
  const rows = lastResult(result)?.rows ?? [];
  if (rows.length === 0) return 'absent';
  const name = rows.length === 1 ? rows[0]!.schema_name : undefined;
  return name === 'public' || name === 'extensions' ? name : 'other';
}
