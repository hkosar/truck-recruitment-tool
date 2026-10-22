import type { PipelineContext } from './db.js';

/**
 * Monthly safety snapshot, carried by the one nightly Render cron (render.yaml has a single
 * cron on purpose; 04-costs.md §7 rule 6). Controlled by PIPELINE_NIGHTLY_SAFETY:
 *   - 'off'     (default): nightly never touches safety -- the same behaviour as before.
 *   - 'dry-run': after the nightly chain, run sync-safety in dry-run mode (stages and validates
 *                the full source, writes nothing to carrier_safety) once per monthly window.
 *   - 'on':      after the nightly chain, run the real sync-safety once per monthly window.
 *
 * The monthly window opens at 00:00 UTC on the 5th (Part B §6.3 `pipeline-monthly-safety`,
 * "0 8 5 * *"). Safety is due when no qualifying success has finished since the window opened,
 * so a failed attempt retries the next night instead of waiting a month, and switching to 'on'
 * for the first time runs on the very next nightly.
 *
 * Deliberate reload (after a rollback emptied carrier_safety): set PIPELINE_SAFETY_RELOAD_AFTER
 * to the time of the rollback. Successes that finished at or before it stop counting, so the next
 * nightly reloads once; that new success is later than the setting, so it is naturally one-shot.
 * pipeline_runs is never edited or deleted for this -- it stays the audit trail.
 */
export type NightlySafetyMode = 'off' | 'dry-run' | 'on';

export const SAFETY_WINDOW_DAY = 5;

/** Start of the monthly window that `now` falls in (UTC). */
export function safetyWindowStart(now: Date): Date {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const start = new Date(Date.UTC(year, month, SAFETY_WINDOW_DAY));
  return now.getTime() >= start.getTime() ? start : new Date(Date.UTC(year, month - 1, SAFETY_WINDOW_DAY));
}

export function isSafetyDue(now: Date, lastQualifyingSuccessAt: Date | null): boolean {
  return lastQualifyingSuccessAt === null || lastQualifyingSuccessAt.getTime() < safetyWindowStart(now).getTime();
}

/**
 * Latest sync-safety success that counts toward the current mode. Only full runs of the
 * current source contract qualify: `datasetIds` marks the reviewed AB + C source (older rows
 * used a different dataset), and a `pages` cap marks a partial smoke run. In 'on' mode a dry
 * run does not count; in 'dry-run' mode either kind does, so the dry run happens once a window.
 */
export function buildLastSafetySuccessSql(): string {
  return `
select max(finished_at) as last_success_at
from public.pipeline_runs
where step = 'sync-safety'
  and status = 'success'
  and meta ? 'datasetIds'
  and meta->'pages' is null
  and ($1::boolean or coalesce(meta->>'dryRun', 'false') <> 'true')
  and ($2::timestamptz is null or finished_at > $2::timestamptz)
  `.trim();
}

export async function findLastSafetySuccess(
  ctx: PipelineContext,
  includeDryRuns: boolean,
  reloadAfter: Date | null = null
): Promise<Date | null> {
  const result = await ctx.pg.query(buildLastSafetySuccessSql(), [includeDryRuns, reloadAfter?.toISOString() ?? null]);
  const value = result.rows[0]?.last_success_at as Date | string | null | undefined;
  return value ? new Date(value) : null;
}

/** A future value would make every nightly reload until then, so it is refused loudly. */
export function parseReloadAfter(value: string | undefined, now: Date): Date | null {
  if (!value) return null;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) throw new Error('PIPELINE_SAFETY_RELOAD_AFTER is not a valid time');
  if (at.getTime() > now.getTime()) {
    throw new Error(`PIPELINE_SAFETY_RELOAD_AFTER (${at.toISOString()}) is in the future; set it to the rollback time`);
  }
  return at;
}

export interface NightlySafetyDecision {
  run: boolean;
  dryRun: boolean;
  reason: string;
}

export async function decideNightlySafety(
  ctx: PipelineContext,
  mode: NightlySafetyMode,
  now = new Date()
): Promise<NightlySafetyDecision> {
  if (mode === 'off') return { run: false, dryRun: false, reason: 'PIPELINE_NIGHTLY_SAFETY=off' };
  const dryRun = mode === 'dry-run';
  const reloadAfter = parseReloadAfter(ctx.config.PIPELINE_SAFETY_RELOAD_AFTER, now);
  const last = await findLastSafetySuccess(ctx, dryRun, reloadAfter);
  if (!isSafetyDue(now, last)) {
    return { run: false, dryRun, reason: `already succeeded at ${last?.toISOString()} in this monthly window` };
  }
  return { run: true, dryRun, reason: last
      ? `last success ${last.toISOString()} is before this window`
      : reloadAfter
        ? `no qualifying success after PIPELINE_SAFETY_RELOAD_AFTER=${reloadAfter.toISOString()}`
        : 'no prior success' };
}
