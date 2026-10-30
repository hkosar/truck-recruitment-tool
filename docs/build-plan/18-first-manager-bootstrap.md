# 18 · First-manager bootstrap — design note and runbook (cutover gap OPEN-2)

Status: **local code and tests only. Never run against production. Never run against any hosted database.** Written
2026-10-30 UTC on branch `signin/first-manager-bootstrap` (from `wave1/review-fixes-r3` @ 56cc204) by a worker for the
manager thread. Closes the "no route is recorded" part of doc 17 OPEN-2 (draft on `signin/cutover-prep`) once the manager
accepts it; the staging rehearsal and the production run are separate steps that each need Hunter's own go.

## 1 · Plain-language summary (for Hunter)

After the new sign-in is switched on, a person can sign in only if a manager has put them on the team list, and only a
signed-in manager can add people. On an empty team list nobody can add the first one. This tool adds exactly one person —
you, `hunter@twistednail.com` — as a Manager, once.

- It does **not** make a login or a password. The new sign-in sends an email link; the only thing it needs is your row on the
  team list. No one but you ever types or holds your password, and there is none to hold.
- It does nothing unless you (or the manager at your word) type a long confirmation phrase **and** add `--execute`. Without
  `--execute` it only prints what it would do and touches nothing.
- It refuses to run if there is already any Manager, or if it has ever run before. So it cannot be used later to sneak in a
  second Manager.
- It must be told whether it is aimed at staging or production. There is no default.

## 2 · What makes "Hunter is the first manager" true in production after M1 and M1b

Facts from the migrations and the server (all read, none executed):

| Fact | Where |
|---|---|
| A person can request a sign-in link only if `public.profiles` has a row with `lower(email)` equal to the typed address, `status = 'approved'` and `role` in manager/edit/view (and the address is not on `internal.blocked_email_addresses`). | `internal.auth_mint_lock`, `supabase/pending/M1_same_origin_signin.sql` §8 |
| After M1b, `public.profiles` no longer needs an `auth.users` row (`profiles_id_fkey` dropped, `id` defaults to `gen_random_uuid()`). | `supabase/pending/M1b_add_person.sql` §1 |
| Adding anyone needs a signed-in **manager** link session (`team_add_person` → `internal.lock_and_validate(['manager'], ['link'], …)`), so the first manager cannot be created through the app. | `M1b_add_person.sql` §3 |
| Every team change first takes `internal.roster_lock` exclusively; sign-in paths take it shared. | M1 §1, §8 |
| Changing role/status/approval columns by UPDATE passes `guard_profile_update` only for a manager or the transaction-local service-role claim. A plain INSERT has no such trigger. | `20260723004500_profile_service_bootstrap.sql`; M1 triggers |

So, in production after M1 + M1b, **one `public.profiles` row** is the whole identity:
`email = hunter@twistednail.com`, `role = 'manager'`, `status = 'approved'`, `approved_by = id` (self, the same convention
as the staging owner promotion), `approved_at = now()`. No `auth.users` row, password, Auth Admin call or Supabase email is
involved: there is no Supabase Auth user for the first manager. This is the model the Node server implements (`app/server/db/pg-auth-store.ts` calls only the `internal.auth_*`
definer functions). Decision G1 ("create the login via Auth Admin, then promote separately") belongs to the **old password
login** on staging (`owner-bootstrap.ts`); the new sign-in has no login to create, so only its second half (a separate,
reviewed promotion) has a production counterpart, and this tool is that.

Quote-Queue: its first-user script `scripts/bootstrap-prod.ts` exists (doc 15 C11 lists it as "not needed" because QQ
users are preserved). It was not copied; this repository's model (one profile row, locked roster, audit event) follows the
M1/M1b functions instead.

## 3 · Shape of the tool

Code: `pipeline/src/first-manager-bootstrap.ts` (plan, facts, assessments, transaction), `pipeline/src/first-manager-runner.ts`
(command line). Own runner, deliberately: the staging runners keep refusing production, and nothing in them knows this tool.

```
npm run first-manager -- --target=<staging|production> --action=<first-manager-check|first-manager-create> --confirm="<phrase>" [--execute]
```

- **there is no default target.** Missing or any other value → refusal `bootstrap_target_required`.
- **Target pinning.** `staging` → the one recorded rebuilt staging project (`target-guard.ts`), the production project is
  `production_refused`, anything else `target_not_recorded_staging`. `production` → exactly the recorded production project
  (`target_not_recorded_production` otherwise); session port 5432 only.
- **Typed confirmations** (per target and action, compared exactly):
  - `RUN TNBS FIRST MANAGER CHECK` — read-only report, both targets.
  - `CREATE TNBS STAGING FIRST MANAGER` — staging create.
  - `CREATE TNBS PRODUCTION FIRST MANAGER` — production create. The staging phrase does not unlock production or the reverse.
- **Plan-only default.** Everything above is verified offline; without `--execute` it prints two fixed lines
  (`first-manager.verified`, `first-manager.plan_only`) and never connects.
- **Connection string.** `STAGING_DB_URL` for staging, `PRODUCTION_DB_URL` for production, each through
  `scripts/run-with-secrets.mjs` and its hidden prompt. `PRODUCTION_DB_URL` is **prompt-only**: `--from-env` (the staging
  Doppler path) refuses it, and the runner itself refuses a production URL that was not typed at that prompt: the wrapper
  hands its child a proof (a hash of the value it just read; `TNBS_PROMPT_PROOF_PRODUCTION_DB_URL`) and `selectFirstManagerDbUrl`
  refuses a `PRODUCTION_DB_URL` without the matching proof (`plan_refused`), so `npm run first-manager` with a value left in the
  environment never reaches a connection. The proof stops accidents; it is not a defence against someone who forges it on purpose.
  If both variables are present the run is refused (`plan_refused`, mixed environment).
- **One transaction** (`begin` … `commit`): `lock_timeout` 10 s, `statement_timeout` 60 s; schema readiness read first (M1 tables, the real sign-in functions such as `internal.auth_mint_lock`, `team_add_person`, the account link gone, and exactly one `internal.roster_lock` control row; the locked read must also return exactly one row);
  `internal.roster_lock FOR UPDATE` (I1), then `LOCK TABLE public.profiles IN SHARE ROW EXCLUSIVE MODE` (I2); every
  precondition re-read under those locks; the write; one audit row; every postcondition re-read, including a call to the real `internal.auth_mint_lock` that must return exactly the new person; only then `commit`.
- **Single use.** The tool refuses if any manager profile exists (a `role = 'manager'` row in **any** status), **or** an
  `internal.auth_events` row of kind `first_manager_bootstrap` already exists (so demoting or disabling the manager later
  cannot re-open the door). Two simultaneous runs: one commits, the other is refused (tested).
- **Two write paths, one result.** Address absent → insert one row. Address present as exactly one *pristine* pending
  guest (role guest, status pending, never approved, stored lower case) → promote that row in place, using the
  transaction-local service-role claim on that path only. Anything else on the roster for the address (already approved
  editor, different casing, twice) → refused, nothing touched; that is a decision for Hunter.
- **Blocked address** (`internal.blocked_email_addresses`, not cleared) → refused.
- **Output.** Fixed events only (`first-manager.*`): counts, a state word, check names from a fixed list, a result word.
  Never the address, the name, an id or the connection string. `run-with-secrets.mjs` allow-lists exactly these events;
  tests keep its lists equal to the code.
- **Failure.** Any refusal or error rolls back. An unknown commit result is reported `unknown` and never retried; an
  unacknowledged rollback is `rollback_not_confirmed`. After either, run `first-manager-check` and stop.
- **No other change.** No Auth user, no email, no delete, no schema change, no network call. The tests pin the three
  writes (insert or promote profile, one audit row).

States printed by `first-manager-check` (read-only): `schema_not_ready`, `manager_exists`, `already_bootstrapped`,
`address_blocked`, `address_on_roster`, `ready_to_create`, `ready_to_promote`.

## 4 · Runbook (nothing here is approved; each step needs its own go)

Staging rehearsal first (doc 16 approval list; after the rebuilt staging project has M1 + M1b applied):

1. Hunter's go for "first-manager check on staging". Run `first-manager-check` on staging. Expect `ready_to_create` (or
   `manager_exists` if the staging owner promotion already ran — then the rehearsal is a check of the refusal only).
2. Hunter's go for "first-manager create on staging". Run `first-manager-create`. Expect result `committed`, then a second
   `first-manager-create` refused. Then request a sign-in link for the address through the staging app (doc 17 C11 steps)
   and confirm Team → Add person works.
3. Re-running the rehearsal on the same staging database is refused by design (the audit event stays). Resetting that
   needs a separate, reviewed staging-only cleanup that does not exist yet.

Production (doc 17 step B11 — "First manager signs in (depends on OPEN-2)"):

1. Precondition: M1 and M1b applied and verified; maintenance mode still on; Hunter says "go for B11-prep".
2. `first-manager-check` against production (`--target=production`), confirmation `RUN TNBS FIRST MANAGER CHECK`, hidden
   prompt for `PRODUCTION_DB_URL`. Required: `ready_to_create` or `ready_to_promote`. Any other state → stop, tell Hunter.
3. Hunter's separate go. `first-manager-create`, confirmation `CREATE TNBS PRODUCTION FIRST MANAGER`, `--execute`.
   Required: result `committed`, all `after` checks ok.
4. Same-day `first-manager-check` (expect `manager_exists`), then Hunter's B11 sign-in (link, confirm button, dashboard as Manager).

## 5 · Backout

The first manager has no `auth.users` row. After `M1b-backout.sql` the foreign key returns **NOT VALID**, so the row stays
but **cannot sign in to the old app** (the same is true of everyone added under M1b). If a production backout must give
Hunter the old password login back, that is a separate owner-approved Auth Admin step (the staging `owner-auth-create`
pattern) — not part of this tool. Decision for Hunter before the cutover.

## 6 · What is and is not proven

Proven locally: planner and executor against an in-memory fake (77 tests, run by `npm test` in `pipeline/`, so by `npm run build`, `verify` and CI); the real SQL against a throwaway PostgreSQL 16
cluster built from the 20 migrations, the profile fixtures, M1, M1b and M1c: insert path, promote path, every refusal,
rollback on an injected error, two-at-once, the real `internal.auth_mint_lock` finding the new manager, and the new manager
adding a person through a `recruiter_app` link session (`team_add_person`). The text-level contract is
`scripts/verify-first-manager-contract.mjs`; it checks the guard statements themselves (confirmation, precondition, plan-only return,
prompt-only) and that the tests are wired into verification, and CI runs it. The A3 test validates both of its connection strings offline
(`first-manager-a3-urls.ts`: loopback, no overrides, same owned cluster and database, app role `recruiter_app`) before any client exists.

**Not proven (needs a hosted rehearsal):** the hosted runner login's privileges (the tool needs INSERT/UPDATE on
`public.profiles` and `internal.auth_events`, FOR UPDATE on `internal.roster_lock`, LOCK TABLE on `public.profiles`);
Supabase-specific event triggers or default privileges interfering; TLS behaviour of the pooler connection (copied from the
other runners: `rejectUnauthorized: false`); what the production roster actually holds on the cutover day (doc 15 §32 says 0
profiles on 2026-10-22).
