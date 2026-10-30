# 17 · Production sign-in cutover — owner runbook (DRAFT, revised after Codex review)

**Status: DRAFT. NOTHING IN THIS FILE IS APPROVED OR HAS BEEN RUN.** First written 2026-10-30 (UTC) on branch `signin/cutover-prep`; revised 2026-10-30 (UTC) to fix the eight Codex review findings. Local only. Every step that touches a live system is marked **NOT APPROVED, needs its own go**. A "go" for one step is not a "go" for the next. Hunter's clock is US Central; times written down here are UTC.

Covers release-path plan step 14 (production sign-in cutover) and step 15 (L1, closing the old Supabase sign-in credentials). Order comes from doc 14 §11.2 step 4 and doc 16 §3.2. Where the repo has **no recorded command**, the step says so and stops (marked **GAP**).

**Decisions already settled:**
- The mail provider is **SendGrid** (settled by the manager, 2026-10-30; the older "Resend" mention in the release-path plan is stale).
- **Every secret goes through Doppler** (the source of truth since 2026-10-28). This runbook names each secret by NAME, its source and its Doppler project/config only. **No step asks Hunter to type a value into Render, GitHub or any other dashboard.** The Doppler → Render rules are in `C:\Users\hunte\.bb\BB Rules\doppler-render-playbook.md` (a sync replaces every Render setting with what Doppler holds; a restart does NOT load new settings, "Deploy latest commit" does).
- **Doppler homes (proposed here, Hunter confirms in OPEN-5):** runtime settings only in `truck-recruitment-tool` / `prd`; owner-only `PRODUCTION_DB_URL` in separate project `truck-recruitment-tool-owner` / `prd`, which must never sync to Render or any other service. (Doc 16 §1.9 uses `truck-recruitment-tool` / `stg` for staging runner secrets. Not verified: either proposed production scope exists today.)
- **The server's maintenance mode answers 503 to everything except `/readyz` and `/healthz/db`** (`app/server/app.ts:566`; test `app/server/app.test.ts:548`). That includes sign-in, confirmation and the SendGrid webhook. There is **no operator bypass and none is invented here**. So: anything that needs the real sign-in or the webhook runs **after** maintenance is turned off (Part C). Database work for the first manager runs **before** (Part B).

---

### Pending Action

**Nothing is asked of Hunter today.** This is a draft for review. Before anyone can ask for the first "go", Hunter must settle the open items below (OPEN-1 to OPEN-5). After that, the steps run in order, one "go" at a time.

🔴 **OPEN-1 — How production SQL gets run (no route is recorded)** — NOT APPROVED, needs its own go
- **What:** the staging SQL runners refuse production on purpose: the original planner at `pipeline/src/staging-sql-runner.ts:67–68` (error `production_refused`) and the rebuilt-project actions at `pipeline/src/staging-rebuilt.ts:183–184`. Their actions (`snapshot`, `apply-m1`, `apply-m1b`, `apply-m1c`, `window-on`, `window-off`, `reapply-*`) are staging only. Doc 14 says "the operator runs it as `postgres`" and doc 16 §1.9 says "production steps stay owner-run", but **no document records the exact tool** for running the production SQL files.
- **Why needed:** steps A2, A3, B2, B3, B4, B5, B10, B13 and the backout SQL steps cannot be scheduled without it.
- **If skipped:** the cutover cannot start.
- **Steps:**
  1. a. Hunter tells the manager, in chat, which route to use for production SQL (for example: Hunter pastes each reviewed file into the Supabase SQL editor at https://supabase.com/dashboard (not verified: exact page) while the operator watches; or a new, separately reviewed production runner is built).
  2. a. The manager records the answer in this file, replacing this item.
- **Success check:** this item names one route and who runs it.

🔴 **OPEN-2 — First manager on an empty roster** — NOT APPROVED, needs its own go. **Candidate tool exists; PENDING REVIEW.**
- **What:** production had 0 Auth users and 0 profiles on 2026-10-22 (doc 15 §32; release-path plan §2 step 14; historical counts, not a live measurement). `team_add_person` (M1b) needs an existing manager (doc 15 §32), so the first manager cannot be created through the app. The candidate tool is on branch `signin/first-manager-bootstrap` @ `e31dc29` (design and runbook: its `docs/build-plan/18-first-manager-bootstrap.md`). **It is under separate review and is not merged into this branch. Until that review passes, treat everything below as "pending review".** The tool makes one `public.profiles` row (Hunter's email, role manager, status approved); it makes no Auth user and no password.
- **Exact command (from doc 18 §3, pending review), run through `scripts/run-with-secrets.mjs` with a hidden prompt for the secret `PRODUCTION_DB_URL`:**
  ```
  npm run first-manager -- --target=production --action=first-manager-check --confirm="RUN TNBS FIRST MANAGER CHECK" --execute
  npm run first-manager -- --target=production --action=first-manager-create --confirm="CREATE TNBS PRODUCTION FIRST MANAGER" --execute
  ```
  Without `--execute` either command only prints a plan and connects to nothing (doc 18 §3); with it, the check reads only. The exact wrapped form (`run-with-secrets.mjs --cwd pipeline --secret PRODUCTION_DB_URL -- node ...`) is **not written out in doc 18** — the wrapper requires the child command to start with `node` — so the manager records the exact wrapped line after review (pending review).
- **Secret handling (scope confirmation needed, see OPEN-5):** `PRODUCTION_DB_URL` stays **owner-only and prompt-only** (the candidate wrapper refuses `--from-env`; doc 16 §1.9 excludes production from the Doppler runner path). Source: the owner database credential approved for the separately reviewed bootstrap, obtained by Hunter from the production Supabase connection page at https://supabase.com/dashboard (not verified: exact page). Record it only in Doppler project `truck-recruitment-tool-owner`, config `prd`, at https://dashboard.doppler.com (not verified: exact project page). Hunter reads it there and supplies the hidden local prompt; the tool does not fetch it from Doppler. This project/config must have no integrations or syncs and must never be synced to Render or another service. Never store `PRODUCTION_DB_URL` in `truck-recruitment-tool/prd`, any other Render-synced config, an environment group or secret file. `DATABASE_URL` is the separate runtime login. No change to the candidate's prompt-only design is proposed here.
- **Why needed:** without a manager profile for Hunter's email, step C1 (first manager signs in) cannot succeed, and nobody can add anyone.
- **If skipped:** the cutover finishes with a sign-in page nobody can use.
- **Steps:** 1. a. The manager reports the outcome of the separate review of `e31dc29`. b. If it passes, the manager merges it (a separate action, not part of this runbook) and replaces "pending review" here. c. The staging rehearsal in doc 18 §4 passes first (its own approvals).
- **Success check:** the tool is reviewed, merged, and rehearsed on staging.

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

---

#### The production steps (all NOT APPROVED, each needs its own go)

Legend: **Who** = Hunter (owner) or the operator (the agent running reviewed files). "Go-gate" = what must be true and what Hunter must say before the step. After any failure: **stop, do not retry, tell the manager**. Links marked "(not verified: …)" were not opened; exact page and button names must be confirmed on the day.

Order at a glance: **Part A** (prepare, nothing user-facing) → **Part B** (maintenance period, everything database- and provider-side, ends with maintenance off) → **Part C** (after opening: the real sign-in and the webhook proof) → **Backout**.

##### Part A — before the maintenance period (nothing user-facing changes)

🔴 **A1 — Read-only production inventory (O1)** — NOT APPROVED, needs its own go
- **What:** counts of profiles by role and status, and duplicate emails. **Why:** decides D7 (old pending/guest rows) and the unique-index question; confirms nothing changed since 2026-10-22. **If skipped:** the cutover could meet surprise rows.
- **Who:** Hunter, through "the existing Hunter-run read-only query route" (doc 14 §11.4 O1).
- **Steps:**
  1. a. Open https://supabase.com/dashboard (not verified: exact project page) and pick the **production** project. b. Open the SQL editor (not verified: menu name). c. Run the read-only query the manager provides. **GAP: the query text is not recorded in the repo; the manager must supply it and have it reviewed first.** Paste box: *(none recorded; the manager adds it here)*.
  2. a. Report **numbers only** to the manager (never names or emails).
- **Success check:** counts reported; no write happened.
- **Go-gate:** Hunter says "go for A1".
- **Source:** doc 14 §11.4 O1; doc 16 §3.2 step 1.

🔴 **A2 — The four July migrations on production (only if still unapplied)** — NOT APPROVED, needs its own go per migration (approval 19)
- **What:** `20260722223300_security_hardening`, `20260723004500_profile_service_bootstrap`, `20260723010400_dnc_activity_enum_cast`, `20260723020000_contact_logs_dnc_guard`, one at a time, each after its staging replay (release-path plan §2 steps 9a–9d; M1, M1b and M1c depend on all four, doc 16 §1.1). **If skipped:** M1 fails or leaves the wrong permissions.
- **Who:** the production SQL route from **OPEN-1**. **GAP: no command recorded (OPEN-1).**
- **Steps:**
  1. a. For each migration in the order above, the operator runs the file from `supabase/migrations/` unchanged, first line to last. b. After each, run the success check below before the next. c. Hunter's separate go for each.
- **Backouts (kept here so each is known before the go):** hardening → `supabase/backout/security-hardening-backout.sql` (this branch; run after `M1-backout.sql` if M1 is also being backed out); profile bootstrap → restore the earlier function body (`20260720000300` / `20260720000800`; **no file prepared**); DNC enum cast → previous body (**no file prepared**); DNC guard → drop trigger and function (file header).
- **Success check (per file):** the function or trigger is present when re-read; the next nightly pipeline run succeeds (plan step 9a evidence).
- **Go-gate:** the migration's staging replay passed; Hunter says "go for A2, migration <name>".
- **Source:** release-path plan §2 steps 9a–9d; doc 16 §3.2 step 1; `scripts/verify-baseline-reconciliation.mjs`.

🔴 **A3 — Pre-cutover permission snapshot (read-only)** — NOT APPROVED, needs its own go
- **What:** `supabase/backout/pre-cutover-snapshot.sql` lists every grant, policy and function M1 touches. **Why:** the backout is checked against it. **If skipped:** the backout cannot be proven identical. Must run **before** M1.
- **Who:** the production SQL route from **OPEN-1**. (On staging the runner action is `snapshot`; production is refused by the runner.)
- **Steps:**
  1. a. Run the file unchanged. b. Store the output **outside the repo** with the release record. c. Do not paste it into chat.
- **Success check:** the output file exists and is non-empty.
- **Go-gate:** Hunter says "go for A3".
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
- **Who:** the production SQL route (**OPEN-1**).
- **Steps:**
  1. a. Run the file **unchanged, first line to last**; no edits. b. Do not split it.
- **Paste box:** the file's own text, unchanged.
- **Success check:** the file commits; the PostGIS self-check passes; Postgres logs show no `permission denied` / `does not exist` (doc 16 §1.5 row 2).
- **Go-gate:** B1 done, A2 done, A3 snapshot stored, OPEN-1 answered; Hunter says "go for B2".
- **Rollback:** the Backout section below.
- **Source:** doc 16 §1.4 step 1, §3.2 step 3; the file header.

🔴 **B3 — M1b (managers add people)** — NOT APPROVED, needs its own go
- **What:** `supabase/pending/M1b_add_person.sql` (D8, approved 2026-10-22): adds `team_add_person` and drops the `profiles_id_fkey` so a profile no longer needs an Auth user. **If skipped:** the first manager cannot be created (B8/B9) and nobody can be added.
- **Who:** the production SQL route (**OPEN-1**).
- **Steps:**
  1. a. Run the file **unchanged, first line to last**; no edits.
- **Paste box:** the file's own text, unchanged.
- **Success check:** the file commits, with no error.
- **Go-gate:** B2 committed; Hunter says "go for B3".
- **Rollback:** the Backout section below.
- **Source:** doc 16 §1.4 step 2; doc 15 §32.

🔴 **B4 — M1c (batch delete audit)** — NOT APPROVED, needs its own go
- **What:** `supabase/pending/M1c_batch_delete_audit.sql` (Hunter "yes", 2026-10-23, per doc 16): the batch-delete audit record. **Its self-check must pass** (doc 16 §3.2 step 3). **If skipped:** batch deletes are not audited.
- **Who:** the production SQL route (**OPEN-1**).
- **Steps:**
  1. a. Run the file **unchanged, first line to last**; no edits.
- **Paste box:** the file's own text, unchanged.
- **Success check:** the file commits and its self-check passes.
- **Go-gate:** B3 committed; Hunter says "go for B4".
- **Rollback:** the Backout section below.
- **Source:** doc 16 §1.4 step 3.

🔴 **B5 — Set the `recruiter_app` password and store `DATABASE_URL` in Doppler** — NOT APPROVED, needs its own go
- **What:** M1 makes the login roles without passwords. The owner sets the password out of band. **Why:** the server cannot connect without it. **If skipped:** the deploy never becomes ready (`/readyz` stays 503).
- **Who:** Hunter.
- **Steps:**
  1. a. Generate a long random password in your password manager. b. Open https://supabase.com/dashboard (not verified: exact page) → the production project → SQL editor. c. Run one statement that gives `recruiter_app` LOGIN and that password. **GAP: no exact statement is recorded in this repo.** Quote-Queue's recorded form is `ALTER ROLE qq_maintenance LOGIN PASSWORD '<generated>'` (QQ `docs/M0_HOMEWORK.md` / `scripts/retention.ts` at 4059789); the manager adapts it to `recruiter_app` and has it reviewed. Paste box: *(the reviewed statement; the manager adds it here)*. d. Close the editor tab afterwards so the password is not left on screen.
  2. a. Build the `DATABASE_URL` as the **session pooler** address, user `recruiter_app.<project-ref>`, port **5432** (doc 16 §2.6). The pooler address is shown on the Supabase project's connection page (not verified: exact page name). b. Open https://dashboard.doppler.com (not verified) → project `truck-recruitment-tool` → config `prd` → `DATABASE_URL` → paste → save. **Only** into Doppler.
- **Success check:** `DATABASE_URL` is filled in Doppler `prd` (names only reported). Later, B7's deploy passes the `/readyz` health check.
- **Go-gate:** B4 committed; Hunter says "go for B5".
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

🔴 **B8 — First manager: read-only check (maintenance still on)** — NOT APPROVED, needs its own go. **Tool PENDING REVIEW (OPEN-2).**
- **What:** report whether production is ready for the first manager row. Reads only. **Why:** the first manager must exist **before** maintenance is lifted, because sign-in cannot be tested while maintenance is on. **If skipped:** the create step runs blind.
- **Who:** the operator, with Hunter present for the hidden prompt.
- **Steps:**
  1. a. Confirm B2 and B3 committed and maintenance remains on. b. Open https://dashboard.doppler.com (not verified: exact project page) → project `truck-recruitment-tool-owner` → config `prd` → `PRODUCTION_DB_URL`. Source: Hunter's owner bootstrap database credential from the approved production Supabase connection page (https://supabase.com/dashboard, not verified: exact page). Confirm this owner-only scope has no syncs or integrations. c. Operator uses the reviewed and merged first-manager tool (candidate branch `signin/first-manager-bootstrap` @ `e31dc29`, pending review), through `scripts/run-with-secrets.mjs` with a hidden prompt for `PRODUCTION_DB_URL`. Candidate child command, **not a complete wrapped invocation**:
  ```
  npm run first-manager -- --target=production --action=first-manager-check --confirm="RUN TNBS FIRST MANAGER CHECK" --execute
  ```
  d. **GAP: the manager must add the exact reviewed wrapper line with a `node` child before requesting go; do not run the bare npm line above as though it were wrapped.** e. Hunter supplies `PRODUCTION_DB_URL` from `truck-recruitment-tool-owner/prd` only to the hidden local prompt; never to an environment variable, Render, chat or a file.
- **Success check:** the printed state is `ready_to_create` or `ready_to_promote`. Any other state (`manager_exists`, `already_bootstrapped`, `address_blocked`, `address_on_roster`, `schema_not_ready`) → **stop** and tell Hunter.
- **Go-gate:** OPEN-2 review, merge and staging rehearsal passed; exact hidden-prompt wrapper line supplied and reviewed; OPEN-5 owner-only isolation verified; B2/B3 committed and maintenance on; Hunter says "go for B8". Pending review means STOP, no go requested.
- **Source:** doc 18 §3, §4 (branch `signin/first-manager-bootstrap` @ `e31dc29`, pending review).

🔴 **B9 — First manager: create (maintenance still on)** — NOT APPROVED, needs its own go. **Tool PENDING REVIEW (OPEN-2).**
- **What:** insert (or promote) the one `public.profiles` row for Hunter's email as an approved Manager, with one audit row. No Auth user, no password, no email. **Why:** the first manager must exist in the database before real sign-in can be tested after maintenance ends. **If skipped:** nobody can sign in or add anyone after opening.
- **Who:** the operator, with Hunter present for the hidden prompt.
- **Steps:**
  1. a. Confirm B8 reported `ready_to_create` or `ready_to_promote` and maintenance is still on. b. Open https://dashboard.doppler.com (not verified: exact project page) → project `truck-recruitment-tool-owner` → config `prd` → `PRODUCTION_DB_URL`; confirm no syncs or integrations. Source: Hunter's approved owner bootstrap database credential from the production Supabase connection page (https://supabase.com/dashboard, not verified: exact page). c. Operator uses the reviewed and merged first-manager tool through `scripts/run-with-secrets.mjs` with a hidden local prompt. Candidate child command (pending review), **not a complete wrapped invocation**:
  ```
  npm run first-manager -- --target=production --action=first-manager-create --confirm="CREATE TNBS PRODUCTION FIRST MANAGER" --execute
  ```
  d. **GAP: the exact reviewed wrapper line with a `node` child must be recorded before requesting go.** e. Hunter supplies `PRODUCTION_DB_URL` from `truck-recruitment-tool-owner/prd` only to the hidden prompt; never to Render, an environment variable, chat or a file. f. The tool is single-use. After any failure or unknown result, **stop**, tell the manager, and do not retry or run another check under this approval.
- **Success check:** result `committed` with all "after" checks ok. Existence is independently checked in B9V under its own go; B9 alone does not authorize opening sign-in.
- **Go-gate:** OPEN-2 review, merge and staging rehearsal passed; exact hidden-prompt wrapper line supplied and reviewed; owner-only isolation verified; B8 showed `ready_to_create` or `ready_to_promote`; maintenance on; Hunter says "go for B9". Pending review means STOP, no go requested.
- **Source:** doc 18 §3, §4 (pending review).

🔴 **B9V — First manager: independent follow-up check** — NOT APPROVED, needs its own go. **Tool PENDING REVIEW.**
- **What:** read the roster after the create attempt, without creating, promoting or sending anything. **Why:** a create result alone does not prove the manager exists; an unknown result must not cause a blind retry. **If skipped:** B15 and C1 remain blocked.
- **Who:** the operator, with Hunter supplying the hidden prompt.
- **Steps:**
  1. a. Keep maintenance on. b. Open https://dashboard.doppler.com (not verified: exact project page) → project `truck-recruitment-tool-owner` → config `prd` → `PRODUCTION_DB_URL`. Source: Hunter's approved owner bootstrap database credential from the production Supabase connection page (https://supabase.com/dashboard, not verified: exact page). Confirm this scope has no syncs or integrations.
  2. a. Use the reviewed and merged first-manager tool through `scripts/run-with-secrets.mjs` with its hidden local prompt. Candidate child command (pending review), **not a complete wrapped invocation**:
  ```
  npm run first-manager -- --target=production --action=first-manager-check --confirm="RUN TNBS FIRST MANAGER CHECK" --execute
  ```
  b. **GAP: manager must supply the exact reviewed wrapper line with a `node` child before requesting go.** c. Hunter supplies `PRODUCTION_DB_URL` from `truck-recruitment-tool-owner/prd` only to that hidden prompt; never to an environment variable, Render, chat or a file. d. Record the state only, no personal data.
- **Success check:** `manager_exists` after a confirmed successful create. Any other state or any unknown/failed B9 result is a STOP for the manager's investigation; a negative check never authorizes another create.
- **Go-gate:** OPEN-2 review, merge and staging rehearsal passed; exact hidden-prompt wrapper line supplied and reviewed; owner isolation verified; B9 result recorded (including any unknown result); maintenance on; Hunter says "go for B9V". Pending review means STOP, no go requested.
- **Source:** doc 18 §3, §4 (branch `signin/first-manager-bootstrap` @ `e31dc29`, pending review).

🔴 **B10 — Backout window on (`window-on`) and verify** — NOT APPROVED, needs its own go (approval 18)
- **What:** pause email edits during the window. Done **before** maintenance is turned off. **If skipped:** the backout's identity check (`profiles.email = auth.users.email`) can fail.
- **Who:** the production SQL route (**OPEN-1**). (Staging runner action name: `window-on`; it refuses production.)
- **Steps:**
  1. a. Run the update below. b. Run the check below.
- **Paste boxes (from doc 16 §3.1):**
  ```
  update internal.backout_window set email_edits_paused = true
  ```
  verify:
  ```
  select email_edits_paused from internal.backout_window
  ```
- **Success check:** the second statement returns `true`. (A Team email edit being refused is proved on staging first, doc 16 §3.1 step 2.)
- **Go-gate:** D10 answered (OPEN-3); B4 committed; Hunter says "go for B10".
- **Source:** doc 16 §3.1.

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
- **Who:** the production SQL route (**OPEN-1**), as `postgres`. File: `supabase/rollout/L1-close-legacy-auth.sql`, run **in its own stages**, not as one paste. **Never print token values or ids.** Numbers only.
- **Steps:**
  1. **Stage 1, shape check.** a. Run the two `information_schema` selects at the top of the file, unchanged. b. Any `auth.*` table that holds credentials and is not listed there → **STOP** for review. Success: nothing unlisted.
  2. **Stage 2, counts before.** a. Run the `select … as sessions …` counts query, unchanged. b. Record the numbers. Success: numbers recorded.
  3. **Stage 3, first sweep (one transaction).** a. Run `begin; … commit;` from the file, unchanged. b. Record rows changed (numbers only). Success: it commits.
  4. **Stage 4, first recount.** a. Re-run the counts query. b. Record the numbers. Success: every number is **0**: all four tables, and no `auth.users` row with a non-empty token column. Otherwise **STOP**.
  5. **Stage 5, wait W.** a. Wait W minutes (A4). b. Write the start and end time (UTC).
  6. **Stage 6, second sweep.** a. Run stage 3 again. b. Record rows changed. Success: **zero** rows changed. Any non-zero → incident: stop and investigate (doc 14 §11.6 step 6).
  7. **Stage 7, second recount (doc 14 §11.6 step 6 repeats both the sweep and the verification).** a. Immediately after stage 6, re-run the counts query. b. Record the numbers as their own result. Success: all four tables **0** and no non-empty token column. Otherwise incident: **STOP**. The daily counts in step 9 are a later check and do not replace this one.
  8. a. Record the final result (numbers only) with the release record.
  9. a. During the backout window, run the counts daily (doc 14 §11.6 step 8). Any non-zero is an incident.
- **Paste box:** the file's own text, unchanged, stage by stage.
- **Success check:** stages 4 and 7 both show all zeros; stage 6 changed 0 rows.
- **Go-gate:** B12 all refused; Hunter says "go for B13".
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
  2. a. Source for `MAINTENANCE_DATABASE_URL`: Hunter's approved `recruiter_maintenance` production connection credential, prepared via the still-undecided OPEN-1 production SQL route; no credential-creation command is supplied here. If unavailable, **stop**. b. Open https://dashboard.doppler.com (not verified: exact project page) → project `pipeline` → config `prd`. c. Record existing names and `PIPELINE_COMMAND` without printing secret values; confirm the existing Render sync targets the pipeline cron. Do not create or reconnect a sync under this step.
  3. a. Only after the separate go, add `MAINTENANCE_DATABASE_URL` in Doppler `pipeline/prd` from that approved source. Never type its value into Render or another dashboard. b. Read back names and confirm `PIPELINE_COMMAND` and existing entries are unchanged, without displaying secret values.
  4. a. Follow the activation/evidence procedure recorded in step 1 only if it is covered by Hunter's explicit C3 go; any additional run or change requires its own go. b. Record the UTC run time and reviewed retention result, with counts only.
- **Success check:** `MAINTENANCE_DATABASE_URL` present in `pipeline/prd`; existing names, entries and `PIPELINE_COMMAND` unchanged; recorded cron evidence proves the approved activation loaded the setting and retention succeeded. Merely saving the secret is not activation proof.
- **Go-gate:** C1/C2 passed; later sitting; OPEN-1 credential preparation resolved and approved; `pipeline/prd` source/sync confirmed; exact cron activation, schedule and evidence procedure written and reviewed with all gaps resolved; Hunter says "go for C3" (approval 23). Until then STOP; do not request this go or edit `pipeline/prd`.
- **Source:** doc 16 §4 step 4; Hunter's AGENTS.md identifies `pipeline/prd`; playbook says cron jobs have no Deploy latest commit and not to Trigger Run just to apply settings.

🔴 **C4 — Close the backout window (approval 24)** — NOT APPROVED, needs its own go
- **What:** `window-off`, then verify `false`, only on Hunter's word (recommended day 14). Then M2 (FK drop) is a separate decision (doc 14 §11.2 step 5). **If skipped:** email edits stay paused.
- **Who:** the production SQL route (**OPEN-1**).
- **Steps:**
  1. a. Run the update below. b. Run the check below.
- **Paste boxes (inverse of B10, from doc 16 §3.1):**
  ```
  update internal.backout_window set email_edits_paused = false
  ```
  verify:
  ```
  select email_edits_paused from internal.backout_window
  ```
- **Success check:** the check returns `false`.
- **Go-gate:** Hunter says "go for C4" (day 14 recommended).
- **Source:** doc 16 §3.1 step 3.

##### Backout (if anything goes wrong; every step its own go, in this order)

Order from doc 16 §3.3 and doc 14 §11.5. After any failure: **stop, tell the manager**. Backout SQL runs through the production SQL route from **OPEN-1**.

🔴 **BO1 — Maintenance on** — NOT APPROVED, needs its own go
- **What:** put the new server back in maintenance. **If skipped:** users keep reaching a system being rolled back.
- **Steps:**
  1. a. Open https://dashboard.doppler.com (not verified) → project `truck-recruitment-tool` → config `prd` → `MAINTENANCE_MODE` → `true` → save. b. Open https://dashboard.render.com (not verified) → `tnbs-recruiter-prod` → Manual Deploy → **Deploy latest commit** (Restart does not load the change). c. Operator: `node "C:\Users\hunte\.bb\BB Rules\doppler-tools\deploy-watch.js" truck-recruitment-tool tnbs-recruiter-prod`.
- **Success check:** the service address answers "Back shortly."; `/readyz` still answers.
- **Go-gate:** reader copy `TEMP_RENDER_API_KEY` is still valid in Doppler `truck-recruitment-tool/dev` for deploy-watch; K1 has not removed it; Hunter says "go for BO1". If missing or revoked, STOP until a separate reader-key provisioning plan and go are recorded; do not use A7's revoked key.
- **Source:** doc 16 §3.3; playbook step 6.

🔴 **BO2 — `retire-app-credentials.sql` (five stages)** — NOT APPROVED, needs its own go
- **What:** stop the app database login (`NOLOGIN`, password cleared) and close its ledgers: `supabase/backout/retire-app-credentials.sql`. **If skipped:** the app can still reach the database during the rollback.
- **Steps (file's own steps 1–5; file step 1 is outside SQL):**
  1. a. After BO1, suspend the Render service `tnbs-recruiter-prod` (https://dashboard.render.com, not verified: exact button). Success: it shows suspended.
  2. a. File STEP 2: run `alter role recruiter_app nologin password null;` on its own (autocommit). Success: it commits; new logins now fail.
  3. a. File STEP 3: run the terminate query, then poll the `recruiter_app_backends` count once a second. Success: **0 three times in a row**. More than 60 seconds without that: **STOP** and tell the manager.
  4. a. File STEP 4: run the one transaction that revokes every live app credential. Success: it commits.
  5. a. File STEP 5: run the final checks. Success: all numbers 0.
- **Paste box:** the file's own text, unchanged, stage by stage.
- **Go-gate:** BO1 done; Hunter says "go for BO2".
- **Source:** doc 16 §3.3; doc 14 §11.5.

🔴 **BO3 — Identity alignment check (read-only)** — NOT APPROVED, needs its own go
- **What:** confirm `profiles.email = auth.users.email` for every approved profile (expected, because email edits were paused by B10). **If skipped:** the M1 backout could strand a profile. The first manager (B9) has no Auth user; doc 18 §5 says that profile cannot sign in to the old app, and giving Hunter the old password login back is a separate owner-approved Auth Admin step (decision for Hunter before cutover).
- **Steps:**
  1. a. Run the manager's reviewed read-only check. **GAP: no query text is recorded; the manager supplies it.** b. Report counts only.
- **Success check:** every approved profile matches, except the first manager row, which is named as a known exception in the report.
- **Go-gate:** BO2 done; Hunter says "go for BO3".
- **Source:** doc 16 §3.3; `docs/build-plan/18-first-manager-bootstrap.md` §5 (pending review).

🔴 **BO4 — `M1c-backout.sql`** — NOT APPROVED, needs its own go
- **What:** `supabase/backout/M1c-backout.sql` removes the new batch-delete function and restores the prior direct-delete grant while retaining the audit table. **Why:** restore the earlier delete interface before dismantling M1's permissions. **If skipped:** that new function and its dependency on the sign-in roles remain during the rest of backout.
- **Steps:** 1. a. Run the file unchanged. b. Confirm it commits.
- **Success check:** the file commits with no error.
- **Go-gate:** BO3 done; Hunter says "go for BO4".
- **Source:** doc 16 §3.3.

🔴 **BO5 — `M1b-backout.sql`** — NOT APPROVED, needs its own go
- **What:** `supabase/backout/M1b-backout.sql` removes the new manager add-person function and returns `profiles_id_fkey` as **NOT VALID** (people added stay; they cannot sign in to the old app). **Why:** restore the earlier profile-to-Auth relationship without deleting added people before backing out M1. **If skipped:** the add-person function and its M1 role dependency remain, and the earlier foreign-key relationship is not restored.
- **Steps:** 1. a. Run the file unchanged. b. Confirm it commits.
- **Success check:** the file commits with no error.
- **Go-gate:** BO4 done; Hunter says "go for BO5".
- **Source:** doc 16 §3.3; doc 18 §5 (pending review).

🔴 **BO6 — `M1-backout.sql`** — NOT APPROVED, needs its own go
- **What:** `supabase/backout/M1-backout.sql` restores the earlier permission model, removes the new sign-in interfaces and revokes the app role's membership and grants. Data is preserved (people added stay; batch-delete records stay). **Why:** the old frontend needs its earlier database permissions when traffic returns. **If skipped:** the new session-based permission model remains, so reopening the old frontend does not complete backout and old sign-in may fail.
- **Steps:** 1. a. Run the file unchanged. b. Confirm it commits.
- **Success check:** the file commits with no error; compare with the A3 snapshot in BO8.
- **Go-gate:** BO5 done; Hunter says "go for BO6".
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
  1. a. Open https://dashboard.render.com (not verified) and confirm the static site's live deploy is the one written down in B1. b. Load the site and do the read-only smoke test the manager provides (**GAP: not recorded**). c. Re-run the A3 snapshot file and compare numbers with the stored output (counts only).
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
- **What:** `supabase/backout/security-hardening-backout.sql` (this branch): re-grants EXECUTE on functions in `public` and `internal` to PUBLIC and `anon` and re-adds the matching default privileges, in one transaction. Run **after** BO6. Text-checked by `scripts/verify-hardening-backout-contract.mjs`; **never executed**. It does not undo the search_path pins or the `authenticated`/`service_role` grants. **Why:** only a separately approved rollback of July hardening needs these earlier EXECUTE grants. **If skipped when that rollback is required:** the July EXECUTE restrictions remain; ordinary M1 backout does not itself require BO10.
- **Steps:** 1. a. Run the file unchanged, first line to last. b. Confirm it commits.
- **Success check:** the file commits with no error.
- **Go-gate:** BO6 done; Hunter says "go for BO10".
- **Source:** the file header; Codex review "Backout SQL assessment".

Re-applying later uses `reapply-m1`, `reapply-m1b`, `reapply-m1c` (doc 16 §3.3) on staging only; **no production route is recorded (OPEN-1)**.

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

Nothing runs next. Hunter and the manager read this draft and answer five questions: how production SQL will be run (OPEN-1), whether the first-manager tool passes its review (OPEN-2), whether to declare a 14-day backout window (OPEN-3), when staging proof will be finished (OPEN-4), and whether the separate runtime and owner-only Doppler homes are confirmed (OPEN-5). After that, the manager resolves each step's gaps before asking for its individual go, starting with the read-only counts (A1). Cron retention stays blocked until C3's activation procedure is written and reviewed.

### Summary of Previous Step

Verified by reading the repo (nothing was run against any live system):
- The step order was corrected against the real router: while maintenance is on, everything except `/readyz` and `/healthz/db` returns 503 (`app/server/app.ts:566`). So the first manager is created in the database before maintenance comes off (B8, B9), the real sign-in test (C1) and the SendGrid webhook proof (C2) run after it (Part C), and the five issuance probes run before L1 (B12).
- L1 now repeats the recount after the second sweep (B13 stage 7).
- Runtime settings go through Doppler `truck-recruitment-tool` / `prd`; Render settings come from that config's sync and "Deploy latest commit". Owner-only `PRODUCTION_DB_URL` is isolated in proposed `truck-recruitment-tool-owner` / `prd`, never synced. A7's write key is removed immediately; the separate A7R reader copy stays in `truck-recruitment-tool/dev` through monitoring/backout and is removed only at K1.

Attempts / not verified: exact Supabase, Render, SendGrid, Doppler and Google Cloud page and button names; that Doppler config `prd` exists in that project; Render price today; the production probe subset and the commands for the GAP items; the first-manager tool (read only, under separate review, not merged).

### Miscellaneous

- Sources: docs 13, 14 (§3, §8.1, §11), 15 (§8, §32), 16 (§1–§4, §6, §7), 18 on branch `signin/first-manager-bootstrap` @ `e31dc29` (read only, pending review); release-path plan 2026-10-22 (thr_grum38j2d2); Quote-Queue `docs/M0_HOMEWORK.md` at 4059789845a52e355b747371752744ffd790e135 (read only); `C:\Users\hunte\.bb\BB Rules\doppler-render-playbook.md`.
- Doc 15 §6's env var names (for example `APP_BASE_URL`, `KEY_TOKENS`, `HEALTH_SECRET`) are older than the code; this runbook and the Render draft follow `app/server/config.ts` and doc 16 §2.3.
- Not decided here: SMS (future direction only), TOTP/passkeys (deferred), D8 approved, D10 open (OPEN-3).
- No secrets, project refs, hostnames or account ids appear in this file by design.
