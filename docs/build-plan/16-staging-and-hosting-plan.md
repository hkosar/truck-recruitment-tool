# 16 · Staging and hosting plan for `wave1/integration`

Status: **plan only.** Nothing in this document has been run, installed, created, bought,
pushed or changed on any hosted system. Written 2026-10-23 (UTC) by the sign-in owner. Every
step below needs its own "go" from Hunter (§5). Identifiers (project refs, URLs, service IDs)
are not repeated here; they live in doc 11 and the owners' dashboards.

**Branch state.** `origin/auth/same-origin-signin` is **pushed** at `4b76e0e`.
`wave1/integration` (the merge of readiness-test-fix, add-person, carrier-page polish,
batch-list and location-tables, plus the "New Search" label, M1c, the PostGIS fix, the dialog
focus fix and the OS-assigned HTTP test port) is **local only and NOT pushed**. Pushing it is
approval 1 in §5.

**What changes for hosting.** Today staging serves a static SPA from a Cloudflare Worker that
signs in with Supabase Auth passwords (doc 11). The target is one **Node server per
environment on Render** that serves the SPA, the sign-in pages and the API, with
email-link sign-in (docs 14/15) and the database reached through Supabase's pooler as the
`recruiter_app` login.

---

## 1 · Staging database

### 1.1 Current state (doc 11)

- One dedicated Supabase staging project (doc 10 option A, us-east-2), separate from
  production; the app is the static Worker described in doc 11.
- The fictional baseline (800 carriers, two batches) has been **used**: review sessions changed
  rows (batches, notes, status and do-not-contact changes). The one-time **staging identity
  marker** install adopts only rows that are provably the untouched baseline, so it now
  **refuses**, and doc 11 forbids editing it to force it. Without the marker, the gated reset
  and fixture cleanup also refuse. There is no approved way to adopt the used rows.
- Which migrations the staging ledger holds is **not recorded in the repo**. The four July
  migrations after the geocode queue (`20260722223300_security_hardening`,
  `20260723004500_profile_service_bootstrap`, `20260723010400_dnc_activity_enum_cast`,
  `20260723020000_contact_logs_dnc_guard`) are listed as unapplied **in production**
  (`scripts/verify-baseline-reconciliation.mjs`); M1, M1b and M1c depend on all four.

### 1.2 Clean-rebuild options

| Option | What | Cost | For | Against |
|---|---|---|---|---|
| **R1 (recommended)** | New staging project; replay all 20 migrations from the repo; fixtures; then M1, M1b, M1c. Pause the old project once R1 passes; delete it after production cutover | ~$10/month per running project (Supabase Micro compute ≈ $0.01344/hour; Pro includes $10 credit, per project billing). Old + new both running ≈ +$10/month until the old one is paused | The only option that gives the **real full replay** (§1.4 row 1); clean ledger; marker installs on a pristine baseline; old project kept as evidence | New ref: the staging runner and contracts pin the staging ref, so they need a reviewed commit with the new ref; app config changes |
| R2 | Wipe the existing project's public schema and replay | $0 extra | Keeps the ref | Destructive on a hosted DB; Auth users and storage stay behind; ledger history becomes misleading; not reversible |
| R3 | Adopt the used rows into the marker | $0 | — | No approved path (doc 11); weakens the fixture gate |
| R4 | Supabase preview branch (doc 10 option B) | billed per hour while it exists | Disposable | Branching ties to the production project's migration ledger, which is incomplete (doc 10) |

**R1 exact steps** (operator unless noted; each a separate "go"):

1. *Owner, read-only:* in the Supabase dashboard of the **old** staging project, open
   Database → Migrations and record the applied list (for the record only).
2. *Owner:* create project `truck-recruitment-tool-staging-2` in the same organization,
   region us-east-2, Micro compute, a generated database password kept in the owner's
   password manager (never in chat or the repo).
3. *Operator:* commit (reviewed) the new staging ref in the staging runner and the offline
   contracts (`pipeline/src/staging-sql-runner.ts`, `scripts/verify-staging-*.mjs`), plus
   **new runner actions** `apply-migrations`, `apply-m1`, `apply-m1b`, `apply-m1c`,
   `role-matrix-m1`, `snapshot` and the three backouts, each with the runner's existing guards
   (production refusal, exact staging ref, session port 5432, typed confirmation, dry run
   first). Doc 15 §8 already lists runner actions as the staging-slice tooling change.
4. *Operator:* dry run, then `--execute`: replay the 20 migrations in order, one
   transaction each, stopping on the first error; `scripts/verify-migration-baseline.mjs`
   checksums must match what ran.
5. *Operator:* fictional fixtures and the staging identity marker (doc 11 commands, new ref);
   expect `staging-sql.done`.
6. *Operator:* `snapshot` (the pre-cutover grant/policy snapshot, `supabase/backout/
   pre-cutover-snapshot.sql`) saved outside the repo.
7. Continue with §1.3.

### 1.3 Applying M1, M1b, M1c (staging only)

Order (each its own transaction through the runner, after step 6):

1. `supabase/pending/M1_same_origin_signin.sql`. It creates `recruiter_api` / `recruiter_app` /
   `recruiter_maintenance` **without passwords**, revokes app routines per routine (extension
   members are skipped), grants PostGIS to `recruiter_api`, pins search paths (adding the
   PostGIS schema when it is not `public`), and ends with the **PostGIS self-check** that
   executes spatial queries as `recruiter_api`. A failed self-check aborts M1 with nothing
   applied.
2. `supabase/pending/M1b_add_person.sql` (D8, approved).
3. `supabase/pending/M1c_batch_delete_audit.sql` (Hunter "yes", 2026-10-23).
4. *Owner (out of band):* set the `recruiter_app` password (`alter role … login password`)
   from the Supabase SQL editor; the value goes only into the Render staging environment.
5. *Read-only check:* `select extnamespace::regnamespace from pg_extension where extname =
   'postgis';` (records the placement; M1 handles either).

Backout on staging, for the rehearsal T-REPLAY: `retire-app-credentials.sql` →
`M1c-backout.sql` → `M1b-backout.sql` → `M1-backout.sql`, then compare with the step-6
snapshot (local A3 result: identical after normalization in the `public` placement), then
re-apply §1.3 1–4.

### 1.4 Real Supabase test matrix (what the local stand-ins could not prove)

The local A3 cluster is plain PostgreSQL 16 with text stand-ins for PostGIS, no pg_trgm or
citext, and no Supabase services. Hosted staging must prove:

| # | Test | Why local could not | How (staging) | Pass | Approval |
|---|---|---|---|---|---|
| 1 | Full migration replay | PostGIS, pg_trgm, citext were shimmed; PG 16 vs hosted PG 15 | R1 step 4 | every file applies; checksums match | R1 |
| 2 | Spatial self-check and app paths | Stand-ins, not PostGIS | M1's section 14 runs on real PostGIS; then the app's batch page, search, map pins, batch create/refresh, and the batch list's distance column, through the Render staging service | M1 commits; no `permission denied` / `does not exist` in Postgres logs | M1 on staging |
| 3 | Role matrix with real roles | Supabase's real `anon`/`authenticated`/`service_role` and default privileges | `role-matrix-m1` runner action (rollback-only) | 62/62 as locally | M1 on staging |
| 4 | RLS + grants vs hosted defaults | Platform grants differ from the shim | role matrix + `snapshot` diff before/after | no unexplained differences | same |
| 5 | Supavisor with the custom role | Not available locally | §2.5 probe | `recruiter_app.<ref>` connects through the shared pooler, session mode | A-probe (§2.5) |
| 6 | Hosted Auth endpoints, stateless | No GoTrue locally | A5a (doc 14 §8.1 class A): anon key only, no writes | as listed in doc 14 §8.1 | A5a |
| 7 | Hosted Auth endpoints, stateful + L1 | idem | A5b (class B), including the valid pre-cutover link tests L-a/L-b/L-c | all refused as specified | A5b, L1 |
| 8 | Client IP (T-IP) | No Render proxy locally | doc 15 §4.2 with a staging-only diagnostic endpoint | each client keyed to its real source; forged headers ignored | A5a |
| 9 | Graceful shutdown on Render (T-SHUTDOWN) | Local only | trigger a deploy during an in-flight sign-in request | response delivered; new requests refused cleanly | staging deploy |
| 10 | Mail end to end | Fake adapter locally | real send to an owner mailbox; signed webhook events update the send ladder | delivered event recorded; bad signature refused | SendGrid (§3) |
| 11 | Backout rehearsal (T-REPLAY) | Done locally only | §1.3 backout sequence + snapshot compare | identical after normalization | staging rehearsal |
| 12 | Log redaction (T-HYG) | No hosted logs | A7, §1.5 | zero canary hits | A7 |

### 1.5 Log-redaction gate A7 (T-HYG)

Before any production step: the harness runs every flow (request link, verify, confirm,
recovery if enabled, sign-out, webhook) with **canary values** (unique fake tokens, cookie
values and email markers). The owner (or an operator with read access the owner grants)
searches **Render service logs**, **Supabase Postgres and pooler logs**, and the **SendGrid
activity feed** for the canaries and reports **hit counts only**. Pass: zero hits everywhere.
Any hit blocks production until fixed and re-run.

### 1.6 L1 on staging (legacy Supabase Auth retirement)

Per doc 14 §11.6, its own approval, after §1.3 and after the owner turns Supabase Auth
providers off (O2): read the hosted JWT/OTP expiry settings (stop if unreadable), stop new
issuance, delete legacy refresh tokens and sessions, wait the derived interval W, then run the
A5b probes (refresh and `PUT /user` refused; L-a/L-b/L-c behave as specified). Staging is the
rehearsal for production L1. Rollback: L1 deletes only sign-in artefacts of the old system;
people sign in again (staging fixtures only).

---

## 2 · Hosting on Render

### 2.1 Verified pricing (render.com/pricing, read 2026-10-23T04:39Z, page HTML)

- Workspace plans: **Hobby $0/month + compute** (up to 25 services, 5 GB bandwidth included);
  **Pro $25/month + compute** (unlimited seats and services, 25 GB bandwidth); Scale
  $499/month; Enterprise custom. Bandwidth beyond the allowance: **$0.15 per GB**.
- Web service compute: **Free $0** (512 MB; spins down after 15 minutes idle, ~1 minute to
  wake, 750 free hours/month, "Do not use them for production", render.com/docs/free);
  **$7/month** (512 MB, less than 1 CPU); $25/month (2 GB, 1 CPU); $85/month (4 GB, 2 CPU).
- Billing is **prorated to the second**.
- `04-costs.md` (July) quoted 100 GB free bandwidth for a static site; the current Hobby
  allowance is 5 GB. Five internal users will not approach it, but the doc is out of date.

### 2.2 Services: two, not one (recommended)

**Two web services** in the existing Hobby workspace (the one that runs the production pipeline
job, per `render.yaml`): `tnbs-recruiter-staging` and `tnbs-recruiter-prod`.

Why not one: each environment has its own database, `APP_ORIGIN`, signing keys, SendGrid
webhook key and staging banner. One service cannot serve two origins against two databases
without mixing secrets, and staging must be deployable and breakable without touching
production.

Why Hobby: 2 web services + the existing cron fit under 25 services; bandwidth fits 5 GB.
Pro ($25/month) adds nothing this app needs now. **Hunter's call** (§5), since Render
positions Hobby for personal projects.

Plan size: **$7/month** (512 MB) for both. Free is unsuitable even for staging tests: the
~1-minute wake breaks the sign-in timing envelope and the shutdown test.

Monthly cost (compute only, from §2.1):
- **Minimal staging:** $7/month while it runs. Suspend it between test windows; per-second
  billing means a two-week test window costs about $3.50.
- **Production:** $7/month.
- **Both:** $14/month, plus the Supabase staging project (~$10/month) while it runs. No IPv4
  add-on (§2.6).

Create the two web services **in the dashboard**, not by editing `render.yaml`. Syncing that
Blueprint also manages the production pipeline cron, so changing it is its own reviewed step
at production cutover, together with retiring the old static-site entry.

Service settings (both): Node runtime; root `app`; build `npm ci && npm run build && npm run
build:server`; start `node dist-server/main.js`; region the Render region nearest Supabase
us-east-2 (Ohio; confirm in the dashboard); auto-deploy **off** for production (deploy by
hand from a reviewed commit).

### 2.3 Environment variables (names only; values set by the owner in the Render dashboard)

`APP_ORIGIN` · `DATABASE_URL` (the `recruiter_app` login via the shared pooler, session mode)
· `KEY_LINKS` · `KEY_SESSIONS` · `KEY_RATE` (three independent 32-byte random keys per
environment) · `EMAIL_MODE` · `SENDGRID_API_KEY` · `SENDGRID_FROM_ADDRESS` ·
`SENDGRID_FROM_NAME` · `SENDGRID_WEBHOOK_VERIFICATION_KEY` · `TRUSTED_PROXY_HOPS` (set
from T-IP; not trusted until it passes) · `HOST=0.0.0.0` (Render requires binding 0.0.0.0) ·
`PORT` (Render sets it; default 10000) · `STATIC_DIR` · `DB_ACQUIRE_TIMEOUT_MS` (optional) ·
`MAINTENANCE_MODE` (cutover) · `STAGING_BANNER` (staging only).
Staging and production never share a value.

### 2.4 Health check, graceful shutdown, client IP

- **Health check path:** the server has **no dedicated health route** today. Use `/signin`: a
  request without a session cookie (as Render's check sends) gets the form with 200, and if a
  session lookup fails the error is caught and the form is still shown
  (`app/server/app.ts` `signInPage`), so a database outage does not make Render restart
  healthy instances. Render counts 2xx/3xx as healthy, a 5-second timeout, removes an instance
  from traffic after 15 s of failures and restarts it after 60 s; a failing new deploy is
  cancelled after 15 minutes (render.com/docs/health-checks). A dedicated `/healthz` is an
  optional later code change.
- **Graceful shutdown:** on deploy Render sends SIGTERM 60 s after the new instance serves,
  then SIGKILL after the shutdown delay (**default 30 s**, settable up to 300 s with
  `maxShutdownDelaySeconds`; render.com/docs/deploys). The server drains on SIGTERM with a
  **45 s** budget (`app/server/main.ts`). Set **`maxShutdownDelaySeconds: 60`** on both
  services, or the drain is cut at 30 s. T-SHUTDOWN (§1.4 row 9) verifies it on staging.
- **Client IP (T-IP):** Render's docs say its load balancer terminates TLS and forwards over
  HTTP but do not document the forwarding header chain. `TRUSTED_PROXY_HOPS` stays `0` and the
  per-IP limit is "unverified" until T-IP passes (doc 15 §4.2). Repeat T-IP if a custom domain
  or CDN is added.

### 2.5 Supabase pooler connectivity with the custom role

From the docs (supabase.com/docs/guides/database/connecting-to-postgres, read 2026-10-23):
"If you connect as a custom role through the shared pooler, the username is
`[ROLE].[PROJECT-REF]`." Port 5432 is session mode on the shared pooler; 6543 is transaction
mode. Transaction mode does not support prepared statements. The server sets its session
values with `SET LOCAL` / `set_config(…, true)` inside each transaction and uses no named
prepared statements (`app/server/db/database.ts`), and the runner already requires 5432, so
**use session mode (5432)**; the shared pooler's session-mode connection limit is checked in
the A-probe. This settles doc 14's open item E16 (Supavisor accepts custom
roles) from documentation.

Minimal authorized probe (staging, after §1.3 step 4, approval "A-probe"):
1. From the Render staging service shell, or the owner's machine, connect with `psql` using
   the shared-pooler session-mode string with user `recruiter_app.<staging-ref>`.
2. Run `select current_user, current_setting('server_version_num')` only.
3. Pass: `recruiter_app` and a version; nothing else is run. Fail: record the exact error and
   stop. No data is read or written.

### 2.6 IPv4 add-on: not needed

Supabase direct connections are IPv6 (IPv4 only with the add-on), but "the shared pooler is
IPv4-only on every plan, in both session and transaction mode"
(connecting-to-postgres, read 2026-10-23). The app uses the shared pooler, so the add-on is
**not needed**. Verified price if it ever were: **$0.0055 per hour (~$4 per month)**, Pro plan
and up (supabase.com/docs/guides/platform/manage-your-usage/ipv4 and
.../platform/ipv4-address, read 2026-10-23).

---

## 3 · SendGrid (Quote-Queue's account), owner click-steps

Capacity is **plan-dependent and not published**. SendGrid's changelog (effective 2023-05-03):
"The number of endpoints per user is dependent on the TSG plan you are on"; the API field
`max_allowed` is "the maximum number of Event Webhooks you can have enabled under your current
Twilio SendGrid plan" (twilio.com/docs/sendgrid/api-reference/webhooks/get-all-event-webhooks,
read 2026-10-23). The owner confirms capacity in step B below before anything else.

A. **Send-only key** (once per environment). Settings → API Keys → Create API Key → name
   `tnbs-recruiter-staging-send` → **Restricted Access** → Mail Send: **Full Access**, all
   else **No Access** → Create & View → paste the value straight into Render staging
   `SENDGRID_API_KEY` (never into chat, email or a file). Success: the key list shows the new
   name with restricted access.
B. **Capacity check.** Settings → Mail Settings → Event Webhooks. If creating another
   webhook is not offered, or SendGrid says the plan maximum is reached, **stop** and tell the
   manager: the options are then a plan change (cost to be verified) or a reviewed design
   change. Do not repurpose Quote-Queue's webhook.
C. **Second Event Webhook** (staging first). Create new webhook → Friendly name
   `tnbs-recruiter-staging` → Post URL = staging origin + `/webhooks/sendgrid` → events:
   Processed, Delivered, Deferred, Dropped, Bounced, Spam Reports (the events the app maps;
   leave open/click tracking off) → Save → open it again → enable **Signed Event Webhook**
   → copy the verification key into Render staging `SENDGRID_WEBHOOK_VERIFICATION_KEY` →
   use "Test Your Integration". Success: the staging log shows a verified webhook event;
   a tampered request is refused (§1.4 row 10).
D. **Sender.** Settings → Sender Authentication: pick an address on a domain Quote-Queue has
   already authenticated (no DNS change). Put it in `SENDGRID_FROM_ADDRESS`, the display name
   in `SENDGRID_FROM_NAME`.
E. Production repeats A–D with `-prod` names at the production step, never sharing keys.

---

## 4 · Ownership, rollback, teardown, production cutover

### 4.1 Who runs each step, and its rollback

| Step | Runs it | Rollback |
|---|---|---|
| Push `wave1/integration` (for review / Render deploys) | operator | revert or delete the remote branch (no production effect) |
| R1 new staging project | owner (create), operator (runner) | pause/delete the new project; old project untouched |
| Runner ref + actions commit | operator, reviewed | git revert |
| Migrations replay + fixtures + marker | operator via runner | delete and recreate the new project (staging only) |
| M1 / M1b / M1c on staging | operator via runner | backouts in §1.3 (rehearsed) |
| `recruiter_app` password | owner | `retire-app-credentials.sql` (NOLOGIN) |
| Render staging service + env | owner | suspend or delete the service |
| SendGrid staging key + webhook | owner | delete the key; disable the webhook |
| A-probe, A5a, T-IP | operator (A5a/T-IP) / owner (shell access) | none needed (read-only / no data) |
| A5b, O2 providers off, L1 on staging | owner (O2), operator (L1, A5b) | O2: providers back on; L1 is one-way for legacy sessions (staging fixtures only) |
| A7 log gate | owner or delegated operator | none (search only) |
| Production steps | §4.3 | §4.3 |

### 4.2 Teardown of staging and its cost

- Render staging service: **suspend** between test windows (billing is per second); delete
  after production is stable. Cost stops at suspension.
- New Supabase staging project: keep paused (pausing stops compute billing) when idle; keep
  for regression tests while the app changes; deleting stops billing.
- Old staging project and the old Cloudflare Worker: pause the project after R1 passes; delete
  both after production cutover is accepted. The Worker's cost is not recorded in the repo
  (owner checks the Cloudflare plan); deleting it removes a stale URL.
- SendGrid staging key and webhook: delete when staging is retired.
- Total staging run-rate while active ≈ **$17/month** ($7 Render + ~$10 Supabase), $0 when
  suspended/paused.

### 4.3 Production cutover and backout window

Order (each its own "go"; doc 14 §11.2 adapted to Render, doc 12 kept separate):

1. Read-only production inventory (O1) and decisions D7/unique index; **the four July
   migrations** reviewed and applied to production as their own change (doc 12 item 3) if they
   are still unapplied; pre-cutover snapshot (read-only).
2. Production Render service created, suspended, env set (§2.3), SendGrid prod key/webhook
   (§3 E).
3. Maintenance on (`MAINTENANCE_MODE`) → **M1 → M1b → M1c** (self-check must pass) →
   `recruiter_app` password → deploy the reviewed commit → owner turns Supabase Auth providers
   off (O2) → **L1** (own approval) → probes (A5a/A5b subset) → **T-HYG/A7** → T-IP →
   maintenance off → first manager signs in. **The backout window opens.**
4. Backout (rehearsed on staging): maintenance on → `retire-app-credentials.sql` →
   `M1c-backout` → `M1b-backout` → `M1-backout` → snapshot compare → previous app path. Data
   is preserved (people added stay; batch-delete records stay).
5. **D10 (still unapproved) gates the window itself:** the email-edit freeze rules in M1
   (`internal.backout_window`) exist, but whether a window is declared, how long it lasts, and
   who closes it are undecided. Until D10 is decided, the production cutover cannot be
   scheduled: the runbook needs a declared window (recommended: 14 days, closed by Hunter), and
   email edits stay paused while it is open. Adds are not frozen (D8 superseded that part).

---

## 5 · Approvals Hunter must give, in order

Each line: the approval · recommended answer · cost.

1. Push `wave1/integration` to GitHub for review and deploys · **yes** · $0.
2. Staging rebuild option · **R1 (new staging project)** · ~$10/month while running; $0 paused.
3. Runner ref + migration/M1 actions commit (reviewed) · **yes** · $0.
4. Replay migrations + fixtures + marker on the new staging project · **yes** · $0 extra.
5. Apply M1, M1b, M1c on staging, and set the `recruiter_app` password · **yes** · $0.
6. Render workspace plan · **stay on Hobby** · $0 (Pro would be $25/month).
7. Render staging web service, $7 plan, `maxShutdownDelaySeconds: 60` · **yes, suspended
   between test windows** · ≤ $7/month, prorated.
8. Pooler probe with the custom role (A-probe) · **yes** · $0.
9. SendGrid staging: send-only key, capacity check, second webhook, sender (§3 A–D) · **yes,
   stop if capacity is full** · $0 if capacity exists.
10. A5a stateless probes + T-IP on staging · **yes** · $0.
11. O2 providers off + A5b + L1 on staging · **yes** · $0.
12. Staging backout rehearsal (T-REPLAY) · **yes** · $0.
13. A7 log search (grant log access or run it) · **yes** · $0.
14. Hunter's 5-minute staging walkthrough · **yes** · $0.
15. **D10:** declare a backout window · **yes, 14 days, closed by Hunter; email edits paused
    while open** · $0.
16. Production: the four July migrations as a separate change (doc 12) · **yes, if the
    inventory shows them unapplied** · $0.
17. Production Render web service, $7 plan · **yes** · $7/month.
18. SendGrid production key + webhook · **yes** · $0 if capacity exists.
19. Production cutover (§4.3 step 3), including O2 and L1 · **yes, in a scheduled window** ·
    $0.
20. Teardown: pause the old staging project and delete the Cloudflare Worker after production
    is accepted · **yes** · saves ~$10/month.

Steady-state cost after cutover: **$7/month** (production Render) + **$7/month** if the staging
service stays on + **~$10/month** if the staging project stays running. No IPv4 add-on.

## Sources (read 2026-10-23, UTC)

- https://render.com/pricing (page HTML: plans, compute prices, bandwidth, per-second billing)
- https://render.com/docs/free · https://render.com/docs/deploys ·
  https://render.com/docs/health-checks · https://render.com/docs/web-services
- https://supabase.com/docs/guides/database/connecting-to-postgres (pooler modes, IPv4,
  custom-role username, prepared statements)
- https://supabase.com/docs/guides/platform/ipv4-address ·
  https://supabase.com/docs/guides/platform/manage-your-usage/ipv4 ·
  https://supabase.com/docs/guides/platform/manage-your-usage/compute
- https://www.twilio.com/en-us/changelog/event-webhooks ·
  https://www.twilio.com/docs/sendgrid/api-reference/webhooks/get-all-event-webhooks ·
  https://www.twilio.com/docs/sendgrid/api-reference/webhooks/create-an-event-webhook ·
  https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/event
- [repo] docs 10, 11, 12, 14, 15; `render.yaml`; `app/server/config.ts`; `app/server/main.ts`;
  `scripts/verify-baseline-reconciliation.mjs`.
