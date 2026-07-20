import type { PipelineContext } from './db.js';

/**
 * `pipeline_runs`: the operational run log this file reads/writes. RESOLVED (M2 task #20,
 * reconciliation amendment #21): the Part A ↔ Part B drift this comment used to flag is fixed
 * in supabase/migrations/20260720001400_pipeline_tables.sql. That migration adds
 * `pipeline_runs` with exactly the columns used below — id, job (pipeline_job), step
 * (pipeline_step), status (run_status running|success|failed), started_at, finished_at,
 * rows_read, rows_upserted, rows_changed, error, meta jsonb — the table every M2.x acceptance
 * criterion targets. The shipped-but-unused `sync_runs` table was redefined there as a
 * security_invoker VIEW over pipeline_runs (latest run per sync_source) so the G10 UI-footer
 * freshness contract keeps one source of truth: this pipeline writes `pipeline_runs`; the app
 * reads `sync_runs`.
 */
const PIPELINE_RUNS_TABLE = 'pipeline_runs';

export type PipelineJob = 'nightly' | 'monthly' | 'backfill';

export type PipelineStep =
  | 'sync-census'
  | 'sync-authority'
  | 'sync-insurance'
  | 'sync-safety'
  | 'cargo-facets'
  | 'geocode'
  | 'dq-report';

export type RunStatus = 'running' | 'success' | 'failed';

export interface RunRecord {
  id: number;
  job: PipelineJob;
  step: PipelineStep;
  started_at: string;
}

export interface RunTotals {
  rows_read?: number;
  rows_upserted?: number;
  rows_changed?: number;
  meta?: Record<string, unknown>;
}

function errorToMessage(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

/** Insert the `running` row at step start. See the schema-drift TODO above. */
export async function startRun(ctx: PipelineContext, job: PipelineJob, step: PipelineStep): Promise<RunRecord> {
  const { data, error } = await ctx.supabase
    .from(PIPELINE_RUNS_TABLE)
    .insert({ job, step, status: 'running', started_at: new Date().toISOString() })
    .select('id, job, step, started_at')
    .single();

  if (error || !data) {
    throw new Error(`startRun: insert into ${PIPELINE_RUNS_TABLE} failed: ${error?.message ?? 'no row returned'}`);
  }
  ctx.log.info('run.start', { job, step, runId: data.id });
  // Double-cast through `unknown`: without a generated `Database` type wired into
  // `createClient` (no generated-types milestone yet), the exact shape TS infers for `data`
  // is whatever supabase-js's un-parameterized default resolves to -- robust either way
  // rather than betting on a direct `as RunRecord` being accepted.
  return data as unknown as RunRecord;
}

/**
 * Mark a run finished (success or failed) and, on failure, fire the alert email.
 * Alerting failures are logged but never rethrown -- an email provider outage must not be
 * the reason a Render Cron Job's own non-zero exit code / failure notification is swallowed
 * (Part B §2.5: "belt + suspenders").
 */
export async function finishRun(
  ctx: PipelineContext,
  run: RunRecord,
  status: Extract<RunStatus, 'success' | 'failed'>,
  totals: RunTotals = {},
  error?: unknown
): Promise<void> {
  const errorMessage = error === undefined ? null : errorToMessage(error);

  const { error: updateError } = await ctx.supabase
    .from(PIPELINE_RUNS_TABLE)
    .update({
      status,
      finished_at: new Date().toISOString(),
      rows_read: totals.rows_read ?? null,
      rows_upserted: totals.rows_upserted ?? null,
      rows_changed: totals.rows_changed ?? null,
      error: errorMessage,
      meta: totals.meta ?? {},
    })
    .eq('id', run.id);

  if (updateError) {
    ctx.log.error('run.finish_update_failed', { runId: run.id, dbError: updateError.message });
  }
  ctx.log.info('run.finish', { job: run.job, step: run.step, runId: run.id, status, ...totals });

  if (status === 'failed') {
    await sendFailureEmail(ctx, run, errorMessage ?? 'unknown error', totals).catch((sendErr: unknown) => {
      ctx.log.error('run.alert_email_failed', { runId: run.id, sendErr: errorToMessage(sendErr) });
    });
  }
}

/**
 * Resend failure email (Part B §2.5: "email via Resend (RESEND_API_KEY, ALERT_EMAIL) with
 * job/step/error/row counts"). Exported standalone (not just called from `finishRun`) so
 * `checkStaleness` (below) can reuse it for the watchdog alert, which isn't tied to any one
 * run row.
 */
export async function sendFailureEmail(
  ctx: PipelineContext,
  run: Pick<RunRecord, 'job' | 'step'>,
  errorMessage: string,
  totals: RunTotals = {}
): Promise<void> {
  const subject = `[Twisted Nail pipeline] ${run.job}/${run.step} FAILED`;
  const text = [
    `Job: ${run.job}`,
    `Step: ${run.step}`,
    `Rows read: ${totals.rows_read ?? 'n/a'}`,
    `Rows upserted: ${totals.rows_upserted ?? 'n/a'}`,
    `Rows changed: ${totals.rows_changed ?? 'n/a'}`,
    '',
    'Error:',
    errorMessage,
  ].join('\n');

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ctx.config.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      // TODO(owner-input): confirm the verified "from" sending address once the Resend
      // account + twistednail.com DNS records exist (00-master-plan §3: "During M4-M5 ...
      // Resend account + DNS records for offers.twistednail.com"). This pipeline's alert
      // mail is operational (not the F10 marketing sends, which use offers.*), but it still
      // needs to originate from a domain THIS Resend account has verified, or the send
      // itself will bounce/reject. A plausible operational subdomain is
      // "pipeline.twistednail.com" or reusing "offers.twistednail.com" -- owner/DevOps
      // decision, not this pipeline's to make silently.
      from: 'Twisted Nail Pipeline <pipeline-alerts@twistednail.com>',
      to: [ctx.config.ALERT_EMAIL],
      subject,
      text,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend send failed: ${res.status} ${res.statusText} ${body}`);
  }
}

/**
 * Staleness watchdog (Part B §2.5: "if sync-census last success > 48h -> alert even if
 * today's run 'succeeded' vacuously"). Called from dq-report.ts for each upstream step it
 * cares about.
 */
export async function checkStaleness(
  ctx: PipelineContext,
  step: PipelineStep,
  maxAgeHours = 48
): Promise<{ stale: boolean; lastSuccessAt: string | null }> {
  const { data, error } = await ctx.supabase
    .from(PIPELINE_RUNS_TABLE)
    .select('finished_at')
    .eq('step', step)
    .eq('status', 'success')
    .order('finished_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    ctx.log.warn('run.staleness_query_failed', { step, dbError: error.message });
    return { stale: true, lastSuccessAt: null };
  }
  if (!data?.finished_at) {
    return { stale: true, lastSuccessAt: null };
  }

  const lastSuccessAt = data.finished_at as string;
  const ageMs = Date.now() - new Date(lastSuccessAt).getTime();
  const stale = ageMs > maxAgeHours * 60 * 60 * 1000;

  if (stale) {
    const ageHours = (ageMs / 3_600_000).toFixed(1);
    await sendFailureEmail(
      ctx,
      { job: 'nightly', step },
      `Staleness watchdog: last successful "${step}" run was ${ageHours}h ago ` +
        `(> ${maxAgeHours}h ceiling). The chain may be "succeeding" vacuously -- check ` +
        `pipeline_runs for silent no-ops.`
    ).catch((sendErr: unknown) => {
      ctx.log.error('run.staleness_alert_failed', { step, sendErr: errorToMessage(sendErr) });
    });
  }

  return { stale, lastSuccessAt };
}
