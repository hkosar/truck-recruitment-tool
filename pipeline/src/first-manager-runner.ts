import { pathToFileURL } from 'node:url';
import { newSecurePgClient } from './pg-secure.js';
import { RunnerRefusal, asPlanRefusal, classifyRunnerFailure } from './refusals.js';
import { FirstManagerResultUnknown, executeFirstManagerPlan, planFirstManager, selectFirstManagerDbUrl } from './first-manager-bootstrap.js';
import type { RebuiltSqlClient } from './staging-rebuilt.js';
import type { SupabaseDbTarget } from './target-guard.js';

/**
 * Command line for the first-manager bootstrap (docs/build-plan/18-first-manager-bootstrap.md). Same conventions as
 * staging-sql-runner.ts: everything is verified offline first, nothing connects without --execute, a failure is printed only as a
 * fixed identifier plus a validated code, and the connection string is never printed.
 *
 *   STAGING_DB_URL=...    npm run first-manager -- --target=staging    --action=first-manager-check|first-manager-create --confirm="..." [--execute]
 *   PRODUCTION_DB_URL=... npm run first-manager -- --target=production --action=first-manager-check|first-manager-create --confirm="..." [--execute]
 *
 * --target has no default. Run it through scripts/run-with-secrets.mjs (hidden prompt); for production only with the owner's own go.
 */

export function parseFirstManagerArgs(argv: readonly string[]): { target: string | undefined; action: string; confirm: string | undefined; execute: boolean } {
  let target: string | undefined;
  let action = '';
  let confirm: string | undefined;
  let execute = false;
  for (const arg of argv) {
    if (arg.startsWith('--target=')) target = arg.slice('--target='.length);
    else if (arg.startsWith('--action=')) action = arg.slice('--action='.length);
    else if (arg.startsWith('--confirm=')) confirm = arg.slice('--confirm='.length);
    else if (arg === '--execute') execute = true;
    else throw new RunnerRefusal('unknown_argument', 'Unknown argument');
  }
  return { target, action, confirm, execute };
}

const defaultClientFactory = (db: SupabaseDbTarget): RebuiltSqlClient =>
  // TLS verify-full against the pinned root, SCRAM-only (pg-secure.ts / db-tls.ts).
  newSecurePgClient(db);

export async function main(argv: readonly string[], env: Readonly<Record<string, string | undefined>>, clientFactory = defaultClientFactory): Promise<void> {
  const args = parseFirstManagerArgs(argv);
  const plan = asPlanRefusal(() => planFirstManager({ target: args.target, action: args.action, dbUrl: selectFirstManagerDbUrl(args.target, env), confirm: args.confirm }));
  // Never print the connection string, password, host or the address.
  console.log(JSON.stringify({ msg: 'first-manager.verified', action: plan.action, target: plan.target }));
  if (!args.execute) {
    console.log(JSON.stringify({ msg: 'first-manager.plan_only', hint: 'add --execute to run' }));
    return;
  }
  await executeFirstManagerPlan(plan, clientFactory);
  console.log(JSON.stringify({ msg: 'first-manager.done', action: plan.action, target: plan.target }));
}

const isDirectInvocation = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectInvocation) {
  main(process.argv.slice(2), process.env).catch((err: unknown) => {
    if (!(err instanceof FirstManagerResultUnknown)) console.error(JSON.stringify({ msg: 'first-manager.refused', ...classifyRunnerFailure(err) }));
    process.exitCode = 1;
  });
}
