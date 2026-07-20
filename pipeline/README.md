# pipeline — FMCSA → Supabase ingestion

Node 22 + TypeScript service that syncs FMCSA's Socrata datasets (Company Census File,
Licensing & Insurance, SMS safety) into the Supabase `carriers` schema, geocodes addresses via
the Census Bureau's free batch geocoder, rebuilds the cargo "Other" facet table, and writes a
nightly data-quality report. Deployed as a single Render **Cron Job** — see
`docs/build-plan/01-architecture.md` Part B for the full spec and reconciliation amendments
this code implements (referenced throughout the source as `§N` / `amendment #N`).

**Status:** scaffold. Real paging/retry/upsert logic throughout; several pieces are explicitly
TODO-flagged where they depend on live-database or live-API validation that hadn't happened
yet as of this scaffold (see `COLUMN-VERIFICATION.md` and the `TODO(live-db)` /
`TODO(schema-drift)` comments in each file). Not yet `npm install`ed or run — see the parent
task notes for why.

## Layout

```
pipeline/
  package.json / tsconfig.json / .env.example
  src/
    config.ts        # zod-validated env
    db.ts             # Supabase service-role client + direct pg Pool + staging/bulk-insert helpers
    socrata.ts        # SODA v2.1 client: paging, retry/backoff, 1,000/hr budget
    runs.ts           # pipeline_runs logging + Resend failure email + staleness watchdog
    sources/
      census.ts       # sync-census: TX-active slice -> staging -> row-hash diff upsert
      authority.ts    # sync-authority: 6eyk-hxee -> carrier_insurance (authority statuses)
      insurance.ts    # sync-insurance: qh9u-swkp -> carrier_insurance_filings -> rollup
      safety.ts       # sync-safety: monthly SMS snapshot -> carrier_safety
    geocode.ts        # Census batch geocoder + ZCTA/city centroid fallbacks
    facets.ts         # cargo_other_values global counts + seed/trigram match_group populator
    dq-report.ts      # fill-rate report + warning/geocode distributions + staleness checks
    run.ts            # entry point / chain orchestration
```

## Environment

Copy `.env.example` to `.env.local` and fill in real values (`src/config.ts`'s zod schema is
the source of truth for what's required vs optional/defaulted):

| Var | Required | Notes |
|---|---|---|
| `SUPABASE_URL` | yes | Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | service_role, not anon — this pipeline bypasses RLS by design |
| `SUPABASE_DB_URL` | yes | Direct Postgres connection string, **session pooler** (port 5432) — needed for `COPY`/staging/bulk upserts; not runnable via PostgREST alone |
| `SOCRATA_APP_TOKEN` | yes | Free token from dev.socrata.com/register — lifts anonymous throttling to 1,000 req/hr |
| `RESEND_API_KEY` | no | Optional until M7 and a sending domain are configured; enables failure-email alerting |
| `ALERT_EMAIL` | no | Set together with `RESEND_API_KEY`; Render's native cron failure notification is used otherwise |
| `CENSUS_GEOCODER_BASE_URL`, `CENSUS_GEOCODER_BENCHMARK`, `CENSUS_BATCH_MAX_RECORDS`, `CENSUS_MAX_BATCHES_PER_RUN` | no | Sensible defaults; override for local smoke tests |
| `PIPELINE_ENV` | no | `dev` (default) / `prod` — labels log lines and `pipeline_runs.meta` only |

`QCMOBILE_WEBKEY` is deliberately **not** an env var here — per `01-architecture.md`
reconciliation amendment #16, QCMobile per-carrier lookups are a Supabase **Edge Function**
(`qc-fetch`), not this cron pipeline.

Local dev loads `.env.local` via the shell, not application code (kept config.ts
dependency-free and typecheck-risk-free):

```bash
cp .env.example .env.local   # fill in real values
set -a; source .env.local; set +a
npm run dev                  # nightly chain capped to 1 page / 1 geocode batch
```

(Or invoke `node` directly with Node 22's built-in flag: `node --env-file=.env.local
node_modules/.bin/tsx src/run.ts nightly --pages=1`.)

## Local dev / smoke-testing commands

```bash
npm run typecheck                                  # tsc --noEmit
npm run build                                       # tsc emit (CI artifact / validation; see tsconfig.json's note — Render runs tsx against source, not this output)
npm run dev                                          # nightly, --pages=1 --batches=1
tsx src/run.ts sync-census --pages=1                 # isolate exactly one step
tsx src/run.ts nightly --from=geocode                # resume a chain partway through
tsx src/run.ts backfill --pages=5 --batches=5        # capped backfill smoke test
npm run monthly                                      # sync-safety alone
npm run backfill                                     # full backfill chain, uncapped — PROD DATA VOLUME, see below
```

`--pages=N` caps every Socrata pull's page count (each page is up to 50,000 rows); `--batches=N`
caps how many Census geocoder batches `geocode` submits in one run. Every step prints the same
`pipeline_runs`-shaped structured JSON log lines regardless of how it was invoked.

**Do not run `backfill` uncapped against a project you don't intend to fully populate** — per
`01-architecture.md` reconciliation amendment #13, the real ingest scope is TX **active**
carriers (~150-220k rows), and per amendment #13 / `00-master-plan.md` M2.7, the real-data
backfill is meant to run once, deliberately, against the **production** Supabase Pro project —
the free dev project keeps synthetic seed data only.

## Render cron schedules (Part B §6.3; times UTC, owner is US Central)

| Render Cron Job | Schedule | Command |
|---|---|---|
| `pipeline-nightly` | `0 9 * * *` (~4am CDT, after FMCSA's overnight refresh — Part B §7 R7 flags this hour as needing a week of observation to confirm/shift) | `tsx src/run.ts nightly` |
| `pipeline-monthly-safety` | `0 8 5 * *` | `tsx src/run.ts monthly` |
| `pipeline-backfill` | manual ("Run Job" button only — never scheduled) | `tsx src/run.ts backfill` |

Nightly chain ceiling is **60 minutes** (`01-architecture.md` reconciliation amendment #20);
Part B's own estimate is 25-45 min. `dq-report`'s staleness watchdog alerts if `sync-census`
hasn't succeeded in >48h even on a nominally "green" run.

One Render Cron Job service running all three commands (via the schedule table above) — not
three separate services — per `04-costs.md` §7 rule 6 (each cron service carries its own $1/mo
floor).

## Known gaps / where this scaffold stops short of "done"

These are flagged in-line (`TODO(live-db)`, `TODO(schema-drift)`, `⚠️R#`) throughout `src/`,
collected here for a fast overview:

1. ~~**Schema dependencies not yet in any migration.**~~ **RESOLVED** (M2 task #20 /
   reconciliation amendment #21): `supabase/migrations/20260720001400_pipeline_tables.sql`
   adds `pipeline_runs` (runs.ts), `data_quality_reports` (dq-report.ts), `pipeline_config`
   (seeded with cargo seed terms + OOS thresholds — code still reads its constant, wiring live
   is a small follow-up), and `zip_centroids`/`city_centroids` (geocode.ts, one-time-loaded).
   The `pipeline_runs` vs `sync_runs` conflict was resolved by making `pipeline_runs` the real
   operational table and redefining the dead `sync_runs` table as a `security_invoker` view
   over it (latest run per source, for the G10 UI footer). Still needs `supabase db reset` to
   run in an environment with the CLI/DB to confirm end-to-end (that is the M2 provisioning step).
2. **L&I column names are unverified.** `sources/authority.ts` (6eyk-hxee) in particular —
   see `COLUMN-VERIFICATION.md`. Its `$select`/mapping must be corrected against a live
   `$limit=1` probe before `sync-authority` can run.
3. **`sources/safety.ts`'s dataset choice itself is unresolved** (⚠️R3 — `4y6x-dmck` vs
   `sjpe-nzai`), and its column map (especially crash totals) is a best-guess.
4. **Census batch geocoder response parsing** (`geocode.ts`) is written from documentation,
   not a fetched real response sample — validate on day 1.
5. **`crgo_cargoothr_desc` boolean-flag `'X'` encoding** and a couple of Y/N flag encodings
   are carried forward from the architecture doc's own prior research, not independently
   re-verified this session (see `COLUMN-VERIFICATION.md`'s CONFIRMED/UNVERIFIED split).
6. **`carrier_operation`/`classdef` exact value-domain strings** (not just field names) are
   still open — see `COLUMN-VERIFICATION.md`.

None of these block `tsc --noEmit` — they're runtime/data dependencies, not type errors.
