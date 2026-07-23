import { z } from 'zod';

/**
 * Centralized, fail-fast environment configuration.
 *
 * Every var is validated once (see `loadConfig()`) so a misconfigured Render Cron Job dies
 * in the first second with a legible message, not 20 minutes into a census pull because
 * SUPABASE_DB_URL had a typo (Part B §2.5's alerting philosophy applied to startup too).
 *
 * Scope note: this list includes the task brief's data-source and database values plus optional
 * Resend alerting. Resend itself is deferred until M7 / verified DNS, so its two values do not
 * block ingestion; Render's cron-failure notification covers the launch phase. Two additions to
 * the core data configuration were necessary, not optional:
 *   - `SUPABASE_DB_URL`: db.ts's "direct pg option" (COPY / staging tables / set-based
 *     upserts at ~150-220k-row scale) needs a real Postgres connection string; PostgREST
 *     alone can't do that (Part B §6.1).
 *   - `PIPELINE_ENV` + `PIPELINE_ALLOWED_DEV_REFS`: fail closed on the exact Supabase
 *     project before any client opens, and label `pipeline_runs.meta` / log lines. Per-run
 *     row caps themselves are CLI flags (--pages/--batches/--from), not env, per Part B §6.4.
 *
 * Deliberately ABSENT: `QCMOBILE_WEBKEY`. Per docs/build-plan/01-architecture.md
 * reconciliation amendment #16, QCMobile per-carrier inspection lookups are served by a
 * Supabase EDGE FUNCTION (`qc-fetch`) invoked on profile view -- NOT by this cron pipeline.
 * Do not add QCMobile fetching to this package; if a future job genuinely needs it, that's
 * a deliberate scope change worth re-reading amendment #16 for first.
 */
const EnvSchema = z.object({
  // ---- Supabase --------------------------------------------------------------------
  /** Project URL, e.g. https://xxxx.supabase.co -- used by the service-role JS client. */
  SUPABASE_URL: z.string().url({ message: 'SUPABASE_URL must be a valid https:// URL' }),
  /** service_role key. NEVER the anon key: this pipeline bypasses RLS by design -- it is
   *  the only writer of sync-owned columns (Part A D9). Never log this value. */
  SUPABASE_SERVICE_ROLE_KEY: z
    .string()
    .min(20, 'SUPABASE_SERVICE_ROLE_KEY is missing or looks truncated'),
  /** Direct Postgres connection string, SESSION pooler (port 5432, not the 6543 transaction
   *  pooler -- staging tables + multi-statement transactions need session affinity). */
  SUPABASE_DB_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\//, 'SUPABASE_DB_URL must be a postgres:// connection string'),

  // ---- Socrata (data.transportation.gov, SODA v2.1) ---------------------------------
  /** Free app token; lifts anonymous IP throttling to 1,000 req/rolling-hour
   *  (dev.socrata.com/docs/app-tokens.html; 04-costs §1). Required -- master plan lists it
   *  as an M2-blocking owner prerequisite, not an optional nicety. */
  SOCRATA_APP_TOKEN: z
    .string()
    .min(1, 'SOCRATA_APP_TOKEN is required (sign up at dev.socrata.com/register)'),

  // ---- Census Bureau batch geocoder (Part B §4) --------------------------------------
  CENSUS_GEOCODER_BASE_URL: z
    .string()
    .url()
    .default('https://geocoding.geo.census.gov/geocoder'),
  /** `Public_AR_Current` = the current public Address Ranges benchmark (§4.1). */
  CENSUS_GEOCODER_BENCHMARK: z.string().min(1).default('Public_AR_Current'),
  /** Census hard-caps a single batch file at 10,000 records AND 5MB -- geocode.ts chunks
   *  to this. Configurable only to make local-dev smoke tests cheap (e.g. 50). */
  CENSUS_BATCH_MAX_RECORDS: z.coerce.number().int().positive().max(10_000).default(10_000),
  /** "Good citizen" cap on batches submitted in one nightly run (§4.1: "caps at ~30 batches
   *  to be a good citizen"). Backfill overrides via the --batches CLI flag (run.ts). */
  CENSUS_MAX_BATCHES_PER_RUN: z.coerce.number().int().positive().default(30),

  // ---- Alerting (Part B §2.5: "throw -> ... email via Resend ... belt + suspenders") -
  // Resend is deliberately deferred until M7 / a verified sending domain exists. Render's
  // native cron failure notification remains the launch-phase alert path; when this key is
  // absent, runs.ts logs that email alerting was skipped instead of blocking data ingestion.
  RESEND_API_KEY: z.string().min(1).optional(),
  ALERT_EMAIL: z.string().email('ALERT_EMAIL must be a valid email address').optional(),

  // ---- Misc ---------------------------------------------------------------------------
  /** 'prod' | 'dev' -- selects the exact-ref target guard and labels pipeline_runs.meta
   *  and log lines; does NOT itself cap page/batch counts. Defaults to 'dev' so a bare
   *  invocation can never silently target the production project. */
  PIPELINE_ENV: z.enum(['prod', 'dev']).default('dev'),
  /** Comma-separated explicit allowlist for dev/staging project refs. Required
   * when PIPELINE_ENV=dev; production can never appear in it as a substitute. */
  PIPELINE_ALLOWED_DEV_REFS: z
    .string()
    .default('yhyoxhtguyturgdhwywc')
    .transform((value) => value.split(',').map((ref) => ref.trim()).filter(Boolean)),
});

export type Config = z.infer<typeof EnvSchema>;

/**
 * Parse and validate `env` (defaults to `process.env`). Throws one aggregated, readable
 * error listing every invalid/missing var -- not just the first -- so a bad Render
 * Environment tab fails legibly on the very first call.
 *
 * Deliberately NOT auto-run at module load (no top-level `export const config = ...`):
 * every job function takes its `Config` (bundled into a `PipelineContext`, see db.ts) as an
 * explicit parameter instead of reaching for a hidden singleton. run.ts is the one place
 * that calls this, in a try/catch, so a startup failure prints cleanly and exits non-zero
 * instead of an unhandled-throw stack dump.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `Invalid pipeline environment configuration:\n${issues}\n\n` +
        'Copy pipeline/.env.example to pipeline/.env.local and fill in real values ' +
        "(then `set -a; source .env.local; set +a` before running), or set these in the " +
        "Render Cron Job's Environment tab. See pipeline/README.md."
    );
  }
  return result.data;
}
