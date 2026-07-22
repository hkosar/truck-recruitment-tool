import { loadConfig } from './config.js';
import { closePipelineContext, createPipelineContext, type PipelineContext } from './db.js';
import { SocrataClient } from './socrata.js';
import { finishRun, startRun, type PipelineJob, type PipelineStep, type RunTotals } from './runs.js';
import { syncCensus } from './sources/census.js';
import { syncAuthority } from './sources/authority.js';
import { syncInsurance } from './sources/insurance.js';
import { syncSafety } from './sources/safety.js';
import { runGeocode } from './geocode.js';
import { runFacets } from './facets.js';
import { runDqReport } from './dq-report.js';

/**
 * Entry point: `tsx src/run.ts <nightly|monthly|backfill|STEP_NAME> [--from=step] [--pages=N]
 * [--batches=N]` (Part B §6.1/§6.4). Chain order matches Part B §2.1 exactly:
 *   nightly  = sync-census -> sync-authority -> sync-insurance -> cargo-facets -> geocode -> dq-report
 *   monthly  = sync-safety
 *   backfill = sync-census(full) -> sync-authority -> sync-insurance -> sync-safety
 *              -> geocode(all) -> cargo-facets -> dq-report
 */

const NIGHTLY_STEPS: PipelineStep[] = [
  'sync-census',
  'sync-authority',
  'sync-insurance',
  'cargo-facets',
  'geocode',
  'dq-report',
];
const MONTHLY_STEPS: PipelineStep[] = ['sync-safety'];
const BACKFILL_STEPS: PipelineStep[] = [
  'sync-census',
  'sync-authority',
  'sync-insurance',
  'sync-safety',
  'geocode',
  'cargo-facets',
  'dq-report',
];
const ALL_STEPS: PipelineStep[] = [
  'sync-census',
  'sync-authority',
  'sync-insurance',
  'sync-safety',
  'cargo-facets',
  'geocode',
  'dq-report',
];

export interface CliArgs {
  command: string;
  from?: PipelineStep;
  pages?: number;
  batches?: number;
  dryRun?: boolean;
}

function usage(): string {
  return 'Usage: tsx src/run.ts <nightly|monthly|backfill|STEP_NAME> [--from=step] [--pages=N] [--batches=N] [--dry-run=true]';
}

export function parseArgs(argv: string[]): CliArgs {
  const [command, ...rest] = argv;
  if (!command) throw new Error(usage());

  const args: CliArgs = { command };
  for (const raw of rest) {
    const stripped = raw.startsWith('--') ? raw.slice(2) : raw;
    const eq = stripped.indexOf('=');
    if (eq === -1) throw new Error(`Unrecognized argument "${raw}". ${usage()}`);
    const key = stripped.slice(0, eq);
    const value = stripped.slice(eq + 1);

    if (key === 'from') {
      if (!isPipelineStep(value)) {
        throw new Error(`--from="${value}" is not a known step (${ALL_STEPS.join(', ')})`);
      }
      args.from = value;
    } else if (key === 'pages') {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`--pages must be a positive number, got "${value}"`);
      args.pages = n;
    } else if (key === 'batches') {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`--batches must be a positive number, got "${value}"`);
      args.batches = n;
    } else if (key === 'dry-run') {
      if (value !== 'true' && value !== 'false') {
        throw new Error(`--dry-run must be true or false, got "${value}"`);
      }
      args.dryRun = value === 'true';
    } else {
      throw new Error(`Unrecognized flag "--${key}". ${usage()}`);
    }
  }
  return args;
}

function isPipelineStep(value: string): value is PipelineStep {
  return (ALL_STEPS as string[]).includes(value);
}

type StepRunner = (ctx: PipelineContext, socrata: SocrataClient, args: CliArgs) => Promise<RunTotals>;

const STEP_RUNNERS: Record<PipelineStep, StepRunner> = {
  'sync-census': async (ctx, socrata, args) => {
    const r = await syncCensus(ctx, socrata, { maxPages: args.pages });
    return {
      rows_read: r.rowsRead,
      rows_upserted: r.rowsUpserted,
      rows_changed: r.rowsUpserted,
      meta: { rowsMarkedMissing: r.rowsMarkedMissing },
    };
  },
  'sync-authority': async (ctx, socrata, args) => {
    const r = await syncAuthority(ctx, socrata, { maxPages: args.pages });
    return { rows_read: r.rowsRead, rows_upserted: r.rowsUpserted, rows_changed: r.rowsUpserted };
  },
  'sync-insurance': async (ctx, socrata, args) => {
    const r = await syncInsurance(ctx, socrata, { maxPages: args.pages, dryRun: args.dryRun });
    return {
      rows_read: r.rowsRead,
      rows_upserted: r.filingsUpserted,
      rows_changed: r.carriersRolledUp,
      meta: { filingsUpserted: r.filingsUpserted, carriersRolledUp: r.carriersRolledUp },
    };
  },
  'sync-safety': async (ctx, socrata, args) => {
    const r = await syncSafety(ctx, socrata, { maxPages: args.pages, dryRun: args.dryRun });
    return {
      rows_read: r.rowsRead,
      rows_upserted: r.rowsUpserted,
      rows_changed: r.rowsUpserted,
      meta: {
        datasetId: r.datasetId,
        ratingRowsRead: r.ratingRowsRead,
        dryRun: r.dryRun,
        validation: r.validation,
      },
    };
  },
  'cargo-facets': async (ctx) => {
    const r = await runFacets(ctx);
    return {
      rows_upserted: r.valuesUpserted,
      rows_changed: r.seedPassMatched + r.trigramPassMatched,
      meta: { ...r },
    };
  },
  geocode: async (ctx, _socrata, args) => {
    const r = await runGeocode(ctx, { maxBatches: args.batches });
    return {
      rows_read: r.candidateCount,
      rows_upserted: r.streetMatched + r.zipFallbackMatched + r.cityFallbackMatched,
      meta: { ...r },
    };
  },
  'dq-report': async (ctx) => {
    const metrics = await runDqReport(ctx);
    return {
      rows_upserted: 1,
      meta: { runDate: metrics.runDate, staleSteps: Object.entries(metrics.freshness).filter(([, v]) => v.stale).map(([k]) => k) },
    };
  },
};

/** One step: pipeline_runs start -> run -> pipeline_runs finish(success|failed) [+ alert
 *  email on failure, from within finishRun]. Rethrows on failure so the caller's chain loop
 *  stops (Part B §2.5: "throw -> chain stops"). `adhoc: true` is stamped into the finished
 *  row's meta when a single step is invoked directly (see `main`'s default branch) so a
 *  `pipeline_runs` reader isn't misled into thinking a full nightly chain ran. */
async function runStep(
  ctx: PipelineContext,
  socrata: SocrataClient,
  job: PipelineJob,
  step: PipelineStep,
  args: CliArgs,
  adhoc = false
): Promise<void> {
  const run = await startRun(ctx, job, step);
  try {
    const totals = await STEP_RUNNERS[step](ctx, socrata, args);
    const meta = {
      ...totals.meta,
      ...(adhoc ? { adhoc: true } : {}),
      ...(args.dryRun ? { dryRun: true } : {}),
    };
    await finishRun(ctx, run, 'success', { ...totals, meta });
  } catch (err) {
    await finishRun(ctx, run, 'failed', { meta: adhoc ? { adhoc: true } : undefined }, err);
    throw err;
  }
}

async function runChain(
  ctx: PipelineContext,
  socrata: SocrataClient,
  job: PipelineJob,
  steps: PipelineStep[],
  args: CliArgs
): Promise<void> {
  let startIndex = 0;
  if (args.from) {
    startIndex = steps.indexOf(args.from);
    if (startIndex === -1) {
      throw new Error(`--from=${args.from} is not a step in the '${job}' chain (${steps.join(' -> ')})`);
    }
  }
  const toRun = steps.slice(startIndex);
  ctx.log.info('chain.start', { job, steps: toRun });

  for (const step of toRun) {
    await runStep(ctx, socrata, job, step, args);
  }
  ctx.log.info('chain.complete', { job, steps: toRun });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const ctx = createPipelineContext(config, args.command);
  const socrata = new SocrataClient({ appToken: config.SOCRATA_APP_TOKEN, log: ctx.log });

  try {
    switch (args.command) {
      case 'nightly':
        await runChain(ctx, socrata, 'nightly', NIGHTLY_STEPS, args);
        break;
      case 'monthly':
        await runChain(ctx, socrata, 'monthly', MONTHLY_STEPS, args);
        break;
      case 'backfill':
        await runChain(ctx, socrata, 'backfill', BACKFILL_STEPS, args);
        break;
      default:
        // Single-step invocation for local dev/debugging (e.g. `tsx src/run.ts sync-census
        // --pages=1`) -- distinct from `nightly --from=X`, which runs X through the end of
        // the chain rather than isolating exactly one step. Logged under job='nightly' since
        // PipelineJob has no 'adhoc' member (see runs.ts) -- meta.adhoc marks it explicitly
        // so a pipeline_runs reader isn't misled into thinking a full nightly chain ran.
        if (!isPipelineStep(args.command)) {
          throw new Error(`Unknown command "${args.command}". ${usage()}`);
        }
        ctx.log.warn('run.adhoc_step', { step: args.command });
        await runStep(ctx, socrata, 'nightly', args.command, args, true);
    }
  } finally {
    await closePipelineContext(ctx);
  }
}

const isDirectInvocation = process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], 'file:').href;
if (isDirectInvocation) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', msg: 'pipeline.fatal', err: message }));
    process.exitCode = 1;
  });
}
