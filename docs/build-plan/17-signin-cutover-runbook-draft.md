# 17 · Production sign-in cutover — owner runbook (DRAFT, revised after Codex review)

**Status: DRAFT. NOTHING IN THIS FILE IS APPROVED OR HAS BEEN RUN.** First written 2026-10-30 (UTC) on branch `signin/cutover-prep`; revised 2026-10-30 (UTC) to fix the eight Codex review findings; revised again 2026-10-30 (UTC) to record Hunter's OPEN-1 decision (Route A for the SQL files, Route B for the one password statement); revised 2026-10-31 (UTC) to cite the Route A runner at its later reviewed tip `7111139` (adds A1, B10, C4, BO3 and BO10 actions; marks two A2 backouts DO NOT USE), to cite the reviewed first-manager tool at `7285a7e` (OPEN-2), and to add DRAFT Route B owner steps for the two database-login passwords (B5, C3). revised 2026-11-01 (UTC) to re-point the runner citation to tip `9e3e340` and to replace the old text that said L1 stops whenever a STOP table exists, with the item 28 "stop unless empty" behaviour Hunter approved on 2026-11-01. Revised again 2026-11-01 (UTC) to re-point the runner citation from `9e3e340` to `47f4920` (adds SET CONSTRAINTS ALL IMMEDIATE before the final STOP re-count) and to document the deferred foreign-key failure (SQLSTATE 23503) in B13. Local only. Every step that touches a live system is marked **NOT APPROVED, needs its own go**. A "go" for one step is not a "go" for the next. Hunter's clock is US Central; times written down here are UTC.

Covers release-path plan step 14 (production sign-in cutover) and step 15 (L1, closing the old Supabase sign-in credentials). Order comes from doc 14 §11.2 step 4 and doc 16 §3.2. Where the repo has **no recorded command**, the step says so and stops (marked **GAP**).

**Decisions already settled:**
- The mail provider is **SendGrid** (settled by the manager, 2026-10-30; the older "Resend" mention in the release-path plan is stale).
- **Production SQL is run by Route A, with one exception (OPEN-1, decided by Hunter on 2026-10-30 UTC).** The SQL files go through the guarded runner `pipeline/src/prod-sql-runner.ts`. The one password statement (B5) goes through Route B, the Supabase SQL editor. See OPEN-1 below. The runner is on a different branch and is **not merged here** (GATE-1).
- **Every secret goes through Doppler** (the source of truth since 2026-10-28). This runbook names each secret by NAME, its source and its Doppler project/config only. **No step asks Hunter to type a secret value directly into Render or GitHub, and no step does so in any dashboard except the two owner-approved exceptions below.** The two exceptions, both from Hunter's recorded Route B decision (OPEN-1, 2026-10-30 UTC) and Doppler-first rule, and neither adds any authorization: (1) the Supabase SQL editor, where Hunter pastes the one password statement per login (B5, and the DRAFT C3 second login, which needs Hunter's own route confirmation); (2) Doppler itself, where Hunter stores the resulting secret by NAME (the source of truth). Nothing else, and never Render or GitHub directly. The Doppler → Render rules are in `C:\Users\hunte\.bb\BB Rules\doppler-render-playbook.md` (a sync replaces every Render setting with what Doppler holds; a restart does NOT load new settings, "Deploy latest commit" does).
- **Doppler homes (proposed here, Hunter confirms in OPEN-5):** runtime settings only in `truck-recruitment-tool` / `prd`; owner-only `PRODUCTION_DB_URL` in separate project `truck-recruitment-tool-owner` / `prd`, which must never sync to Render or any other service. (Doc 16 §1.9 uses `truck-recruitment-tool` / `stg` for staging runner secrets. Not verified: either proposed production scope exists today.)
- **The server's maintenance mode answers 503 to everything except `/readyz` and `/healthz/db`** (`app/server/app.ts:566`; test `app/server/app.test.ts:548`). That includes sign-in, confirmation and the SendGrid webhook. There is **no operator bypass and none is invented here**. So: anything that needs the real sign-in or the webhook runs **after** maintenance is turned off (Part C). Database work for the first manager runs **before** (Part B).

---

### Pending Action

**Nothing is asked of Hunter today.** This is a draft for review. Before anyone can ask for the first "go", Hunter must settle the open items below (OPEN-2 to OPEN-5; OPEN-1 is closed) and the three runner gates (GATE-1 to GATE-3, each NOT APPROVED with its own go). After that, the steps run in order, one "go" at a time.

✅ **OPEN-1 — CLOSED: how production SQL gets run.** Decided by **Hunter** on **2026-10-30 (UTC)**: "Route A for the SQL files, Route B (Supabase SQL editor) for the one password statement." **This decision approves no live step.** Every step below stays NOT APPROVED and needs its own go.
- **Cited:** `docs/build-plan/18-production-sql-route-options.md` (doc 18) and the Route A runner at tip `47f4920` on branch `bb/stop-unless-empty-r3-flush-deferred-triggers-bef-thr_2h7fkxxygs`. Review trail: `5101b81` "route-a actions: ready" (window-on, window-off, security-hardening-backout), then `7111139` "missing-sql r2: ready" (read-only-inventory, bootstrap-identity-check; the two A2 backouts DO NOT USE). The runner is **not merged into this branch**; this runbook only cites it (GATE-1). Doc 17 was first written against runner tip `4552557`; then re-pointed to `7111139`, on 2026-11-01 (UTC) to `9e3e340` (adds the 13-table classification and the item 28 "stop unless empty" L1 sweep), and later that day to `47f4920` (adds `SET CONSTRAINTS ALL IMMEDIATE` before the final STOP re-count). The review status of `47f4920` is not verified here (it was under review when this was written): doc 18 recorded the stop-unless-empty change as built locally and pending independent review when it was written; the manager confirms the review result before GATE-1.
- **Route A (the SQL files):** the guarded runner `pipeline/src/prod-sql-runner.ts` (`npm run prod-sql` in `pipeline/`). It has one named action per approved file or stage; every action has its own exact typed phrase (`--confirm`); it connects to nothing unless `--execute` is added (plan-only is the default); it accepts the connection string only from the hidden prompt of `scripts/run-with-secrets.mjs` (`--secret PRODUCTION_DB_URL`).
- **Route B (the one password statement, B5):** Hunter runs it in the Supabase SQL editor. **Reviewed paste box still owed.** The runner is not used for it.
- **Secret handling:** `PRODUCTION_DB_URL` is owner-only and prompt-only, from Doppler project `truck-recruitment-tool-owner`, config `prd` (scope proposed, confirmed in OPEN-5). It is never in an environment variable, Render, chat or a file.
- **Command form (every Route A step below uses it).** Run from the repository root after GATE-1. Wrapped form assembled from the wrapper's usage line and doc 18's staging example (not verified: the runner header gives only the `npm run prod-sql -- ...` form; this wrapped line has never been run):
  ```
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/prod-sql-runner.ts --target=production --action=<action> --confirm="<phrase>"
  ```
  Each step gives the action and phrase, then a **plan-only** paste box first, then the same line with `--execute` in a second box. The `--execute` box is run only after the plan output (`prod-sql.verified`, then `prod-sql.plan_only`) was read and Hunter has given that step's go.
- **Route A actions added since the first draft (all at `47f4920`):** `read-only-inventory` (A1, BO3), `window-on` (B10), `window-off` (C4), `bootstrap-identity-check` (BO3, before the M1 backouts) and `security-hardening-backout` (BO10). Each step below gives the exact action, phrase and both commands. Two of them (`read-only-inventory`, `bootstrap-identity-check`) are marked DRAFT, PENDING REVIEW in their own SQL file headers; the runner at `47f4920` was reviewed ready, and the SQL text itself still has no owner sign-off beyond that review (not verified).
- **DO NOT USE (refused with `prod_sql_action_do_not_use`, never runnable, with or without `--execute`):** `profile-bootstrap-backout` and `dnc-enum-cast-backout` (the A2 backouts). They are listed in the runner's `PROD_SQL_DO_NOT_USE`, not in its action table. Why, from doc 18: the restored profile guard fails open for a pending or disabled user and re-opens self-approval; the restored DNC function fails with SQLSTATE `42804` for an authorized editor. **The forward fixes (`20260723004500` and `20260723010400`) are retained during any application backout.** See A2.
- **Still not built (runner refuses as `prod_sql_action_not_built`):** `reconciliation` (the `09` ledger reconciliation; marked PROPOSAL ONLY, owner decision pending). No step in this runbook uses it.
- **Still required before any use:** GATE-1, GATE-2, GATE-3 below.

🔴 **OPEN-2 — First manager on an empty roster** — NOT APPROVED, needs its own go. **Tool exists and is reviewed; merge into the cutover branch and the staging rehearsal are still owed.**
- **What:** production had 0 Auth users and 0 profiles on 2026-10-22 (doc 15 §32; release-path plan §2 step 14; historical counts, not a live measurement). `team_add_person` (M1b) needs an existing manager (doc 15 §32), so the first manager cannot be created through the app. The tool makes one `public.profiles` row (Hunter's email, role manager, status approved) and one `internal.auth_events` row of kind `first_manager_bootstrap`; it makes no Auth user, no password and sends no email. (That audit row is what BO3's `bootstrap-identity-check` reads.)
- **Cited tool (reviewed, not merged here):** commit `7285a7e` "Fix first-manager failure output and COMMIT outcome reporting" on branch `bb/fix-first-manager-listener-output-commit-outcome-thr_q9ajbvqpa6` (reviewed "fm-listener r2: ready"). `7285a7e` is also contained in the pushed branch `signin/combined-reviewed-abc` (pushed at `7601ace`; `git merge-base --is-ancestor` confirms it for both the local and the `origin/` ref). Tool source read with `git show 7285a7e:<path>` (`pipeline/src/first-manager-runner.ts`, `pipeline/src/first-manager-bootstrap.ts`, `scripts/run-with-secrets.mjs`, `docs/build-plan/18-first-manager-bootstrap.md` §3, §4). It replaces the earlier candidate `e31dc29`, which is no longer cited. Verified with `git ls-tree`: `signin/combined-reviewed-abc` holds **no** `prod-sql` file, so it carries the first-manager tool but not the Route A runner (see GATE-1).
- **Exact commands (from the tool source).** Typed phrases, compared exactly: check `RUN TNBS FIRST MANAGER CHECK`; create `CREATE TNBS PRODUCTION FIRST MANAGER` (the staging phrase `CREATE TNBS STAGING FIRST MANAGER` does not unlock production). Without `--execute` the tool emits only two JSON lines (`first-manager.verified`, `first-manager.plan_only`) and connects to nothing (the wrapper also prints its own prompt and closing summary around them). The wrapped form below is assembled from the wrapper's usage line (`node scripts/run-with-secrets.mjs ... -- node ARGS...`: the child must start with `node`) and the runner's `npm run first-manager` entry (`tsx src/first-manager-runner.ts`); **not verified: this wrapped line has never been run.**
  ```
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/first-manager-runner.ts --target=production --action=first-manager-check --confirm="RUN TNBS FIRST MANAGER CHECK"
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/first-manager-runner.ts --target=production --action=first-manager-check --confirm="RUN TNBS FIRST MANAGER CHECK" --execute
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/first-manager-runner.ts --target=production --action=first-manager-create --confirm="CREATE TNBS PRODUCTION FIRST MANAGER"
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/first-manager-runner.ts --target=production --action=first-manager-create --confirm="CREATE TNBS PRODUCTION FIRST MANAGER" --execute
  ```
  The first and third lines are plan-only; the second (read-only, `begin read only` then rollback) and fourth (the write, one transaction) add `--execute`.
- **Exact outputs (fixed JSON lines only; counts and enumerated words, never the address, the name or an id).** These are the JSON events the tool's own runner emits and the wrapper's allow-list passes (`scripts/run-with-secrets.mjs` at `7285a7e`); the wrapped terminal session also shows the wrapper's own prompt and its closing exit/withheld-count summary, which are not JSON events. The two lines `first-manager.verified` and `first-manager.plan_only` are all the **tool** prints without `--execute`. Field sets, exactly (no other field exists):
  - `first-manager.verified` — fields: `action`, `target`.
  - `first-manager.plan_only` — fields: `hint`.
  - `first-manager.state` — fields: `target`, `state`, `schema_ready`, `profiles_total`, `managers`, `address_profiles`, `bootstrap_events`.
  - `first-manager.check` — fields: `phase`, `check`, `ok` (one line per check; `phase` is before or after, `check` is a name from a fixed list).
  - `first-manager.checks` — fields: `phase`, `ok`, `checks`, `failed` (the aggregate for one phase).
  - `first-manager.result` — fields: `result`, `path` (`result` is `committed`, `rolled_back`, `rollback_not_confirmed` or `unknown`; `path` is `insert` or `promote`).
  - `first-manager.done` — fields: `action`, `target`.
  - `first-manager.refused` — fields: `refusal`, `err_code` (a fixed refusal id and a validated code).
  States printed by the check: `ready_to_create`, `ready_to_promote`, `schema_not_ready`, `manager_exists`, `already_bootstrapped`, `address_blocked`, `address_on_roster`. Single use: refused when any manager profile exists (any status) or an earlier bootstrap event exists. An `unknown` or `rollback_not_confirmed` result is **never retried**: stop, run the check, tell the manager.
- **Secret handling (scope confirmation needed, see OPEN-5):** `PRODUCTION_DB_URL` stays **owner-only and prompt-only** (the tool refuses a production URL that was not typed at the wrapper's hidden prompt, and the wrapper's `--from-env` path refuses it; doc 16 §1.9 excludes production from the Doppler runner path). Source: the owner database credential approved for the bootstrap, obtained by Hunter from the production Supabase connection page at https://supabase.com/dashboard (not verified: exact page). Record it only in Doppler project `truck-recruitment-tool-owner`, config `prd`, at https://dashboard.doppler.com (not verified: exact project page). Hunter reads it there and supplies the hidden local prompt; the tool does not fetch it from Doppler. This project/config must have no integrations or syncs and must never be synced to Render or another service. Never store `PRODUCTION_DB_URL` in `truck-recruitment-tool/prd`, any other Render-synced config, an environment group or secret file. `DATABASE_URL` is the separate runtime login.
- **Why needed:** without a manager profile for Hunter's email, step C1 (first manager signs in) cannot succeed, and nobody can add anyone.
- **If skipped:** the cutover finishes with a sign-in page nobody can use.
- **Steps:** 1. a. The manager merges the reviewed tool into the branch the cutover runs from (a separate action, not part of this runbook; Hunter's rule: no push to main). b. The manager re-reads the merged tool and confirms the phrases and states above are unchanged. c. The staging rehearsal in doc 18 §4 passes first (its own approvals; re-running it on the same staging database is refused by design).
- **Success check:** the tool is merged and rehearsed on staging, and B8, B9 and B9V cite the merged commit.

🔴 **OPEN-3 — D10: declare a backout window?** — NOT APPROVED, needs its own go (approval 18)
- **What:** doc 16 §3.1: production cutover cannot be scheduled until D10 decides whether a window is declared, its length and who closes it. Recommended there: 14 days, closed by Hunter.
- **Steps:** 1. a. Hunter answers yes/no and the length in chat. 2. a. The manager records it here.
- **Success check:** this item states the answer.
- **If skipped:** step B10 (`window-on`) has no rule to follow.

🔴 **OPEN-4 — Staging proof must be finished first** — NOT APPROVED, needs its own go
- **What:** the recorded PASS evidence for doc 16 §1.5 rows 1–15 and approvals 4–16 (doc 16 §6): staging rebuild, M1/M1b/M1c on staging, the pooler probe, mail end to end, T-IP, T-SHUTDOWN, O2 and L1 on staging, T-REPLAY backout rehearsal, and the log gate A7. No completed hosted evidence package was available to the reviewer; this draft does not claim any of it is done or not done.
- **Steps:** 1. a. The manager reconciles the latest recorded evidence with doc 16 §1.5 and shows each row as PASS (with evidence) or missing. b. Nothing is asked of Hunter.
- **Success check:** every row 1–15 is PASS with recorded evidence.

🔴 **OPEN-5 — Confirm separate runtime and owner-only Doppler homes** — NOT APPROVED, needs its own go
- **What:** runtime settings belong in `truck-recruitment-tool` / `prd`; owner-only `PRODUCTION_DB_URL` belongs in `truck-recruitment-tool-owner` / `prd`, never synced. **Why:** a Render sync copies the entire selected config, including any privileged bootstrap credential mistakenly stored there. **If skipped:** A5 and B8/B9 cannot start.
- **Steps:**
  1. a. Hunter confirms both proposed project/config names in chat, including that the owner-only scope must never sync. b. A different choice requires updating every affected step before approval.
  2. a. At https://dashboard.doppler.com (not verified: exact page names), the operator checks project `truck-recruitment-tool` → Configs → `prd`, then project `truck-recruitment-tool-owner` → Configs → `prd`. b. Missing scopes require a separate go before creation. c. Inspect Integrations for the owner-only project: any sync or integration is a STOP; do not remove or change it under this step.
  3. a. Hunter records the approved bootstrap credential from the production Supabase connection page (https://supabase.com/dashboard, not verified: exact page) as `PRODUCTION_DB_URL` only in `truck-recruitment-tool-owner` / `prd`, after a separate go for that secret write. b. Report names and scope only.
- **Success check:** both scopes and the owner login that reaches them are identified; the owner-only scope has no syncs or integrations; `PRODUCTION_DB_URL` is absent from the runtime sync inventory.
- **Go-gate:** Hunter confirms the two scopes; each missing-scope creation or owner-secret write needs its own explicit go before it happens.

🔴 **GATE-1 — Merge the Route A runner's own branch before any use** — NOT APPROVED, needs its own go
- **What:** the runner (`pipeline/src/prod-sql*.ts`, `scripts/run-with-secrets.mjs` changes, `supabase/rollout/auth-table-classification.json`, doc 18) exists only on branch `bb/stop-unless-empty-r3-flush-deferred-triggers-bef-thr_2h7fkxxygs`, tip `47f4920` (reviewed "missing-sql r2: ready"; it contains the earlier reviewed `5101b81` "route-a actions: ready"). It is not on the branch this runbook is on, and it is **not** in `signin/combined-reviewed-abc` (which carries the first-manager tool at `7285a7e` but no `prod-sql` file; verified with `git ls-tree`). The manager decides how the runner branch and the first-manager tool end up on one cutover branch (a merge decision, not made here). This draft does not merge or cherry-pick it. **Why needed:** every action, phrase and command cited here exists only there. **If skipped:** the commands cannot run, and the actions cited here cannot be checked against the code the cutover will actually use.
- **Steps:**
  1. a. Hunter says "go for GATE-1". b. The manager merges that branch (a separate action, not part of this runbook; Hunter's rule: no push to main). c. The manager re-reads `pipeline/src/prod-sql.ts` on the merged result and confirms every action and phrase cited in this runbook is unchanged; if the merged tip differs from `47f4920`, the contract script's pinned tip is updated under its own review (`scripts/verify-cutover-runbook-contract.mjs` pins `47f4920`). d. The runner's own offline test (`test:prod-sql` in `pipeline/package.json`) passes (not verified: not run here).
- **Success check:** `pipeline/src/prod-sql-runner.ts` is present on the branch the cutover runs from, and the cited actions and phrases match it.
- **Go-gate:** Hunter says "go for GATE-1". Needed before A2, A3, B2, B3, B4, B13, BO2, BO4, BO5 and BO6.

🔴 **GATE-2 — staging-2 auth-table inventory capture and human classification (before B13 L1)** — NOT APPROVED, needs its own go
- **What:** the runner's L1 shape gate (action `l1-shape`, which `l1-sweep` runs first inside its own transaction) refuses any `auth.*` table that is not listed in `supabase/rollout/auth-table-classification.json`. A table listed `credential-bearing: STOP` no longer stops the shape check by name (Hunter approved "stop unless empty", item 28, 2026-11-01): it is judged by emptiness, under a lock, inside the `l1-sweep` transaction (B13 stages 3 and 6). The file lists 27 tables: 5 that L1 clears, 9 reviewed as not credential-bearing, and 13 classified `credential-bearing: STOP` (named in B13). The staging-2 capture (read-only catalogue query `supabase/rollout/auth-schema-inventory.sql`) is recorded in doc 18 and the file is classified from it; a staging capture is not proof of production parity (note in the classification file), so the production tables are only judged when B13 stage 1 and the sweep run. **Why needed:** without a reviewed classification the shape gate stops B13 on an unclassified table, or passes on a wrong list. **If skipped:** B13 L1 must not start.
- **Steps:**
  1. a. **Capture (Doppler `stg` read, staging-2 only, read-only SQL).** Secret by name: `STAGING_DB_URL`, Doppler project `truck-recruitment-tool`, config `stg`. `<DIR>` is an absolute folder outside the repository. Command from doc 18, plan-only first (not run here):
  ```
  doppler run --project truck-recruitment-tool --config stg -- node scripts/run-with-secrets.mjs --from-env --cwd pipeline --secret STAGING_DB_URL -- node node_modules/tsx/dist/cli.mjs src/staging-sql-runner.ts --project=rebuilt --action=auth-schema-inventory --confirm="TAKE TNBS AUTH SCHEMA INVENTORY" --out=<DIR>\auth-schema-inventory-staging2.json
  ```
  b. After the plan output was read and Hunter's go for the capture, the same line with `--execute` added at the end:
  ```
  doppler run --project truck-recruitment-tool --config stg -- node scripts/run-with-secrets.mjs --from-env --cwd pipeline --secret STAGING_DB_URL -- node node_modules/tsx/dist/cli.mjs src/staging-sql-runner.ts --project=rebuilt --action=auth-schema-inventory --confirm="TAKE TNBS AUTH SCHEMA INVENTORY" --out=<DIR>\auth-schema-inventory-staging2.json --execute
  ```
  2. a. **Human classification (separate go).** A person reviews the file (names and types only), records the Auth release the project runs, and classifies each table in `auth-table-classification.json` with a cited source; the pin and the regression fixtures are updated together; the gate is re-run on staging (doc 18). Who classifies is not named in doc 18 (not verified: the manager proposes each entry with its source and Hunter approves is assumed here, not recorded). Any table not proven non-credential-bearing stays `STOP`; a `STOP` table that holds rows stops B13 while it is populated (see the B13 STOP rule); the classification is never bulk-changed to get past it.
- **Success check:** the capture file exists outside the repository; every table in it is classified with a cited source; no table remains unclassified (a table that stays `STOP` is allowed: B13 handles it by emptiness); the staging gate re-run passes.
- **Go-gate:** GATE-1 done; Hunter says "go for GATE-2" for the capture, and says it again for the classification and pin update. Required before B13.

🔴 **GATE-3 — The irreversible termination warning, before `retire-terminate`** — NOT APPROVED, needs its own go
- **What:** Route A action `retire-terminate` (BO2 step 3) ends every database connection of the application role. Ended connections **cannot be brought back, and a rollback does not restore them**. The runner prints a fixed warning event `prod-sql.warning` with id `connections_end_cannot_be_undone` together with the plan, before anything connects, for plan-only and `--execute` alike. After a run that ends `rolled_back`, `rollback_not_confirmed` or `unknown` it prints `rollback_does_not_restore_connections`. The fixed sentences (runner source) are: "WARNING: this step ENDS every database connection of the application role. Ended connections cannot be brought back and a rollback does not restore them. Take the owner go for this step only." and "WARNING: a rolled_back or unknown result covers SQL changes only; any connections this step already ended stay ended. STOP, do not retry, and read the real connection count with the retire-backends action." **Why needed:** this is the one step whose effect cannot be undone by the runner's rollback. **If skipped:** the connections could be ended without Hunter having read and accepted that.
- **Steps:**
  1. a. The operator runs the plan-only `retire-terminate` command from BO2 step 3 (connects to nothing) and shows Hunter the `prod-sql.warning` line. b. Hunter reads it and says "go for GATE-3". c. Only then may the `--execute` box in BO2 step 3 be run. d. After any error: **STOP**, do not retry, run the `retire-backends` count (BO2 step 3).
- **Success check:** the plan-only output showed the `connections_end_cannot_be_undone` warning and Hunter's GATE-3 go is recorded before the `--execute` line runs.
- **Go-gate:** GATE-1 done; BO1 done; the BO2 go given; Hunter says "go for GATE-3" (separate from "go for BO2"). Doc 18 adds no extra typed phrase for this step beyond its own per-action phrase (a second phrase is a separate decision).

---

#### The production steps (all NOT APPROVED, each needs its own go)

Legend: **Who** = Hunter (owner) or the operator (the agent running reviewed files). "Go-gate" = what must be true and what Hunter must say before the step. After any failure: **stop, do not retry, tell the manager**. Links marked "(not verified: …)" were not opened; exact page and button names must be confirmed on the day.

Order at a glance: **Part A** (prepare, nothing user-facing) → **Part B** (maintenance period, everything database- and provider-side, ends with maintenance off) → **Part C** (after opening: the real sign-in and the webhook proof) → **Backout**.

##### Part A — before the maintenance period (nothing user-facing changes)

🔴 **A1 — Read-only production inventory (O1)** — NOT APPROVED, needs its own go
- **What:** counts of profiles by role and status, duplicate emails, email mismatches and approved profiles with no Auth user. **Why:** decides D7 (old pending/guest rows) and the unique-index question; confirms nothing changed since 2026-10-22 (that day: 0 profiles, 0 Auth users, doc 15 §32). **If skipped:** the cutover could meet surprise rows.
- **Who:** the operator, through Route A (OPEN-1, closed): action `read-only-inventory`, phrase `RUN TNBS PRODUCTION SQL READ-ONLY-INVENTORY`. The file is `supabase/rollout/read-only-inventory.sql`, pinned by SHA-256 in the runner (`50e6cd622a4d…`). It is **one select that returns one row of 20 whole-number counts**, run in `begin read only` and ended with a rollback; it never commits, and no id, email or name leaves the database. Hunter supplies `PRODUCTION_DB_URL` only to the hidden prompt. (Doc 14 §11.4 O1 said "the existing Hunter-run read-only query route"; with OPEN-1 closed on Route A this runbook uses the runner action instead. Not verified: that Hunter wants the runner, not the dashboard, for O1 specifically. The file's header says DRAFT, PENDING REVIEW.)
- **Steps:**
  1. a. Plan-only first (connects to nothing; expect `prod-sql.verified`, then `prod-sql.plan_only`):
  ```
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/prod-sql-runner.ts --target=production --action=read-only-inventory --confirm="RUN TNBS PRODUCTION SQL READ-ONLY-INVENTORY"
  ```
  b. After Hunter's go, execute:
  ```
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/prod-sql-runner.ts --target=production --action=read-only-inventory --confirm="RUN TNBS PRODUCTION SQL READ-ONLY-INVENTORY" --execute
  ```
  2. a. Record the 20 counts (numbers only, never names or emails) from the `prod-sql.counts` line: `profiles_total`, `auth_users_total`, the twelve `profiles_<role>_<status>` counts (role manager, edit, view, guest; status pending, approved, disabled), `profiles_other_role_status`, `duplicate_email_groups`, `duplicate_email_rows`, `email_mismatches`, `approved_profiles_without_auth_user`, `approved_auth_email_null`. b. Report them to the manager.
- **Success check:** the run ends with result `read_only_done`; the counts are recorded; `profiles_other_role_status` is 0; nothing was written. Any surprise (for example `profiles_total` above 0 when production should be empty) is a decision for Hunter, not a failure to retry.
- **Go-gate:** GATE-1 done; Hunter says "go for A1".
- **Source:** doc 14 §11.4 O1; doc 16 §3.2 step 1; doc 18 (the `read-only-inventory` row) and `supabase/rollout/read-only-inventory.sql` at `47f4920`.

🔴 **A2 — The four July migrations on production (only if still unapplied)** — NOT APPROVED, needs its own go per migration (approval 19)
- **What:** `20260722223300_security_hardening`, `20260723004500_profile_service_bootstrap`, `20260723010400_dnc_activity_enum_cast`, `20260723020000_contact_logs_dnc_guard`, one at a time, each after its staging replay (release-path plan §2 steps 9a–9d; M1, M1b and M1c depend on all four, doc 16 §1.1). **If skipped:** M1 fails or leaves the wrong permissions.
- **Who:** the operator, through Route A (OPEN-1, closed), with Hunter supplying `PRODUCTION_DB_URL` only to the hidden prompt. The runner runs the file from `supabase/migrations/` as pinned by SHA-256 (it refuses on any mismatch).
- **Steps:**
  1. a. For each migration in the order above, one at a time: run the plan-only box, read it, then (after Hunter's go for that migration) the `--execute` box. b. After each, run the success check below before the next. c. Hunter's separate go for each.
  2. Migration 1, action `migration-security-hardening`, phrase `RUN TNBS PRODUCTION SQL MIGRATION-SECURITY-HARDENING`. Plan-only:
  ```
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/prod-sql-runner.ts --target=production --action=migration-security-hardening --confirm="RUN TNBS PRODUCTION SQL MIGRATION-SECURITY-HARDENING"
  ```
  Execute:
  ```
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/prod-sql-runner.ts --target=production --action=migration-security-hardening --confirm="RUN TNBS PRODUCTION SQL MIGRATION-SECURITY-HARDENING" --execute
  ```
  3. Migration 2, action `migration-profile-service-bootstrap`, phrase `RUN TNBS PRODUCTION SQL MIGRATION-PROFILE-SERVICE-BOOTSTRAP`. Plan-only:
  ```
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/prod-sql-runner.ts --target=production --action=migration-profile-service-bootstrap --confirm="RUN TNBS PRODUCTION SQL MIGRATION-PROFILE-SERVICE-BOOTSTRAP"
  ```
  Execute:
  ```
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/prod-sql-runner.ts --target=production --action=migration-profile-service-bootstrap --confirm="RUN TNBS PRODUCTION SQL MIGRATION-PROFILE-SERVICE-BOOTSTRAP" --execute
  ```
  4. Migration 3, action `migration-dnc-activity-enum-cast`, phrase `RUN TNBS PRODUCTION SQL MIGRATION-DNC-ACTIVITY-ENUM-CAST`. Plan-only:
  ```
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/prod-sql-runner.ts --target=production --action=migration-dnc-activity-enum-cast --confirm="RUN TNBS PRODUCTION SQL MIGRATION-DNC-ACTIVITY-ENUM-CAST"
  ```
  Execute:
  ```
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/prod-sql-runner.ts --target=production --action=migration-dnc-activity-enum-cast --confirm="RUN TNBS PRODUCTION SQL MIGRATION-DNC-ACTIVITY-ENUM-CAST" --execute
  ```
  5. Migration 4, action `migration-contact-logs-dnc-guard`, phrase `RUN TNBS PRODUCTION SQL MIGRATION-CONTACT-LOGS-DNC-GUARD`. Plan-only:
  ```
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/prod-sql-runner.ts --target=production --action=migration-contact-logs-dnc-guard --confirm="RUN TNBS PRODUCTION SQL MIGRATION-CONTACT-LOGS-DNC-GUARD"
  ```
  Execute:
  ```
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/prod-sql-runner.ts --target=production --action=migration-contact-logs-dnc-guard --confirm="RUN TNBS PRODUCTION SQL MIGRATION-CONTACT-LOGS-DNC-GUARD" --execute
  ```
- **Backouts (kept here so each is known before the go; one line each, all NOT APPROVED):** hardening → Route A action `security-hardening-backout`, phrase `RUN TNBS PRODUCTION SQL SECURITY-HARDENING-BACKOUT` (file `supabase/backout/security-hardening-backout.sql`; the commands are in BO10; run after `M1-backout.sql` if M1 is also being backed out). **Profile bootstrap: `profile-bootstrap-backout` is DO NOT USE.** The runner refuses it as `prod_sql_action_do_not_use`, with or without `--execute` and whatever phrase is typed. Why (doc 18): the byte-exact restore of the earlier profile guard fails open for a pending or disabled user, so that user could set their own role to manager and status to approved, which re-opens self-approval. **DNC enum cast: `dnc-enum-cast-backout` is DO NOT USE.** Refused the same way. Why (doc 18): the restored function fails with SQLSTATE `42804` for an authorized editor, and the forward migration exists to fix exactly that on PostgreSQL 17. **The forward fixes (`20260723004500_profile_service_bootstrap` and `20260723010400_dnc_activity_enum_cast`) are RETAINED during any application backout**: each replaces one function body and changes no table or data, so nothing needs undoing. A replacement guard or function would be new SQL needing its own separate review (doc 18); none is written or proposed here. DNC guard (`20260723020000`) → drop trigger and function (file header; not verified: no runner action for it appears in the runner source at `47f4920`; no file prepared).
- **Success check (per file):** the runner prints result `committed`; the function or trigger is present when re-read; the next nightly pipeline run succeeds (plan step 9a evidence).
- **Go-gate:** GATE-1 done; the migration's staging replay passed; Hunter says "go for A2, migration <name>".
- **Source:** release-path plan §2 steps 9a–9d; doc 16 §3.2 step 1; `scripts/verify-baseline-reconciliation.mjs`.

🔴 **A3 — Pre-cutover permission snapshot (read-only)** — NOT APPROVED, needs its own go
- **What:** `supabase/backout/pre-cutover-snapshot.sql` lists every grant, policy and function M1 touches. **Why:** the backout is checked against it. **If skipped:** the backout cannot be proven identical. Must run **before** M1.
- **Who:** the operator, through Route A (OPEN-1, closed): action `snapshot`, phrase `RUN TNBS PRODUCTION SQL SNAPSHOT`. It is read-only; the runner reports a digest per statement instead of printing rows. Hunter supplies `PRODUCTION_DB_URL` only to the hidden prompt.
- **Steps:**
  1. a. Plan-only first:
  ```
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/prod-sql-runner.ts --target=production --action=snapshot --confirm="RUN TNBS PRODUCTION SQL SNAPSHOT"
  ```
  b. After Hunter's go, execute:
  ```
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/prod-sql-runner.ts --target=production --action=snapshot --confirm="RUN TNBS PRODUCTION SQL SNAPSHOT" --execute
  ```
  c. Store the printed output (digests, no rows) **outside the repo** with the release record. d. Do not paste it into chat.
- **Success check:** the stored output exists, is non-empty, and ends with result `read_only_done`.
- **Go-gate:** GATE-1 done; Hunter says "go for A3".
- **Source:** doc 14 §11.5; doc 16 §1.3 step 6, §3.2 step 1.

🔴 **A4 — Read the hosted sign-in expiry settings (fixes wait W)** — NOT APPROVED, needs its own go
- **What:** read the hosted access-token (JWT) expiry and email OTP/link expiry. **W = the larger of the two + 5 minutes.** `supabase/config.toml` is NOT used. **If either cannot be read, L1 stops** (doc 14 §11.6 step 0).
- **Who:** Hunter.
- **Steps:**
  1. a. Open https://supabase.com/dashboard (not verified: exact page) → the production project → Authentication → the page that shows the JWT expiry and the email OTP/link expiry (not verified: exact page names; the manager confirms them on staging first). b. Write down both numbers. c. Tell the manager the numbers and compute W together.
- **Success check:** W is a number of minutes recorded here and in the maintenance-period length.
- **Go-gate:** Hunter says "go for A4".
- **Source:** doc 14 §11.6 step 0; doc 16 §3.2 step 1.

🔴 **A5 — Doppler `prd`: create every name for the new service** — NOT APPROVED, needs its own go (Hunter asks before changing anything in Doppler `prd`)
- **What:** make one place — Doppler project `truck-recruitment-tool`, config `prd` (OPEN-5) — that holds **every** environment setting the new Render service will use. **Why:** a Doppler → Render sync replaces every Render setting with what Doppler holds (playbook), so Doppler must be complete before it is connected (B6). **If skipped:** secrets end up outside Doppler, which breaks Hunter's rule.
- **Who:** Hunter, with the operator watching.
- **Steps:**
  1. a. Open https://dashboard.doppler.com (not verified: exact page names) → project `truck-recruitment-tool` → config `prd`.
  2. a. Add these **non-secret** names with these values, exactly:
  ```
  NODE_VERSION=22
  HOST=0.0.0.0
  STATIC_DIR=dist
  TRUSTED_PROXY_HOPS=0
  EMAIL_MODE=production
  MAINTENANCE_MODE=true
  VITE_APP_ENV=production
  VITE_MAPS_PROVIDER=google
  ```
  b. `TRUSTED_PROXY_HOPS` is `0` only until the T-IP test on staging produces the real number; replace it with that number before B15 (doc 16 §2.3). c. `NODE_VERSION`: confirm an installed 22.x at least 22.12 (the app needs `>=22.12.0`; not verified).
  3. a. Create these **secret** names now, with the value left empty for the moment (each is filled by the step named, not here): `APP_ORIGIN` (A6), `DATABASE_URL` (B5), `KEY_LINKS`, `KEY_SESSIONS`, `KEY_RATE` (step 4 below), `SENDGRID_API_KEY`, `SENDGRID_FROM_ADDRESS`, `SENDGRID_FROM_NAME`, `SENDGRID_WEBHOOK_VERIFICATION_KEY` (A9), `VITE_GOOGLE_MAPS_API_KEY`, `VITE_GOOGLE_MAPS_MAP_ID` (A8). Do **not** create `DB_ACQUIRE_TIMEOUT_MS` (leave it unset; an empty string is not the same as unset). Do **not** create `PORT` (Render supplies it) or `STAGING_BANNER` (staging only). `PRODUCTION_DB_URL` and `TEMP_RENDER_API_KEY` are forbidden in this runtime config; neither is an app runtime setting.
  4. a. Make the three app keys (`KEY_LINKS`, `KEY_SESSIONS`, `KEY_RATE`): three different 32-byte random values, base64url, at least 43 characters (`app/server/config.ts`; doc 16 §2.3). b. In a **Windows PowerShell** window, paste this block (not run by the author), which puts one key on the clipboard and prints nothing:
  ```
  $b = New-Object byte[] 32; [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); Set-Clipboard -Value ([Convert]::ToBase64String($b).TrimEnd('=').Replace('+','-').Replace('/','_'))
  ```
  c. In Doppler, open `KEY_LINKS`, paste, save. d. Paste the whole block again for `KEY_SESSIONS`, and again for `KEY_RATE`; each must be different. e. When done, clear the clipboard by pasting `Set-Clipboard -Value ' '` in PowerShell, and close the window.
  5. a. Do **not** connect any sync in this step.
- **Success check:** Doppler `prd` shows all the names above (the secret ones may still be empty except the three `KEY_*`); no value was typed into Render, chat or a file. Report names only.
- **Go-gate:** OPEN-5 answered and Hunter says "go for A5".
- **Source:** doc 16 §2.3, §2.4, §3.2 step 2; `app/server/config.ts`; `docs/build-plan/drafts/render-recruiter-web.yaml`; `C:\Users\hunte\.bb\BB Rules\doppler-render-playbook.md`.

🔴 **A6 — Production Render service, created suspended with NO environment variables** — NOT APPROVED, needs its own go (approval 20; cost ≈ $7/month, NOT VERIFIED today, doc 16 §2.1 read 2026-10-23)
- **What:** create the web service `tnbs-recruiter-prod` **suspended**. Only its build/start/health settings are typed in Render; **its environment settings come from Doppler later (B6)**, never from Render's own Environment page. **Why:** the server must exist before the cutover. **If skipped:** nothing to deploy.
- **Who:** Hunter creates it; the draft values are in `docs/build-plan/drafts/render-recruiter-web.yaml`.
- **Steps:**
  1. a. Open https://render.com/pricing (not verified: current page) and check the price. b. Tell the manager.
  2. a. Open https://dashboard.render.com (not verified: exact page) → New → Web Service (not verified: exact button names) → connect the repository and the commit the manager names.
  3. a. Fill **only** these settings (no environment variables):
  ```
  Name:               tnbs-recruiter-prod
  Runtime:            Node
  Root directory:     app
  Build command:      npm ci && npm run build && npm run build:server
  Start command:      node dist-server/main.js
  Health check path:  /readyz
  Auto-deploy:        Off
  ```
  b. Plan and region: the manager confirms the plan name and region on the day (not verified: the draft says `starter` and `ohio`).
  4. a. Before the first deploy, **suspend** the service (not verified: exact button name).
  5. a. Read the service's public address Render shows. b. In Doppler `prd`, fill `APP_ORIGIN` with that exact `https://...` origin: no path, no trailing slash. (If a custom domain is used instead, that is a separate decision and its own go.)
- **Success check:** the service shows as suspended; Render's Environment page shows **no** variables you typed; `APP_ORIGIN` is filled in Doppler; nothing was typed into Render's environment.
- **Go-gate:** OPEN-4 done, A5 done, and Hunter says "go for A6".
- **Source:** doc 16 §2.2, §2.3, §2.4, §3.2 step 2; draft file above.

🔴 **A7 — Shutdown delay 60 s set and read back** — NOT APPROVED, needs its own go
- **What:** the server drains for up to 45 s; Render's default wait is 30 s (doc 16 §2.2). A Render API key is needed for one `PATCH` and one `GET` of the service. **Why:** without it, in-flight sign-in emails can be cut off. **If skipped:** T-SHUTDOWN is not proven for production.
- **Who:** Hunter creates the key and stores it in Doppler; the operator runs the call; Hunter revokes the key.
- **Steps:**
  1. a. Open https://dashboard.render.com (not verified: exact page) → Account Settings → API Keys (not verified: exact names) → create a key. b. Open https://dashboard.doppler.com (not verified) → project `truck-recruitment-tool` → config `dev` → add the secret `TEMP_RENDER_API_KEY` and paste the key there (the playbook's convention). Never into chat.
  2. a. Operator: one `PATCH` setting `maxShutdownDelaySeconds: 60`, then one `GET`, and records the returned value. **GAP: no command is recorded in the repo for this call; the manager supplies a reviewed one.**
  3. a. Hunter deletes the Render API key in Render. b. Hunter deletes `TEMP_RENDER_API_KEY` from Doppler `dev`.
- **Success check:** the read-back value is 60. If it is not returned, **stop** (doc 16 §2.2). Both the key and its Doppler copy are deleted.
- **Go-gate:** A6 done; Hunter says "go for A7".
- **Source:** doc 16 §2.2; playbook (TEMP_RENDER_API_KEY).

🔴 **A7R — Separate reader-key copy for sync checks and deployment monitoring** — NOT APPROVED, needs its own go
- **What:** after A7 deletes its write-capable key and Doppler copy, place a separately approved reader-key copy named `TEMP_RENDER_API_KEY` in Doppler `truck-recruitment-tool` / `dev`. Source: existing `TEMP_RENDER_API_KEY` in `carrieronboardingbot` / `dev`, per the playbook. **Why:** the local inspect, verify and deploy-watch helpers require this exact target project's `dev` name; A7's revoked key cannot serve them. **If skipped:** B6, B7, B15 and BO1 cannot use those helpers.
- **Who:** Hunter approves the lifecycle; the operator performs only the reviewed secret-safe copy after approval.
- **Steps:**
  1. a. At https://dashboard.doppler.com (not verified: exact pages), identify source project `carrieronboardingbot` → config `dev` → `TEMP_RENDER_API_KEY` and destination project `truck-recruitment-tool` → config `dev`. b. At https://dashboard.render.com → Account Settings → API Keys (not verified: exact names), confirm with Hunter the source reader key is valid and suitable for the connection and read-only helpers, without showing its value. If not confirmed, **stop**; do not recreate or silently reuse A7's key.
  2. a. The manager supplies a reviewed copy procedure that moves the secret between those Doppler scopes without printing, logging or writing its value to a file. **GAP: the exact copy command is not recorded here; stop until it is supplied and reviewed.** Paste box: *(manager must add the reviewed secret-safe procedure before requesting go)*. b. Copy only after the separate go; never put it in `prd`, Render's Environment page or chat.
  3. a. Keep the target `dev` copy available through B6 connection/verification, B7, B15 and any BO1 monitoring, until the backout window is closed or the approved backout is complete. b. Final removal is K1, with its own go. The shared source reader key and the Render integration's connection credential remain in use; this runbook does not revoke them.
- **Success check:** source and target secret names/scopes and reader-key validity are confirmed without values; A7's write key is gone; the target reader copy remains available for all later helpers.
- **Go-gate:** A7 cleanup verified; exact secret-safe copy procedure reviewed; reader-key scope/validity and retention through backout approved; Hunter says "go for A7R".
- **Source:** playbook prerequisite and step 4; local `deploy-watch.js` line 5 reads the target project's `dev` config.

🔴 **A8 — Google Maps referrer for the production origin** — NOT APPROVED, needs its own go
- **What:** add the production origin to the browser key's allowed referrers, and record the two Maps values in Doppler. **If skipped:** maps fail closed; nothing else depends on it (doc 16 §2.4).
- **Who:** Hunter.
- **Steps:**
  1. a. Open https://console.cloud.google.com/apis/credentials (not verified: exact page) → the browser key → Application restrictions (not verified: exact names). b. **Read first** and report which referrers exist (names only). c. After the go, add the production origin from `APP_ORIGIN`.
  2. a. The key value is already in the old setup; copy it from its existing source (Doppler or the Google console) into Doppler `truck-recruitment-tool` / `prd` as `VITE_GOOGLE_MAPS_API_KEY`, and the Map ID as `VITE_GOOGLE_MAPS_MAP_ID`. (Not verified: which Doppler project holds the existing copies.)
- **Success check:** the production origin appears in the list; no other entry changed; both names are filled in Doppler `prd`.
- **Go-gate:** A6 done; Hunter says "go for A8" (approval 20).
- **Source:** doc 16 §2.4.

🔴 **A9 — SendGrid production key, webhook and sender (Quote-Queue's account): CONFIGURE only** — NOT APPROVED, needs its own go (approval 20)
- **What:** a send-only key, a **second** signed Event Webhook, and a sender address, with every value stored in Doppler `prd`. Never reuse Quote-Queue's key or webhook. Capacity check comes first (the plan may not allow another webhook). **This step only configures; it does not test.** The webhook cannot be tested yet: maintenance mode answers 503 before the signature is even checked, and the service is not deployed. The proof is step C2, after maintenance is off. **If skipped:** no sign-in emails.
- **Who:** Hunter.
- **Steps:**
  1. **Capacity check (read-only).** a. Open https://app.sendgrid.com (not verified: exact page) → Settings → Mail Settings → Event Webhooks (not verified: exact names). b. Count the enabled webhooks. c. If another cannot be created: **stop** and tell the manager.
  2. **Send-only key.** a. Settings → API Keys → Create API Key (not verified: exact names). b. Name `tnbs-recruiter-prod-send`. c. Restricted Access → Mail Send: Full Access, everything else No Access. d. Create & View. e. Open https://dashboard.doppler.com (not verified) → project `truck-recruitment-tool` → config `prd` → `SENDGRID_API_KEY` → paste → save. Never into chat, email, a file or Render.
  3. **Second Event Webhook.** a. Create new webhook, name `tnbs-recruiter-prod`. b. Post URL = the value of `APP_ORIGIN` + `/webhooks/sendgrid`. c. Events: Processed, Delivered, Deferred, Dropped, Bounced, Spam Reports; open/click tracking **off**. d. Save, open it, enable **Signed Event Webhook**, copy the verification key into Doppler `prd` as `SENDGRID_WEBHOOK_VERIFICATION_KEY`. e. Do **not** press "Test Your Integration" yet (step C2).
  4. **Sender.** a. Settings → Sender Authentication (not verified: exact names). b. Use an address on a domain Quote-Queue already authenticated (no DNS change) → Doppler `prd` `SENDGRID_FROM_ADDRESS`; display name → `SENDGRID_FROM_NAME`. (Doc 13 recommended `signin@twistednail.com`; the choice is Hunter's.)
- **Success check:** the key list shows the new key as restricted; the webhook exists with a verification key; the four Doppler names are filled; **no verified event is claimed yet** (that is C2).
- **Go-gate:** A6 done; Hunter says "go for A9".
- **Source:** doc 16 §7 (B, A, C, D, E), §3.2 step 2; doc 15 §8 item 2.

##### Part B — the maintenance period (everything inside it, in this order; ends with maintenance OFF)

Length of the period = the work below + **W** (A4). Pick the date with Hunter; give times in US Central **and** UTC. Doc 16 §3.2 step 3: **maintenance stays on until O2, L1 and the acceptance probes pass.** Nothing in Part B needs the real sign-in or the webhook: both are 503 while maintenance is on.

🔴 **B1 — Maintenance on (and record the fallback)** — NOT APPROVED, needs its own go (approval 22)
- **What:** `MAINTENANCE_MODE=true` is already the value in Doppler `prd` (A5), so the new server's first deploy serves only the maintenance reply. Production has no users (release-path plan step 14), so nobody is locked out. **Limitation:** nothing in this repo makes the old static frontend show a "back shortly" notice; this runbook does not claim one. The pre-cutover frontend stays deployed and untouched.
- **Steps:**
  1. a. Open https://dashboard.doppler.com (not verified) → project `truck-recruitment-tool` → config `prd` → read `MAINTENANCE_MODE`; it must be `true`. b. Open https://dashboard.render.com (not verified) and **write down which deploy of the current static site is live**, for backout (doc 16 §1.7). Change nothing there.
- **Success check:** the Doppler value reads `true`; the pre-cutover deploy is written down.
- **Go-gate:** Hunter says "go for the cutover window, starting B1" (approval 22).
- **Source:** doc 16 §3.2 step 3, §1.7.

🔴 **B2 — M1** — NOT APPROVED, needs its own go
- **What:** `supabase/pending/M1_same_origin_signin.sql` (1,816 lines): creates the sign-in tables and the roles `recruiter_api`, `recruiter_app`, `recruiter_maintenance` (no passwords), re-keys permissions from `auth.uid()` to the session ledger, and ends with a PostGIS self-check that aborts everything on failure. **If skipped:** no new sign-in.
- **Who:** the operator, through Route A (OPEN-1, closed): action `m1`, phrase `RUN TNBS PRODUCTION SQL M1`. The runner sends the pinned file unchanged, first line to last, and wraps it in one transaction when the file has none of its own. Hunter supplies `PRODUCTION_DB_URL` only to the hidden prompt.
- **Steps:**
  1. a. Plan-only first (no edits to the file; do not split it):
  ```
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/prod-sql-runner.ts --target=production --action=m1 --confirm="RUN TNBS PRODUCTION SQL M1"
  ```
  b. After Hunter's go, execute:
  ```
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/prod-sql-runner.ts --target=production --action=m1 --confirm="RUN TNBS PRODUCTION SQL M1" --execute
  ```
- **Paste box:** none; the runner reads the file itself.
- **Success check:** the runner prints result `committed`; the PostGIS self-check passes; Postgres logs show no `permission denied` / `does not exist` (doc 16 §1.5 row 2).
- **Go-gate:** B1 done, A2 done, A3 snapshot stored, GATE-1 done; Hunter says "go for B2".
- **Rollback:** the Backout section below.
- **Source:** doc 16 §1.4 step 1, §3.2 step 3; the file header.

🔴 **B3 — M1b (managers add people)** — NOT APPROVED, needs its own go
- **What:** `supabase/pending/M1b_add_person.sql` (D8, approved 2026-10-22): adds `team_add_person` and drops the `profiles_id_fkey` so a profile no longer needs an Auth user. **If skipped:** the first manager cannot be created (B8/B9) and nobody can be added.
- **Who:** the operator, through Route A (OPEN-1, closed): action `m1b`, phrase `RUN TNBS PRODUCTION SQL M1B`. Hunter supplies `PRODUCTION_DB_URL` only to the hidden prompt.
- **Steps:**
  1. a. Plan-only first (the file runs unchanged, first line to last; no edits):
  ```
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/prod-sql-runner.ts --target=production --action=m1b --confirm="RUN TNBS PRODUCTION SQL M1B"
  ```
  b. After Hunter's go, execute:
  ```
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/prod-sql-runner.ts --target=production --action=m1b --confirm="RUN TNBS PRODUCTION SQL M1B" --execute
  ```
- **Paste box:** none; the runner reads the file itself.
- **Success check:** the runner prints result `committed`, with no error.
- **Go-gate:** B2 committed; GATE-1 done; Hunter says "go for B3".
- **Rollback:** the Backout section below.
- **Source:** doc 16 §1.4 step 2; doc 15 §32.

🔴 **B4 — M1c (batch delete audit)** — NOT APPROVED, needs its own go
- **What:** `supabase/pending/M1c_batch_delete_audit.sql` (Hunter "yes", 2026-10-23, per doc 16): the batch-delete audit record. **Its self-check must pass** (doc 16 §3.2 step 3). **If skipped:** batch deletes are not audited.
- **Who:** the operator, through Route A (OPEN-1, closed): action `m1c`, phrase `RUN TNBS PRODUCTION SQL M1C`. Hunter supplies `PRODUCTION_DB_URL` only to the hidden prompt.
- **Steps:**
  1. a. Plan-only first (the file runs unchanged, first line to last; no edits):
  ```
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/prod-sql-runner.ts --target=production --action=m1c --confirm="RUN TNBS PRODUCTION SQL M1C"
  ```
  b. After Hunter's go, execute:
  ```
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/prod-sql-runner.ts --target=production --action=m1c --confirm="RUN TNBS PRODUCTION SQL M1C" --execute
  ```
- **Paste box:** none; the runner reads the file itself.
- **Success check:** the runner prints result `committed` and the file's self-check passes.
- **Go-gate:** B3 committed; GATE-1 done; Hunter says "go for B4".
- **Rollback:** the Backout section below.
- **Source:** doc 16 §1.4 step 3.

🔴 **B5 — Set the `recruiter_app` password and store `DATABASE_URL` in Doppler** — NOT APPROVED, needs its own go
- **What:** M1 makes the login roles without passwords. The owner sets the password out of band. **Why:** the server cannot connect without it. **If skipped:** the deploy never becomes ready (`/readyz` stays 503).
- **Who:** Hunter, on **Route B** (the Supabase SQL editor), as decided in OPEN-1. This is the one statement that stays off the Route A runner, so the password never passes through runner output.
- **Status of the paste box:** **DRAFT, NOT APPROVED, NEEDS REVIEW.** The statement below is a draft adapted from Quote-Queue's recorded form `ALTER ROLE qq_maintenance LOGIN PASSWORD '<generated>'` (QQ `docs/M0_HOMEWORK.md` / `scripts/retention.ts` at 4059789). A reviewed paste box still owed: the manager's review replaces this draft and removes this marker; until then nobody runs it.
- **Still owed before this is a reviewed paste box (open questions for the manager; each needs a verified answer or Hunter's decision, none is decided here):** 1. exact production project identification, the SQL Editor's execution role and privileges, page and button names, and the approved one-statement SQL for the named role, with target and role checks and success evidence that show no secret; 2. password generation, storage and substitution, and confirmed SQL editor history, saved-query and log treatment **before** the statement is run (the cleanup in these steps is a draft and does not prove every retained copy is removed); 3. the correct session-pooler username, mode and port and the approved credential source; the app URL must be the restricted runtime login, never the owner URL (`DATABASE_URL` in `truck-recruitment-tool/prd` is the runtime `recruiter_app` credential that B6 syncs to the recruiter app; owner-only `PRODUCTION_DB_URL` is never synced); 4. OPEN-5's scope decision and B6's full-name inventory and sync isolation (no sync is connected or changed by B5).
- **Steps (the DRAFT owner steps in Hunter's four-heading format are the next four headings; the first one is the action):**

  ###### Pending Action (DRAFT, NOT APPROVED, NEEDS REVIEW)
  - 🔴 **Set the `recruiter_app` database password, then store the connection URL in Doppler (B5)** — **What:** give the database login `recruiter_app` a password, so the new server can connect. **Why needed:** M1 created that login with no password; without one the deploy never becomes ready. **If skipped:** `/readyz` stays 503 and the new sign-in never starts. Do this only after B4 committed and Hunter's "go for B5".
    1. a. **Make the password.** In your password manager (not verified: which one), create a new entry named `tnbs production recruiter_app password` and use its generator: at least 32 characters, **letters and digits only** (no quotes, backslashes or symbols: the password goes into a SQL line and later into a web address, and symbols can break both). b. Never type or paste it into chat, a file, Render or GitHub. c. Success check: the entry exists and is saved.
    2. a. **Run one line in the production database.** Open https://supabase.com/dashboard (not verified: exact page) → the **production** project (the manager names it; do not use the staging project) → SQL Editor (not verified: menu name) → New query. b. Paste this line, then replace `<paste here>` with the password from your password manager. Keep the two single quotes around it. Nothing else changes:
    ```
    ALTER ROLE recruiter_app LOGIN PASSWORD '<paste here>';
    ```
    c. Press Run (not verified: button name). d. Success check: the editor reports success and no error (not verified: exact wording). On any error, **stop**, do not retry, tell the manager. e. Then clear the query text and close the tab. Supabase may keep a saved copy of the query (not verified): the manager checks, and if it does, delete that saved query before continuing.
    3. a. **Store the connection URL in Doppler.** Open https://supabase.com/dashboard (not verified: exact page) → the production project → the connection page (not verified: exact page name) → copy the **session pooler** address (port 5432, user `recruiter_app.<project-ref>`, doc 16 §2.6) with its password placeholder (not verified: placeholder wording). b. Open https://dashboard.doppler.com (not verified: exact page) → project `truck-recruitment-tool` → config `prd` → secret `DATABASE_URL`. c. Paste the pooler address into the value box, replace the password placeholder with the password from your password manager, and save. Only into Doppler. d. Success check: `DATABASE_URL` shows as filled. Tell the manager the **name only**.
    4. a. Do not connect any sync and do not click anything in Render in this step.

  ###### Summary of Next Step (DRAFT)
  Nothing runs until the manager reviews this box and Hunter says "go for B5". Then Hunter makes a password, runs one line in the production database, and stores the connection address in Doppler. That is all. Terms: a **role** is a database login name; a **pooler** is the shared doorway the host gives for database connections.

  ###### Summary of Previous Step (DRAFT)
  Verified: M1 creates `recruiter_app` without a password (M1 line 45 comment). Not verified: the exact Supabase and Doppler page and button names, and whether the SQL editor saves queries. The line has never been run anywhere.

  ###### Miscellaneous (DRAFT)
  The password is never shown in this document. `DATABASE_URL` goes in `truck-recruitment-tool` / `prd` (runtime scope). If a different project/config is confirmed in OPEN-5, this step changes.
- **Success check:** `DATABASE_URL` is filled in Doppler `prd` (names only reported). Later, B7's deploy passes the `/readyz` health check.
- **Go-gate:** B4 committed; the reviewed paste box replaces the DRAFT marker; Hunter says "go for B5".
- **Source:** doc 16 §1.4 step 4, §2.6; M1 line 45 comment ("operator later: LOGIN + password").

🔴 **B6 — Connect the Doppler → Render sync (Redeploy = No)** — NOT APPROVED, needs its own go
- **What:** link Doppler `truck-recruitment-tool` / `prd` to the Render service `tnbs-recruiter-prod`. **Why:** Render gets its settings from Doppler. A sync **replaces every Render setting with what Doppler holds** (playbook), which is safe here only because A6 left the service with no variables and Doppler `prd` is now complete. **If skipped:** the deploy has no settings. **Hunter's rule:** never edit these settings in Render directly.
- **Who:** the operator for the read-only checks; Hunter for the connect.
- **Steps:**
  1. **Check Doppler is complete (read-only).** a. Operator: confirm every secret name listed in A5 now has a value (names only, never values). b. Confirm `MAINTENANCE_MODE` is `true`. c. Compare the complete `truck-recruitment-tool/prd` name inventory with A5's runtime-only list: `PRODUCTION_DB_URL`, `TEMP_RENDER_API_KEY` or any unapproved extra name is a **STOP**, even if nonempty. d. Confirm owner-only `truck-recruitment-tool-owner/prd` has no syncs or integrations and is not the selected source. e. If anything is empty or either isolation check fails: **stop**; correct the draft/inventory under separate approval before connecting.
  2. **Inspect Render (read-only).** a. Operator: `node "C:\Users\hunte\.bb\BB Rules\doppler-tools\render-to-doppler.js" inspect truck-recruitment-tool tnbs-recruiter-prod` (playbook step 1). b. Expect **no** variables, no env groups, no secret files. If any exist: **stop** and plan them separately.
  3. **Connect (Hunter).** a. Open https://dashboard.doppler.com (not verified) → Integrations → Render → (+). b. Project `truck-recruitment-tool`, Config `prd`, choose the non-"By project & environment" service selection, service `tnbs-recruiter-prod`, **Redeploy = No**. c. Take a screenshot of the selection only, with no credential fields visible, and give it to the manager. d. Create Sync. If Doppler asks for a first-time Render connection, Name `Render`; its reader credential source is `TEMP_RENDER_API_KEY` in Doppler `truck-recruitment-tool/dev`, copied separately from `carrieronboardingbot/dev` under A7R. Use only the reviewed secret-safe connection procedure in Doppler Integrations; **GAP: manager must record that procedure before requesting go**, without values in chat, files or other dashboards. Never use A7's revoked write key or the owner-only bootstrap config.
  4. **Verify (read-only).** a. Operator: `node "C:\Users\hunte\.bb\BB Rules\doppler-tools\render-to-doppler.js" verify truck-recruitment-tool tnbs-recruiter-prod`. b. Expect 0 missing, 0 different; Render gains only `DOPPLER_CONFIG`, `DOPPLER_ENVIRONMENT`, `DOPPLER_PROJECT`.
- **Success check:** step 4 reports 0 missing and 0 different.
- **Go-gate:** B5 and A7R done; the reader copy in `truck-recruitment-tool/dev` is valid; runtime-only inventory and owner isolation checks passed; exact first-time connection procedure reviewed if needed; Doppler `prd` complete; Hunter says "go for B6".
- **Source:** playbook steps 1, 4, 5; Hunter's rule on Doppler → Render.

🔴 **B7 — Deploy the reviewed commit (Render waits for `/readyz`)** — NOT APPROVED, needs its own go
- **What:** resume the service and deploy the reviewed commit. The service is still in maintenance, so the only answers are the maintenance reply and the health routes. **If skipped:** no server.
- **Who:** Hunter clicks; the operator watches.
- **Steps:**
  1. a. Open https://dashboard.render.com (not verified) → `tnbs-recruiter-prod` → resume (not verified: exact button name). b. Manual Deploy → **Deploy latest commit** (Restart does NOT load new settings, so do not use Restart; the commit is the one the manager names; auto-deploy is off). c. Operator: `node "C:\Users\hunte\.bb\BB Rules\doppler-tools\deploy-watch.js" truck-recruitment-tool tnbs-recruiter-prod`. d. The deploy becomes live only when `/readyz` answers 200.
- **Success check:** the deploy shows live; a visit to the service address shows the plain text "Back shortly." (maintenance). If `/readyz` never answers 200 within the time Render allows (doc 16 says 15 minutes, inherited and not re-verified), Render cancels the deploy. **This is the first deploy of a new service, so there is no older running instance to keep serving**; the live site stays the recorded pre-cutover static frontend (B1). Stop and tell the manager.
- **Go-gate:** B6 done; A7R reader copy `TEMP_RENDER_API_KEY` remains valid in Doppler `truck-recruitment-tool/dev` for the watcher; Hunter says "go for B7".
- **Source:** doc 16 §3.2 step 3, §2.5; `app/server/app.ts:562`; playbook step 6.

🔴 **B8 — First manager: read-only check (maintenance still on)** — NOT APPROVED, needs its own go. **Tool reviewed at `7285a7e` (OPEN-2); merge and staging rehearsal still owed.**
- **What:** report whether production is ready for the first manager row. Reads only. **Why:** the first manager must exist **before** maintenance is lifted, because sign-in cannot be tested while maintenance is on. **If skipped:** the create step runs blind.
- **Who:** the operator, with Hunter present for the hidden prompt.
- **Steps:**
  1. a. Confirm B2 and B3 committed and maintenance remains on. b. Open https://dashboard.doppler.com (not verified: exact project page) → project `truck-recruitment-tool-owner` → config `prd` → `PRODUCTION_DB_URL`. Source: Hunter's owner bootstrap database credential from the approved production Supabase connection page (https://supabase.com/dashboard, not verified: exact page). Confirm this owner-only scope has no syncs or integrations. c. Operator uses the merged first-manager tool (reviewed at `7285a7e`, OPEN-2) through `scripts/run-with-secrets.mjs` with a hidden prompt for `PRODUCTION_DB_URL`. Plan-only first (connects to nothing; expect `first-manager.verified`, then `first-manager.plan_only`; wrapped line assembled from the sources, not verified: never run):
  ```
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/first-manager-runner.ts --target=production --action=first-manager-check --confirm="RUN TNBS FIRST MANAGER CHECK"
  ```
  d. After Hunter's go, execute (read-only):
  ```
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/first-manager-runner.ts --target=production --action=first-manager-check --confirm="RUN TNBS FIRST MANAGER CHECK" --execute
  ```
  e. Hunter supplies `PRODUCTION_DB_URL` from `truck-recruitment-tool-owner/prd` only to the hidden local prompt; never to an environment variable, Render, chat or a file.
- **Success check:** the `first-manager.state` line shows state `ready_to_create` or `ready_to_promote`. Any other state (`manager_exists`, `already_bootstrapped`, `address_blocked`, `address_on_roster`, `schema_not_ready`) → **stop** and tell Hunter.
- **Go-gate:** OPEN-2 merge and staging rehearsal passed; the manager has confirmed the wrapped line above against the merged tool; OPEN-5 owner-only isolation verified; B2/B3 committed and maintenance on; Hunter says "go for B8".
- **Source:** OPEN-2 above; `docs/build-plan/18-first-manager-bootstrap.md` §3, §4 and `pipeline/src/first-manager-runner.ts` at `7285a7e`.

🔴 **B9 — First manager: create (maintenance still on)** — NOT APPROVED, needs its own go. **Tool reviewed at `7285a7e` (OPEN-2); merge and staging rehearsal still owed.**
- **What:** insert (or promote) the one `public.profiles` row for Hunter's email as an approved Manager, with one audit row (kind `first_manager_bootstrap`). No Auth user, no password, no email. **Why:** the first manager must exist in the database before real sign-in can be tested after maintenance ends. **If skipped:** nobody can sign in or add anyone after opening.
- **Who:** the operator, with Hunter present for the hidden prompt.
- **Steps:**
  1. a. Confirm B8 reported `ready_to_create` or `ready_to_promote` and maintenance is still on. b. Open https://dashboard.doppler.com (not verified: exact project page) → project `truck-recruitment-tool-owner` → config `prd` → `PRODUCTION_DB_URL`; confirm no syncs or integrations. Source: Hunter's approved owner bootstrap database credential from the production Supabase connection page (https://supabase.com/dashboard, not verified: exact page). c. Operator uses the merged first-manager tool through `scripts/run-with-secrets.mjs` with a hidden local prompt. Plan-only first (wrapped line assembled from the sources, not verified: never run):
  ```
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/first-manager-runner.ts --target=production --action=first-manager-create --confirm="CREATE TNBS PRODUCTION FIRST MANAGER"
  ```
  d. After Hunter's go, execute:
  ```
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/first-manager-runner.ts --target=production --action=first-manager-create --confirm="CREATE TNBS PRODUCTION FIRST MANAGER" --execute
  ```
  e. Hunter supplies `PRODUCTION_DB_URL` from `truck-recruitment-tool-owner/prd` only to the hidden prompt; never to Render, an environment variable, chat or a file. f. The tool is single-use. After any failure or an `unknown` or `rollback_not_confirmed` result, **stop**, tell the manager, and do not retry or run another check under this approval.
- **Success check:** `first-manager.result` shows `committed` and every `phase: after` check reports `ok: true`. Existence is independently checked in B9V under its own go; B9 alone does not authorize opening sign-in.
- **Go-gate:** OPEN-2 merge and staging rehearsal passed; the manager has confirmed the wrapped line above against the merged tool; owner-only isolation verified; B8 showed `ready_to_create` or `ready_to_promote`; maintenance on; Hunter says "go for B9".
- **Source:** OPEN-2 above; doc 18 §3, §4 and `pipeline/src/first-manager-bootstrap.ts` at `7285a7e`.

🔴 **B9V — First manager: independent follow-up check** — NOT APPROVED, needs its own go. **Tool reviewed at `7285a7e` (OPEN-2); merge and staging rehearsal still owed.**
- **What:** read the roster after the create attempt, without creating, promoting or sending anything. **Why:** a create result alone does not prove the manager exists; an unknown result must not cause a blind retry. **If skipped:** B15 and C1 remain blocked.
- **Who:** the operator, with Hunter supplying the hidden prompt.
- **Steps:**
  1. a. Keep maintenance on. b. Open https://dashboard.doppler.com (not verified: exact project page) → project `truck-recruitment-tool-owner` → config `prd` → `PRODUCTION_DB_URL`. Source: Hunter's approved owner bootstrap database credential from the production Supabase connection page (https://supabase.com/dashboard, not verified: exact page). Confirm this scope has no syncs or integrations.
  2. a. Use the merged first-manager tool through `scripts/run-with-secrets.mjs` with its hidden local prompt. Plan-only first (wrapped line assembled from the sources, not verified: never run):
  ```
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/first-manager-runner.ts --target=production --action=first-manager-check --confirm="RUN TNBS FIRST MANAGER CHECK"
  ```
  b. After Hunter's go, execute (read-only):
  ```
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/first-manager-runner.ts --target=production --action=first-manager-check --confirm="RUN TNBS FIRST MANAGER CHECK" --execute
  ```
  c. Hunter supplies `PRODUCTION_DB_URL` from `truck-recruitment-tool-owner/prd` only to that hidden prompt; never to an environment variable, Render, chat or a file. d. Record the state only, no personal data.
- **Success check:** the `first-manager.state` line shows `manager_exists` after a confirmed successful create. Any other state or any unknown/failed B9 result is a STOP for the manager's investigation; a negative check never authorizes another create.
- **Go-gate:** OPEN-2 merge and staging rehearsal passed; the manager has confirmed the wrapped line above against the merged tool; owner isolation verified; B9 result recorded (including any unknown result); maintenance on; Hunter says "go for B9V".
- **Source:** OPEN-2 above; doc 18 §3, §4 and `pipeline/src/first-manager-runner.ts` at `7285a7e`.

🔴 **B10 — Backout window on (`window-on`) and verify** — NOT APPROVED, needs its own go (approval 18)
- **What:** pause email edits during the window. Done **before** maintenance is turned off. **If skipped:** the backout's identity check (`profiles.email = auth.users.email`) can fail.
- **Who:** the operator, through Route A (OPEN-1, closed): action `window-on`, phrase `RUN TNBS PRODUCTION SQL WINDOW-ON`. The file `supabase/rollout/backout-window-on.sql` holds exactly the two statements from doc 16 §3.1 (the update setting `email_edits_paused` to `true` on `internal.backout_window`, then the verify select), copied verbatim with a closing semicolon added. The runner sends both in **one transaction** (begin, 10-second lock wait, update, verify select, commit) and reads the select's answer **before** it commits: it must be exactly one row holding `true`. Anything else stops with `prod_sql_flag_not_expected` and rolls back, so the flag is never left unchecked. Hunter supplies `PRODUCTION_DB_URL` only to the hidden prompt. (Hunter's OPEN-1 decision named "the SQL files"; these two statements are the runner's own reviewed file, so no separate route decision remains.)
- **Steps:**
  1. a. Plan-only first:
  ```
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/prod-sql-runner.ts --target=production --action=window-on --confirm="RUN TNBS PRODUCTION SQL WINDOW-ON"
  ```
  b. After Hunter's go, execute:
  ```
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/prod-sql-runner.ts --target=production --action=window-on --confirm="RUN TNBS PRODUCTION SQL WINDOW-ON" --execute
  ```
  c. Read the `prod-sql.flag` line.
- **Paste box:** none; the runner reads the file itself. Do not paste the two statements anywhere else.
- **Success check:** the runner prints result `committed` and one `prod-sql.flag` line showing `email_edits_paused` `true`. (A Team email edit being refused is proved on staging first, doc 16 §3.1 step 2.) After any error or a `prod_sql_flag_not_expected` refusal: **stop**, do not retry, tell the manager.
- **Go-gate:** D10 answered yes (OPEN-3); B4 committed; GATE-1 done; Hunter says "go for B10".
- **Source:** doc 16 §3.1; doc 18 (the `window-on` row); runner at `47f4920`.

🔴 **B11 — O2: turn off Supabase sign-ups and every Auth provider** — NOT APPROVED, needs its own go
- **What:** stops NEW Supabase sign-ins. **If skipped:** the old door stays open. Do this **after** the new server is deployed (B7; doc 14 §11.2 step 4).
- **Who:** Hunter.
- **Steps:**
  1. a. Open https://supabase.com/dashboard (not verified: exact page) → the production project → Authentication → sign-up settings and Providers (not verified: exact page names). b. Write down what each setting is **before** changing it (so backout can restore the email provider). c. Turn **off** sign-ups. d. Turn **off** email, phone, anonymous and every OAuth provider.
- **Success check:** the settings page shows sign-ups and every provider off, and the "before" values are written down. The proof that nothing can be issued is the next step (B12), not this one.
- **Go-gate:** B7 live; Hunter says "go for B11".
- **Source:** doc 14 §11.2 step 4, §11.4 O2, §11.6 step 1.

🔴 **B12 — Issuance probes (the five class-B probes), BEFORE L1** — NOT APPROVED, needs its own go
- **What:** confirm with the five Supabase Auth issuance endpoints `/otp`, `/magiclink`, `/recover`, `/resend` and `/signup` (doc 14 §8.1 class B) that nothing new can be issued now that sign-ups and providers are off. **Why:** L1's own header and doc 14 §11.6 step 1 require providers off **and these probes refused before the first sweep**. **If skipped:** L1 sweeps credentials while new ones can still be issued. **No retry.**
- **Who:** the operator (the probes call hosted Supabase Auth, not the new server).
- **Steps:**
  1. a. Operator runs the five probes exactly as the manager's reviewed list says. **GAP: the production probe commands are not written down in the repo; the manager lists them here before the go.** b. Production has no fixture accounts: any probe that needs one must be decided by the manager first (do not create test accounts in production without a separate go). c. Record the result of each probe as refused / not refused (no tokens, no addresses).
- **Success check:** all five probes refused. If any is not refused: **stop**; do not start L1.
- **Go-gate:** B11 done; the probe list is written down; Hunter says "go for B12".
- **Source:** doc 14 §8.1, §11.6 step 1; `supabase/rollout/L1-close-legacy-auth.sql` header.

🔴 **B13 — L1: close the old Supabase sign-in credentials** — NOT APPROVED, needs its own go (approval 21, given before 22)
- **What:** clears old sessions, refresh tokens, one-time tokens and flow state, and empties six token columns on `auth.users`. Changes **no** password, ban, email or profile. Expected rows changed: about 0 (production had 0 Auth users; verify at run time). **If skipped:** old credentials could still reach Supabase's `/user` endpoint. **No backout**; the backout only restores the email provider (doc 14 §11.6).
- **Who:** the operator, through Route A (OPEN-1, closed), as the runner's own connection. File: `supabase/rollout/L1-close-legacy-auth.sql`, run **in its own stages** through three actions, not as one paste. Hunter supplies `PRODUCTION_DB_URL` only to the hidden prompt. **Never print token values or ids.** Numbers only (the runner prints counts, not rows).
- **Actions (each its own plan-only box, then its own `--execute` box, in the steps below):** `l1-shape` (phrase `RUN TNBS PRODUCTION SQL L1-SHAPE`, read-only; stage 1); `l1-counts` (phrase `RUN TNBS PRODUCTION SQL L1-COUNTS`, read-only; stages 2, 4 and 7); `l1-sweep` (phrase `RUN TNBS PRODUCTION SQL L1-SWEEP`; stages 3 and 6; it runs the `l1-shape` gate first, inside its own transaction, and must pass).
- **STOP tables: stop unless empty (item 28, Hunter-approved 2026-11-01; runner `47f4920`; doc 18 section "STOP tables: stop unless empty").** L1 clears five tables and leaves 13 credential-bearing `auth` tables alone. The runner does not clear them. The 13, from `supabase/rollout/auth-table-classification.json`: `custom_oauth_providers`, `instances`, `mfa_challenges`, `mfa_factors`, `mfa_recovery_codes`, `oauth_authorizations`, `oauth_client_states`, `oauth_clients`, `saml_relay_states`, `scim_tokens`, `scim_users`, `webauthn_challenges`, `webauthn_credentials`. What the operator sees: one fixed event `prod-sql.stop_tables` with the fields `action`, `classification` (the words `credential-bearing: STOP`), `locked`, `tables` (each of the 13 names with a row count number, or `absent` if this Auth release has no such table), `tables_present`, `tables_populated` and `passed`. Stage 1 (`l1-shape`) prints it as information only, with `locked: false` (read-only, no lock; it does not refuse on a populated table). The sweep (`l1-sweep`, stages 3 and 6) locks every STOP table that exists (`SHARE ROW EXCLUSIVE`, one statement, 10 second lock timeout), counts them with only `select count(*)`, and goes on only if every count is 0. Just before COMMIT it sends `SET CONSTRAINTS ALL IMMEDIATE` (this fires any deferred constraint trigger or deferred foreign-key check that the L1 statements queued, so none is left to fire inside COMMIT), then counts again, with no second event. **"Empty" is true only up to COMMIT:** the lock ends with the sweep, then nothing stops a later insert; the later recounts (stages 4 and 7) and the daily counts cover the L1 tables, not these 13, and the runner does not watch them after COMMIT. Two refusal ids, both roll the transaction back and change nothing: `prod_sql_l1_stop_table_populated` and `prod_sql_l1_stop_table_lock_failed`. A third outcome is not a refusal id: if a deferred foreign-key check fails at that flush, the runner reports `server_or_driver_error` with SQLSTATE `23503` and the run rolls back (result `rolled_back`), so nothing is committed.
  - **STOP rule, `prod_sql_l1_stop_table_populated`:** a STOP table holds a row (or a count could not be read, which counts as populated, or the re-count before COMMIT found a row). **STOP.** Do not retry. Do not clear, delete or edit anything in those tables. Record the event numbers (table names and counts only; never row content). Hunter and the manager decide together what happens next; there is no way forward inside this runbook, and any change (such as clearing a table, or a reviewed change to L1) is its own reviewed change with its own go.
  - **STOP rule, deferred foreign-key failure at the flush (`server_or_driver_error`, SQLSTATE `23503`):** a foreign-key check that PostgreSQL had deferred failed when the runner flushed deferred checks just before the final STOP re-count. The transaction rolled back and nothing was committed. **STOP.** Do not retry. Do not change any data to make the check pass. Record the SQLSTATE and the event numbers only (never row content). Hunter and the manager decide together what happens next; a later re-run is its own go.
  - **STOP rule, `prod_sql_l1_stop_table_lock_failed`:** the locks were not granted (lock timeout, deadlock or a name that is not lockable). Nothing was counted or changed. **STOP.** Do not loop the retry. Record the refusal and report it to Hunter and the manager; a later single re-run is its own go after they have read why the lock failed. Any other lock error (for example a missing privilege) is reported as `server_or_driver_error` with its SQLSTATE and is a STOP too.
- **Steps:**
  1. **Stage 1, shape check (action `l1-shape`).** a. Plan-only:
  ```
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/prod-sql-runner.ts --target=production --action=l1-shape --confirm="RUN TNBS PRODUCTION SQL L1-SHAPE"
  ```
  b. After Hunter's go, execute:
  ```
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/prod-sql-runner.ts --target=production --action=l1-shape --confirm="RUN TNBS PRODUCTION SQL L1-SHAPE" --execute
  ```
  c. Any `auth.*` table that is not listed (the runner's `no_unreviewed_auth_tables` check, from `supabase/rollout/auth-table-classification.json`, GATE-2) → **STOP** for review (refusal `prod_sql_l1_shape_not_ok`). Read the `prod-sql.stop_tables` event it prints as information: record `tables_populated` and each count (numbers only). A non-zero count here is a warning, not a refusal; it will stop stage 3 (STOP rule above), so tell Hunter now and do not go on to stage 2 until Hunter and the manager have decided. Success: nothing unlisted.
  2. **Stage 2, counts before (action `l1-counts`).** a. Plan-only:
  ```
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/prod-sql-runner.ts --target=production --action=l1-counts --confirm="RUN TNBS PRODUCTION SQL L1-COUNTS"
  ```
  b. After Hunter's go, execute:
  ```
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/prod-sql-runner.ts --target=production --action=l1-counts --confirm="RUN TNBS PRODUCTION SQL L1-COUNTS" --execute
  ```
  c. Record the numbers (`sessions`, `refresh_tokens`, `one_time_tokens`, `flow_state`, `users_with_tokens`). Success: numbers recorded.
  3. **Stage 3, first sweep (action `l1-sweep`, one transaction).** a. Plan-only:
  ```
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/prod-sql-runner.ts --target=production --action=l1-sweep --confirm="RUN TNBS PRODUCTION SQL L1-SWEEP"
  ```
  b. After Hunter's go, execute:
  ```
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/prod-sql-runner.ts --target=production --action=l1-sweep --confirm="RUN TNBS PRODUCTION SQL L1-SWEEP" --execute
  ```
  c. Record rows changed (numbers only) and the `prod-sql.stop_tables` event (`passed` must be true, `locked` true). Success: it commits. If it refuses with `prod_sql_l1_stop_table_populated` or `prod_sql_l1_stop_table_lock_failed`: the matching STOP rule above applies and stages 4 to 9 do not run.
  4. **Stage 4, first recount.** a. Run the `l1-counts` plan-only box from stage 2, then its `--execute` box. b. Record the numbers. Success: every number is **0**: all four tables, and no `auth.users` row with a non-empty token column. Otherwise **STOP**.
  5. **Stage 5, wait W.** a. Wait W minutes (A4). b. Write the start and end time (UTC).
  6. **Stage 6, second sweep.** a. Run the `l1-sweep` boxes from stage 3 again. b. Record rows changed. Success: **zero** rows changed. Any non-zero → incident: stop and investigate (doc 14 §11.6 step 6). This sweep applies the same STOP-table check again (new locks, new counts); a STOP table populated since stage 3 refuses it under the same STOP rule.
  7. **Stage 7, second recount (doc 14 §11.6 step 6 repeats both the sweep and the verification).** a. Immediately after stage 6, run the `l1-counts` boxes from stage 2 again. b. Record the numbers as their own result. Success: all four tables **0** and no non-empty token column. Otherwise incident: **STOP**. The daily counts in step 9 are a later check and do not replace this one.
  8. a. Record the final result (numbers only) with the release record.
  9. a. During the backout window, run the counts daily (doc 14 §11.6 step 8), with the `l1-counts` boxes. Any non-zero is an incident.
- **Paste box:** none beyond the action boxes above; the runner reads the file and pins each stage by SHA-256.
- **Success check:** both sweeps passed the STOP-table check (`passed` true); stages 4 and 7 both show all zeros; stage 6 changed 0 rows.
- **Go-gate:** B12 all refused; GATE-1 and GATE-2 done (inventory capture and human classification); Hunter says "go for B13". Every stage above stays NOT APPROVED and needs its own go; a go for one stage is not a go for the next, and a refusal above is not covered by any earlier go.
- **Source:** doc 14 §11.6 steps 0–8; `supabase/rollout/L1-close-legacy-auth.sql`.

🔴 **B14 — Acceptance probes after L1 (rejection probes, log check, T-IP)** — NOT APPROVED, needs its own go
- **What:** the production subset of the A5a (stateless) probes, of the L1 rejection probes, of the A7 log check, and T-IP. Doc 14 §8.1 and doc 16 §1.6 define them. **GAP: the exact production subset is not written down; the manager lists it here before the go.** **If skipped:** maintenance cannot responsibly come off.
- **Who:** the operator.
- **Steps:**
  1. a. Run each listed probe; record pass/fail. b. Stateful probes that need a fixture account must be decided by the manager first (no test accounts in production without a separate go). c. Log searches: report hit counts only.
- **Success check:** every probe matches its listed expected result; log searches show 0 credential hits.
- **Go-gate:** B13 done (stages 4, 6 and 7 passed); the subset is written down; Hunter says "go for B14".
- **Source:** doc 16 §3.2 step 3; doc 14 §8.1; doc 16 §1.6.

🔴 **B15 — Maintenance off (Doppler, then Deploy latest commit)** — NOT APPROVED, needs its own go
- **What:** set `MAINTENANCE_MODE` to `false` in Doppler `prd`, then redeploy so the server loads it. **Do this last in Part B.** **If skipped:** users still see "Back shortly."
- **Who:** Hunter.
- **Steps:**
  1. a. Open https://dashboard.doppler.com (not verified) → project `truck-recruitment-tool` → config `prd` → `MAINTENANCE_MODE` → set `false` → save. b. Confirm `TRUSTED_PROXY_HOPS` is the number the T-IP test gave (A5 step 2b). Do not edit anything in Render.
  2. a. Open https://dashboard.render.com (not verified) → `tnbs-recruiter-prod` → Manual Deploy → **Deploy latest commit**. (A Restart does NOT load new settings.) b. Operator: `node "C:\Users\hunte\.bb\BB Rules\doppler-tools\deploy-watch.js" truck-recruitment-tool tnbs-recruiter-prod`.
- **Success check:** the deploy shows live; `https://<APP_ORIGIN>/signin` loads the sign-in page for an outside visitor (it returned 503 "Back shortly." before).
- **Go-gate:** B10, B13, B14 passed; B9 committed and B9V confirmed `manager_exists`; A7R reader copy `TEMP_RENDER_API_KEY` remains valid in Doppler `truck-recruitment-tool/dev` for the watcher; Hunter says "go for B15".
- **Source:** doc 16 §3.2 step 3; playbook step 6.

##### Part C — after opening (each its own go)

🔴 **C1 — First manager signs in (the real sign-in test)** — NOT APPROVED, needs its own go
- **What:** Hunter requests a sign-in link and opens it. This is the first time the real sign-in can be tested: maintenance had to be off. **If skipped:** sign-in is unproven.
- **Who:** Hunter.
- **Steps:**
  1. a. Open the production address's `/signin` (the `APP_ORIGIN` value). b. Enter Hunter's email. c. Open the emailed link within 15 minutes (not re-verified; the link is one-time). d. Press the confirm button on the page that appears (doc 14 §3.3, §3.4).
- **Success check:** Hunter reaches the dashboard as Manager. **If it fails:** run backout step BO1 (maintenance on) first, tell the manager, and do not retry blindly.
- **Go-gate:** B15 done; Hunter says "go for C1".
- **Source:** doc 14 §11.2 step 4; doc 16 §3.2 step 3.

🔴 **C2 — SendGrid webhook proof (now that maintenance is off)** — NOT APPROVED, needs its own go
- **What:** prove that a genuine SendGrid event reaches the server and a tampered one is refused. This could not run earlier because maintenance mode answers 503 before checking the signature. **No code bypass is invented.** SendGrid events sent while the server was in maintenance got 503; how long SendGrid retries is not verified here, and nothing depends on those events. **If skipped:** delivery events are unproven.
- **Who:** Hunter and the operator.
- **Steps:**
  1. a. Open https://app.sendgrid.com (not verified: exact page) → Settings → Mail Settings → Event Webhooks → `tnbs-recruiter-prod` → "Test Your Integration" (not verified: exact names). b. Operator: confirm in the production server log one verified event (counts only, no addresses).
  2. a. The sign-in email from C1 also produces a delivery event; confirm that one too.
  3. a. Operator sends one request with a **wrong signature** to the webhook route and records that it is refused. **GAP: no exact tamper command is recorded; the manager supplies a reviewed one.**
- **Success check:** a verified event is logged; a tampered request is refused (doc 16 §7 C).
- **Go-gate:** C1 passed; Hunter says "go for C2".
- **Source:** doc 16 §7 (C); `app/server/app.ts:566`.

🔴 **C3 — Retention wired on the pipeline (approval 23)** — NOT APPROVED, needs its own go. Never in the same sitting as the cutover.
- **What:** add `MAINTENANCE_DATABASE_URL` for the `recruiter_maintenance` database login to Doppler project `pipeline`, config `prd`, which supplies the production pipeline cron. **Why:** retention needs its own database login. **If skipped:** retention is not enabled or proven; do not claim it runs.
- **Who:** Hunter, with the operator.
- **Steps:**
  1. a. **STOP before requesting go:** the manager must document and review how the cron loads the synced setting, the exact activation action or next scheduled-run rule, its UTC date/time, and the read-only evidence that will prove retention ran using the new setting. **GAP: cron activation is unresolved.** Paste box: *(manager must add the reviewed activation and evidence procedure here; no action is authorized while absent)*. b. At https://dashboard.render.com (not verified: exact service page), confirm `pipeline` is the cron and identify its schedule without changing it. A cron has no **Deploy latest commit**; do not use **Trigger Run** just to load settings. No web-service branch applies.
  2. a. Source for `MAINTENANCE_DATABASE_URL`: Hunter's approved `recruiter_maintenance` production connection credential (drafted below), prepared on **Route B** by the DRAFT owner steps below (the runner has **no action** that gives `recruiter_maintenance` a login or password, by design: the password never passes through runner output). **DRAFT, NOT APPROVED, NEEDS REVIEW:** Hunter's OPEN-1 decision named one password statement (B5); extending Route B to this second login is not verified as Hunter's decision, so Hunter confirms it first. If the credential is unavailable, **stop**. b. Open https://dashboard.doppler.com (not verified: exact project page) → project `pipeline` → config `prd`. c. Record existing names and `PIPELINE_COMMAND` without printing secret values; confirm the existing Render sync targets the pipeline cron. Do not create or reconnect a sync under this step.
  3. a. Only after the separate go, add `MAINTENANCE_DATABASE_URL` in Doppler `pipeline/prd` from that approved source. Never type its value into Render or another dashboard. b. Read back names and confirm `PIPELINE_COMMAND` and existing entries are unchanged, without displaying secret values.
  4. a. Follow the activation/evidence procedure recorded in step 1 only if it is covered by Hunter's explicit C3 go; any additional run or change requires its own go. b. Record the UTC run time and reviewed retention result, with counts only.
- **Still owed before this is a reviewed paste box (open questions for the manager; each needs a verified answer or Hunter's decision, none is decided here):** 1. exact production project identification, the SQL Editor's execution role and privileges, page and button names, and the approved one-statement SQL for the named role, with target and role checks and success evidence that show no secret; 2. password generation, storage and substitution, and confirmed SQL editor history, saved-query and log treatment **before** the statement is run (the cleanup in these steps is a draft and does not prove every retained copy is removed); 3. the correct session-pooler username, mode and port and the approved credential source (the maintenance login's pooler mode is not verified; the cron needs the maintenance login, never the owner URL); 4. Hunter's explicit route decision for this second credential, OPEN-5's scope decision and B6-style isolation, and the missing cron activation, schedule and evidence procedure (step 1 above).
- **DRAFT owner steps for the `recruiter_maintenance` login (DRAFT, NOT APPROVED, NEEDS REVIEW; a reviewed paste box still owed; in Hunter's four-heading format; run only after C3's own go and only when step 1's gap is resolved):**

  ###### Pending Action (DRAFT, NOT APPROVED, NEEDS REVIEW)
  - 🔴 **Give the `recruiter_maintenance` database login a password, then store its connection URL in Doppler (C3)** — **What:** set a password on the retention login and keep its connection address in Doppler project `pipeline`, config `prd`, under the name `MAINTENANCE_DATABASE_URL`. **Why needed:** retention needs its own database login; M1 created it with no password. **If skipped:** retention is not enabled or proven; do not claim it runs.
    1. a. **Make the password.** In your password manager (not verified: which one), create a new entry named `tnbs production recruiter_maintenance password` and generate at least 32 characters, **letters and digits only**. b. It must be a different password from the `recruiter_app` one. c. Never type or paste it into chat, a file, Render or GitHub. d. Success check: the entry exists and is saved.
    2. a. **Run one line in the production database.** Open https://supabase.com/dashboard (not verified: exact page) → the **production** project (the manager names it) → SQL Editor (not verified: menu name) → New query. b. Paste this line, then replace `<paste here>` with the password. Keep the two single quotes:
    ```
    ALTER ROLE recruiter_maintenance LOGIN PASSWORD '<paste here>';
    ```
    c. Press Run (not verified: button name). d. Success check: success, no error (not verified: exact wording). On any error **stop**, do not retry, tell the manager. e. Clear the query text and close the tab; if Supabase saved the query (not verified), delete that saved copy.
    3. a. **Store the connection URL in Doppler.** From the production project's connection page (https://supabase.com/dashboard, not verified: exact page name) copy the pooler address for user `recruiter_maintenance.<project-ref>` (not verified: that the same pooler mode and port as `recruiter_app` apply; the manager confirms which the cron needs). b. Open https://dashboard.doppler.com (not verified: exact page) → project `pipeline` → config `prd` → add secret `MAINTENANCE_DATABASE_URL`. c. Paste the address, replace the password placeholder with the password from your password manager, save. Only in Doppler; never into Render. d. Success check: the name shows as filled and the existing names and `PIPELINE_COMMAND` are unchanged. Report **names only**.
    4. a. Do not create or reconnect a sync and do not trigger a run in this step; activation follows step 4 above only under C3's own go.

  ###### Summary of Next Step (DRAFT)
  Nothing runs until the manager reviews this box, the cron activation gap is closed, and Hunter says "go for C3". Then Hunter sets one password, runs one line in the production database, and stores the address in Doppler under the name `MAINTENANCE_DATABASE_URL`.

  ###### Summary of Previous Step (DRAFT)
  Verified: M1 creates `recruiter_maintenance` with no password. Not verified: the page and button names, the pooler mode for this login, whether the SQL editor saves queries. The line has never been run.

  ###### Miscellaneous (DRAFT)
  The password and the address never appear in this document. Changing `pipeline/prd` needs Hunter's go (Doppler `prd` rule). If the existing sync is confirmed in step 2 above, Doppler copies the new name to the pipeline cron's settings; do not edit Render directly.
- **Success check:** `MAINTENANCE_DATABASE_URL` present in `pipeline/prd`; existing names, entries and `PIPELINE_COMMAND` unchanged; recorded cron evidence proves the approved activation loaded the setting and retention succeeded. Merely saving the secret is not activation proof.
- **Go-gate:** C1/C2 passed; later sitting; `recruiter_maintenance` credential preparation (route and reviewed statement) resolved and approved; `pipeline/prd` source/sync confirmed; exact cron activation, schedule and evidence procedure written and reviewed with all gaps resolved; Hunter says "go for C3" (approval 23). Until then STOP; do not request this go or edit `pipeline/prd`.
- **Source:** doc 16 §4 step 4; Hunter's AGENTS.md identifies `pipeline/prd`; playbook says cron jobs have no Deploy latest commit and not to Trigger Run just to apply settings.

🔴 **C4 — Close the backout window (approval 24)** — NOT APPROVED, needs its own go
- **What:** `window-off`, which verifies `false` before it commits, only on Hunter's word (recommended day 14). Then M2 (FK drop) is a separate decision (doc 14 §11.2 step 5). **If skipped:** email edits stay paused.
- **Who:** the operator, through Route A (OPEN-1, closed): action `window-off`, phrase `RUN TNBS PRODUCTION SQL WINDOW-OFF`. The file `supabase/rollout/backout-window-off.sql` is the inverse of B10's (update to `false`, then the verify select); the runner commits only if the verify select returns exactly one row holding `false` (else `prod_sql_flag_not_expected`, rolled back). Hunter supplies `PRODUCTION_DB_URL` only to the hidden prompt.
- **Steps:**
  1. a. Plan-only first:
  ```
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/prod-sql-runner.ts --target=production --action=window-off --confirm="RUN TNBS PRODUCTION SQL WINDOW-OFF"
  ```
  b. After Hunter's go, execute:
  ```
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/prod-sql-runner.ts --target=production --action=window-off --confirm="RUN TNBS PRODUCTION SQL WINDOW-OFF" --execute
  ```
  c. Read the `prod-sql.flag` line.
- **Paste box:** none; the runner reads the file itself.
- **Success check:** the runner prints result `committed` and one `prod-sql.flag` line showing `email_edits_paused` `false`.
- **Go-gate:** C1/C2 passed; GATE-1 done; Hunter says "go for C4" (day 14 recommended).
- **Source:** doc 16 §3.1 step 3; doc 18 (the `window-off` row); runner at `47f4920`.

##### Backout (if anything goes wrong; every step its own go, in this order)

Order from doc 16 §3.3 and doc 14 §11.5. After any failure: **stop, tell the manager**. Backout SQL runs through Route A (OPEN-1, closed 2026-10-30) where the runner has an action: BO2 (six actions), BO3 (two read-only actions, before the M1 backouts), BO4, BO5, BO6 and BO10. The two A2 backouts for the profile guard and the DNC cast are DO NOT USE and are not in this order (see A2); their forward fixes stay. Every command below needs GATE-1 first.

🔴 **BO1 — Maintenance on** — NOT APPROVED, needs its own go
- **What:** put the new server back in maintenance. **If skipped:** users keep reaching a system being rolled back.
- **Steps:**
  1. a. Open https://dashboard.doppler.com (not verified) → project `truck-recruitment-tool` → config `prd` → `MAINTENANCE_MODE` → `true` → save. b. Open https://dashboard.render.com (not verified) → `tnbs-recruiter-prod` → Manual Deploy → **Deploy latest commit** (Restart does not load the change). c. Operator: `node "C:\Users\hunte\.bb\BB Rules\doppler-tools\deploy-watch.js" truck-recruitment-tool tnbs-recruiter-prod`.
- **Success check:** the service address answers "Back shortly."; `/readyz` still answers.
- **Go-gate:** reader copy `TEMP_RENDER_API_KEY` is still valid in Doppler `truck-recruitment-tool/dev` for deploy-watch; K1 has not removed it; Hunter says "go for BO1". If missing or revoked, STOP until a separate reader-key provisioning plan and go are recorded; do not use A7's revoked key.
- **Source:** doc 16 §3.3; playbook step 6.

🔴 **BO2 — `retire-app-credentials.sql` (five stages)** — NOT APPROVED, needs its own go
- **What:** stop the app database login (`NOLOGIN`, password cleared) and close its ledgers: `supabase/backout/retire-app-credentials.sql`. **If skipped:** the app can still reach the database during the rollback.
- **Who:** the operator, through Route A (OPEN-1, closed), one action per file stage; Hunter supplies `PRODUCTION_DB_URL` only to the hidden prompt. Each step: plan-only box first, `--execute` box only after Hunter's go.
- **Steps (file's own steps 1–5, plus the runner's step 6; file step 1 is outside SQL):**
  1. a. After BO1, suspend the Render service `tnbs-recruiter-prod` (https://dashboard.render.com, not verified: exact button). Success: it shows suspended.
  2. a. File STEP 2 (action `retire-nologin`, phrase `RUN TNBS PRODUCTION SQL RETIRE-NOLOGIN`): `alter role recruiter_app nologin password null;` on its own. Plan-only:
  ```
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/prod-sql-runner.ts --target=production --action=retire-nologin --confirm="RUN TNBS PRODUCTION SQL RETIRE-NOLOGIN"
  ```
  b. Execute:
  ```
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/prod-sql-runner.ts --target=production --action=retire-nologin --confirm="RUN TNBS PRODUCTION SQL RETIRE-NOLOGIN" --execute
  ```
  Success: it commits; new logins now fail.
  3. a. **IRREVERSIBLE (GATE-3 first).** File STEP 3, terminate query (action `retire-terminate`, phrase `RUN TNBS PRODUCTION SQL RETIRE-TERMINATE`). Plan-only (shows the `connections_end_cannot_be_undone` warning; Hunter's "go for GATE-3" comes after reading it):
  ```
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/prod-sql-runner.ts --target=production --action=retire-terminate --confirm="RUN TNBS PRODUCTION SQL RETIRE-TERMINATE"
  ```
  b. Execute only after GATE-3:
  ```
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/prod-sql-runner.ts --target=production --action=retire-terminate --confirm="RUN TNBS PRODUCTION SQL RETIRE-TERMINATE" --execute
  ```
  c. Then poll the `recruiter_app_backends` count once a second (action `retire-backends`, read-only, phrase `RUN TNBS PRODUCTION SQL RETIRE-BACKENDS`). Plan-only:
  ```
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/prod-sql-runner.ts --target=production --action=retire-backends --confirm="RUN TNBS PRODUCTION SQL RETIRE-BACKENDS"
  ```
  Execute (repeat as the poll):
  ```
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/prod-sql-runner.ts --target=production --action=retire-backends --confirm="RUN TNBS PRODUCTION SQL RETIRE-BACKENDS" --execute
  ```
  Success: **0 three times in a row**. More than 60 seconds without that: **STOP** and tell the manager. The runner does not poll for the operator.
  4. a. File STEP 4, the one transaction that revokes every live app credential (action `retire-revoke`, phrase `RUN TNBS PRODUCTION SQL RETIRE-REVOKE`). Plan-only:
  ```
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/prod-sql-runner.ts --target=production --action=retire-revoke --confirm="RUN TNBS PRODUCTION SQL RETIRE-REVOKE"
  ```
  b. Execute:
  ```
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/prod-sql-runner.ts --target=production --action=retire-revoke --confirm="RUN TNBS PRODUCTION SQL RETIRE-REVOKE" --execute
  ```
  Success: it commits.
  5. a. File STEP 5, the final checks (action `retire-checks`, read-only, phrase `RUN TNBS PRODUCTION SQL RETIRE-CHECKS`). Plan-only:
  ```
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/prod-sql-runner.ts --target=production --action=retire-checks --confirm="RUN TNBS PRODUCTION SQL RETIRE-CHECKS"
  ```
  b. Execute:
  ```
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/prod-sql-runner.ts --target=production --action=retire-checks --confirm="RUN TNBS PRODUCTION SQL RETIRE-CHECKS" --execute
  ```
  Success: all numbers 0 (`backends`, `live_sessions`, `live_links`, `live_codes`).
  6. a. File step 6 (action `retire-email`, read-only, phrase `RUN TNBS PRODUCTION SQL RETIRE-EMAIL`; count `email_mismatches`). Plan-only:
  ```
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/prod-sql-runner.ts --target=production --action=retire-email --confirm="RUN TNBS PRODUCTION SQL RETIRE-EMAIL"
  ```
  b. Execute:
  ```
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/prod-sql-runner.ts --target=production --action=retire-email --confirm="RUN TNBS PRODUCTION SQL RETIRE-EMAIL" --execute
  ```
  Success: the count is reported (numbers only). It does **not** replace BO3: it skips a profile with no Auth user and an Auth user with a null email (doc 18); BO3 has its own two read-only actions.
- **Paste box:** none beyond the action boxes above; the runner reads the file and pins each stage by SHA-256.
- **Go-gate:** GATE-1 done; BO1 done; Hunter says "go for BO2". The `retire-terminate` step also needs "go for GATE-3".
- **Source:** doc 16 §3.3; doc 14 §11.5.

🔴 **BO3 — Identity alignment check (read-only; two actions, run BEFORE the M1 backouts)** — NOT APPROVED, needs its own go
- **What:** confirm `profiles.email = auth.users.email` for every approved profile (expected, because email edits were paused by B10), and prove that the one approved profile without an Auth user is the first manager. **If skipped:** the M1 backout could strand a profile. The first manager (B9) has no Auth user; doc 18 §5 (first-manager) says that profile cannot sign in to the old app, and giving Hunter the old password login back is a separate owner-approved Auth Admin step (decision for Hunter before cutover).
- **Order matters (doc 18, Route A):** (1) `bootstrap-identity-check`, (2) `read-only-inventory`, (3) only then the M1 backouts (BO4, BO5, BO6). `bootstrap-identity-check` reads `internal.auth_events`, which `M1-backout.sql` (BO6) drops; after BO6 the check fails closed (read-only, nothing changes) and **cannot** establish the exception: **stop** and tell the manager.
- **Who:** the operator, through Route A (OPEN-1, closed). Hunter supplies `PRODUCTION_DB_URL` only to the hidden prompt. Both files are marked DRAFT, PENDING REVIEW in their headers; both run in `begin read only` and roll back, and return whole-number counts only (no id, email or name).
- **Steps:**
  1. **Bootstrap identity (action `bootstrap-identity-check`, phrase `RUN TNBS PRODUCTION SQL BOOTSTRAP-IDENTITY-CHECK`, file `supabase/rollout/bootstrap-identity-check.sql`).** a. Plan-only:
  ```
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/prod-sql-runner.ts --target=production --action=bootstrap-identity-check --confirm="RUN TNBS PRODUCTION SQL BOOTSTRAP-IDENTITY-CHECK"
  ```
  b. After Hunter's go, execute:
  ```
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/prod-sql-runner.ts --target=production --action=bootstrap-identity-check --confirm="RUN TNBS PRODUCTION SQL BOOTSTRAP-IDENTITY-CHECK" --execute
  ```
  c. Read the four counts from the `prod-sql.counts` line: `bootstrap_events` (expected 1), `bootstrap_profiles_present` (expected 1), `bootstrap_profiles_with_auth_user` (0 is the named exception; 1 means the bootstrap profile has since gained an Auth user) and `other_approved_profiles_without_auth_user` (expected 0; above 0 is **not** the first-manager exception, for example a person added by M1b, and the manager must resolve that person's old-login treatment before the backout). The exception is established only when `bootstrap_events` is 1, `bootstrap_profiles_present` is 1 and `other_approved_profiles_without_auth_user` is 0.
  2. **Aggregate inventory (action `read-only-inventory`, phrase `RUN TNBS PRODUCTION SQL READ-ONLY-INVENTORY`).** a. Plan-only (the same box as A1):
  ```
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/prod-sql-runner.ts --target=production --action=read-only-inventory --confirm="RUN TNBS PRODUCTION SQL READ-ONLY-INVENTORY"
  ```
  b. After Hunter's go, execute:
  ```
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/prod-sql-runner.ts --target=production --action=read-only-inventory --confirm="RUN TNBS PRODUCTION SQL READ-ONLY-INVENTORY" --execute
  ```
  c. Report `email_mismatches` (expected 0), `approved_auth_email_null` (expected 0; the runner source says an approved profile whose Auth row has a NULL email is invisible to the `email_mismatches` comparison, so this count closes that blind spot; **above 0 is a STOP**, it needs the manager's investigation and is never waved through) and `approved_profiles_without_auth_user` (a total; a value of 1 fits the first-manager exception only if nobody else lacks an Auth user: inferred here, not from a reviewed doc).
  3. **Why two reads, and `retire-email`.** The inventory's `approved_profiles_without_auth_user` is a **total**: with two approved managers, swapping which one has an Auth user leaves all 20 inventory counts identical, so the inventory alone cannot show the missing one is the first manager. Do not call BO3 closed on the inventory alone. The BO2 step 6 action `retire-email` counts approved profiles whose lower-cased email differs from the Auth email; its inner join skips a profile with no Auth user and its inequality skips an Auth user with a null email, so it **cannot replace BO3**. Keep `retire-email` as the reviewed BO2 check; the inventory's `email_mismatches` repeats the same comparison, so do not treat the two as independent evidence. The inventory's `approved_auth_email_null` is the count that sees an Auth user with a NULL email; BO3 consumes it and requires 0.
- **Success check:** both runs end with result `read_only_done`; the exception conditions in step 1c hold; `email_mismatches` is 0; and `approved_auth_email_null` is 0. If `bootstrap_events` is 0 (B9 never committed), if `email_mismatches` or `approved_auth_email_null` is above 0, or any count differs, **stop** and tell the manager; this runbook does not interpret other values.
- **Go-gate:** BO2 done; BO6 (`M1-backout.sql`) not yet run; GATE-1 done; Hunter says "go for BO3".
- **Source:** doc 16 §3.3; doc 18 (the `bootstrap-identity-check` and `read-only-inventory` rows, "BO3 action order"); `docs/build-plan/18-first-manager-bootstrap.md` §5 at `7285a7e`; runner at `47f4920`.

🔴 **BO4 — `M1c-backout.sql`** — NOT APPROVED, needs its own go
- **What:** `supabase/backout/M1c-backout.sql` removes the new batch-delete function and restores the prior direct-delete grant while retaining the audit table. **Why:** restore the earlier delete interface before dismantling M1's permissions. **If skipped:** that new function and its dependency on the sign-in roles remain during the rest of backout.
- **Steps:**
  1. a. Route A action `backout-m1c`, phrase `RUN TNBS PRODUCTION SQL BACKOUT-M1C` (the file runs unchanged, as written). Plan-only:
  ```
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/prod-sql-runner.ts --target=production --action=backout-m1c --confirm="RUN TNBS PRODUCTION SQL BACKOUT-M1C"
  ```
  b. After Hunter's go, execute:
  ```
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/prod-sql-runner.ts --target=production --action=backout-m1c --confirm="RUN TNBS PRODUCTION SQL BACKOUT-M1C" --execute
  ```
  c. Confirm it commits.
- **Success check:** the runner prints result `committed`, with no error.
- **Go-gate:** GATE-1 done; BO3 done; Hunter says "go for BO4".
- **Source:** doc 16 §3.3.

🔴 **BO5 — `M1b-backout.sql`** — NOT APPROVED, needs its own go
- **What:** `supabase/backout/M1b-backout.sql` removes the new manager add-person function and returns `profiles_id_fkey` as **NOT VALID** (people added stay; they cannot sign in to the old app). **Why:** restore the earlier profile-to-Auth relationship without deleting added people before backing out M1. **If skipped:** the add-person function and its M1 role dependency remain, and the earlier foreign-key relationship is not restored.
- **Steps:**
  1. a. Route A action `backout-m1b`, phrase `RUN TNBS PRODUCTION SQL BACKOUT-M1B` (the file runs unchanged, as written). Plan-only:
  ```
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/prod-sql-runner.ts --target=production --action=backout-m1b --confirm="RUN TNBS PRODUCTION SQL BACKOUT-M1B"
  ```
  b. After Hunter's go, execute:
  ```
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/prod-sql-runner.ts --target=production --action=backout-m1b --confirm="RUN TNBS PRODUCTION SQL BACKOUT-M1B" --execute
  ```
  c. Confirm it commits.
- **Success check:** the runner prints result `committed`, with no error.
- **Go-gate:** GATE-1 done; BO4 done; Hunter says "go for BO5".
- **Source:** doc 16 §3.3; `docs/build-plan/18-first-manager-bootstrap.md` §5 at `7285a7e`.

🔴 **BO6 — `M1-backout.sql`** — NOT APPROVED, needs its own go
- **What:** `supabase/backout/M1-backout.sql` restores the earlier permission model, removes the new sign-in interfaces and revokes the app role's membership and grants. Data is preserved (people added stay; batch-delete records stay). **Why:** the old frontend needs its earlier database permissions when traffic returns. **If skipped:** the new session-based permission model remains, so reopening the old frontend does not complete backout and old sign-in may fail.
- **Steps:**
  1. a. Route A action `backout-m1`, phrase `RUN TNBS PRODUCTION SQL BACKOUT-M1` (the file has its own begin/commit and runs as written). Plan-only:
  ```
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/prod-sql-runner.ts --target=production --action=backout-m1 --confirm="RUN TNBS PRODUCTION SQL BACKOUT-M1"
  ```
  b. After Hunter's go, execute:
  ```
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/prod-sql-runner.ts --target=production --action=backout-m1 --confirm="RUN TNBS PRODUCTION SQL BACKOUT-M1" --execute
  ```
  c. Confirm it commits.
- **Success check:** the runner prints result `committed`, with no error; compare with the A3 snapshot in BO8.
- **Go-gate:** GATE-1 done; BO5 done; Hunter says "go for BO6".
- **Source:** doc 16 §3.3.

🔴 **BO7 — Re-enable the Supabase email provider (undo B11)** — NOT APPROVED, needs its own go
- **What:** restore the email provider to what B11 step 1b recorded. **Sign-ups stay off.** **Why:** people sign in again with their passwords. **If skipped:** nobody can use the old sign-in.
- **Who:** Hunter.
- **Steps:**
  1. a. Open https://supabase.com/dashboard (not verified: exact page) → the production project → Authentication → Providers (not verified: exact names). b. Set the email provider to its recorded "before" value. c. Leave sign-ups off.
- **Success check:** the email provider matches the recorded value; sign-ups still off.
- **Go-gate:** BO6 done; Hunter says "go for BO7".
- **Source:** doc 16 §3.3; doc 14 §11.5.

🔴 **BO8 — Return traffic to the recorded pre-cutover frontend, then smoke test** — NOT APPROVED, needs its own go
- **What:** the pre-cutover static site (recorded in B1) is the live site again; compare permissions with the A3 snapshot. **Why:** a successful SQL backout alone does not prove the old site works. **If skipped:** users may be directed to an unusable site and permission differences remain undetected. **Note:** the old frontend was never switched off in this runbook, so this step is "confirm it is still the live deploy"; any change of address or redirect is a separate decision not recorded in the repo (**GAP**).
- **Steps:**
  1. a. Open https://dashboard.render.com (not verified) and confirm the static site's live deploy is the one written down in B1. b. Load the site and do the read-only smoke test the manager provides (**GAP: not recorded**). c. Re-run the A3 snapshot (Route A action `snapshot`, the same plan-only and `--execute` boxes as A3) and compare its digests with the stored A3 output (counts only).
- **Success check:** the live deploy matches B1; the smoke test passes; the snapshot comparison shows no difference.
- **Go-gate:** BO7 done; Hunter says "go for BO8".
- **Source:** doc 16 §3.3, §1.7.

🔴 **BO9 — Tell the team** — NOT APPROVED, needs its own go
- **What:** Hunter tells the team the old sign-in is back and why. **If skipped:** people do not know to use their passwords. Sessions closed by L1 (B13) stay closed.
- **Steps:** 1. a. The manager drafts the message; Hunter sends it (nothing is sent automatically).
- **Success check:** Hunter confirms it was sent.
- **Go-gate:** BO8 done; Hunter says "go for BO9".
- **Source:** doc 16 §3.3.

🔴 **BO10 — `security-hardening-backout.sql` (only if hardening itself must also go back)** — NOT APPROVED, needs its own go
- **What:** `supabase/backout/security-hardening-backout.sql`: re-grants EXECUTE on functions in `public` and `internal` to PUBLIC and `anon` and re-adds the matching default privileges, in one transaction (its own `begin` … `commit`). Run **after** BO6. It does not undo the search_path pins or the `authenticated`/`service_role` grants, ends no connection and is safe to repeat (doc 18). Text-checked by `scripts/verify-hardening-backout-contract.mjs`; the runner pins the file by SHA-256 (git blob `608b69d1…`, byte for byte from `f1189dc`). **Why:** only a separately approved rollback of July hardening needs these earlier EXECUTE grants. **If skipped when that rollback is required:** the July EXECUTE restrictions remain; ordinary M1 backout does not itself require BO10.
- **Who:** the operator, through Route A (OPEN-1, closed): action `security-hardening-backout`, phrase `RUN TNBS PRODUCTION SQL SECURITY-HARDENING-BACKOUT`. Hunter supplies `PRODUCTION_DB_URL` only to the hidden prompt. The file runs as written, first line to last.
- **Steps:**
  1. a. Plan-only first:
  ```
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/prod-sql-runner.ts --target=production --action=security-hardening-backout --confirm="RUN TNBS PRODUCTION SQL SECURITY-HARDENING-BACKOUT"
  ```
  b. After Hunter's go, execute:
  ```
  node scripts/run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node node_modules/tsx/dist/cli.mjs src/prod-sql-runner.ts --target=production --action=security-hardening-backout --confirm="RUN TNBS PRODUCTION SQL SECURITY-HARDENING-BACKOUT" --execute
  ```
  c. Confirm it commits.
- **Success check:** the runner prints result `committed`, with no error.
- **Go-gate:** BO6 done; GATE-1 done; Hunter says "go for BO10".
- **Source:** the file header; doc 18 (the `security-hardening-backout` row); runner at `47f4920`; Codex review "Backout SQL assessment".

##### Final reader-copy cleanup (after the monitoring/backout period)

🔴 **K1 — Remove only the temporary reader-key copy** — NOT APPROVED, needs its own go
- **What:** remove `TEMP_RENDER_API_KEY` only from Doppler `truck-recruitment-tool` / `dev`. Source of this copy: `TEMP_RENDER_API_KEY` in `carrieronboardingbot` / `dev`. **Why:** the temporary monitoring copy should not remain after its approved use. **If skipped:** an unnecessary reader-key copy remains in the target dev config.
- **Who:** Hunter, with the operator checking names only.
- **Steps:**
  1. a. The manager records that B6/B7/B15 and any BO1 monitoring are finished. b. On the successful cutover path, record C1/C2 proof and C4's closed backout window, or Hunter's OPEN-3 decision that no window was declared plus explicit closure of the monitoring period. On the backout path, record completed BO8 smoke/snapshot proof and the disposition of BO9 and conditional BO10. c. If more deploy-watch, inspect or verify calls may be needed, **stop**; cleanup is premature.
  2. a. Open https://dashboard.doppler.com (not verified: exact page) → project `truck-recruitment-tool` → config `dev` → `TEMP_RENDER_API_KEY`. b. After the separate go, delete only this temporary target copy. Do not delete the source in `carrieronboardingbot/dev` and do not revoke the shared reader key in Render: the Doppler Render connection may still rely on it. A7's write key was revoked and removed during A7.
  3. a. Read the target config's names only. Confirm `TEMP_RENDER_API_KEY` is absent and record cleanup time in UTC. b. No helper requiring it runs after cleanup under these approvals; future monitoring requires a new, separately approved reader-copy lifecycle.
- **Success check:** target dev copy absent; cleanup time recorded; source reader key and integration credential unchanged; no outstanding approved helper needs the removed copy.
- **Go-gate:** A7R created the target copy; successful cutover monitoring/window closed or approved backout complete as recorded in step 1; no later helper needs the key; Hunter says "go for K1".
- **Source:** playbook prerequisite (delete the copy when done); helper source requires the target project's dev copy on every invocation.

---

### Summary of Next Step

Nothing runs next. Hunter decided OPEN-1 on 2026-10-30: Route A (the guarded runner) for the SQL files, Route B (Supabase SQL editor) for the one password statement. That approves nothing live. Hunter and the manager now settle four items: the merge and staging rehearsal of the reviewed first-manager tool (`7285a7e`, OPEN-2), whether to declare a 14-day backout window (OPEN-3), when staging proof will be finished (OPEN-4), and whether the separate runtime and owner-only Doppler homes are confirmed (OPEN-5). Three gates must also pass before the runner is used, each with its own go: merge the runner's branch at `47f4920` (GATE-1), capture and classify the staging-2 auth tables before L1 (GATE-2), and read the irreversible termination warning before `retire-terminate` (GATE-3). The window statements (B10, C4), the read-only inventory (A1), the BO3 checks and the hardening backout (BO10) now have Route A actions; two A2 backouts are DO NOT USE and their forward fixes stay. The two database passwords (B5 for `recruiter_app`, C3 for `recruiter_maintenance`) have DRAFT Route B owner steps that still need review. After that, the manager resolves each step's remaining gaps before asking for its individual go, starting with the read-only counts (A1). Cron retention stays blocked until C3's activation procedure is written and reviewed.

### Summary of Previous Step

Verified by reading the repo (nothing was run against any live system):
- The step order was corrected against the real router: while maintenance is on, everything except `/readyz` and `/healthz/db` returns 503 (`app/server/app.ts:566`). So the first manager is created in the database before maintenance comes off (B8, B9), the real sign-in test (C1) and the SendGrid webhook proof (C2) run after it (Part C), and the five issuance probes run before L1 (B12).
- L1 now repeats the recount after the second sweep (B13 stage 7).
- Runtime settings go through Doppler `truck-recruitment-tool` / `prd`; Render settings come from that config's sync and "Deploy latest commit". Owner-only `PRODUCTION_DB_URL` is isolated in proposed `truck-recruitment-tool-owner` / `prd`, never synced. A7's write key is removed immediately; the separate A7R reader copy stays in `truck-recruitment-tool/dev` through monitoring/backout and is removed only at K1.

- OPEN-1 is closed with Hunter's decision (2026-10-30 UTC). Every unnamed-route placeholder was replaced by the Route A action name, typed phrase and command taken from the runner source, read with `git show` (nothing run). This revision (2026-10-31 UTC) re-pointed every citation from `4552557` to `7111139` (a later revision, 2026-11-01 UTC, re-pointed them from `7111139` to `9e3e340`, and a further revision the same day from `9e3e340` to `47f4920`); filled in A1, B10, C4, BO3 and BO10 from the actions built since; marked the two A2 backouts DO NOT USE; replaced the `e31dc29` candidate-tool text with the reviewed tool `7285a7e` (also on the pushed branch `signin/combined-reviewed-abc`, which holds no runner file); and drafted the Route B owner steps for B5 and C3 (DRAFT, NOT APPROVED, NEEDS REVIEW, no value anywhere).

Attempts / not verified: the wrapped command line (assembled, never run); exact Supabase, Render, SendGrid, Doppler and Google Cloud page and button names; that Doppler config `prd` exists in that project; Render price today; the production probe subset and the commands for the GAP items; the first-manager tool's wrapped production command line (assembled from the tool and wrapper sources, never run); the DRAFT password statements (never run, not reviewed); the SQL of `read-only-inventory` and `bootstrap-identity-check` (marked DRAFT, PENDING REVIEW in their own file headers); `reconciliation` (unused here; see OPEN-1).

### Miscellaneous

- Route A source (read only, not merged): doc 18 and the runner (`pipeline/src/prod-sql.ts`, `prod-sql-runner.ts`, `prod-sql-split.ts`, `scripts/run-with-secrets.mjs`, `supabase/rollout/auth-table-classification.json`, `pipeline/package.json`) at tip `47f4920` on branch `bb/stop-unless-empty-r3-flush-deferred-triggers-bef-thr_2h7fkxxygs`, plus the supabase files it pins (`supabase/rollout/*.sql`, `supabase/backout/*.sql`).
- Sources: docs 13, 14 (§3, §8.1, §11), 15 (§8, §32), 16 (§1–§4, §6, §7), 18 (first-manager bootstrap, `docs/build-plan/18-first-manager-bootstrap.md`) and the first-manager tool at `7285a7e` on branch `bb/fix-first-manager-listener-output-commit-outcome-thr_q9ajbvqpa6` (read only, reviewed "fm-listener r2: ready", contained in the pushed `signin/combined-reviewed-abc`); release-path plan 2026-10-22 (thr_grum38j2d2); Quote-Queue `docs/M0_HOMEWORK.md` at 4059789845a52e355b747371752744ffd790e135 (read only); `C:\Users\hunte\.bb\BB Rules\doppler-render-playbook.md`.
- Doc 15 §6's env var names (for example `APP_BASE_URL`, `KEY_TOKENS`, `HEALTH_SECRET`) are older than the code; this runbook and the Render draft follow `app/server/config.ts` and doc 16 §2.3.
- Not decided here: SMS (future direction only), TOTP/passkeys (deferred), D8 approved, D10 open (OPEN-3).
- No secrets, project refs, hostnames or account ids appear in this file by design.
