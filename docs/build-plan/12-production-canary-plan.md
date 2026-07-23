# Production Canary Plan

Status: approval-ready design only. No production pipeline run, schema change, data write, Render run, or migration application is authorized by this document.

## Priority and dependencies

1. Complete the recovery rehearsal in `11-recovery-rehearsal-runbook.md`.
2. Apply the metadata-only baseline reconciliation only after its own approval.
3. Review and apply the three post-geocode migrations as a separate production change.
4. Run the safety read-only dry run.
5. Run a bounded safety write canary.
6. Validate the location fallback with transaction-wrapped or fictional-row evidence before any persistent production location write.

Do not combine these into one approval or one execution window.

## Shared identity and environment guards

Every canary must independently verify:

- production project name `truck-recruitment-tool`;
- project ref `ejrfobddnojbijzrjbii`;
- organization `svmhdffcnfuoyvaegpbl`;
- ACTIVE_HEALTHY status and region `us-east-2`;
- Render service `pipeline`, ID `crn-d9f6aiu1a83c73dhqdqg`, still tracks the authorized production branch and retains `PIPELINE_COMMAND=nightly`;
- `PIPELINE_ENV=prod` only for the explicitly approved production run;
- current backup/recovery evidence remains valid;
- no other pipeline job is running.

A staging URL/ref, missing ref, ambiguous URL, or changed Render command is an immediate stop.

## Safety canary A — read-only source validation

### Purpose

Validate both official safety populations and the sparse Texas rating join without changing `carrier_safety`.

### Proposed invocation

Run the isolated command from an approved one-shot production context:

`tsx src/run.ts sync-safety --pages=1 --dry-run=true`

The current implementation stages source rows in a transaction, validates them, returns before the upsert, and rolls back the staging transaction. It still writes a `pipeline_runs` operational record describing the dry run. That metadata write must be included in approval and evidence.

### Before-state

Record:

- `carrier_safety` row count and checksum-style aggregates;
- warning distribution;
- latest successful/failed `sync-safety` run;
- active Texas carrier count;
- official current row counts for datasets `4y6x-dmck` and `h9zy-gjn8`;
- zero running jobs.

### Pass conditions

- reads exactly one page from each safety dataset;
- stages exactly `min(source count, page size)` rows per source;
- detects no duplicate DOT across the official disjoint populations;
- invalid OOS and component-total counts are zero;
- rating source count is below the 10,000 hard cap and every rating/date validates;
- `rows_upserted=0`, `dryRun=true`, and `carrier_safety` remains unchanged;
- source row counts are stable from beginning to end;
- no crash fields are written or synthesized.

### Stop conditions

Stop on source-count drift, unknown/missing fields, duplicate DOT, invalid rates/totals, rating overflow, transaction ambiguity, nonzero upsert, changed target identity, or any difference in `carrier_safety`.

## Safety canary B — bounded persistent write

### Required code change before approval

The current `--pages=1` write path still upserts all carrier rows from the first 10,000-row page of each dataset that exist in Texas, which is too broad for the first production write. Add an explicit canary DOT allowlist or maximum-write cap enforced inside `buildUpsertSql`; a fetch cap alone is not a write cap.

The write canary is not executable until tests prove:

- the allowlist is mandatory in canary mode;
- every modified DOT is in the allowlist;
- the write count cannot exceed the approved cap;
- the command refuses canary mode when `dryRun=false` and no allowlist is supplied;
- second-run idempotency changes zero rows;
- reconciliation can delete only rows first inserted by the canary or restore exact captured rows.

### Proposed initial cap

At most 10 preselected active Texas USDOTs spanning:

- interstate/AB and intrastate non-Hazmat/C populations;
- zero and nonzero inspections;
- at least one S, C, or U rating when present;
- no existing `carrier_safety` row unless its complete before-image is captured.

### Reconciliation

Before execution, export the full before-image of each allowlisted DOT. After evidence:

- delete rows that did not exist before the canary; and
- restore every column for rows that did exist.

Re-read and compare exact rows after reconciliation. A timeout is an unknown state; read before retrying.

## Location canary — no persistent production write yet

### Current risk

`geocode` supports a batch-count cap, but it has no dry-run mode or DOT allowlist. It submits real addresses to Census and persists exact matches, no-match attempt hashes, and ZIP/city fallback updates. Therefore `--batches=1` is not a sufficiently bounded first production canary.

### Required code change before approval

Add a location canary mode with all of:

- exact USDOT allowlist or a maximum candidate/write cap;
- mandatory target-ref verification;
- transaction-rollback dry run that reports would-change rows by precision tier;
- an option to disable external Census submission for pure fallback testing;
- persistent write refusal when no allowlist is supplied;
- before-image capture of geometry, lat/lng, precision, source, address hash, attempt hash, and geocoded timestamp;
- second-run idempotency assertion;
- reconciliation restoring exact before-images.

### Safe first validation

Use either fictional carriers in isolated staging or transaction-created fictional production rows that are guaranteed to roll back. Prove:

- exact/interpolated coordinates are never overwritten;
- ZIP fallback applies only when geometry is null and ZIP centroid exists;
- city fallback applies only after ZIP fails and a city centroid exists;
- attempted no-match addresses leave geometry null but set the attempt hash only inside the rolled-back transaction;
- a second identical run changes zero rows.

No persistent production location run is authorized until this mode exists and passes automated tests.

## Owner approval packet for each production action

Present separately:

- exact target and command;
- current before-state;
- maximum rows that may change;
- external API calls and expected duration;
- stop conditions;
- rollback/reconciliation script and limitations;
- recovery rehearsal evidence;
- whether operational logs are written even during a dry run.

Hunter's approval for one action does not authorize the next.
