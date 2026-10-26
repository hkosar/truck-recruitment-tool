import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import pg from 'pg';
import { M1C_POSTCONDITION_SQL, M1C_STATE_PROBE_SQL, REAPPLY_POST_SQL, REAPPLY_PRECHECKS, classifyM1cState, idempotentReapplySql, type M1cStateFacts, type ReapplyTarget } from './reapply.js';
import { reportEnvironmentPreflight, runEnvironmentPreflight } from './environment-preflight.js';
import { OWNER_CHECK_CONFIRMATION, OWNER_PROMOTE_CONFIRMATION, runOwnerLoginCheck, runOwnerPromotion } from './owner-bootstrap.js';
import { reportLedgerPreflight, runLedgerPreflight } from './ledger-preflight.js';
import { MAINTENANCE_ROLE, roleOf } from './retention-step.js';
import { runRetentionDryRun, type DryRunReport } from './retention-dry-run.js';
import { RunnerRefusal } from './refusals.js';
import { RECORDED_PROJECT_REFS, parseSupabaseDbTarget, type SupabaseDbTarget } from './target-guard.js';

/**
 * Runner actions for the REBUILT staging project (doc 16 section 1.3 R1, section 5 item 1).
 * Same guards as staging-sql-runner.ts: production refused, the exact recorded ref, session
 * port 5432, typed confirmation per action, and a printed plan unless --execute is given.
 *
 * The rebuilt ref is recorded in target-guard.ts by its own reviewed commit once the owner has
 * created the project; until then every rebuilt action is refused. The existing SQL files pin
 * the OLD staging ref as a second, independent check inside the database. For the rebuilt project
 * the runner re-pins that literal to the recorded rebuilt ref in memory (the files on disk stay
 * as reviewed) and refuses if any old or production ref is left in what it would send.
 */

export const REPOSITORY_ROOT = resolve(import.meta.dirname, '..', '..');
const REBUILT_REF_PATTERN = /^[a-z]{20}$/;

type RebuiltKind = 'file' | 'migrations' | 'inline' | 'snapshot' | 'retention' | 'ledger-preflight' | 'environment-preflight' | 'owner-check' | 'owner-promote';

interface RebuiltActionSpec {
  kind: RebuiltKind;
  /** Repo-relative path for file/snapshot actions. */
  file?: string;
  /** Inline statements for `inline` actions. */
  sql?: string;
  confirmation: string;
  confirmationSetting?: string;
  /** Re-apply after a backout: the file is sent in its idempotent form (reapply.ts) behind a state precheck. */
  reapply?: ReapplyTarget;
  /** The file carries a pinned-ref gate that must be re-pinned (so it must contain the old ref). */
  pinned: boolean;
}

export const REBUILT_STAGING_SQL_ACTIONS: Readonly<Record<string, RebuiltActionSpec>> = {
  'apply-migrations': { kind: 'migrations', confirmation: 'APPLY TNBS BASELINE MIGRATIONS', pinned: false },
  // Read-only catalogue assessment of the migration ledger as the runner login; run (and PASSed by the manager) before apply-migrations --execute.
  'ledger-preflight': { kind: 'ledger-preflight', confirmation: 'RUN TNBS LEDGER PREFLIGHT', pinned: false },
  // Read-only report of event triggers, default privileges and Data API exposure (project switches the creation screen pre-selects); every line is a manager decision gate.
  'environment-preflight': { kind: 'environment-preflight', confirmation: 'RUN TNBS ENVIRONMENT PREFLIGHT', pinned: false },
  // Owner login bootstrap (doc 16 approval 4, owner-bootstrap.ts): a read-only report of the exact owner identity, and the single reviewed promotion transaction. The Auth Admin create call is owner-auth-create (no database login; staging-sql-runner.ts).
  'owner-login-check': { kind: 'owner-check', confirmation: OWNER_CHECK_CONFIRMATION, pinned: false },
  'owner-promote': { kind: 'owner-promote', confirmation: OWNER_PROMOTE_CONFIRMATION, pinned: false },
  // Connects AS recruiter_maintenance (STAGING_DB_URL must be that login): counts, never deletes.
  'retention-dry-run': { kind: 'retention', confirmation: 'RUN TNBS RETENTION DRY RUN', pinned: false },
  'install-marker': { kind: 'file', file: 'supabase/staging/install-staging-identity-marker.sql', confirmation: 'INSTALL TNBS STAGING IDENTITY MARKER', confirmationSetting: 'app.staging_marker_install_confirmation', pinned: true },
  'profile-fixtures': { kind: 'file', file: 'supabase/staging/profile-fixtures.sql', confirmation: 'INSTALL TNBS PROFILE FIXTURES', pinned: false },
  'install-shutdown-fixtures': { kind: 'file', file: 'supabase/staging/rebuild/install-shutdown-fixtures.sql', confirmation: 'INSTALL TNBS SHUTDOWN TEST FIXTURES', confirmationSetting: 'app.staging_shutdown_fixtures_confirmation', pinned: true },
  'remove-shutdown-fixtures': { kind: 'file', file: 'supabase/staging/rebuild/remove-shutdown-fixtures.sql', confirmation: 'REMOVE TNBS SHUTDOWN TEST FIXTURES', confirmationSetting: 'app.staging_shutdown_fixtures_confirmation', pinned: true },
  reset: { kind: 'file', file: 'supabase/staging/reset-fictional-data.sql', confirmation: 'RESET FICTIONAL TNBS RECRUITER DATA', confirmationSetting: 'app.staging_reset_confirmation', pinned: true },
  cleanup: { kind: 'file', file: 'supabase/staging/cleanup-fixtures.sql', confirmation: 'CLEAN UP TNBS RECRUITER FIXTURES', confirmationSetting: 'app.staging_cleanup_confirmation', pinned: true },
  'cleanup-ledgers-m1': { kind: 'file', file: 'supabase/staging/m1/cleanup-auth-ledgers-m1.sql', confirmation: 'CLEAN UP TNBS RECRUITER SIGN-IN FIXTURES', confirmationSetting: 'app.staging_auth_ledger_cleanup_confirmation', pinned: true },
  'apply-m1': { kind: 'file', file: 'supabase/pending/M1_same_origin_signin.sql', confirmation: 'APPLY TNBS M1', pinned: false },
  'apply-m1b': { kind: 'file', file: 'supabase/pending/M1b_add_person.sql', confirmation: 'APPLY TNBS M1B', pinned: false },
  'apply-m1c': { kind: 'file', file: 'supabase/pending/M1c_batch_delete_audit.sql', confirmation: 'APPLY TNBS M1C', pinned: false },
  'reapply-m1': { kind: 'file', file: 'supabase/pending/M1_same_origin_signin.sql', confirmation: 'REAPPLY TNBS M1 AFTER BACKOUT', pinned: false, reapply: 'm1' },
  'reapply-m1b': { kind: 'file', file: 'supabase/pending/M1b_add_person.sql', confirmation: 'REAPPLY TNBS M1B AFTER BACKOUT', pinned: false, reapply: 'm1b' },
  'reapply-m1c': { kind: 'file', file: 'supabase/pending/M1c_batch_delete_audit.sql', confirmation: 'REAPPLY TNBS M1C AFTER BACKOUT', pinned: false, reapply: 'm1c' },
  'role-matrix-m1': { kind: 'file', file: 'supabase/staging/m1/verify-role-matrix-m1.sql', confirmation: 'RUN TNBS M1 ROLE MATRIX', pinned: true },
  snapshot: { kind: 'snapshot', file: 'supabase/backout/pre-cutover-snapshot.sql', confirmation: 'TAKE TNBS PRE-CUTOVER SNAPSHOT', pinned: false },
  'window-on': {
    kind: 'inline',
    sql: 'update internal.backout_window set email_edits_paused = true; select email_edits_paused from internal.backout_window;',
    confirmation: 'TURN ON TNBS BACKOUT WINDOW',
    pinned: false,
  },
  'window-off': {
    kind: 'inline',
    sql: 'update internal.backout_window set email_edits_paused = false; select email_edits_paused from internal.backout_window;',
    confirmation: 'TURN OFF TNBS BACKOUT WINDOW',
    pinned: false,
  },
  'backout-m1c': { kind: 'file', file: 'supabase/backout/M1c-backout.sql', confirmation: 'RUN TNBS M1C BACKOUT', pinned: false },
  'backout-m1b': { kind: 'file', file: 'supabase/backout/M1b-backout.sql', confirmation: 'RUN TNBS M1B BACKOUT', pinned: false },
  'backout-m1': { kind: 'file', file: 'supabase/backout/M1-backout.sql', confirmation: 'RUN TNBS M1 BACKOUT', pinned: false },
};

/** One statement batch sent on the verified connection. `transaction` wraps it in begin/commit. */
export interface RebuiltSqlStep {
  label: string;
  sql: string;
  transaction: boolean;
  /** Migration replay: recorded in supabase_migrations.schema_migrations in the SAME transaction. */
  ledger?: { version: string; name: string };
}

/** Same shape the Supabase CLI keeps (and doc 09's reviewed adoption script writes): version, name, statements. */
export const LEDGER_TABLE_SQL = `
  create schema if not exists supabase_migrations;
  create table if not exists supabase_migrations.schema_migrations (version text not null primary key);
  alter table supabase_migrations.schema_migrations add column if not exists statements text[];
  alter table supabase_migrations.schema_migrations add column if not exists name text;`;
export const LEDGER_INSERT_SQL = 'insert into supabase_migrations.schema_migrations (version, name, statements) values ($1, $2, array[]::text[])';

export interface RebuiltSqlPlan {
  action: string;
  kind: RebuiltKind;
  target: SupabaseDbTarget;
  settings: ReadonlyArray<readonly [string, string]>;
  steps: readonly RebuiltSqlStep[];
  /** Snapshot only: where the rows are written. Outside the repository. */
  outPath?: string;
  /** reapply-m1c only: step index of the revoke that alone is sent when the interrupted-run state is detected. */
  m1cRecoveryStep?: number;
}

/** Re-pin the old staging ref literal in a reviewed SQL file to the rebuilt ref, in memory only. */
export function retargetSqlToRebuiltRef(sql: string, rebuiltRef: string, pinned: boolean): string {
  const { production, staging } = RECORDED_PROJECT_REFS;
  if (sql.includes(production)) throw new Error('SQL file contains the production project ref; refusing');
  if (pinned && !sql.includes(staging)) throw new Error('SQL file has no pinned staging ref to re-pin; refusing');
  const out = sql.split(staging).join(rebuiltRef);
  if (out.includes(staging)) throw new Error('old staging ref left in SQL after re-pinning; refusing');
  return out;
}

/** The reviewed checksums in docs/build-plan/migration-checksums.sha256 must match every file. */
function verifiedMigrationSteps(): RebuiltSqlStep[] {
  const dir = resolve(REPOSITORY_ROOT, 'supabase', 'migrations');
  const manifest = new Map(
    readFileSync(resolve(REPOSITORY_ROOT, 'docs', 'build-plan', 'migration-checksums.sha256'), 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '')
      .map((line) => line.split('\t') as [string, string])
  );
  const files = readdirSync(dir).filter((name) => /^\d{14}_[a-z0-9_]+\.sql$/.test(name)).sort();
  if (files.length !== manifest.size || files.some((f) => !manifest.has(f))) {
    throw new Error('migration files do not match the reviewed checksum manifest (file list differs)');
  }
  return files.map((file) => {
    const raw = readFileSync(resolve(dir, file));
    if (createHash('sha256').update(raw).digest('hex') !== manifest.get(file)) {
      throw new Error(`migration ${file} does not match its reviewed checksum`);
    }
    const sql = raw.toString('utf8');
    // Only a top-level `begin;` / `commit;` line means the file manages its own transaction (a bare
    // `begin` also starts every plpgsql body). None of the 20 does, so each is applied and recorded
    // in the ledger in one transaction; a self-managed file could not be recorded atomically.
    if (/^\s*(begin|commit)\s*;/im.test(sql)) throw new Error(`migration ${file} manages its own transaction; cannot record it in the ledger atomically`);
    const match = /^(\d{14})_([a-z0-9_]+)\.sql$/.exec(file)!;
    return { label: file, sql, transaction: true, ledger: { version: match[1]!, name: match[2]! } };
  });
}

/** The recorded rebuilt ref, or a refusal. `override` is for tests only; production code reads target-guard.ts. */
export function requireRecordedRebuiltRef(override?: string | null): string {
  const rebuiltRef = override === undefined ? RECORDED_PROJECT_REFS.stagingRebuilt : override;
  if (rebuiltRef === null) {
    throw new RunnerRefusal('ref_not_recorded', 'The rebuilt staging project ref is not recorded yet (target-guard.ts); refusing every rebuilt action');
  }
  if (!REBUILT_REF_PATTERN.test(rebuiltRef) || rebuiltRef === RECORDED_PROJECT_REFS.production || rebuiltRef === RECORDED_PROJECT_REFS.staging) {
    throw new RunnerRefusal('ref_invalid', 'The recorded rebuilt staging ref is invalid or equals a different recorded project');
  }
  return rebuiltRef;
}

/** Pure, offline verification for the rebuilt project. Throws before anything could connect. */
export function planRebuiltSqlRun(input: {
  action: string;
  dbUrl: string | undefined;
  confirm: string | undefined;
  out?: string | undefined;
  /** Tests only; production code reads the ref recorded in target-guard.ts. */
  recordedRebuiltRef?: string | null;
}): RebuiltSqlPlan {
  if (!Object.prototype.hasOwnProperty.call(REBUILT_STAGING_SQL_ACTIONS, input.action)) {
    throw new RunnerRefusal('unknown_action', `Unknown rebuilt staging SQL action "${input.action}" (expected ${Object.keys(REBUILT_STAGING_SQL_ACTIONS).join(', ')})`);
  }
  const spec = REBUILT_STAGING_SQL_ACTIONS[input.action] as RebuiltActionSpec;
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
  if (input.confirm !== spec.confirmation) {
    throw new RunnerRefusal('confirmation_required', `Staging SQL runner requires --confirm="${spec.confirmation}" for ${input.action}`);
  }
  let outPath: string | undefined;
  if (spec.kind === 'snapshot') {
    if (!input.out || !isAbsolute(input.out)) throw new Error('snapshot requires --out=<absolute path outside the repository>');
    const rel = relative(REPOSITORY_ROOT, resolve(input.out));
    if (!rel.startsWith('..') && !isAbsolute(rel)) throw new Error('snapshot output must be outside the repository');
    if (existsSync(input.out)) throw new Error('snapshot output already exists; refusing to overwrite');
    outPath = resolve(input.out);
  } else if (input.out) {
    throw new Error('--out is only valid for snapshot');
  }

  if (spec.kind === 'retention' && roleOf(target.user) !== MAINTENANCE_ROLE) {
    throw new Error(`retention-dry-run must connect as ${MAINTENANCE_ROLE} (STAGING_DB_URL user), not another role`);
  }

  let steps: RebuiltSqlStep[];
  if (spec.kind === 'retention') {
    steps = [{ label: 'retention-dry-run', sql: '', transaction: false }];
  } else if (spec.kind === 'ledger-preflight' || spec.kind === 'environment-preflight' || spec.kind === 'owner-check' || spec.kind === 'owner-promote') {
    steps = [{ label: spec.kind, sql: '', transaction: false }];
  } else if (spec.kind === 'migrations') {
    steps = verifiedMigrationSteps();
  } else if (spec.kind === 'inline') {
    steps = [{ label: input.action, sql: spec.sql as string, transaction: true }];
  } else {
    const sql = readFileSync(resolve(REPOSITORY_ROOT, spec.file as string), 'utf8');
    const retargeted = retargetSqlToRebuiltRef(sql, rebuiltRef, spec.pinned);
    steps = spec.reapply
      ? [
          { label: `${spec.file} (precheck)`, sql: REAPPLY_PRECHECKS[spec.reapply], transaction: false },
          { label: `${spec.file} (idempotent re-apply)`, sql: idempotentReapplySql(retargeted), transaction: false },
          ...(REAPPLY_POST_SQL[spec.reapply] ? [{ label: `${spec.file} (restore fresh-apply grants)`, sql: REAPPLY_POST_SQL[spec.reapply] as string, transaction: false }] : []),
        ]
      : [{ label: spec.file as string, sql: retargeted, transaction: false }];
  }
  const settings: Array<readonly [string, string]> = [
    ['app.staging_runner_verified_ref', target.projectRef],
    ['app.staging_project_ref', target.projectRef],
  ];
  if (spec.confirmationSetting) settings.push([spec.confirmationSetting, spec.confirmation]);
  return { action: input.action, kind: spec.kind, target, settings, steps, ...(outPath ? { outPath } : {}), ...(spec.reapply === 'm1c' ? { m1cRecoveryStep: steps.length - 1 } : {}) };
}

/** The part of pg.Client the executor uses; tests (and the local-database proof) inject their own. */
export interface RebuiltSqlClient {
  connect(): Promise<unknown>;
  query(sql: string, params?: unknown[]): Promise<any>;
  end(): Promise<void>;
}

const defaultClientFactory = (target: SupabaseDbTarget): RebuiltSqlClient =>
  new pg.Client({
    host: target.host,
    port: target.port,
    user: target.user,
    password: target.password,
    database: target.database,
    // Same relaxed pooler TLS setting as the pipeline (see db.ts TODO(live-db)).
    ssl: { rejectUnauthorized: false },
  });

export async function executeRebuiltSqlPlan(plan: RebuiltSqlPlan, clientFactory: (target: SupabaseDbTarget) => RebuiltSqlClient = defaultClientFactory): Promise<void> {
  const client = clientFactory(plan.target);
  await client.connect();
  try {
    if (plan.kind === 'retention') {
      const report: DryRunReport = await runRetentionDryRun(client, MAINTENANCE_ROLE);
      // Pass/fail, check counts and the per-rule would-delete counts only (rule names are repository constants).
      console.log(JSON.stringify({ msg: 'staging-sql.retention_dry_run', ok: report.ok, checks: report.checks.length, failed: report.checks.filter((c) => !c.ok).length, would_delete: report.wouldDelete }));
      if (!report.ok) throw new RunnerRefusal('retention_dry_run_failed', `retention dry run: ${report.checks.filter((c) => !c.ok).length} check(s) failed`);
      return;
    }
    for (const [name, value] of plan.settings) {
      await client.query('select set_config($1, $2, false)', [name, value]);
    }
    if (plan.kind === 'ledger-preflight') {
      await client.query('begin read only');
      try {
        const assessment = await runLedgerPreflight(client);
        reportLedgerPreflight(assessment);
        if (!assessment.ok) throw new RunnerRefusal('ledger_preflight_failed', `ledger preflight: ${assessment.checks.filter((c) => !c.ok).length} check(s) failed; the replay must not run`);
      } finally {
        await client.query('rollback');
      }
      return;
    }
    if (plan.kind === 'environment-preflight') {
      await client.query('begin read only');
      try {
        reportEnvironmentPreflight(await runEnvironmentPreflight(client));
      } finally {
        await client.query('rollback');
      }
      return;
    }
    if (plan.kind === 'owner-check') {
      await client.query('begin read only');
      try {
        await runOwnerLoginCheck(client, plan.target.projectRef);
      } finally {
        await client.query('rollback');
      }
      return;
    }
    if (plan.kind === 'owner-promote') {
      await runOwnerPromotion(client, plan.target.projectRef);
      return;
    }
    if (plan.kind === 'migrations') {
      // Same read-only assessment, in the same session, so a mismatched ledger is refused before the first file.
      await client.query('begin read only');
      let assessment;
      try {
        assessment = await runLedgerPreflight(client);
      } finally {
        await client.query('rollback');
      }
      reportLedgerPreflight(assessment);
      if (!assessment.ok) throw new RunnerRefusal('ledger_preflight_failed', `ledger preflight: ${assessment.checks.filter((c) => !c.ok).length} check(s) failed; refusing to replay`);
      // Refuse to replay onto a database that already has the baseline.
      const present = await client.query("select to_regclass('public.profiles') as t");
      if (present.rows[0]?.t !== null) throw new RunnerRefusal('profiles_already_exist', 'public.profiles already exists; the baseline replay only runs on an empty project');
      await client.query(LEDGER_TABLE_SQL);
      const recorded = await client.query('select count(*)::int as n from supabase_migrations.schema_migrations');
      if (recorded.rows[0]?.n !== 0) throw new RunnerRefusal('ledger_not_empty', 'supabase_migrations.schema_migrations is not empty; the baseline replay only runs on a clean ledger');
    }
    if (plan.kind === 'snapshot') {
      await client.query('begin read only');
      try {
        const results = await client.query(plan.steps[0]!.sql);
        const list = Array.isArray(results) ? results : [results];
        writeFileSync(
          plan.outPath as string,
          JSON.stringify(list.map((r, i) => ({ statement: i + 1, rowCount: r.rowCount, rows: r.rows })), null, 2),
          { flag: 'wx' }
        );
      } finally {
        await client.query('rollback');
      }
      return;
    }
    let steps = plan.steps;
    if (plan.m1cRecoveryStep !== undefined) {
      const probe = await client.query(M1C_STATE_PROBE_SQL);
      const { state, failed } = classifyM1cState(probe.rows[0] as M1cStateFacts);
      if (state === 'recover') {
        console.log(JSON.stringify({ msg: 'staging-sql.m1c_interrupted_run_detected' }));
        steps = [plan.steps[plan.m1cRecoveryStep]!];
      } else if (state === 'refuse') {
        console.error(JSON.stringify({ msg: 'staging-sql.m1c_partial_state_refused', failed_checks: failed }));
        throw new RunnerRefusal('m1c_state_unrecognised', 're-apply M1c refused: the retained M1c audit guards or privileges are not in a state this tool recognises (neither the backed-out state nor the interrupted-run state, or PostGIS lives outside schema public, which re-apply does not support); inspect by hand');
      }
    }
    for (const step of steps) {
      if (step.transaction) await client.query('begin');
      try {
        await client.query(step.sql);
        if (step.ledger) await client.query(LEDGER_INSERT_SQL, [step.ledger.version, step.ledger.name]);
        if (step.transaction) await client.query('commit');
      } catch (err) {
        if (step.transaction) await client.query('rollback').catch(() => undefined);
        // Stop on the first failure; name the step but never echo SQL or connection details.
        console.error(JSON.stringify({ msg: 'staging-sql.step_failed', step: step.label }));
        throw err;
      }
      console.log(JSON.stringify({ msg: 'staging-sql.step_done', step: step.label }));
    }
    if (plan.kind === 'migrations' && steps === plan.steps) {
      // The full set, not a count: the ledger must hold exactly the reviewed (version, name) pairs, in order.
      const got = await client.query('select version, name from supabase_migrations.schema_migrations order by version');
      const want = plan.steps.map((st) => `${st.ledger!.version}|${st.ledger!.name}`);
      const have = (got.rows as Array<{ version: string; name: string }>).map((r) => `${r.version}|${r.name}`);
      const same = have.length === want.length && have.every((v, i) => v === want[i]);
      console.log(JSON.stringify({ msg: 'staging-sql.ledger_verified', expected: want.length, found: have.length, exact_match: same }));
      if (!same) throw new RunnerRefusal('ledger_not_exact', 'migration ledger does not hold exactly the reviewed (version, name) pairs');
    }
    if (plan.m1cRecoveryStep !== undefined) {
      const after = await client.query(M1C_POSTCONDITION_SQL);
      if (after.rows[0]?.service_role_execute !== false) {
        console.error(JSON.stringify({ msg: 'staging-sql.m1c_postcondition_failed' }));
        throw new RunnerRefusal('m1c_postcondition_failed', 're-apply M1c: the revoke ran but service_role still has effective EXECUTE on the trigger function; inspect by hand');
      }
      console.log(JSON.stringify({ msg: 'staging-sql.m1c_postcondition_ok' }));
    }
  } finally {
    await client.end();
  }
}
