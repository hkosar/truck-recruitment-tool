# 16 · Staging and hosting plan for `wave1/integration`

Status: **plan only.** Nothing in this document has been run, installed, created, bought,
pushed or changed on any hosted system. Written 2026-10-23 (UTC) by the sign-in owner;
revision 2 after the plan review (Codex, of `9befc35`), revision 3 after its re-review (of
`a5a4171`); both in §9. Every step needs its
own "go" from Hunter (§6). Identifiers (project refs, URLs, service IDs, keys) are not repeated
here; they live in doc 11 and the owners' dashboards.

**Branch state.** `origin/auth/same-origin-signin` is **pushed** at `4b76e0e`.
`wave1/integration` (readiness-test-fix, add-person, carrier-page polish, batch-list,
location-tables, the "New Search" label, M1c, the PostGIS fix, the dialog focus fix, the
OS-assigned HTTP test port, and this document) is **local only and NOT pushed**. It is pushed
**once**, after the reviewed code items of §5 are on it (approval 3).

**What changes for hosting.** Today staging serves a static SPA from a Cloudflare Worker that
signs in with Supabase Auth passwords (doc 11). The target is one **Node server per
environment on Render** that serves the SPA, the sign-in pages and the API, with email-link
sign-in (docs 14/15), and reaches the database through Supabase's shared pooler as the
`recruiter_app` login.

---

## 1 · Staging database

### 1.1 Current state (doc 11)

- One dedicated Supabase staging project (doc 10 option A, us-east-2) in the paid (Pro)
  organization, separate from production; the app is the static Worker described in doc 11.
- The fictional baseline (800 carriers, two batches) has been **used**: review sessions changed
  rows. The one-time **staging identity marker** install adopts only rows that are provably the
  untouched baseline, so it now **refuses**, and doc 11 forbids editing it to force it. Without
  the marker, the gated reset and fixture cleanup also refuse.
- Which migrations the staging ledger holds is **not recorded in the repo**. The four July
  migrations after the geocode queue (`20260722223300_security_hardening`,
  `20260723004500_profile_service_bootstrap`, `20260723010400_dnc_activity_enum_cast`,
  `20260723020000_contact_logs_dnc_guard`) are listed as unapplied **in production**
  (`scripts/verify-baseline-reconciliation.mjs`); M1, M1b and M1c depend on all four.

### 1.2 Costs and retention of Supabase projects (corrected)

- Micro compute is about **$10/month per running project** ($0.01344/hour). Paid plans include
  **$10 of compute credit per organization**, not per project, so each extra project adds its
  full compute cost (supabase.com/docs/guides/platform/manage-your-usage/compute).
- **Projects in a paid organization cannot be paused.** Pausing requires first transferring the
  project to a Free-plan organization; a paused project can be restored for up to one year
  (supabase.com/docs/guides/platform/free-project-pausing). Deleting a project stops its
  billing.
- So an idle staging project in the Pro organization costs ~$10/month. The only $0 states are
  **deleted**, or **transferred to a Free organization and paused** (an organization-level
  change, its own approval). The old staging project already costs ~$10/month today.

### 1.3 Clean-rebuild options

| Option | What | Cost | For | Against |
|---|---|---|---|---|
| **R1 (recommended)** | New staging project; replay all 20 migrations; fixtures; then M1, M1b, M1c. **Delete** the old project only after the backout rehearsal on the new project passes (fictional data only; its migration list is recorded first) | +$10/month only while both exist; after the old one is deleted, the same as today (~$10/month) | The only option with the **real full replay** (§1.5 row 1); clean ledger; the marker installs on a pristine baseline | New ref: the runner and contracts pin the staging ref (reviewed commit, §5 item 1) |
| R2 | Wipe the existing project's public schema and replay | $0 extra | Keeps the ref | Destructive on a hosted DB; Auth users and storage stay; misleading ledger; not reversible |
| R3 | Adopt the used rows into the marker | $0 | — | No approved path (doc 11) |
| R4 | Supabase preview branch (doc 10 option B) | per hour while it exists | Disposable | Branching ties to the production ledger, which is incomplete (doc 10) |

**Retention choice for staging after production cutover** (approval 25): (a) keep the new
staging project running for regression tests, ~$10/month; (b) delete it and rebuild with R1
when needed, $0; (c) transfer it to a Free organization and pause it, $0, restorable for a year.
**Recommended: (a) during the first month after cutover, then (b).**

**R1 exact steps** (operator unless noted; each a separate "go"):

1. *Owner, read-only:* in the **old** staging project, Database → Migrations: record the
   applied list (evidence only).
2. *Owner:* create project `truck-recruitment-tool-staging-2` in the same organization, region
   us-east-2, Micro compute; the database password goes to the owner's password manager only.
   **Done:** the project exists (confirmed from the owner's dashboard: region us-east-2, Micro compute, healthy)
   and its ref is recorded in `pipeline/src/target-guard.ts` (the reviewed commit of step 3); the runner refuses
   any other ref.
3. *Operator:* the reviewed tooling commit (§5 item 1): new staging ref, and runner actions
   `environment-preflight`, `ledger-preflight`, `apply-migrations`, `apply-m1`, `apply-m1b`, `apply-m1c`, `role-matrix-m1`, `snapshot`,
   `window-on`, `window-off`, `retention-dry-run` and the three backouts, all with the runner's
   existing guards (production refusal, exact staging ref, session port 5432, typed
   confirmation, dry run first).
4. *Operator:* first the **environment preflight**, then the **ledger preflight**.
   *Before the ledger preflight, the read-only environment preflight* (`environment-preflight`, dry run then
   `--execute`, confirmation `RUN TNBS ENVIRONMENT PREFLIGHT`). The creation screen pre-selects three
   switches (Data API, "Automatically expose new tables", "Enable automatic RLS") whose values the owner does
   not know. **SQL cannot establish those switches**, so they are owner dashboard checks with a STOP gate (the
   owner reads each setting on its dashboard page, under reviewed instructions, and reports the value to the
   manager; a setting the owner cannot find or read is a STOP). The runner adds only catalogue facts, as the
   actual runner login and read-only, printed as identifiers, enumerated words, booleans and counts, never
   passing or failing anything: (a) the complete event-trigger count and, up to 50, each trigger's name, event,
   enabled state and function name, with `truncated` when the list is cut off (zero is a valid result; nothing is
   inferred from function text, since a body can call a helper, build its statement from pieces or only mention
   the words in a comment; every listed trigger needs an explicit human assessment, a name alone verifies
   nothing); (b) for objects this login creates, the full set of privilege types in the login's explicit
   default-ACL entries for `anon`, `authenticated`, `service_role` and `PUBLIC` on tables, sequences and
   functions, in schema `public` and globally, whether any entry is grantable, the entry count, and how many
   entries fall outside those cells (implicit defaults, such as EXECUTE on functions for PUBLIC when no entry
   exists, and the effective access of existing objects are NOT visible there and are not reported); (c) how
   many `pgrst.db_schemas` settings exist on the `authenticator` role (role-wide and for this database) and,
   only when exactly one exists, whether it names `public`, otherwise `"unknown"`; this is a fact about that
   setting and is explicitly not the Data API switch or the exposed-schema list the running API uses.
   Expected values, from the reviewed migrations, for the manager's comparison only:
   `20260720001500_service_role_pipeline_grants.sql` grants `service_role` table DML, sequence USAGE+SELECT and
   function EXECUTE by default in `public` for the executing creator (explicit entries need not exist before
   that file runs); `20260722223300_security_hardening.sql` revokes existing PUBLIC/anon function access and
   attempts a schema-specific default revocation; `20260720001200_rls.sql` states that RLS gates tables and relies
   on the platform default for table access, while also containing explicit column UPDATE and view SELECT
   grants. So the legacy rehearsal frontend (approval 5) needs the owner-confirmed dashboard setting
   "Automatically expose new tables" and the Data API listing `public`; that is an approval-5 prerequisite and
   not proof that either is on now. An automatic-RLS helper is a conservative policy question, not something the
   migrations prove must be absent. **Manager PASS gates, each with its remedy owner:** every listed event
   trigger and each of the three owner-confirmed switch values is assessed and recorded; a deferral to approval 5
   must be written down before PASS (no `--execute` that writes runs before the manager records PASS or a
   recorded deferral of the approval-5-only items); only the owner changes a dashboard switch, and the operator
   never alters default privileges.
   Then the ledger preflight:
   (`ledger-preflight`, dry run then `--execute`):
   a read-only catalogue assessment, as the actual runner login, of
   `supabase_migrations.schema_migrations`. The contract is exact and narrow, and every point is something
   the replay's own statements need (`create schema if not exists`, `create table if not exists`, two
   unconditional `alter table ... add column if not exists`, and one `insert` per file): `public.profiles`
   is absent; the login has CREATE on the database (PostgreSQL checks this before `IF NOT EXISTS`, so it is
   needed even when the schema exists); if the schema exists but the table does not, USAGE and CREATE on the
   schema; if the table exists: it is an ordinary table **owned by the runner login itself** (the `alter table`
   needs ownership even when the columns already exist; membership in the owner role is not accepted), it has
   **only** the columns `version` (`text not null`), `statements` (`text[]`, or absent) and `name` (`text`,
   or absent), none of them with a default, identity or generation, `version` is its sole primary/unique key,
   there is no other constraint, index, trigger, rule or row-level security, the login can select and
   insert, and the ledger is empty. Anything outside this (an extra column even with a default, a
   different owner) is a stop for a human, not something the tool tries to accept. It prints only fixed
   check names, true/false and counts. Any failed or unreadable check is a stop.
   **The manager records an explicit PASS before the replay's
   `--execute`; on any failure or uncertainty the replay does not run and nothing is bypassed.** The
   replay repeats the same assessment in its own session and refuses on any failed check. (The tool does not
   verify a manager message: the PASS is a procedural gate.) Locally, for every one of 34 catalogue
   scenarios the real initialization and a ledger insert are run as the same low-privilege login: a PASS is
   never followed by a failure there (`pipeline/src/ledger-preflight-a3.test.ts`). The hosted ledger and
   login are still unverified until the preflight runs against the real project. Then dry
   run, then `--execute`: replay the 20 migrations in order, one transaction each, stopping on the
   first error; checksums as `scripts/verify-migration-baseline.mjs`. After the last file the tool
   reads the ledger back and requires exactly the 20 reviewed (version, name) pairs in order
   (names are the file name without the timestamp and `.sql`), printing
   `staging-sql.ledger_verified` with counts and `exact_match`; a wrong or missing pair fails the run.
   *Secret input and output:* run every hosted runner command through `scripts/run-with-secrets.mjs`, which takes
   the database URL (and, for `scripts/seed-auth-users.ts`, the service-role key and the fixture
   password) from a hidden prompt, passes it to the child process environment only, and shows **only a fixed
   allow-list of the child's output**: an enumerated list of `staging-sql.*` events, each with fixed keys
   whose values must fit that key's own pattern or enumerated list; a failure is shown only as an identifier from
   the runner's fixed refusal list (`pipeline/src/refusals.ts`) plus a validated SQLSTATE/driver code, and the
   runner never forwards message text (a server message that merely begins like a known refusal is generic); the
   seeding script's exact progress lines; and one closing line with the exit code, the number of output lines
   withheld and the number of fields (keys or values inside an accepted line) withheld. Everything else (driver
   errors, stack traces, server messages) is withheld and only counted. The owner never pastes raw output: the
   owner reports fixed labels only (PASS/FAIL, event and check names, counts, the exit code), and continues only
   when both withheld counts are 0. This is a filter, not a proof that nothing sensitive can reach the screen.Masking of the secret and its
   URL-encoded and host/user/password forms is applied as defense in depth only; it cannot catch a fragment,
   another encoding or a value split across lines, and the procedure does not rely on it. Limits: the secret
   is in the child process environment (readable by the child and by local tools with enough rights), the
   terminal's own scrollback and clipboard history are outside the tool, and the hidden prompt was tested only
   with a fake terminal in code; the operator checks it once in the real PowerShell window before any hosted
   use (a Git Bash window that hands Node a pipe instead of a terminal makes the tool refuse safely).
   A failure whose cause is not visible in the allow-list is diagnosed by the operator at the terminal or
   by a dry run, never by the owner pasting output.
5. *Operator:* fictional fixtures, the staging identity marker and the hosted Auth fixture
   accounts for A5b (doc 11 commands, new ref), in their supported order (profile fixtures, then
   the marker, then the owner login, then the reset, then the Auth fixtures); expect `staging-sql.done`.
   **Owner login (G1; between the marker and the reset).** The reset requires, as separate checks, exactly one
   auth account with a password, exactly one approved manager profile for the owner's email and seven fixture
   profiles; nothing there proves the first two are the same account. The reviewed bootstrap (`pipeline/src/owner-bootstrap.ts`,
   Codex option 1) makes them one account in two separate commits, and any failure or unknown result **stops** for a
   read-only reconciliation; nothing is deleted or re-created automatically:
   (1) `owner-login-check` (read-only; confirmation `RUN TNBS OWNER LOGIN CHECK`) must report `no_owner_login`;
   (2) `owner-auth-create` (confirmation `CREATE TNBS STAGING OWNER LOGIN`; `--project=rebuilt`; no database login, secrets
   `SUPABASE_SERVICE_ROLE_KEY` and `OWNER_STAGING_PASSWORD` through the hidden prompt) makes ONE supported Auth Admin
   create-user request, with the email confirmed and no invitation or message, for exactly the approved owner email at
   the address derived from the recorded rebuilt ref; it is created only on a 2xx whose body names that email and an id,
   a definite rejection (400, 401, 403, 404, 409, 422) is "not created", and everything else (5xx, a dropped connection,
   a timeout, a redirect, a body that does not match) is "unknown"; none is retried; the existing trigger then creates a
   pending guest profile; (3) `owner-login-check` must now report `ready_to_promote`; (4) `owner-promote`
   (confirmation `PROMOTE TNBS STAGING OWNER`) runs one transaction: transaction-local service-role claim (the reviewed
   `auth.role()` pattern; connecting as a privileged SQL role is not what the guard checks), row locks on the exact auth
   user and its profile, every pre-check (staging marker names this project; exactly one auth user with the approved email,
   with a non-empty password and confirmed email, not SSO/anonymous; it is the only password account; auth users are
   the owner plus the seven fixtures; exactly one joined profile with the same email that is still a pristine pending
   guest; exactly seven passwordless fixture profiles; no other profile; no approved manager profile for the owner yet),
   then updates only that profile (`manager`/`approved`, approved by itself, timestamp), then requires the joined
   postconditions before committing; (5) `owner-login-check` reports `promoted`. A refused or failed promotion
   rolls back and leaves the account pending and unable to enter the app; a failed commit is reported as `unknown` and
   needs `owner-login-check` before anything else. Proved locally on a real PostgreSQL 16 database
   (`pipeline/src/owner-bootstrap-a3.test.ts`, 28 checks) and, for the Auth call, against a local fake HTTP server only
   (`pipeline/src/smoke-tests.ts`). **Not verified:** the hosted Auth API's actual behaviour and response, the hosted
   auth schema (for example `auth.identities`), the hosted runner login's privileges on `auth.users`, and that the
   resulting password can sign in (login is proven in a later approved phase).
   **The 12 eligible T-SHUTDOWN fixture identities (§1.5 row 10) are NOT part of this step.**
   `supabase/staging/rebuild/install-shutdown-fixtures.sql` requires `team_add_person` (M1b) and
   `batch_delete` (M1c) and refuses until M1, M1b and M1c are applied, and §1.4 applies them
   later, under the separately approved approval 6. So the shutdown fixtures are installed only
   **after** §1.4 steps 1–3 have completed, as an operator follow-up whose authorization the
   manager records (there is no separate numbered approval line for it); running M1 early to
   satisfy this step is not allowed. Removing the shutdown fixtures accepts exactly those 12
   identities or none (nothing installed is a no-op); any other count, such as 11, or a stray
   identity in the reserved range is refused and rolls back.
6. *Operator:* `snapshot` (`supabase/backout/pre-cutover-snapshot.sql`), stored outside the
   repo. It is read-only but has no numbered approval line in §6: it is an operator follow-up
   whose authorization the manager must record before it runs (it must be taken before M1).
7. **Legacy rehearsal frontend (approval 5).** The backout returns users to the old app, so the
   rehearsal needs the old app **pointed at the new project**. The operator builds the pre-cutover
   SPA (the commit the current staging Worker serves, doc 11) with the **new** staging project's
   URL and public anon key, and the owner deploys it as a **separate, isolated** Cloudflare
   Worker (`tnbs-carrier-recruiter-staging-legacy`), leaving the current Worker untouched.
   **Prove the configuration before M1:** (a) the built bundle contains the new staging ref and
   neither the old staging ref nor the production ref (operator search of the build output);
   (b) the page's staging header shows the new ref; (c) a staging fixture signs in with its
   password, opens a batch and logs a test call. This is the baseline the backout must restore.
8. Continue with §1.4.

### 1.4 Applying M1, M1b, M1c (staging)

1. `supabase/pending/M1_same_origin_signin.sql`. It creates `recruiter_api`,
   `recruiter_app` and `recruiter_maintenance` **without passwords**; revokes app routines per
   routine (extension members are skipped); grants PostGIS to `recruiter_api`; pins search paths
   (adding the PostGIS schema when it is not `public`); and ends with the **PostGIS self-check**
   that executes spatial queries as `recruiter_api`. A failed self-check aborts M1 with nothing
   applied.
2. `supabase/pending/M1b_add_person.sql` (D8, approved).
3. `supabase/pending/M1c_batch_delete_audit.sql` (Hunter "yes", 2026-10-23).
   After these three have completed, the T-SHUTDOWN fixtures (§1.3 step 5) may be installed.
4. *Owner (out of band, Supabase SQL editor):* set the `recruiter_app` password (LOGIN) and,
   separately, the `recruiter_maintenance` password (LOGIN). Each value goes only to the Render
   variable that uses it (§2.3 and §4).
5. *Read-only:* `select extnamespace::regnamespace from pg_extension where extname =
   'postgis';` (records the placement; M1 handles either).

### 1.5 Hosted test matrix (what the local stand-ins could not prove)

The local A3 cluster is plain PostgreSQL 16 with text stand-ins for PostGIS, no pg_trgm or
citext, and no Supabase services.

| # | Test | Why local could not | How (staging) | Pass |
|---|---|---|---|---|
| 1 | Full migration replay | PostGIS, pg_trgm, citext were shimmed; PG 16 vs hosted PG 15 | R1 step 4 | every file applies; checksums match |
| 2 | Spatial self-check and app paths | stand-ins | M1 section 14 on real PostGIS; then batch page, search, map pins, batch create/refresh, batch-list distance column through the staging service | M1 commits; no `permission denied` / `does not exist` in Postgres logs |
| 3 | Role matrix with real roles | real `anon`/`authenticated`/`service_role` and defaults | `role-matrix-m1` (rollback-only) | 62/62 |
| 4 | RLS + grants vs hosted defaults | platform grants differ from the shim | role matrix + `snapshot` diff | no unexplained differences |
| 5 | Pooler, custom role, connection budget, isolation, timing | not available locally | §2.6 probe | all §2.6 criteria |
| 6 | Hosted Auth, stateless | no GoTrue | **A5a** (doc 14 §8.1 class A) | as in doc 14 §8.1 |
| 7 | Hosted Auth, stateful | idem | **A5b** (class B) | as in doc 14 §8.1 |
| 8 | Legacy credentials retired | idem | **L1** (§1.8), then its A5b probes incl. L-a/L-b/L-c | refused as specified |
| 9 | Client IP (T-IP) | no Render proxy | doc 15 §4.2, staging-only diagnostic endpoint | each client keyed to its real source |
| 10 | Graceful shutdown (T-SHUTDOWN) | local only | **Bounded, synchronized bursts, every limit kept** (`rate.ts`: 20 requests per IP per 15 min; `ladder.ts`: 1 link/min, 5/hour, 10/day per person and the 2-minute courtesy). Fixtures: **12 distinct eligible staging fixture identities** reserved for this test (added in the §5 item 1 tooling commit). One attempt = one burst of **6 requests, one per fixture, sent at the same moment** from one client, using only fixtures with no link in the last 2 minutes and under their hour/day ceilings; then, **300 ms into the ~880 ms response envelope** (the window the local test uses), the operator sends SIGTERM to the server process from the Render shell of the staging instance (availability on the $7 plan to be confirmed; without it the test is reported as not run, not passed). A deploy is **not** the trigger: Render signals the old instance about 60 s after traffic moves, when its work has normally finished. At most 3 attempts per 15 minutes (18 requests, under the IP ceiling), alternating the two fixture sets of 6, attempts **at least 5 minutes apart** (no fixture reused inside its 2-minute courtesy or 1-per-minute ceiling), **at most 8 attempts per hour** (each fixture at most 4 times per hour, under its 5) and each fixture at most 10 times per Chicago day | **Pending at SIGTERM:** `shutdown_started` (§5 item 4) reports the burst's requests as accepted and their continuations not yet complete. **Correlated completion:** before the burst the operator records each fixture's newest link id; afterwards **exactly one new link row per fixture** in the burst exists and each records `send_status = 'accepted'`; the count of minted links equals 6, and `shutdown` reports `abandoned: 0`; every HTTP response of the burst arrived (303). A fixture with no new link means a limit or courtesy was hit, so the attempt is **invalid** (fixture selection error), not a pass. An attempt where the SIGTERM landed after the work completed (`shutdown_started` shows nothing pending) is **inconclusive** and is repeated within the bounds above, never counted as a pass |
| 11 | Deploy readiness gate | no Render | §2.5: deploy with a deliberately wrong database password | the deploy never becomes ready and is cancelled; the old instance keeps serving |
| 12 | Mail end to end | fake adapter | real send to an owner mailbox; signed webhook | delivered event recorded; bad signature refused |
| 13 | Backout rehearsal (T-REPLAY) | SQL-only locally | §3.3 on staging | snapshot identical **and** an old-app fixture signs in and logs a call |
| 14 | Log redaction (T-HYG) | no hosted logs | **A7**, §1.6 | per-sink rule, §1.6 |
| 15 | Retention least privilege | no hosted roles | §4 | as in §4 |

### 1.6 Log-redaction gate A7 (T-HYG), per sink

**Flows run** (doc 14 T-HYG contract, unchanged): request link, verify, confirm, sign-out,
**`/api/*` calls**, the webhook, and the **forced error paths**: a statement error and a lock
timeout while `app.session_hash` is set, a malformed bind, and a bad webhook signature. The
recovery-code (backup-code) paths stay **disabled** (D2); the run checks they are refused.

**Canaries.** Credential canaries: the raw session cookie, the session hash, the link token and
link URL, the confirm nonce and CSRF values, the recovery pre-token, the webhook payload
signature. Metadata canaries: unique fixture recipient addresses.

| Sink | Searched by | Credential canaries | Recipient metadata |
|---|---|---|---|
| Render service logs (staging) | owner, or operator with granted read | **0 hits** | 0 raw addresses (the app logs event names and categories only) |
| Supabase Postgres logs, normal and error (incl. statement-error text) | owner / operator | **0 hits** (bind values must not be logged) | 0 hits |
| Supabase pooler logs | owner / operator | **0 hits** | 0 hits |
| SendGrid Email Activity (To, From, Subject, Message ID, events) | owner | **0 hits** in any visible field (click tracking off, so links are not rewritten) | **expected**: the recipient address and subject are provider metadata and are allowed |

Results are reported as hit counts only. Any credential-canary hit, or a recipient address in
the first three sinks, blocks production until fixed and re-run.

### 1.7 Backout targets

- **Staging:** the legacy rehearsal frontend of §1.3 step 7, pointed at the **new** staging
  project. The old Worker and the old staging database are not part of the rehearsal; the old
  database is deleted only after the rehearsal passes (approval 17).
- **Production:** the pre-cutover frontend, recorded at cutover and kept deployed and untouched
  until the backout window closes.

### 1.8 Staging Auth phases: credential prep → O2 → L1 → rejection probes

Doc 14 §8.1 and §11.6, in this order, each phase its own approval:

1. **Credential prep (approval 12), before O2.** With the providers still on, the operator
   creates, for the staging Auth fixtures only: legacy sessions and refresh tokens, and the
   valid pre-cutover verification credentials L-a, L-b, L-c (Admin `generateLink`, one
   email-change token). These are what the later probes must see refused.
2. **O2 (approval 13).** The owner turns the Supabase Auth providers off on staging (signups
   stay off).
3. **L1, then the rejection probes (approval 14).** Read the hosted JWT/OTP expiry settings
   (stop if unreadable); L-a is redeemed during L1 as specified; delete legacy refresh tokens
   and sessions; wait the derived interval W; then the A5b rejection probes: refresh with the
   prepared token refused, `PUT /user` refused, L-b and L-c refused, provider endpoints answer
   with documented errors identically for known and unknown addresses.
L1 is one-way for legacy sessions; the backout (§3.3) restores the email provider so people can
sign in again with passwords.

---

## 2 · Hosting on Render

### 2.1 Verified pricing (render.com/pricing, page HTML read 2026-10-23T04:39Z)

- Workspace: **Hobby $0/month + compute** (up to 25 services, 5 GB bandwidth);
  **Pro $25/month + compute** (unlimited seats/services, 25 GB); bandwidth beyond the
  allowance **$0.15/GB**.
- Web compute: **Free $0** (spins down after 15 min idle, ~1 min wake, "Do not use them for
  production", render.com/docs/free); **$7/month** (512 MB, under 1 CPU); $25/month (2 GB,
  1 CPU). Billing **prorated to the second**.
- `04-costs.md` (July) quoted 100 GB free bandwidth; the current Hobby allowance is 5 GB.

### 2.2 Two services (recommended)

`tnbs-recruiter-staging` and `tnbs-recruiter-prod`, $7 plan each, in the existing workspace
(Hobby per `render.yaml`). One service cannot serve two origins against two databases without
mixing secrets, and staging must be breakable without touching production. Free is unsuitable
even for staging (the ~1-minute wake breaks the timing envelope and the shutdown test). Hobby
vs Pro is Hunter's call (Render positions Hobby for personal projects; nothing here needs Pro).

Created in the **dashboard** (not via `render.yaml`, whose Blueprint also manages the
production pipeline cron). Settings: Node runtime; root `app`; build `npm ci && npm run build
&& npm run build:server`; start `node dist-server/main.js`; region nearest Supabase us-east-2
(Ohio; confirm in the dashboard); production auto-deploy **off**.

**Shutdown delay (executable step).** Render documents only the **Update service API** or a
Blueprint for `maxShutdownDelaySeconds` (render.com/docs/deploys#setting-a-shutdown-delay;
default 30 s, maximum 300 s). The server drains for up to **45 s** (`app/server/main.ts`).
Mechanism: the owner creates a Render API key; the operator runs one `PATCH` of the service
setting `maxShutdownDelaySeconds: 60`, then a `GET` of the same service and **records the
returned value**. If the value is not returned, stop and report (T-SHUTDOWN alone cannot prove
a 60 s budget). The owner revokes the API key afterwards.

### 2.3 Server environment (names only; values set by the owner in the dashboard)

`APP_ORIGIN` · `DATABASE_URL` (the `recruiter_app` login via the shared pooler, session mode) ·
`KEY_LINKS` · `KEY_SESSIONS` · `KEY_RATE` (three independent 32-byte random keys per
environment) · `EMAIL_MODE` · `SENDGRID_API_KEY` · `SENDGRID_FROM_ADDRESS` ·
`SENDGRID_FROM_NAME` · `SENDGRID_WEBHOOK_VERIFICATION_KEY` · `TRUSTED_PROXY_HOPS` (`0` until
T-IP passes) · `HOST=0.0.0.0` (Render requires it) · `PORT` (set by Render) · `STATIC_DIR` ·
`DB_ACQUIRE_TIMEOUT_MS` (optional) · `MAINTENANCE_MODE` · `STAGING_BANNER` (staging only).

### 2.4 Frontend build settings (per environment; new services inherit nothing)

From `app/.env.example`, set as build-time variables on each service:
`VITE_APP_ENV` (`staging` / `production`; staging turns on the non-production labelling) ·
`VITE_GOOGLE_MAPS_API_KEY` · `VITE_GOOGLE_MAPS_MAP_ID` · `VITE_MAPS_PROVIDER` (`google`).
The browser key is HTTP-referrer restricted. **Read-only first:** the owner checks in Google
Cloud Console → APIs & Services → Credentials → the browser key → Application restrictions
which referrers are allowed. Adding the staging origin (and later the production origin) is a
**separate authorized action** (approvals 8 and 20). Until it is done, maps on the new service fail
closed; nothing else depends on it.

### 2.5 Liveness, readiness and outage monitoring

- **Today:** there is no health route, and `main.ts` deliberately serves even when the database
  warm-up fails. `/signin` is a **liveness** check only (200 even if the database is down). Used
  as Render's health path, a deploy with a wrong database password would still pass and replace
  a working instance.
- **Proposed code change (separate reviewed item, §5 item 2; NOT made yet):**
  - `GET /readyz`: **503 until** the process has completed one bounded database round trip as
    `recruiter_app` (acquire ≤ 2 s, `select 1`, statement timeout 1 s), then **200 for the life
    of the process**. Generic body, no details, no session. Render's health path is set to
    `/readyz`, so a deploy with broken credentials never becomes ready and Render cancels it
    (render.com/docs/health-checks: unready new instances get no traffic; cancelled after 15
    minutes), while a later database outage does not cause a restart loop.
  - `GET /healthz/db`: a **live** bounded check (same limits, 200/503, generic body) for
    outage monitoring only; Render does not use it.
  - Tests: unit (503 → 200 transition, bounded time, no details in the body), A3 (wrong password
    → stays 503), staging (§1.5 row 11).
- **Outage monitoring:** an external uptime check of `/healthz/db` and `/signin` every few
  minutes that alerts the owner; plus Render's deploy-failure notifications and the server's
  existing `operator_alert` log events. The monitor provider and its cost are **not chosen or
  verified** (approval 10).

### 2.6 Supabase pooler connectivity with the custom role

From the docs (supabase.com/docs/guides/database/connecting-to-postgres): "If you connect as a
custom role through the shared pooler, the username is `[ROLE].[PROJECT-REF]`"; port 5432 is
session mode, 6543 transaction mode; transaction mode does not support prepared statements.
The server sets session values with `SET LOCAL` / `set_config(…, true)` inside each transaction
and uses no named prepared statements; the runner requires 5432. **Use session mode (5432).**
This settles doc 14's open item E16 from documentation.

**Connection budget.** Per instance: auth pool max 4 + data pool max 10 = **14**; during a
deploy two instances overlap = **28**; plus maintenance (1) and operator/runner sessions (≤ 2).
Micro limits: **60** direct database connections, **200** pooler clients
(supabase.com/docs/guides/platform/compute-and-disk). Session mode holds one server connection
per client, so the app's peak (~31) must stay well under 60 alongside Supabase's own services.

**Probe (staging, approval 11), acceptance criteria:**
1. Connect as `recruiter_app.<staging-ref>` through the shared pooler, session mode:
   `select current_user, current_setting('server_version_num')` → `recruiter_app` and a
   version.
2. **Budget:** with the staging service running and a deploy in progress, `select count(*) from
   pg_stat_activity` (owner, SQL editor) stays ≤ 40; the pooler refuses nothing.
3. **Transaction-local isolation:** in client A, `begin; select set_config('app.session_hash',
   'probe-a', true); commit;` then a new transaction reads `current_setting('app.session_hash',
   true)` as empty; a concurrent client B never sees `probe-a`.
4. **Admission timing, no false pass:** 20 sign-in requests (known eligible fixture, unknown,
   deactivated, invalid) all answer within the local envelope (880–1300 ms), **and** each
   eligible fixture request was **admitted and queued**: a new link row exists for it with
   `send_status` recorded, and the Render log shows **no** `signin_admission_unavailable` (or
   `db_pool_acquire_failed`) alert during the run. Uniform timing with every admission failing
   closed is a **fail**.
No data is read or written beyond these statements.

### 2.7 IPv4 add-on: not needed

Direct connections are IPv6 unless the add-on is enabled, but "the shared pooler is IPv4-only
on every plan, in both session and transaction mode" (connecting-to-postgres). Verified price if
ever needed: **$0.0055/hour (~$4/month)**, Pro plan and up
(supabase.com/docs/guides/platform/manage-your-usage/ipv4; .../platform/ipv4-address).

---

## 3 · Cutover, backout window and rehearsal

### 3.1 Backout window (D10 gates it)

M1 creates `internal.backout_window` with `email_edits_paused = false`. **Approving D10 does
not turn the guard on.** The runbook must:

1. **Activate:** runner action `window-on` (`update internal.backout_window set
   email_edits_paused = true`), in the same maintenance period as the cutover, **before**
   maintenance is turned off.
2. **Verify:** `select email_edits_paused from internal.backout_window` → `true`; and a Team
   email edit through the app is refused (route and trigger) on staging.
3. **Close** only on Hunter's word (`window-off`, then verify `false`).
D10 still decides whether a window is declared, its length and who closes it; until it does,
production cutover cannot be scheduled. Recommended: 14 days, closed by Hunter. Adds are not
frozen (D8 superseded that part).

### 3.2 Production cutover (each line its own "go"; doc 12 kept separate)

**Production access does not open before L1.** The legacy credential and Auth roster-probing
paths must be closed before anyone uses the new system, so O2, L1 and their acceptance probes
run **inside** the cutover maintenance period, and the L1 approval (21) is given **before** the
cutover approval (22).

1. Read-only production inventory (O1); D7 and the unique-index decision; the **four July
   migrations** as their own change (doc 12 item 3) if still unapplied; pre-cutover snapshot;
   the hosted JWT/OTP expiry settings read (they fix L1's wait W, and so the length of the
   maintenance period).
2. Production Render service created **suspended**; env (§2.3, §2.4); shutdown delay set and
   read back (§2.2); Maps referrer added (§2.4); SendGrid production key/webhook (§7 E).
3. **Cutover (maintenance on throughout):** M1 → M1b → M1c (self-check must pass) →
   `recruiter_app` password → deploy the reviewed commit (Render waits for `/readyz`) →
   `window-on` and verify → **O2** (providers off) → **L1** (wait W) → acceptance probes:
   production subset of A5a and of the L1 rejection probes, A7 subset, T-IP → **maintenance
   off** → first manager signs in. The backout window is open.
4. Retention wired on the production pipeline (§4), separate approval.

### 3.3 Backout (rehearsed on staging first)

Maintenance on → `retire-app-credentials.sql` → identity-alignment check (`profiles.email =
auth.users.email` for every approved profile; expected because email edits were paused) →
`M1c-backout` → `M1b-backout` → `M1-backout` → **re-enable the Supabase email provider**
(reverse of O2; signups stay off) → return traffic to the previous app (staging: the old
Worker; production: the recorded pre-cutover frontend) → smoke test → tell the team. Data is
preserved (people added stay; batch-delete records stay). Sessions closed by L1 stay closed;
people sign in again with their passwords.

**Re-applying after a backout** uses three runner actions, not the plain apply files (the
backouts keep the sign-in ledgers, added people and batch-delete record, so the plain files fail
on the first retained object): `reapply-m1`, `reapply-m1b`, `reapply-m1c`, in that order. Each
first checks that the database looks backed out (retained tables present, live functions absent)
and refuses otherwise, then sends the reviewed file in an in-memory idempotent form (existence
guards only; existing rows and the single-row control tables such as `backout_window` are not
touched). `reapply-m1c` ends with one extra step,
`revoke execute on function internal.batch_delete_audit_append_only() from service_role;`,
because M1's blanket grant to `service_role` reaches that retained trigger-only function, which a
fresh apply creates later and never grants. These steps are **not atomic**: the M1c file commits
before the revoke runs. Before `reapply-m1c` sends anything it reads the live catalogue (real
queries, not object names alone) and accepts exactly two states; any other state is refused before
anything is changed, and the refusal names only the failed check names:

- *Backed out* (`public.batch_delete` absent): the retained audit guards must be intact, then the
  normal precheck, file and revoke run. If the audit table itself is absent, the plan's own
  precheck refuses with the plain-apply hint.
- *Interrupted* (M1c file committed, revoke not run): `public.batch_delete` present, the same guards
  intact, and the **only** unexpected privilege is a direct `service_role` EXECUTE entry on
  `internal.batch_delete_audit_append_only()`; then only the revoke is sent.

"Guards intact" means exact equality with the text a fresh local apply produces (`pipeline/src/reapply-m1c-expected.ts`), not a name or substring match:
the trigger function's complete definition (`pg_get_functiondef`, whitespace collapsed: language, body, SECURITY, volatility and `SET` clause) equals the reviewed one with `search_path` either the M1c one
`internal, pg_temp` or `public, internal, pg_temp` (which M1's search-path pinning gives it in a backed-out database before the reapplied M1c file resets it; the interrupted state requires the M1c one), and it is owned by
the table's owner; the table's canonical description (every column with type, nullability, default, identity and generation, every constraint and index definition, relation kind, row security, persistence, rules,
partitioning, inheritance) equals the fresh-apply text, so an added column, foreign key (cascading or not), default or changed type is refused; the table has exactly the two triggers
`batch_delete_audit_no_update_delete` (BEFORE UPDATE OR DELETE, FOR EACH ROW) and `batch_delete_audit_no_truncate` (BEFORE TRUNCATE, FOR EACH STATEMENT), both
enabled, both on that function, with no arguments, WHEN clause or column list; PUBLIC, `anon`, `authenticated` and `recruiter_api` hold nothing on the table (table ACL, column ACLs, effective table and column
privileges) and no EXECUTE on the function (ACL and effective); `recruiter_api` has no DELETE on `public.batches` and
(when it exists) has effective EXECUTE on `batch_delete` while `anon`/`authenticated` have none (including through a role they belong to) and PUBLIC holds none in its ACL; and
`service_role` has no EXECUTE path other than a direct entry (not via PUBLIC, an inherited role,
ownership or a default ACL). After the revoke the tool re-reads the effective privilege and reports
success only if `service_role` has lost EXECUTE. It does not revoke PUBLIC or inherited grants to
compensate. **Not checked, and therefore not certified by this tool:** the body of `public.batch_delete` (only its
privileges are checked; a separate manual comparison of its definition with the reviewed file is a required step
of the separately approved M1c run, not of approval 4), other objects in the schema, and grants on objects other
than those named. **Unsupported:** a database whose PostGIS extension lives outside schema `public` (M1 then pins
a different `search_path`, including on the audit function); `reapply-m1c` refuses it at `trigger_function`, which
is a safe stop, and a human handles it. The hosted catalogue may differ from the local one (for example extra
default ACL entries, or a different PostgreSQL major version printing `pg_get_functiondef` differently); a
refusal there is safe and means a human inspects. The expected text was produced by a fresh PostgreSQL 16 catalogue in a session with the default search path; the deparsing functions (`pg_get_functiondef`, `pg_get_expr`, `pg_get_constraintdef`, `pg_get_indexdef`, `format_type`) are not a cross-version serialization contract, so a different minor version, an extension that changes qualification, or a different session `search_path` can also change the text. Nothing is proved about hosted minor versions. A mismatch makes the equality fact false and the classifier refuses before any file or revoke is sent; it is never relaxed to pass, a human inspects the hosted text and a new canonical form is reviewed. Proved locally on a real
PostgreSQL 16 catalogue (`pipeline/src/reapply-m1c-a3.test.ts`, 34 states: the tampering counterexamples (the
reviewed raise only in a comment, a swallowed exception, SECURITY DEFINER, another owner), an added cascading foreign key,
column, changed type, dropped check, changed default and row security, column-level privileges, an inherited `anon` grant on `batch_delete`,
disabled, wrong-function and wrong-timing triggers, wrong function search paths including the non-public PostGIS one, restored DELETE on batches,
PUBLIC and inherited EXECUTE, table/function privileges for `recruiter_api`, missing trigger/function/disabled
trigger with `batch_delete` absent, a whitespace-only change of the body (accepted), plus the valid interrupted and backed-out states). Also proved locally: a fresh apply and a backout followed
by the three re-applies give snapshots identical after normalization, with the role matrix 62/62.

**Staging rehearsal (T-REPLAY, approval 15)** runs against the **new** staging project and
proves more than the snapshot: after the backout, **a staging fixture signs in on the legacy
rehearsal frontend (§1.3 step 7) with its password, opens a batch and logs a test call** (the
real old-app path, including the restored email provider); then M1, M1b, M1c are
re-applied and the new app works again with new keys and a new `recruiter_app` password.

---

## 4 · Retention provisioning (doc 15 §23)

M1 creates `recruiter_maintenance` as NOLOGIN with `select, delete` on the five sign-in
ledgers only. The nightly retention step is **not wired**; without it the ledgers only grow.

1. **Reviewed pipeline hook (§5 item 3):** a step after the nightly sync, in its own `try`,
   connecting with a separate `MAINTENANCE_DATABASE_URL` as `recruiter_maintenance`, using the
   retention rules in `pipeline/src/retention.ts` via `pipeline/src/retention-step.ts` (statement timeout, row cap, failure
   logged and alerted, never failing the pipeline run). The pipeline's existing
   `SUPABASE_DB_URL` / service-role access is **not changed or widened**.
2. **Separate credential:** the owner sets the `recruiter_maintenance` password (§1.4 step 4);
   it is never the app's or the pipeline's credential.
3. **Hosted least-privilege test (staging, approval 11):** runner action `retention-dry-run`
   as `recruiter_maintenance`: counts what would be deleted; then proves it **cannot** select
   from `public.profiles`, cannot execute the sign-in functions, and cannot update any table;
   then one real run deletes only aged fixture rows.
4. **Pipeline configuration approval (approval 23):** add `MAINTENANCE_DATABASE_URL` to the
   production pipeline service after cutover; read back that `PIPELINE_COMMAND` and the
   existing secrets are unchanged (doc 12 guards).

---

## 5 · Reviewed code items before the single push

1. Staging runner: new staging ref and the actions in §1.3 step 3; the 12 T-SHUTDOWN fixture
   identities in the staging fixtures; offline contract updates.
2. `/readyz` and `/healthz/db` (§2.5), with tests.
3. Pipeline retention hook (§4 step 1), with tests; no change to existing pipeline access.
4. A `shutdown_started` log line at SIGTERM carrying the lifecycle counts (accepted requests,
   pending continuations; `app/server/core/lifecycle.ts` already keeps them) so T-SHUTDOWN can
   prove work was pending; event names and counts only.
Each gets an independent review; then `wave1/integration` is pushed once (approval 3). None of
these is made yet.

---

## 6 · Approvals Hunter must give, in order

Line: approval · recommended answer · cost. Push, deletions, production changes, L1 and window
closure are separate lines. **25 approvals.**

1. Create the new staging project (R1 step 2) · **yes** · +$10/month while the old one also
   exists.
2. Engineering: the four reviewed code items of §5 · **yes** · $0.
3. Push `wave1/integration` once, after item 2's reviews · **yes** · $0.
4. Replay migrations, fixtures, marker and Auth fixtures on the new staging project (the
   T-SHUTDOWN fixtures are installed later, after approval 6; §1.3 step 5) · **yes** · $0.
5. Legacy rehearsal frontend: an isolated Worker of the pre-cutover app pointed at the new
   project, configuration proven before M1 (§1.3 step 7) · **yes** · cost: the owner confirms
   the Cloudflare plan (not recorded in the repo).
6. Apply M1, M1b, M1c on staging; set the `recruiter_app` and `recruiter_maintenance` passwords
   · **yes** · $0.
7. Render: stay on the **Hobby** workspace, and create the staging service ($7 plan) with env,
   `VITE_*` settings, and `maxShutdownDelaySeconds: 60` set and read back via a temporary API
   key · **yes** · ≤ $7/month, prorated (Pro would add $25/month).
8. Google Maps browser key: add the staging origin to its referrer restrictions (after the
   read-only check) · **yes** · $0.
9. SendGrid: capacity check first (read-only); **only if capacity exists**, the staging
   send-only key, second signed webhook and sender (§7 B, A, C, D) · **yes** · $0 if capacity
   exists.
10. Outage monitor (provider and cost proposed and verified first) · **yes, after a verified
    quote** · unverified.
11. **Scoped staging test authorization**, staging fixtures only, no production contact: the
    pooler probe (§2.6), A5a stateless probes and T-IP, the readiness-gate test, T-SHUTDOWN,
    mail end to end, and the retention least-privilege test (§4 step 3) · **yes** · $0.
12. Staging Auth phase 1: credential prep before O2 (§1.8 step 1) · **yes** · $0.
13. Staging Auth phase 2: O2, providers off on staging · **yes** · $0.
14. Staging Auth phase 3: **L1 on staging**, then the A5b rejection probes · **yes** · $0.
15. Staging backout rehearsal (T-REPLAY) on the new project through the legacy rehearsal
    frontend (§3.3) · **yes** · $0.
16. A7 log gate on staging (grant log read access or run the searches) · **yes** · $0.
    *Milestone, not an approval:* Hunter's 5-minute staging walkthrough.
17. Delete the **old** staging project (after 15 passes; migration list recorded) · **yes** ·
    saves ~$10/month.
18. **D10:** declare a backout window · **yes, 14 days, closed by Hunter; `window-on`
    verified** · $0.
19. Production: the four July migrations as their own change (doc 12) · **yes, if the
    inventory shows them unapplied** · $0.
20. Production Render service (suspended), env, `VITE_*`, shutdown delay read back, Maps
    referrer for the production origin, SendGrid production key/webhook · **yes** · $7/month.
21. **Production L1** (with O2), given before 22 and run inside the cutover before access
    opens · **yes** · $0.
22. Production cutover (§3.2 step 3; maintenance stays on until O2, L1 and the acceptance
    probes pass) · **yes, in a scheduled maintenance window** · $0.
23. Production pipeline configuration: add `MAINTENANCE_DATABASE_URL` (§4 step 4) · **yes** ·
    $0.
24. Close the backout window (`window-off`) · **Hunter decides at day 14** · $0.
25. Destructive retirement after acceptance: the old Cloudflare Worker, the legacy rehearsal
    Worker, the old static-site entry in `render.yaml` (a reviewed Blueprint change), the staging
    SendGrid key and webhook, the Render staging service, and the staging project per the
    retention choice (§1.3; recommended keep one month, then delete) · **yes, each listed
    resource** · saves up to $17/month.

Steady state after cutover and retirement: **$7/month** (production Render). While staging
runs: +$7 (Render) +~$10 (Supabase). No IPv4 add-on.

---

## 7 · SendGrid (Quote-Queue's account), owner click-steps

Capacity is **plan-dependent and not published**: "The number of endpoints per user is
dependent on the TSG plan you are on" (changelog, effective 2023-05-03); `max_allowed` is "the
maximum number of Event Webhooks you can have enabled under your current Twilio SendGrid plan"
(api-reference, get-all-event-webhooks). So the capacity check comes **first**.

B. **Capacity check (first, read-only).** Settings → Mail Settings → Event Webhooks. Count the
   enabled webhooks. If creating another is not offered or the plan maximum is reported,
   **stop** and tell the manager (options: a plan change with a verified price, or a reviewed
   design change). Never repurpose Quote-Queue's webhook.
A. **Send-only key.** Settings → API Keys → Create API Key → name
   `tnbs-recruiter-staging-send` → Restricted Access → Mail Send: Full Access, everything else
   No Access → Create & View → paste straight into Render staging `SENDGRID_API_KEY` (never into
   chat, email or a file). Success: the key list shows it as restricted.
C. **Second Event Webhook.** Create new webhook → name `tnbs-recruiter-staging` → Post URL =
   staging origin + `/webhooks/sendgrid` → events Processed, Delivered, Deferred, Dropped,
   Bounced, Spam Reports (open/click tracking off) → Save → open it → enable **Signed Event
   Webhook** → copy the verification key into `SENDGRID_WEBHOOK_VERIFICATION_KEY` → "Test Your
   Integration". Success: a verified event in the staging log; a tampered request refused.
D. **Sender.** Settings → Sender Authentication: an address on a domain Quote-Queue has already
   authenticated (no DNS change) → `SENDGRID_FROM_ADDRESS`, display name →
   `SENDGRID_FROM_NAME`.
E. Production repeats B, A, C, D with `-prod` names (approval 20); keys are never shared.

---

## 8 · Ownership, rollback and teardown

| Step | Runs it | Rollback |
|---|---|---|
| New staging project | owner | delete it (old project untouched until approval 17) |
| Code items + single push | operator, reviewed | revert / delete the remote branch (no production effect) |
| Replay, fixtures, marker | operator via runner | delete and recreate the new project |
| M1/M1b/M1c on staging | operator via runner | backouts (§3.3, rehearsed) |
| Passwords (`recruiter_app`, `recruiter_maintenance`) | owner | `retire-app-credentials.sql` (NOLOGIN) / `alter role … nologin` |
| Legacy rehearsal frontend | owner (deploy), operator (build, config proof) | delete that Worker |
| Delete old staging project (after T-REPLAY) | owner | none (fictional data; migration list recorded) |
| Render staging service, env, shutdown delay | owner (service, env), operator (API PATCH/GET) | suspend or delete the service; revoke the API key |
| Maps referrer change | owner | remove the added referrer |
| SendGrid key, webhook, sender | owner | delete the key; disable the webhook |
| Pooler probe, A5a, T-IP | operator / owner | none (no data) |
| Credential prep, O2, L1 + rejection probes (staging) | operator (prep, L1), owner (O2) | O2: providers back on; L1 one-way for legacy sessions |
| T-REPLAY, retention test, A7 | operator / owner | re-apply M1/M1b/M1c (part of the rehearsal) |
| Production steps | §3.2 | §3.3 |
| Pipeline config (retention) | owner | remove `MAINTENANCE_DATABASE_URL`; the step skips |
| Retirement (approval 25) | owner | none for deletions; the reviewed Blueprint change is revertible |

Teardown costs: Render staging stops billing at suspension or deletion (per second). The
Supabase staging project bills until deleted or transferred to a Free organization and paused
(§1.2). SendGrid keys and webhooks cost nothing.

---

## 9 · Review response (Codex, plan review of `9befc35`, 2026-10-23)

*This table records the review of revision 2, which used the old approval numbering (1–29). Approval numbers cited in it are converted to the current (revision-3) numbering of §6.*

| # | Finding | Change |
|---|---|---|
| 1 | Paid projects cannot be paused; credit is per organization | §1.2 corrected costs and states; §1.3 retention choice; approvals 1, 17, 25 (revision-3 numbering) |
| 2 | Window not activated; backout must restore the email provider; rehearse the old app | §3.1 `window-on` + verify; §3.3 email provider restored before returning users; old-app fixture login and call in T-REPLAY |
| 3 | `/signin` is liveness, not readiness | §2.5 `/readyz` deploy gate + `/healthz/db` monitoring, proposed as a separate reviewed code item (§5 item 2; not made); §1.5 row 11 |
| 4 | A7 pass rule vs provider metadata; error cases | §1.6 per-sink table; `/api/*` and the forced error cases retained; backup-code paths stay disabled |
| 5 | Retention unprovisioned | §4: hook, separate credential, hosted least-privilege test, pipeline config approval; pipeline access unchanged |
| 6 | Frontend build settings missing | §2.4 `VITE_APP_ENV`, `VITE_GOOGLE_MAPS_*`, `VITE_MAPS_PROVIDER`; referrer change as its own action |
| 7 | Shutdown delay had no executable step | §2.2 API PATCH + GET read-back, stop if not returned |
| 8 | Probe and T-SHUTDOWN criteria too weak | §2.6 budget, isolation and timing criteria; §1.5 row 10 post-response email continuation |
| 9 | Approval order | §5 single push after reviewed code; §6 capacity check before key creation; L1 separate on staging and production; creation, retirement and cutover separate; teardown approval lists every resource |

### Re-review (Codex, of `a5a4171`, 2026-10-23)

| # | Finding | Change |
|---|---|---|
| 1 | Blocker: production opened before L1 | §3.2: O2, L1 and acceptance probes inside the maintenance period, before access opens; L1 approval (21) before the cutover (22); staging phases in §1.8 (prep before O2, rejection probes after L1), approvals 12–14 |
| 2 | Backout rehearsal targeted the old database | §1.3 step 7 legacy rehearsal frontend on the new project, configuration proven before M1; §1.7; old staging DB deleted only after the rehearsal (approval 17) |
| 3 | Hosted tests could false-pass | §1.5 row 10: pending at SIGTERM (`shutdown_started`, §5 item 4) and completed after, inconclusive runs repeated; §2.6 step 4: eligible request admitted and queued, no admission-unavailable alert |
| 4 | Approval merges | 7→8, 11→12, 10+14+19 as one scoped test authorization (11), walkthrough a milestone; 25 approvals |

## Sources (read 2026-10-23, UTC)

- https://render.com/pricing (page HTML) · https://render.com/docs/free ·
  https://render.com/docs/deploys (incl. #setting-a-shutdown-delay) ·
  https://render.com/docs/health-checks · https://render.com/docs/web-services
- https://supabase.com/docs/guides/database/connecting-to-postgres ·
  https://supabase.com/docs/guides/platform/compute-and-disk ·
  https://supabase.com/docs/guides/platform/free-project-pausing ·
  https://supabase.com/docs/guides/platform/manage-your-usage/compute ·
  https://supabase.com/docs/guides/platform/ipv4-address ·
  https://supabase.com/docs/guides/platform/manage-your-usage/ipv4
- https://www.twilio.com/en-us/changelog/event-webhooks ·
  https://www.twilio.com/docs/sendgrid/api-reference/webhooks/get-all-event-webhooks ·
  https://www.twilio.com/docs/sendgrid/api-reference/webhooks/create-an-event-webhook ·
  https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/event ·
  https://www.twilio.com/docs/sendgrid/ui/analytics-and-reporting/email-activity-feed
- [repo] docs 10, 11, 12, 14 (§8, §11.5, §11.6), 15 (§4.2, §8, §23); `render.yaml`;
  `app/.env.example`; `app/server/config.ts`; `app/server/main.ts`; `app/server/app.ts`;
  `app/server/db/database.ts`; `pipeline/src/retention.ts`, `pipeline/src/retention-step.ts`;
  `supabase/pending/M1_same_origin_signin.sql`; `scripts/verify-baseline-reconciliation.mjs`.
