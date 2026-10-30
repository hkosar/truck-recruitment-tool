# 17 · Production sign-in cutover — owner runbook (DRAFT)

**Status: DRAFT. NOTHING IN THIS FILE IS APPROVED OR HAS BEEN RUN.** Written 2026-10-30 (UTC) on branch `signin/cutover-prep`, local only. Every step that touches a live system is marked **NOT APPROVED, needs its own go**. A "go" for one step is not a "go" for the next. Hunter's clock is US Central; times written down here are UTC.

Covers release-path plan step 14 (production sign-in cutover) and step 15 (L1, closing the old Supabase sign-in credentials). Order comes from doc 14 §11.2 step 4 and doc 16 §3.2. Nothing here is invented: every step cites its source. Where the repo has **no recorded command**, the step says so and stops (see the red "GAP" items).

The mail provider is **SendGrid** (settled by the manager, 2026-10-30; the older "Resend" mention in the release-path plan is stale).

---

### Pending Action

**Nothing is asked of Hunter today.** This is a draft for review. Before anyone can ask for the first "go", Hunter must settle the four open items below. After that, the steps run in order.

🔴 **OPEN-1 — How production SQL gets run (no route is recorded)** — NOT APPROVED, needs its own go
- **What:** the staging SQL runner refuses production on purpose (`pipeline/src/staging-sql-runner.ts:67`, error `production_refused`). Its actions (`snapshot`, `apply-m1`, `apply-m1b`, `apply-m1c`, `window-on`, `window-off`, …) are staging only. Doc 14 says "the operator runs it as `postgres`" and doc 16 says "production steps stay owner-run", but **no document records the exact tool or window** for running the production SQL files.
- **Why needed:** steps C2–C9 below cannot be scheduled without it.
- **If skipped:** the cutover cannot start.
- **Steps:**
  1. Hunter tells the manager which route to use for production SQL (for example: Hunter pastes each reviewed file into the Supabase SQL editor while the operator watches; or a new, separately reviewed production runner is built).
  2. The manager records the answer in this file, replacing this item.
- **Success check:** this item names one route and who runs it.

🔴 **OPEN-2 — First manager on an empty roster (no route is recorded)** — NOT APPROVED, needs its own go
- **What:** production had 0 Auth users and 0 profiles on 2026-10-22 (doc 15 §32; release-path plan §2 step 14). `team_add_person` (M1b) needs an existing manager (doc 15 §32). The planned one-time script `scripts/bootstrap-first-manager.ts` (doc 13:430) **does not exist** in `scripts/`. The staging owner login tool (`pipeline/src/owner-bootstrap.ts`, doc 16 §1.3 step 5) targets staging only and uses a Supabase Auth account, which the new sign-in does not need.
- **Why needed:** without a manager profile for Hunter's email, step C11 ("first manager signs in") cannot succeed, and nobody can add anyone.
- **If skipped:** the cutover finishes with a sign-in page nobody can use.
- **Steps:**
  1. Hunter and the manager decide how Hunter's manager profile is created in production (an engineering item; needs a reviewed script or reviewed SQL and its own staging rehearsal).
  2. The manager records the decision and the reviewed artifact here.
- **Success check:** a named, reviewed, staging-rehearsed artifact exists.

🔴 **OPEN-3 — D10: declare a backout window?** — NOT APPROVED, needs its own go (approval 18)
- **What:** doc 16 §3.1: production cutover cannot be scheduled until D10 decides whether a window is declared, its length and who closes it. Recommended there: 14 days, closed by Hunter.
- **Steps:** (1) Hunter answers yes/no and the length in chat. (2) The manager records it here.
- **Success check:** this item states the answer.
- **If skipped:** step C7 (`window-on`) has no rule to follow.

🔴 **OPEN-4 — Staging proof must be finished first** — NOT APPROVED, needs its own go
- **What:** staging approvals 4–16 (doc 16 §6) are all still ahead: the staging rebuild, M1/M1b/M1c on staging, the pooler probe, mail end to end, T-IP, T-SHUTDOWN, O2 and L1 on staging, T-REPLAY backout rehearsal, and the log gate A7. Doc 14 §8 and doc 16 §1.5 say production waits for those.
- **Steps:** none for Hunter now; the manager reports when staging is done and shows the results.
- **Success check:** doc 16 §1.5 matrix rows 1–15 are each PASS with evidence.

---

#### The production steps (all NOT APPROVED, each needs its own go)

Legend: **Who** = Hunter (owner) or the operator (the agent running reviewed files). "Go-gate" = what must be true and what Hunter must say before the step. After any failure: **stop, do not retry, tell the manager**.

##### Part A — before the maintenance period (nothing user-facing changes)

🔴 **A1 — Read-only production inventory (O1)** — NOT APPROVED, needs its own go
- **What:** counts of profiles by role and status, and duplicate emails. **Why:** it decides D7 (what to do with old pending/guest rows) and the unique-index question; with 0 profiles expected, it confirms nothing changed since 2026-10-22. **If skipped:** the cutover could meet surprise rows.
- **Who:** Hunter, through "the existing Hunter-run read-only query route" (doc 14 §11.4 O1).
- **Steps:**
  1. a. Open the Supabase dashboard for the **production** project (link: https://supabase.com/dashboard — not verified: exact project page). b. Open the SQL editor. c. Run the read-only query the manager provides. **The query text is NOT recorded in the repo; the manager must supply it and have it reviewed first.** Paste box: *(none recorded; the manager adds it here)*.
  2. a. Report **numbers only** to the manager (never names or emails).
- **Success check:** counts reported; no write happened.
- **Go-gate:** Hunter says "go for A1".
- **Source:** doc 14 §11.4 O1; doc 16 §3.2 step 1.

🔴 **A2 — The four July migrations on production (only if still unapplied)** — NOT APPROVED, needs its own go (approval 19)
- **What:** `20260722223300_security_hardening`, `20260723004500_profile_service_bootstrap`, `20260723010400_dnc_activity_enum_cast`, `20260723020000_contact_logs_dnc_guard`, one at a time, each after its staging replay (release-path plan §2 steps 9a–9d; M1, M1b and M1c depend on all four, doc 16 §1.1). **If skipped:** M1 fails or leaves the wrong permissions.
- **Backouts:** hardening → `supabase/backout/security-hardening-backout.sql` (this branch, new); profile bootstrap → restore the earlier function body (`20260720000300` / `20260720000800`, no file prepared); DNC enum → previous body (no file prepared); DNC guard → drop trigger and function (file header).
- **Who:** the production SQL route from **OPEN-1**. *(No command recorded: OPEN-1.)*
- **Success check (per file):** the function or trigger is present when re-read; the next nightly pipeline run succeeds (plan step 9a evidence).
- **Go-gate:** the migration's staging replay passed; Hunter says "go for A2, migration <name>".
- **Source:** release-path plan §2 steps 9a–9d; doc 16 §3.2 step 1; `scripts/verify-baseline-reconciliation.mjs`.

🔴 **A3 — Pre-cutover permission snapshot (read-only)** — NOT APPROVED, needs its own go
- **What:** `supabase/backout/pre-cutover-snapshot.sql` lists every grant, policy and function M1 touches. **Why:** the backout is checked against it. **If skipped:** the backout cannot be proven identical. Must run **before** M1.
- **Who:** the production SQL route from **OPEN-1**. (On staging the runner action is `snapshot`; production is refused by the runner.)
- **Steps:** 1. a. Run the file unchanged. b. Store the output **outside the repo** with the release record. c. Do not paste it into chat.
- **Success check:** the output file exists and is non-empty.
- **Go-gate:** Hunter says "go for A3".
- **Source:** doc 14 §11.5; doc 16 §1.3 step 6, §3.2 step 1.

🔴 **A4 — Read the hosted sign-in expiry settings (fixes wait W)** — NOT APPROVED, needs its own go
- **What:** read the hosted access-token (JWT) expiry and email OTP/link expiry. **W = the larger of the two + 5 minutes.** `supabase/config.toml` is NOT used. **If either cannot be read, L1 stops** (doc 14 §11.6 step 0).
- **Who:** Hunter.
- **Steps:** 1. a. Supabase dashboard → the production project → Authentication → the page that shows the JWT expiry and the email OTP/link expiry (not verified: exact page names; the manager confirms them on staging first). b. Write down both numbers. c. Tell the manager the numbers and compute W together.
- **Success check:** W is a number of minutes recorded here and in the maintenance-period length.
- **Go-gate:** Hunter says "go for A4".
- **Source:** doc 14 §11.6 step 0; doc 16 §3.2 step 1.

🔴 **A5 — Production Render service, suspended** — NOT APPROVED, needs its own go (approval 20; cost ≈ $7/month, NOT VERIFIED today, doc 16 §2.1 read 2026-10-23)
- **What:** create the web service `tnbs-recruiter-prod` **suspended**, with its settings and env var names. **Why:** the server must exist before cutover. **If skipped:** nothing to deploy.
- **Who:** Hunter creates it in the dashboard; the draft values are in `docs/build-plan/drafts/render-recruiter-web.yaml` (names only, no values).
- **Steps:**
  1. a. Re-check the price on Render's pricing page (link: https://render.com/pricing) and tell the manager. b. Render dashboard → New → Web Service (not verified: exact button names).
  2. a. Fill the settings from the draft file: Node runtime; root directory `app`; build `npm ci && npm run build && npm run build:server`; start `node dist-server/main.js`; health check path `/readyz`; auto-deploy **off**.
  3. a. Add the env var **names** listed in the draft. b. Values go **only** into the Render dashboard (or the approved Doppler route), never into chat. c. Set `MAINTENANCE_MODE` to `true`. d. Set `TRUSTED_PROXY_HOPS` to the value the T-IP test on staging produced.
  4. a. Suspend the service before the first deploy.
- **Paste boxes (values to type, exactly):**
  ```
  Build command:  npm ci && npm run build && npm run build:server
  Start command:  node dist-server/main.js
  Health check path:  /readyz
  MAINTENANCE_MODE:  true
  HOST:  0.0.0.0
  ```
- **Success check:** the service shows as suspended; every name in the draft is present; no value was typed anywhere but the dashboard.
- **Go-gate:** staging proof done (OPEN-4) and Hunter says "go for A5".
- **Source:** doc 16 §2.2, §2.3, §2.4, §3.2 step 2; draft file above.

🔴 **A6 — Shutdown delay 60 s set and read back** — NOT APPROVED, needs its own go
- **What:** the server drains for up to 45 s; Render's default wait is 30 s (doc 16 §2.2). A Render API key is needed for one `PATCH` and one `GET` of the service. **Why:** without it, in-flight sign-in emails can be cut off. **If skipped:** T-SHUTDOWN is not proven for production.
- **Who:** Hunter creates the API key; the operator runs the call; Hunter revokes the key afterwards.
- **Steps:** 1. a. Render dashboard → Account Settings → API Keys → create a key (not verified: exact names). b. Give it to the operator through the approved hidden channel, never chat. 2. Operator: one `PATCH` setting `maxShutdownDelaySeconds: 60`, then one `GET`, and records the returned value. **No command is recorded in the repo for this call; the manager supplies a reviewed one.** 3. a. Hunter revokes the API key.
- **Success check:** the read-back value is 60. If it is not returned, **stop** (doc 16 §2.2).
- **Go-gate:** Hunter says "go for A6".
- **Source:** doc 16 §2.2.

🔴 **A7 — Google Maps referrer for the production origin** — NOT APPROVED, needs its own go
- **What:** add the production origin to the browser key's allowed referrers. **If skipped:** maps fail closed; nothing else depends on it (doc 16 §2.4).
- **Steps:** 1. a. Google Cloud Console → APIs & Services → Credentials → the browser key → Application restrictions. b. **Read first** and report which referrers exist. c. After the go, add the production origin. 
- **Success check:** the production origin appears in the list; no other entry changed.
- **Go-gate:** Hunter says "go for A7" (approval 20).
- **Source:** doc 16 §2.4.

🔴 **A8 — SendGrid production key, webhook and sender (Quote-Queue's account)** — NOT APPROVED, needs its own go (approval 20)
- **What:** a send-only key, a **second** signed Event Webhook and a sender address. Never reuse Quote-Queue's key or webhook. Capacity check comes first (the plan may not allow another webhook). **If skipped:** no sign-in emails.
- **Who:** Hunter.
- **Steps:**
  1. **Capacity check (read-only).** a. SendGrid → Settings → Mail Settings → Event Webhooks. b. Count the enabled webhooks. c. If another cannot be created: **stop** and tell the manager.
  2. **Send-only key.** a. Settings → API Keys → Create API Key. b. Name `tnbs-recruiter-prod-send`. c. Restricted Access → Mail Send: Full Access, everything else No Access. d. Create & View → paste straight into Render `SENDGRID_API_KEY`. Never into chat, email or a file.
  3. **Second Event Webhook.** a. Create new webhook, name `tnbs-recruiter-prod`. b. Post URL = the production origin + `/webhooks/sendgrid`. c. Events: Processed, Delivered, Deferred, Dropped, Bounced, Spam Reports; open/click tracking **off**. d. Save, open it, enable **Signed Event Webhook**, copy the verification key into Render `SENDGRID_WEBHOOK_VERIFICATION_KEY`. e. "Test Your Integration".
  4. **Sender.** a. Settings → Sender Authentication. b. Use an address on a domain Quote-Queue already authenticated (no DNS change) → `SENDGRID_FROM_ADDRESS`; display name → `SENDGRID_FROM_NAME`. (Doc 13 recommended `signin@twistednail.com`; the choice is Hunter's.)
- **Success check:** the key list shows the new key as restricted; a verified event reaches the production log; a tampered request is refused (doc 16 §7 C).
- **Go-gate:** Hunter says "go for A8".
- **Source:** doc 16 §7 (B, A, C, D, E), §3.2 step 2; doc 15 §8 item 2.

##### Part B — the maintenance period (users locked out of changes; everything inside it, in this order)

Length of the period = the work below + **W** (A4). Pick the date with Hunter; give times in US Central **and** UTC. Doc 16 §3.2 step 3: **maintenance stays on until O2, L1 and the acceptance probes pass.**

🔴 **B1 — Maintenance on** — NOT APPROVED, needs its own go (approval 22)
- **What:** the old app shows "back shortly" and the new server serves the maintenance page only. Production has no users, so nobody is locked out (release-path plan step 14).
- **Steps:** 1. a. Render → `tnbs-recruiter-prod` → Environment → confirm `MAINTENANCE_MODE` = `true` (set in A5). b. The pre-cutover frontend (the current static site) stays deployed and untouched; **record which deploy it is** for backout (doc 16 §1.7).
- **Success check:** the value reads `true`; the pre-cutover deploy is written down.
- **Go-gate:** Hunter says "go for the cutover window, starting B1" (approval 22).
- **Source:** doc 16 §3.2 step 3, §1.7.

🔴 **B2 — M1** — NOT APPROVED, needs its own go
- **What:** `supabase/pending/M1_same_origin_signin.sql` (1,816 lines): creates the sign-in tables and the roles `recruiter_api`, `recruiter_app`, `recruiter_maintenance` (no passwords), re-keys permissions from `auth.uid()` to the session ledger, and ends with a PostGIS self-check that aborts everything on failure. **If skipped:** no new sign-in.
- **Who:** production SQL route (**OPEN-1**). Paste box: run the file **unchanged, first line to last**; no edits.
- **Success check:** the file commits; the PostGIS self-check passes; Postgres logs show no `permission denied` / `does not exist` (doc 16 §1.5 row 2).
- **Go-gate:** B1 done, A2 done, A3 snapshot stored, OPEN-1 answered; Hunter says "go for B2".
- **Rollback:** the order in section "Backout" below.
- **Source:** doc 16 §1.4 step 1, §3.2 step 3; the file header.

🔴 **B3 — M1b (managers add people)** — NOT APPROVED, needs its own go
- Same as B2 for `supabase/pending/M1b_add_person.sql` (D8, approved 2026-10-22). Success check: the file commits. Source: doc 16 §1.4 step 2; doc 15 §32.

🔴 **B4 — M1c (batch delete audit)** — NOT APPROVED, needs its own go
- Same as B2 for `supabase/pending/M1c_batch_delete_audit.sql` (Hunter "yes", 2026-10-23, per doc 16). **Its self-check must pass** (doc 16 §3.2 step 3). Source: doc 16 §1.4 step 3.

🔴 **B5 — Set the `recruiter_app` password** — NOT APPROVED, needs its own go
- **What:** M1 makes the login roles without passwords. The owner sets the password out of band. **Why:** the server cannot connect without it. **If skipped:** the deploy never becomes ready (`/readyz` stays 503).
- **Steps:** 1. a. Generate a long random password in your password manager. b. Supabase dashboard → SQL editor (production). c. Run one statement that gives `recruiter_app` LOGIN and that password. **No exact statement is recorded in this repo.** Quote-Queue's recorded form is `ALTER ROLE qq_maintenance LOGIN PASSWORD '<generated>'` (QQ `docs/M0_HOMEWORK.md` / `scripts/retention.ts` at 4059789); the manager adapts it to `recruiter_app` and has it reviewed. 2. a. Build `DATABASE_URL` as the **session pooler** URL, user `recruiter_app.<project-ref>`, port **5432** (doc 16 §2.6). b. Put it only in Render's `DATABASE_URL`.
- **Success check:** later, B6's deploy passes the `/readyz` health check.
- **Go-gate:** Hunter says "go for B5".
- **Source:** doc 16 §1.4 step 4, §2.6; M1 line 45 comment ("operator later: LOGIN + password").

🔴 **B6 — Deploy the reviewed commit (Render waits for `/readyz`)** — NOT APPROVED, needs its own go
- **What:** resume the service and deploy the reviewed commit. **If skipped:** no server.
- **Steps:** 1. a. Render → the service → resume. b. Manual deploy of the commit the manager names (not verified: exact button name; auto-deploy is off). c. Watch the deploy: it becomes live only when `/readyz` answers 200.
- **Success check:** the deploy shows live; the site shows the maintenance page. If `/readyz` never goes 200 within the 15 minutes Render allows, Render cancels it and the old instance keeps serving (doc 16 §2.5) — stop and tell the manager.
- **Go-gate:** B5 done; Hunter says "go for B6".
- **Source:** doc 16 §3.2 step 3, §2.5; `app/server/app.ts:562`.

🔴 **B7 — Backout window on (`window-on`) and verify** — NOT APPROVED, needs its own go (approval 18)
- **What:** pause email edits during the window. Done **before** maintenance is turned off. **If skipped:** the backout's identity check (`profiles.email = auth.users.email`) can fail.
- **Who:** production SQL route (**OPEN-1**). (Staging runner action name: `window-on`; refuses production.)
- **Paste boxes (from doc 16 §3.1):**
  ```
  update internal.backout_window set email_edits_paused = true
  ```
  verify:
  ```
  select email_edits_paused from internal.backout_window
  ```
- **Success check:** the second statement returns `true`. (A Team email edit being refused is proved on staging first, doc 16 §3.1 step 2.)
- **Go-gate:** D10 answered (OPEN-3); Hunter says "go for B7".
- **Source:** doc 16 §3.1.

🔴 **B8 — O2: turn off Supabase sign-ups and every Auth provider** — NOT APPROVED, needs its own go
- **What:** stops NEW Supabase sign-ins. **If skipped:** the old door stays open. Do this **after** the new server is deployed (doc 14 §11.2 step 4).
- **Steps:** 1. a. Supabase dashboard → production project → Authentication → sign-up settings and Providers (not verified: exact page names). b. Turn **off** sign-ups. c. Turn **off** email, phone, anonymous and every OAuth provider. d. Write down what each was set to before (so backout can restore the email provider).
- **Success check:** the issuance probes (`/otp`, `/magiclink`, `/recover`, `/resend`, `/signup`) are refused (doc 14 §8.1 class B, run in B10).
- **Go-gate:** B6 live; Hunter says "go for B8".
- **Source:** doc 14 §11.2 step 4, §11.4 O2, §11.6 step 1.

🔴 **B9 — L1: close the old Supabase sign-in credentials** — NOT APPROVED, needs its own go (approval 21, given before 22)
- **What:** clears old sessions, refresh tokens, one-time tokens and flow state, and empties six token columns on `auth.users`. Changes **no** password, ban, email or profile. Expected rows changed: about 0 (production had 0 Auth users, verify at run time). **If skipped:** old credentials could still reach Supabase's `/user` endpoint. **No backout**; the backout only restores the email provider (doc 14 §11.6).
- **Who:** production SQL route (**OPEN-1**), as `postgres`. File: `supabase/rollout/L1-close-legacy-auth.sql`, run **in its own stages**, not as one paste:
  1. a. Stage "shape check" (the two `information_schema` selects at the top of the file). b. Any `auth.*` table that holds credentials and is not listed there → **STOP** for review.
  2. a. Stage "counts before" (the `select … as sessions …` query). b. Record numbers only.
  3. a. Stage "one transaction" (`begin; … commit;`). b. Record rows changed (numbers only).
  4. a. Re-run the counts query: every number must be 0.
  5. a. **Wait W** (A4). b. Run stage 3 again; expect **zero rows changed**. Any non-zero → incident: stop and investigate.
  6. a. Run the counts daily during the backout window (doc 14 §11.6 step 8).
- **Paste box:** the file's own text, unchanged, stage by stage. **Never print token values or ids.**
- **Success check:** all four tables at 0; no `auth.users` row with a non-empty token column; the second sweep changed 0 rows.
- **Go-gate:** B8 done and its issuance probes refused; Hunter says "go for B9".
- **Source:** doc 14 §11.6 steps 0–8; `supabase/rollout/L1-close-legacy-auth.sql`.

🔴 **B10 — Acceptance probes** — NOT APPROVED, needs its own go
- **What:** the production subset of A5a (stateless) probes and of the L1 rejection probes, the A7 log check subset and T-IP. Doc 14 §8.1 and doc 16 §1.6 define them; their exact production subset is **not written down** — the manager lists it here before the go. Production has no fixture accounts, so any stateful probe that needs one **must be decided by the manager first** (do not create test accounts in production without a separate go).
- **Success check:** every probe matches its listed expected result; log searches show 0 credential hits (hit counts only).
- **Go-gate:** B9 done; the subset is written down; Hunter says "go for B10".
- **Source:** doc 16 §3.2 step 3; doc 14 §8.1; doc 16 §1.6.

🔴 **B11 — First manager signs in (depends on OPEN-2)** — NOT APPROVED, needs its own go
- **What:** Hunter's manager profile exists (OPEN-2), then Hunter requests a sign-in link and opens it.
- **Steps:** 1. a. Open the production origin's `/signin`. b. Enter Hunter's email. c. Open the emailed link within 15 minutes (the link is one-time). d. Press the confirm button on the page that appears (doc 14 §3.3, §3.4).
- **Success check:** Hunter reaches the dashboard as Manager.
- **Go-gate:** maintenance is still **on** while the manager profile is created and tested through the operator's path; Hunter says "go for B11".
- **Source:** doc 14 §11.2 step 4; doc 16 §3.2 step 3.

🔴 **B12 — Maintenance off** — NOT APPROVED, needs its own go
- **What:** set `MAINTENANCE_MODE` to `false` and redeploy/restart as the manager directs (not verified: whether a restart or a deploy loads a changed Render setting; Hunter's rule says a restart does not load changes for Doppler-synced services). **Do this last**, after B7–B11.
- **Success check:** `/signin` loads for an outside visitor; the backout window is open.
- **Go-gate:** B7, B9, B10, B11 all passed; Hunter says "go for B12".
- **Source:** doc 16 §3.2 step 3.

##### Part C — after cutover (each its own go)

🔴 **C1 — Retention wired on the pipeline (approval 23)** — NOT APPROVED. Add `MAINTENANCE_DATABASE_URL` to the production pipeline service, then read back that `PIPELINE_COMMAND` and the existing secrets are unchanged. Source: doc 16 §4 step 4. Never in the same sitting as the cutover.

🔴 **C2 — Close the backout window (approval 24)** — NOT APPROVED. `window-off`, then verify `false`, only on Hunter's word (recommended day 14). Then M2 (FK drop) is a separate decision (doc 14 §11.2 step 5). Source: doc 16 §3.1 step 3.

##### Backout (if anything goes wrong; each step its own go)

Ordered, from doc 16 §3.3 and doc 14 §11.5:
1. Maintenance on. 2. `supabase/backout/retire-app-credentials.sql` in its five stages (suspend the Render service first; `NOLOGIN` committed on its own; wait for 0 backends three reads in a row; revoke ledgers; checks all 0). 3. Check `profiles.email = auth.users.email` for every approved profile. 4. `M1c-backout.sql`, then `M1b-backout.sql`, then `M1-backout.sql`. 5. Re-enable the Supabase email provider (undo B8; sign-ups stay off). 6. Return traffic to the recorded pre-cutover frontend. 7. Read-only smoke test and compare with the A3 snapshot. 8. Tell the team. If hardening itself must also go back: run `security-hardening-backout.sql` **after** `M1-backout.sql`. Sessions closed by L1 stay closed; people sign in again with passwords. Re-applying later uses `reapply-m1`, `reapply-m1b`, `reapply-m1c` (doc 16 §3.3) on staging; **no production route recorded (OPEN-1)**.

---

### Summary of Next Step

Nothing runs next. The next step is for Hunter and the manager to read this draft and answer four questions: how production SQL will be run, how Hunter's own manager login gets created in an empty production database, whether to declare a 14-day backout window, and when staging proof will be finished. After that, the manager asks for one "go" at a time, starting with the read-only counts (A1).

### Summary of Previous Step

Verified by reading the repo (nothing was run against any live system):
- The step order comes from docs 14 and 16. The SQL files named here all exist (`supabase/pending/M1*.sql`, `supabase/backout/*.sql`, `supabase/rollout/L1-close-legacy-auth.sql`).
- The staging SQL runner refuses production (`pipeline/src/staging-sql-runner.ts:67`), so production steps cannot reuse its actions.
- `scripts/bootstrap-first-manager.ts` (doc 13:430) does not exist, and production had 0 profiles on 2026-10-22.
- `/readyz` is already implemented (`app/server/app.ts:562`), although doc 16 §2.5 still says it is not made.

Attempts / not verified: exact Supabase, Render, SendGrid and Google Cloud page and button names; Render price today; whether a Render restart loads a changed setting; the production probe subset.

### Miscellaneous

- Sources: docs 13, 14 (§3, §8.1, §11), 15 (§8, §32), 16 (§1–§4, §6, §7); release-path plan 2026-10-22 (thr_grum38j2d2); Quote-Queue `docs/M0_HOMEWORK.md` at 4059789845a52e355b747371752744ffd790e135 (read only).
- Doc 15 §6's env var names (for example `APP_BASE_URL`, `KEY_TOKENS`, `HEALTH_SECRET`) are older than the code; this runbook and the Render draft follow `app/server/config.ts` and doc 16 §2.3.
- Not decided here: SMS (future direction only), TOTP/passkeys (deferred), D8/D10 (D8 approved; D10 open), Doppler connection for the new Render service.
- No secrets, project refs, hostnames or account ids appear in this file by design.
