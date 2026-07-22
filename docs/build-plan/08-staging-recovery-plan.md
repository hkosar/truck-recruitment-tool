# Staging and Recovery Safety Plan

Status: prepared, not applied. This plan does not authorize creating a billed Supabase resource, changing the production migration ledger, restoring a backup, merging a branch, deploying, or writing production data.

## 1. Verified constraints

- Production is Supabase project `truck-recruitment-tool`, ref `ejrfobddnojbijzrjbii`, in `us-east-2`.
- The organization is `Twisted Nail Broker Services`, ID `svmhdffcnfuoyvaegpbl`, on Pro.
- Production Postgres is 17.6 and the database is approximately 514 MB.
- The repository contains sixteen migration files. Production's Supabase migration ledger contains only one row, `20260722042539 geocode_attempt_queue`.
- The production schema substantially contains the objects defined by the first fifteen repository migrations, but those migrations are not registered in the ledger.
- A normal Supabase development branch replays the main project's registered migrations into a fresh database and does not copy production data. With the current incomplete ledger, a normal branch would not reproduce the live application schema.
- No separate Carrier Recruiter development project exists. Every other visible Supabase project belongs to another application and must not be repurposed.
- Current quoted cost: a preview branch starts at $0.01344/hour plus usage and is not covered by the spend cap; a new project is $10/month in this organization.
- The current sandbox does not provide Docker, psql, or the Supabase CLI, so a true local Supabase Auth/RLS/Realtime stack cannot be verified here.

## 2. Decision

Do not create a normal branch yet. First prepare a reproducible schema baseline and safe fixtures, then validate them in a disposable hosted environment after an explicit cost decision.

The preferred long-lived test environment is a dedicated project named `truck-recruitment-tool-staging` in `us-east-2`. It has a predictable $10/month cost and a stable URL suitable for Auth, RLS, Realtime, application E2E, and manual map verification. An ephemeral preview branch is cheaper for short database-only experiments, but it should not be treated as the durable staging environment; its current creation path is blocked by migration-ledger drift and the branch-list integration also returns a permission-validation error.

A restore-to-new-project clone is reserved for the recovery rehearsal. It copies production data and Auth users, creates a separately billed project, and therefore is not the fictional-data staging environment.

## 3. Migration baseline reconciliation

### 3.1 Immutable evidence package

Before any ledger repair, capture and retain:

- the exact production project ref, database version, and database size;
- the complete production migration ledger;
- checksums of all sixteen repository migrations;
- generated production TypeScript types;
- an inventory of public and internal tables, views, functions, triggers, policies, grants, indexes, extensions, and Realtime publication members;
- security and performance advisor output;
- explicit carrier, user, batch, contact-log, safety, and pipeline-run counts;
- a visible current daily backup timestamp.

### 3.2 Adopted-baseline rule

Treat migrations `20260720000100` through `20260720001500` as an adopted historical baseline only after object-by-object reconciliation proves production already contains their intended effects. Do not execute those files against production merely to repair history.

The production ledger repair is a Tier 3 metadata write and requires a separate authorization immediately before application. If approved, the repair must insert only the missing historical version/name records in a single transaction, preserve the existing `20260722042539` row, and make no application-schema change. Reread the ledger and all pre-write invariants before committing completion.

### 3.3 Repository numbering alignment

The former repository file `20260722000100_geocode_attempt_queue.sql` and the live ledger version `20260722042539` represent the same statement but used different version numbers. The repository file is now renamed to `20260722042539_geocode_attempt_queue.sql`, preserving its exact SQL content. Do not create a second migration that repeats the index change.

### 3.4 Clean-replay acceptance

A disposable empty environment passes only when:

1. All sixteen migrations execute in order without manual schema edits.
2. The migration ledger contains exactly the expected sixteen version/name pairs.
3. The fictional seed loads after migrations.
4. The post-migration probes in `05-verification.md` pass.
5. Generated types match the intended application contract.
6. RLS and function grants pass the negative matrix.
7. A second reset/replay produces the same schema and deterministic fixture invariants.

No branch merge path may be enabled or used during this validation.

## 4. Fictional fixture policy

The current `supabase/seed.sql` is structurally useful but is not safe enough for a hosted shared test environment. Before use:

- replace all real employee names and `twistednail.com` references with fictional role labels and reserved non-deliverable addresses under `example.invalid`;
- replace carrier email domains with `example.invalid` and keep all phone numbers within the North American fictional 555-0100 through 555-0199 block;
- label every seeded legal name, batch, customer, job, note, and activity as synthetic test data;
- retain deterministic USDOT fixtures, warning cases, cross-batch membership, global DNC, refresh candidates, and multi-lane geometry;
- include a fixture manifest with expected row counts and identifiers;
- add an automated repository scan that fails if hosted seed or test files contain a real TNBS employee address, unreserved external domain, production project ref, or production credential.

Seed files remain data-only. Schema changes remain migrations.

## 5. Temporary Auth users and inbox strategy

Use the supported Supabase Admin API in nonproduction; never insert directly into `auth.users` in a hosted environment.

Create six unique, run-scoped users:

- approved manager;
- approved editor;
- approved viewer;
- pending guest;
- approved guest if a distinct approved-guest case remains meaningful;
- disabled user.

Requirements:

- IDs, emails, and passwords are generated per run; no shared hard-coded password.
- Emails use a reserved `example.invalid` namespace for admin-created, auto-confirmed role tests, so no message can reach a real mailbox.
- User metadata contains `test_only=true`, a run ID, creation time, and expiry time.
- Passwords and secret keys never appear in chat, repository files, logs, screenshots, or test reports.
- Provisioning is idempotent by run ID and refuses a production project URL/ref.
- Cleanup deletes all run-created sessions/users and verifies no profiles, batches, zones, members, contact logs, activities, or suppressions remain for the run.

Use a separate mail-sink environment only for registration-confirmation and password-reset delivery tests. Do not use real employee inboxes or plus-address aliases until final owner-approved production onboarding. If a hosted branch/project cannot provide a non-delivering mail sink safely, keep those two delivery tests local/CI and test hosted Auth roles with auto-confirmed admin-created users.

## 6. Environment identity guard

Every destructive test or fixture command must require all of the following:

- `TEST_ENVIRONMENT=staging`;
- exact target ref present in the explicit `TEST_ALLOWED_PROJECT_REFS` allowlist;
- target project name ending in `-staging` or an explicitly recorded disposable branch name;
- `PIPELINE_ENV=dev`;
- absence of production ref `ejrfobddnojbijzrjbii` in URL, database URL, and CLI target;
- a unique run ID and expiry timestamp.

If any check fails or the project identity cannot be read independently, abort before creating a user or writing a row.

## 7. Role and workflow verification

Run two complementary suites:

1. Database-level pgTAP or equivalent transaction-wrapped tests that simulate anon and authenticated JWT claims and assert every negative case in `05-verification.md`.
2. Application-level tests using real nonproduction JWTs and unique run-scoped users, followed by explicit cleanup.

At minimum, verify:

- anon, pending, approved guest, viewer, editor, manager, and disabled access;
- no privilege escalation through profile self-update;
- view cannot write any CRM state;
- editor cannot approve users, delete protected records, or update sync-owned carrier columns;
- manager can perform only the intended administrative writes;
- all five SECURITY DEFINER application write RPCs fail for unauthorized roles;
- DNC is global across batches;
- contact/activity ledgers and batch refresh semantics are correct;
- Realtime delivers only rows visible through RLS.

## 8. Pipeline safety in staging

Do not point the production Render cron at staging. Run staging canaries from an isolated one-shot context with staging-only credentials.

- Safety dry run: capped source pages, no persistent upsert.
- Safety write canary: initially a small allowlisted carrier set or a transaction rollback/shadow-table comparison; assert rates, counts, duplicate handling, and second-run idempotency.
- Location fallback canary: fictional carriers only; prove exact/interpolated coordinates are never overwritten and the second run changes zero rows.
- External source credentials remain separate from Supabase credentials, and no alert email is required for a disposable run.

## 9. Cleanup and cost boundary

### Dedicated staging project

- Expected cost: $10/month under the current organization quote.
- Keep only fictional data and temporary test users.
- Review monthly; pause or delete only through an owner-approved lifecycle decision.
- Never use it as a source of production data.

### Disposable preview branch

- Expected starting cost: $0.01344/hour plus usage, outside the spend cap.
- Use only after the migration baseline is repaired and branch permissions work.
- Name with purpose and expiry, for example `recruiter-rls-20260722-exp24h`.
- Record branch ID immediately after creation.
- Delete within 24 hours or sooner, then verify it no longer appears in the branch inventory.
- Never merge the validation branch into production.

## 10. Recovery gate

Before any Tier 3 production schema or data write:

1. Hunter verifies the latest Supabase Pro daily backup is visible and current in the exact production project.
2. Restore one backup to a new scratch project through Supabase's Restore to a New Project flow after reviewing its separate cost.
3. In the scratch project, verify schema, representative counts, Auth-user count, extension inventory, functions, policies, indexes, and Realtime publication members.
4. Record recovery time and any reconfiguration gaps. Official documentation says Storage objects/settings, Edge Functions, Auth settings/API keys, Realtime settings, extensions/settings, and read replicas may need manual reconfiguration even though database content and Auth records are copied.
5. Delete or otherwise retire the scratch recovery project through an owner-approved cleanup action after evidence is retained.

A visible backup without a successful restore rehearsal is not sufficient launch evidence.

PITR is not part of the current recommendation. It would add at least about $100/month for seven-day retention and requires at least Small compute. Reconsider it only after real CRM users and contact activity make a daily-backup recovery point materially insufficient.

## 11. Owner decisions still required

No owner action is required while the code, fixture, cleanup, and baseline package are being prepared.

Before hosted validation, choose and authorize one:

- recommended: create `truck-recruitment-tool-staging` in `Twisted Nail Broker Services`, `us-east-2`, at the quoted $10/month;
- short experiment only: create an expiring preview branch at $0.01344/hour plus usage after ledger repair and branch-access recovery.

Before the first production write, separately authorize:

- production migration-ledger reconciliation after reviewing the exact transaction;
- recovery rehearsal and its scratch-project cost;
- the exact bounded production canary with before-state, row cap, stop conditions, and reconciliation plan.

Earlier approval for autonomous repository work does not authorize any of these billed or production-impacting actions.
