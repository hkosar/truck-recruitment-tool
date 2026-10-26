import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { RunnerRefusal, asPlanRefusal, classifyRunnerFailure } from './refusals.js';
import { OWNER_AUTH_CREATE_ACTION, planOwnerAuthCreate, runOwnerAuthCreate } from './owner-bootstrap.js';
import { executeRebuiltSqlPlan, planRebuiltSqlRun, requireRecordedRebuiltRef } from './staging-rebuilt.js';
import { RECORDED_PROJECT_REFS, parseSupabaseDbTarget, type SupabaseDbTarget } from './target-guard.js';

/**
 * The only supported way to run the destructive staging SQL (marker install, fictional data
 * reset, fixture cleanup). It verifies the connection target BEFORE opening any connection:
 *   - STAGING_DB_URL is parsed by the same guard the pipeline uses (no query-parameter or
 *     fragment overrides; explicit host/user/port/database are what the client receives);
 *   - the production Carrier Recruiter project is refused outright;
 *   - the project must be exactly the recorded staging project;
 *   - only the session pooler / direct port 5432 is accepted, because the session settings
 *     below must stay on one server session for the whole file;
 *   - the operator must type the action's confirmation phrase.
 * Only then does it connect, set app.staging_runner_verified_ref (which every staging file
 * requires), and send the file. Without --execute it only prints the verified plan.
 *
 *   STAGING_DB_URL=... npm run staging:sql -- --action=reset --confirm="RESET FICTIONAL TNBS RECRUITER DATA" [--execute]
 */

export const STAGING_SQL_ACTIONS = {
  'install-marker': {
    file: 'install-staging-identity-marker.sql',
    confirmationSetting: 'app.staging_marker_install_confirmation',
    confirmation: 'INSTALL TNBS STAGING IDENTITY MARKER',
  },
  reset: {
    file: 'reset-fictional-data.sql',
    confirmationSetting: 'app.staging_reset_confirmation',
    confirmation: 'RESET FICTIONAL TNBS RECRUITER DATA',
  },
  cleanup: {
    file: 'cleanup-fixtures.sql',
    confirmationSetting: 'app.staging_cleanup_confirmation',
    confirmation: 'CLEAN UP TNBS RECRUITER FIXTURES',
  },
} as const;

export type StagingSqlAction = keyof typeof STAGING_SQL_ACTIONS;

export interface StagingSqlPlan {
  action: StagingSqlAction;
  file: string;
  target: SupabaseDbTarget;
  /** Session-level settings applied, in order, on the same connection before the file. */
  settings: ReadonlyArray<readonly [string, string]>;
}

export const STAGING_SQL_DIR = resolve(import.meta.dirname, '..', '..', 'supabase', 'staging');

function isStagingSqlAction(value: string): value is StagingSqlAction {
  return Object.prototype.hasOwnProperty.call(STAGING_SQL_ACTIONS, value);
}

/** Pure, offline verification. Throws before anything could connect. */
export function planStagingSqlRun(input: { action: string; dbUrl: string | undefined; confirm: string | undefined }): StagingSqlPlan {
  if (!isStagingSqlAction(input.action)) {
    throw new RunnerRefusal('unknown_action', `Unknown staging SQL action "${input.action}" (expected ${Object.keys(STAGING_SQL_ACTIONS).join(', ')})`);
  }
  if (!input.dbUrl) throw new RunnerRefusal('db_url_required', 'STAGING_DB_URL is required');
  const target = parseSupabaseDbTarget(input.dbUrl);
  if (target.projectRef === RECORDED_PROJECT_REFS.production) {
    throw new RunnerRefusal('production_refused', 'Staging SQL runner refuses the production Carrier Recruiter project');
  }
  if (target.projectRef !== RECORDED_PROJECT_REFS.staging) {
    throw new RunnerRefusal('target_not_recorded_staging', 'Staging SQL runner only targets the recorded staging project');
  }
  if (target.port !== 5432) {
    throw new RunnerRefusal('port_must_be_5432', 'Staging SQL runner requires a session connection on port 5432 (not the 6543 transaction pooler)');
  }
  const spec = STAGING_SQL_ACTIONS[input.action];
  if (input.confirm !== spec.confirmation) {
    throw new RunnerRefusal('confirmation_required', `Staging SQL runner requires --confirm="${spec.confirmation}" for ${input.action}`);
  }
  return {
    action: input.action,
    file: resolve(STAGING_SQL_DIR, spec.file),
    target,
    settings: [
      ['app.staging_runner_verified_ref', target.projectRef],
      ['app.staging_project_ref', target.projectRef],
      [spec.confirmationSetting, spec.confirmation],
    ],
  };
}

export async function executeStagingSqlPlan(plan: StagingSqlPlan): Promise<void> {
  const sql = readFileSync(plan.file, 'utf8');
  const client = new pg.Client({
    host: plan.target.host,
    port: plan.target.port,
    user: plan.target.user,
    password: plan.target.password,
    database: plan.target.database,
    // Same relaxed pooler TLS setting as the pipeline (see db.ts TODO(live-db)).
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    for (const [name, value] of plan.settings) {
      await client.query('select set_config($1, $2, false)', [name, value]);
    }
    await client.query(sql);
  } finally {
    await client.end();
  }
}

/**
 * Failures are printed ONLY as a fixed identifier plus, for a database or driver failure, a validated code (refusals.ts).
 * No part of an error message is ever forwarded, so a driver or server message cannot carry an address, account or key.
 */
function parseRunnerArgs(argv: readonly string[]): { action: string; confirm: string | undefined; execute: boolean; project: string; out: string | undefined } {
  let action = '';
  let confirm: string | undefined;
  let execute = false;
  let project = 'current';
  let out: string | undefined;
  for (const arg of argv) {
    if (arg.startsWith('--action=')) action = arg.slice('--action='.length);
    else if (arg.startsWith('--confirm=')) confirm = arg.slice('--confirm='.length);
    else if (arg.startsWith('--project=')) project = arg.slice('--project='.length);
    else if (arg.startsWith('--out=')) out = arg.slice('--out='.length);
    else if (arg === '--execute') execute = true;
    else throw new RunnerRefusal('unknown_argument', 'Unknown argument');
  }
  if (project !== 'current' && project !== 'rebuilt') throw new RunnerRefusal('bad_project_option', '--project must be current or rebuilt');
  return { action, confirm, execute, project, out };
}

async function main(): Promise<void> {
  const args = parseRunnerArgs(process.argv.slice(2));
  if (args.project === 'rebuilt' && args.action === OWNER_AUTH_CREATE_ACTION) {
    // The Supabase Auth Admin create-user call for the owner login (owner-bootstrap.ts). It needs no database login: the
    // address is always https://<recorded rebuilt ref>.supabase.co. The key and the owner password come from the hidden prompt.
    const authPlan = asPlanRefusal(() => planOwnerAuthCreate({ ref: requireRecordedRebuiltRef(), confirm: args.confirm, serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY, password: process.env.OWNER_STAGING_PASSWORD }));
    console.log(JSON.stringify({ msg: 'staging-sql.verified', action: OWNER_AUTH_CREATE_ACTION, steps: 1, target: 'recorded rebuilt staging project' }));
    if (!args.execute) {
      console.log(JSON.stringify({ msg: 'staging-sql.plan_only', hint: 'add --execute to run' }));
      return;
    }
    await runOwnerAuthCreate(authPlan);
    console.log(JSON.stringify({ msg: 'staging-sql.done', action: OWNER_AUTH_CREATE_ACTION }));
    return;
  }
  if (args.project === 'rebuilt') {
    // The rebuilt project has its own guarded planner (staging-rebuilt.ts); --out is snapshot-only.
    const rebuilt = asPlanRefusal(() => planRebuiltSqlRun({ action: args.action, dbUrl: process.env.STAGING_DB_URL, confirm: args.confirm, out: args.out }));
    console.log(JSON.stringify({ msg: 'staging-sql.verified', action: rebuilt.action, steps: rebuilt.steps.length, target: 'recorded rebuilt staging project' }));
    if (!args.execute) {
      console.log(JSON.stringify({ msg: 'staging-sql.plan_only', hint: 'add --execute to run' }));
      return;
    }
    await executeRebuiltSqlPlan(rebuilt);
    console.log(JSON.stringify({ msg: 'staging-sql.done', action: rebuilt.action }));
    return;
  }
  const plan = asPlanRefusal(() => planStagingSqlRun({ action: args.action, dbUrl: process.env.STAGING_DB_URL, confirm: args.confirm }));
  // Never print the connection string, password, or host.
  console.log(JSON.stringify({ msg: 'staging-sql.verified', action: plan.action, file: plan.file, target: 'recorded staging project' }));
  if (!args.execute) {
    console.log(JSON.stringify({ msg: 'staging-sql.plan_only', hint: 'add --execute to run' }));
    return;
  }
  await executeStagingSqlPlan(plan);
  console.log(JSON.stringify({ msg: 'staging-sql.done', action: plan.action }));
}

const isDirectInvocation = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectInvocation) {
  main().catch((err: unknown) => {
    console.error(JSON.stringify({ msg: 'staging-sql.refused', ...classifyRunnerFailure(err) }));
    process.exitCode = 1;
  });
}
