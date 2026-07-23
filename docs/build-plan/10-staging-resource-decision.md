# Staging Resource Decision

Status: decision package only. No resource has been created, no cost has been incurred, and no production operation is authorized by this document.

## Objective

Provide a stable, isolated Supabase environment where the Carrier Recruiter schema, fictional seed, Auth roles, RLS, RPCs, Realtime, pipeline dry runs, and application workflows can be tested without production data or production credentials.

## Verified resource identity

- Production project: `truck-recruitment-tool`
- Production ref: `ejrfobddnojbijzrjbii`
- Organization: `Twisted Nail Broker Services`
- Organization ID: `svmhdffcnfuoyvaegpbl`
- Plan: Pro
- Production region: `us-east-2`
- Production status: active and healthy

No other existing project may be substituted or repurposed.

## Options

### Option A — Dedicated staging project

Proposed values:

- Name: `truck-recruitment-tool-staging`
- Organization: `Twisted Nail Broker Services` (`svmhdffcnfuoyvaegpbl`)
- Region: `us-east-2`
- Current quoted cost: **$10 per month**
- Data: migrations plus fictional fixtures only
- Auth: run-scoped `example.invalid` users only

Advantages:

- Stable project ref and URL for app configuration and E2E testing.
- Full hosted Auth, RLS, RPC, Realtime, and database behavior.
- Clean separation from production and all unrelated applications.
- Predictable monthly cost.
- No dependence on the currently incomplete production migration ledger.

Risks and controls:

- Ongoing spend: owner approval is required before creation; record the project ref and review monthly.
- Wrong-target risk: all fixture scripts require an explicit staging-ref allowlist and refuse production ref `ejrfobddnojbijzrjbii`.
- Residual fixtures: every test run receives a unique run ID, expiry metadata, FK residue checks, Auth deletion, and an independent post-cleanup reread.
- Schema drift: apply only the checksum-pinned repository migrations; no dashboard-only schema edits.
- Accidental production merge/deploy: the staging project has no branch-merge relationship to production and is not connected to the production Render cron.

Lifecycle:

1. Create after explicit cost confirmation.
2. Record project ID/ref immediately.
3. Apply all sixteen migrations in an empty environment.
4. Load only fictional seed and temporary users.
5. Run acceptance suites and cleanup checks.
6. Keep as the stable development/UAT environment through launch.
7. Pause or delete only through a later owner-approved lifecycle decision.

### Option B — Preview branch

- Current quoted cost: **$0.01344 per hour plus usage**.
- Not protected by the organization spend cap.
- Appropriate only for short-lived database experiments.

Current blockers:

- Production's migration ledger contains only the geocode migration, so a normal branch cannot reproduce the live schema safely.
- The connected branch-list action still fails with `Project reference is missing when validating permissions`.
- A preview branch is not the preferred durable Auth/app UAT endpoint.

Controls if used later:

- Repair the production ledger only after a separately approved Tier 3 decision and recovery gate.
- Confirm branch integration access works.
- Name with an expiry suffix and delete within 24 hours.
- Record branch ID immediately and verify deletion.
- Never merge the validation branch to production.

### Option C — Reuse another project

Rejected. Existing projects belong to other applications. Reuse would violate resource isolation and create unacceptable cross-application blast radius.

### Option D — Continue production-only testing

Rejected. Synthetic users, destructive negative authorization tests, workflow fixtures, and broad application E2E do not belong in production.

## Recommendation

Choose **Option A: create `truck-recruitment-tool-staging` in `Twisted Nail Broker Services`, region `us-east-2`, at the currently quoted $10/month**.

This is the only current option that supports the required hosted Auth/RLS/Realtime/application tests while remaining independent of production migration-ledger drift. It has a higher direct cost than a short-lived branch, but substantially lower operational risk and less setup churn.

## Creation stop conditions

Do not create the project unless all are true immediately before creation:

- The organization is exactly `svmhdffcnfuoyvaegpbl`.
- The quoted cost is repeated to Hunter and confirmed as understood.
- The name is exactly `truck-recruitment-tool-staging`.
- The region is exactly `us-east-2`.
- No project with that name already exists.
- No unrelated project is selected as a substitute.

After creation, stop immediately if:

- the returned organization, name, or region differs;
- project initialization fails or remains unhealthy;
- a target-ref allowlist cannot be established;
- any setup command resolves to the production ref;
- migrations or the fictional seed fail acceptance.

## Success definition for Stage 3

Stage 3 is complete only when:

- the dedicated project exists and is healthy;
- exact identity and cost evidence are recorded;
- all sixteen checksum-pinned migrations replay cleanly;
- generated types and schema probes match expectations;
- fictional seed validation passes;
- no production or unrelated project changed;
- no real employee/carrier contact destination exists in staging;
- the environment can be reset or cleaned deterministically.

## Required owner decision

The standing approval for repository automation does not by itself authorize new monthly spend. To authorize creation, Hunter must state in ordinary chat that he understands and approves the **$10/month** charge for `truck-recruitment-tool-staging` in organization `svmhdffcnfuoyvaegpbl`, region `us-east-2`.
