import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { RunnerRefusal, asPlanRefusal, classifyRunnerFailure } from './refusals.js';
import { ProdSqlResultUnknown, emitIrreversibleWarning, executeProdSqlPlan, planProdSql, selectProdSqlDbUrl, type ProdSqlFiles } from './prod-sql.js';
import type { RebuiltSqlClient } from './staging-rebuilt.js';
import type { SupabaseDbTarget } from './target-guard.js';

/**
 * Command line for the guarded production SQL runner (docs/build-plan/18-production-sql-route-options.md, Route A).
 * BUILT, PENDING REVIEW AND HUNTER'S OPEN-1 CHOICE. Same conventions as first-manager-runner.ts: everything is verified offline first,
 * nothing connects without --execute, a failure is printed only as a fixed identifier plus a validated code, and the connection string
 * is never printed.
 *
 *   PRODUCTION_DB_URL=... npm run prod-sql -- --target=production --action=<id> --confirm="<that action's phrase>" [--execute]
 *
 * --target has no default. Run it through scripts/run-with-secrets.mjs (hidden prompt, --secret PRODUCTION_DB_URL), and only with the
 * owner's own go for that one step.
 */

export function parseProdSqlArgs(argv: readonly string[]): { target: string | undefined; action: string; confirm: string | undefined; execute: boolean } {
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
  new pg.Client({
    host: db.host, port: db.port, user: db.user, password: db.password, database: db.database,
    // Same relaxed pooler TLS setting as the other runners (see db.ts TODO(live-db)).
    ssl: { rejectUnauthorized: false },
  });

export async function main(argv: readonly string[], env: Readonly<Record<string, string | undefined>>, clientFactory = defaultClientFactory, files?: ProdSqlFiles): Promise<void> {
  const args = parseProdSqlArgs(argv);
  const plan = asPlanRefusal(() => planProdSql({ target: args.target, action: args.action, dbUrl: selectProdSqlDbUrl(env), confirm: args.confirm, files }));
  // Never print the connection string, password, host or address. The hash is repository content.
  console.log(JSON.stringify({ msg: 'prod-sql.verified', action: plan.action.id, target: plan.target, statements: plan.statements.length, wrap: plan.shape, sha256: plan.sha256 }));
  // An irreversible action (ending connections) says so here, with the plan and before anything connects, for plan-only and --execute alike.
  emitIrreversibleWarning(plan.action, 'connections_end_cannot_be_undone');
  if (!args.execute) {
    console.log(JSON.stringify({ msg: 'prod-sql.plan_only', hint: 'add --execute to run' }));
    return;
  }
  await executeProdSqlPlan(plan, clientFactory);
  console.log(JSON.stringify({ msg: 'prod-sql.done', action: plan.action.id, target: plan.target }));
}

const isDirectInvocation = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectInvocation) {
  main(process.argv.slice(2), process.env).catch((err: unknown) => {
    if (!(err instanceof ProdSqlResultUnknown)) console.error(JSON.stringify({ msg: 'prod-sql.refused', ...classifyRunnerFailure(err) }));
    process.exitCode = 1;
  });
}
