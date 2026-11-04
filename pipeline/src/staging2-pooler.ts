import { isLoopbackHost } from './db-tls.js';
import { RunnerRefusal } from './refusals.js';
import { isStaging2PoolerAddress, namesRebuiltStaging } from './target-guard.js';

/**
 * Staging-2 is reached only through the session pooler (target-guard.ts STAGING2_POOLER_ADDRESS): a target that points at
 * staging-2 by any other host or port is refused here, before a client exists. Called by:
 *  - pg-secure.ts securePgConfig, which every pg client and pool in the pipeline is configured through;
 *  - the staging-2 planners, so a plan-only run refuses too;
 *  - the app server's Database constructor (app/server/db/database.ts), before its pg.Pool is built.
 * It lives in this module, with no import of pg, so the app can use the one copy. The app launcher
 * (scripts/run-app-staging.mjs) applies the same isStaging2PoolerAddress rule with the same id before it starts the app.
 * Fixed text only: never the host, user, password or project ref. Other projects are not affected.
 * Local test databases are not the hosted project: a loopback host, or a name under the reserved `.invalid` top-level domain
 * (RFC 6761: never resolves; the TLS test kit redirects it to a local fake server), is left to db-tls.ts. The planners still
 * refuse both, because parseSupabaseDbTarget accepts only Supabase hosts.
 */
export function refuseStaging2UnlessPooler(target: { host: string; port: number; user: string; projectRef?: string }): void {
  const host = String(target.host).toLowerCase();
  if (isLoopbackHost(host) || host.endsWith('.invalid')) return;
  if (namesRebuiltStaging(target) && !isStaging2PoolerAddress(target)) {
    throw new RunnerRefusal('staging2_pooler_required', 'refusing: staging-2 is reached only through the Supabase session pooler (pooler host, port 5432)');
  }
}
