# 15 · Quote-Queue infrastructure reconciliation (sign-in)

Revision 2 (2026-10-21 UTC): review edits on IP trust, shutdown contract and SendGrid
one-shot sends (§10).
Revision 6 (2026-10-21 UTC): one global lock order including the business tables, compared
with Quote-Queue design 8111f3c (C7, C8/D9); see §17.
Revision 5 (2026-10-21 UTC): in-transaction authorization boundary, privileged-mutation
inventory, uniform fail-closed admission and recovery ordering, after QQ's review of its design
(findings F-1 to F-4, under revision in QQ, not completed fixes). See §14.
Revision 4 (2026-10-21 UTC): streaming body limits (§4.3), staging SQL adaptation inventory
(§12.5), email events marked Adapt, exact Auth call list (§12.1). See §13.
Revision 3 (2026-10-21 UTC): checked against Quote-Queue's infrastructure map
(`1f7cce2:docs/handoff/SIGNIN-2026-10-21-infra-map.md`). Adds the reuse table (§11) and the
data-access and permission migration boundary inventory (§12).

Status: **proposal for the coordinator (thr_z77w8egnyw). Nothing built, deployed, installed or
configured.** Written 2026-10-21 UTC on local branch `auth/same-origin-signin` by the sign-in
owner (thr_pn5gr4mx94), after Hunter's clarification relayed by the coordinator: *"the process
already works in Quote Queue, so however it is doing it should be used for the new
implementations as far as infrastructure goes."*

Reference: Quote-Queue `origin/main` f1167dc, read only with `git show` (no fetch, checkout or
pull). Citations are `[QQ] path:line`. This repo is cited as `[repo]`. Doc 14
(`14-same-origin-signin-design.md`, Gate 1 passed at 8dafc06) supplies the behaviour contract,
threat model, gap findings and tests. This document replaces only **its hosting layer** (the
Cloudflare Worker, Hyperdrive, `waitUntil`, `CF-Connecting-IP`); everything else in doc 14 carries
forward unless a row below says otherwise.

---

## 1 · Plain-language summary (for Hunter)

**Recommendation: run sign-in the way Quote-Queue does.** That means one small Node web server
on Render (the hosting company both apps already use) that:

- serves the Carrier Recruiter screens,
- handles sign-in with Quote-Queue's own design: emailed one-time links, a locked cookie,
  sessions stored in the database, the same limits and the same one-second answer,
- sends sign-in email through Quote-Queue's SendGrid account, with its own key and sender
  name, and tracks delivery the same way,
- talks to this app's existing database for you, checking your session on every request.

The team sees exactly the Quote-Queue sign-in screens, with "CARRIER RECRUITER" under the
badge.

**What stays different from Quote-Queue, and why:**

1. **The data stays where it is** (this app's own Supabase database). Moving it would be a big,
   risky migration for no sign-in benefit. It also holds map features Quote-Queue doesn't have.
   Because Supabase has its own public "side doors" (its own sign-in and data addresses),
   those are shut as an extra step. Quote-Queue has no such doors.
2. **The existing permission rules stay in the database.** Manager, Editor and Viewer are
   already enforced there. The server passes your session to the database, and the database
   keeps applying the same rules. Quote-Queue checks permissions only in server code. Keeping
   ours avoids rewriting every rule.
3. **Recovery codes** (an email-outage fallback) are new. Quote-Queue doesn't have them. They
   stay off until the cross-app policy is decided.

**What it costs and what you'd need to do (later, nothing now):**
- A Render **paid** web service (Starter, about $7 a month according to this project's July
  2026 cost notes; not re-checked today). The free tier "spins down" after 15 minutes idle and
  takes about a minute to wake, and Render says not to use it for production.
- Later, at rollout: a separate SendGrid key and webhook for this app in the Quote-Queue
  SendGrid account, a database password for the new server login, and the Supabase switches
  described in doc 14. Each is a separate "go" from you.

---

## 2 · What Quote-Queue actually runs (evidence)

| Item | Quote-Queue fact | Source |
|---|---|---|
| App/server | One Next.js 15 app on Node 22 (`runtime = "nodejs"` on auth routes) | [QQ] `package.json`; `app/auth/request/route.ts:131` |
| Hosting | Render: a web service plus a Render Postgres database, live since 2026-08-27; Auto-Deploy on `main`; Render **Pre-Deploy Command** runs the migration script before each deploy | [QQ] `docs/handoff/HANDOFF-2026-10-16-manager.md:7`; `docs/PROJECT_LOG.md` entry 089 (~line 5823-5845) and entry 090 (~5910-5913) |
| Database | Postgres 16; driver `pg`, one pool (`new Pool({connectionString: DATABASE_URL})`), `withTransaction` helper | [QQ] `lib/db.ts`; `docs/BUILDER_HANDOFF.md:1829-1831` |
| DB roles | `qq_app` (runtime, ordinary, explicit grants), `qq_maintenance` (retention job), `qq_migration` (migrations and bootstrap only) | [QQ] `db/migrations/0001_init.sql:19-33, 859-917`; `scripts/bootstrap-prod.ts` header; `.github/workflows/ci.yml` header |
| Config (names only) | `DATABASE_URL`, `APP_BASE_URL`, `EMAIL_MODE`, `SENDGRID_API_KEY`, `SENDGRID_WEBHOOK_VERIFICATION_KEY`, `CRON_SECRET`, `HEALTH_SECRET`, `KEY_TOKENS`, `KEY_SESSIONS`, `KEY_RATE`; plus `MIGRATE_DATABASE_URL` for scripts. Validated at boot (`instrumentation.ts` → `lib/env.ts`; keys ≥ 43 base64url chars) | [QQ] `.env.example`; `lib/env.ts`; `instrumentation.ts` |
| Sign-in links | `POST /auth/request` (1000 ± 100 ms, anonymous buckets before the response, identity work after it via `after()`), `GET /auth/verify` (validate, set `__Host-qq_confirm` = token.nonce, 303 to clean `/auth/confirm?x=`), `GET/POST /auth/confirm` (masked address, CSRF, locked redeem) | [QQ] `app/auth/{request,verify,confirm}/route.ts` |
| Sessions | `sessions` table, `token_hash` = HMAC(`KEY_SESSIONS`), cookie `__Host-qq_session` (`Secure; HttpOnly; SameSite=Lax; Path=/`), 30-day rolling, 90-day cap, renewal throttled to 5 min, `{renew:false}` for auto-refresh | [QQ] `lib/auth/session.ts`; `lib/cookies.ts` |
| Authorization | Central server code: `validateAndRenewSession` on every page/route, role from `users.role`; no RLS | [QQ] `lib/auth/session.ts:182-225`; `lib/roles.ts` (not read in full) |
| CSRF | Origin (else Host) must match `APP_BASE_URL`; double-submit HMAC token | [QQ] `lib/csrf.ts:90-137` |
| Client IP | Rightmost `X-Forwarded-For` hop, else `X-Real-IP` | [QQ] `lib/request-ip.ts` |
| Mail | SendGrid `/v3/mail/send`, click/open tracking off, `custom_args` `qq_source`/`qq_local_id`, a custom key header that is **diagnostic only** (SendGrid does not deduplicate on it, [QQ] `lib/sendgrid.ts:64`), outcome classes; signed Event Webhook (ECDSA) at `/webhooks/sendgrid`; DB-enforced send-status lattice | [QQ] `lib/sendgrid.ts`; `app/webhooks/sendgrid/route.ts`; `db/migrations/0006…`, `0007…` |
| Post-response work | Next.js `after()` inside a route with `maxDuration = 60` | [QQ] `app/auth/request/route.ts:131-137, 612-614` |
| Security headers | Middleware: CSP with nonce, HSTS, nosniff, Referrer-Policy, Permissions-Policy, `no-store` | [QQ] `middleware.ts:72-156` |
| CI | GitHub Actions with a Postgres 16 service, three roles, typecheck, route check, vitest, build | [QQ] `.github/workflows/ci.yml` |
| Recovery codes | **None.** (`scripts/recover-prod.ts` is a record-repair CLI, not a sign-in fallback, and is deliberately not used here) | [QQ] `scripts/` listing |

---

## 3 · Component-by-component reconciliation

Legend: **Reuse** = same design, code copied with the Quote-Queue names changed; **Adapt** =
same design, a small stated change; **New** = no Quote-Queue counterpart.

| # | Component | QQ source | Here | Hosted on (this project) | Smallest necessary difference |
|---|---|---|---|---|---|
| C1 | One-time links (request → verify → confirm) | `app/auth/{request,verify,confirm}/route.ts`, `lib/keys.ts`, `lib/mask.ts`, `lib/rate.ts`, `lib/chicago.ts` | **Reuse** | New Node web service (§4) | Names: `__Host-tr_confirm`, `tr_source`; table names in `internal`; ceilings unchanged. Copy URL/wording per decisions 19/35 with "CARRIER RECRUITER" |
| C2 | Opaque Postgres sessions + cookie | `lib/auth/session.ts`, `lib/auth/revoke.ts`, `lib/cookies.ts` | **Reuse**, plus a `kind` column for recovery (doc 14 §3.5) | Supabase Postgres (`internal.app_sessions`) | The renewal rule is fed by navigation, mutation and an in-app activity ping, because the SPA has no full page loads between screens. Recovery sessions get their own windows |
| C3 | Central server authorization | `validateAndRenewSession` on every request | **Adapt** | Node server + Supabase Postgres | The server validates the session exactly as QQ does, **and** passes `app.session_hash` (transaction-local) so the existing RLS/RPC rules re-check it per statement (§5 D2) |
| C4 | CSRF, Origin, headers | `lib/csrf.ts`, `middleware.ts` | **Reuse**; strict Origin (required) for recovery and `/api/*` mutations (doc 14 finding 1); SPA mutations carry the token in a header instead of a form field | Node server | Header token for `fetch()` mutations |
| C5 | SendGrid send | `lib/sendgrid.ts`, the canonical request in `app/auth/request/route.ts:390-430` | **Reuse** | Node server | Its own API key, restricted to Mail Send; `from` = the sender Hunter picks; `custom_args` `tr_source`/`tr_local_id`. **Each sign-in send is one-shot.** The custom key header (if kept) is diagnostic only; SendGrid does not deduplicate on it. An uncertain outcome (5xx, timeout, network error after transmission) is recorded as `unknown` and is **never** replayed automatically. Only the person's own new request mints a new link and a new send, under the normal ceilings. A 429 is recorded as not sent (QQ's `retryable_rejection`) and is likewise not auto-retried in the sign-in path |
| C6 | SendGrid signed webhook + delivery ladder | `app/webhooks/sendgrid/route.ts`, migrations 0006/0007 | **Reuse** | Node server `/webhooks/sendgrid`; lattice trigger in Supabase | A **separate** Event Webhook in the same SendGrid account, pointing at this app with its own verification key. SendGrid has supported multiple Event Webhooks per account since May 2023; the per-plan cap (`max_allowed`) is **unverified** for TNBS's plan (owner check). Events whose `tr_source` is missing are ignored |
| C7 | Post-response work | `after()` + `maxDuration = 60` | **Adapt** (departure D7) | Node server process | Plain Node with an explicit graceful-shutdown contract (§4.1) that tracks every accepted request **and** its continuation. Same honesty as QQ: best effort plus human retry; a lost send leaves the link `pending` or `unknown` |
| C8 | Client IP | `lib/request-ip.ts` | **Adapt after verification**: QQ's own header comment says the result depends on the specific proxy chain, including any extra CDN in front. That this app's chain matches QQ's is **unverified** | Render | Use QQ's extraction only after hosted test T-IP (§4.2) passes for this service's exact chain (custom domain, any CDN or proxy in front). Until then the 20/IP limit is **not** accepted as protection. If the chain differs, the extraction is pinned to the verified trusted hop |
| C9 | Config validated at boot | `lib/env.ts`, `instrumentation.ts` | **Reuse** | Render env vars | Names in §6 |
| C10 | Migrations + roles | `scripts/migrate.ts`, Pre-Deploy Command, `qq_app`/`qq_migration` | **Adapt** | Supabase Postgres | This repo already has its own migration discipline (`supabase/migrations` + pinned checksum manifest, `scripts/verify-migration-baseline.mjs`). The new runtime login role `recruiter_app` is the `qq_app` equivalent. Migrations stay operator-applied per environment, with owner approval, as today; there is **no** automatic Pre-Deploy migration until Hunter decides otherwise |
| C11 | First-user bootstrap | `scripts/bootstrap-prod.ts` | **Not needed** | — | Existing users and roles are preserved (no new first user). If no active manager exists at cutover, that is a decision for Hunter |
| C12 | Recovery codes | none | **New** (doc 14 §7), off by flag | Node server + Supabase | Cross-app policy D2 is open |
| C13 | Hosting | Render web service | **Reuse** (Render web service, Node 22) | Same Render workspace and Blueprint (`render.yaml`) as the pipeline cron | Replaces the planned `runtime: static` site (`render.yaml` first service) with a Node web service. Staging host: §5 D5 |

---

## 4 · Recommended shape (replaces doc 14 §2.1–2.4 if the coordinator accepts it)

```
Browser ──HTTPS──▶ Render web service "recruiter-web" (Node 22, plain `node:http`)
                     ├─ static SPA files from app/dist (cache headers; index.html no-store)
                     ├─ QQ-style auth routes: /signin, /auth/request, /auth/verify,
                     │                        /auth/confirm, /auth/signout
                     │                        (/signin/recovery + /auth/recovery: flag, off)
                     ├─ /api/*  JSON routes (replace every supabase-js call in the SPA)
                     └─ /webhooks/sendgrid
                          │ pg Pool, TLS, LOGIN role recruiter_app (qq_app equivalent)
                          ▼ via the Supabase **session pooler** (IPv4; port 5432)
                     Supabase Postgres (existing project; RLS + RPCs re-keyed, doc 14 §4)
   Render cron "pipeline" ── unchanged (service role / its own DB URL)
```

- **Server framework:** plain Node `http` plus `pg`, with no Express and no Next.js. That is the
  smallest dependency set; `pg` is the same driver Quote-Queue and this repo's pipeline already
  use. The SPA stays Vite. A framework difference is not a reason for a different auth system,
  and the auth routes are copied as functions.
- **Why the session pooler:** Supabase's direct connection is IPv6 by default, and Supabase's
  own IPv4 page lists Render as IPv4-only. The shared pooler is IPv4 on every plan. This repo's
  pipeline on Render already uses the session pooler (`render.yaml`, `SUPABASE_DB_URL` comment).
  Whether the pooler accepts a **custom** login role (user `recruiter_app.<project-ref>`) is
  **unverified**. If it doesn't, the alternative is Supabase's paid IPv4 add-on (Pro plan), which
  is a spending decision.
- **Data path (unchanged from doc 14 §4, now concrete for Node):**
  - The new migration (pending, not executed) replaces every `auth.uid()` use (22 sites in 4
    migrations) with `internal.current_staff_id()`. It redefines `current_app_role()` on the
    session ledger, so `is_staff`/`can_edit`/`is_manager` and every policy and RPC follow.
    Recovery sessions get no staff role. Profiles are readable only with a link session.
  - The server runs each request in one transaction: `BEGIN; select
    set_config('app.session_hash', $1, true); …; COMMIT`, as `recruiter_app`, so RLS re-checks
    the session per statement.
  - `anon`/`authenticated` lose every grant; `recruiter_app` gets the old `authenticated` grants.
  - The SPA keeps its screens: `lib/rpc.ts` keeps its signatures and calls `/api/rpc/:name` (an
    allow-list of the 17 granted RPCs); the 24 table calls become named endpoints (doc 14 §4.2).
  - All existing rows, ids, roles (manager/edit/view, labelled Manager/Editor/Viewer) and
    statuses are preserved. Pending/guest rows stay untouched and without access.
  - The pipeline is unchanged.
- **Everything else from doc 14 carries forward** with the host words swapped: the threat model
  and access paths P1–P18; closing Supabase's side doors (grants, providers off, and L1 with
  the review-round-4 order); the backout window, M1/M2 and the retire-credentials order (the
  "pool stop" becomes *suspend or scale the Render service to zero* instead of deleting
  Hyperdrive); the T-HYG log gate (now for Render logs, Supabase logs and SendGrid); the probe
  matrix; recovery deny-by-default; concurrency tests.

### 4.1 Graceful-shutdown contract (replaces Next.js `after()`; review edit 2)

Render sends `SIGTERM` to the old instance once the new one is up, then `SIGKILL` after the
shutdown delay (default 30 s, configurable up to 300 s; Render requires the app to implement
graceful shutdown itself). Proposed setting: **60 s** (it matches QQ's `maxDuration = 60`), with
the app's own drain budget **45 s**.

State kept by the server:
- `accepted`: every request the server has started handling and not yet finished (including
  `POST /auth/request` while it waits for its 1000 ± 100 ms envelope).
- `continuations`: every post-response task (identity work, send, outcome recording),
  registered **before** the response is written, so no gap exists between "response sent"
  and "continuation tracked".
- Each continuation carries a deadline (lock ≤ 5 s, provider call ≤ 8 s, outcome write ≤ 5 s,
  overall ≤ 25 s).

On `SIGTERM`:
1. **Stop admission:** `server.close()` stops new connections. Keep-alive sockets get
   `Connection: close`, and any new request that still arrives gets `503` with `Retry-After`
   (no auth work and no bucket increment).
2. **Drain `accepted`:** each in-progress request completes normally (the envelope still
   fires; a request already admitted still gets its continuation registered).
3. **Drain `continuations`:** await all, bounded by the drain budget. A continuation past its
   own deadline is aborted (`AbortController` on the provider call; the DB statement is
   cancelled by `statement_timeout`), leaving the link `pending` (not sent) or `unknown` (sent,
   outcome unknown). Never `accepted` without evidence.
4. **Close the database:** `pool.end()` after both sets are empty or the budget ends, whichever
   is first, so connections close before `SIGKILL`.
5. Exit 0. A second `SIGTERM` or the budget running out → log the counts of abandoned tasks
   (counts only, no identities) and exit.

Tests (**T-SHUTDOWN**, local Node server under A4, replacing doc 14's Worker-specific
T-WRANGLER text): send `SIGTERM` at each phase and assert the result.

| SIGTERM arrives during | Expected |
|---|---|
| admission (bucket transaction open) | request completes with the generic envelope or the generic 503; the bucket is counted at most once; no orphan transaction |
| the response envelope wait | response delivered at the envelope; continuation runs and finishes within budget |
| the provider send (fake adapter delaying 6 s) | send completes; outcome recorded; then exit |
| the provider send (fake adapter hanging) | aborted at 8 s; link stays `pending`/`unknown`; never auto-replayed; exit within budget |
| outcome recording (DB lock held) | statement times out; link stays in its prior state; pool closed; exit within budget |
| new request after SIGTERM | 503 + `Retry-After`; no DB work |

Also: the pool has zero open connections at exit (checked from the test DB's
`pg_stat_activity`), and the process exits before the configured delay.

### 4.2 Client-IP trust test (T-IP; review edit 1)

Hosted, on the staging web service only, under a separately approved probe run (part of A5a:
no login, no data):
1. Two independent clients on different networks each send requests with **forged**
   `X-Forwarded-For` (several shapes: a single fake IP; a list; another client's real IP) and
   `X-Real-IP` headers. A diagnostic endpoint, present on staging only and removed before
   production, returns only the keyed **bucket hash class** (equal/not equal across requests),
   never the IP.
2. Pass: each client's requests map to that client's real source, whatever it forges; the
   two clients never share a bucket; forged values never choose the bucket.
3. Then the 21st request from one client is refused while the other client is unaffected.
4. Repeat if the hosting chain changes (custom domain, CDN). Until T-IP passes, the per-IP
   limit is recorded as unverified and the release gate for production includes it.

### 4.3 Request-body limits in plain Node (replaces Next.js protection; review edit)

QQ relies on Next.js for a framework-level body cap (`next.config.ts`
`middlewareClientMaxBodySize: "1mb"`), and its webhook checks the actual size only **after**
reading the full body. A plain Node server has no such cap, so copying that order would let
an oversized chunked request (no `Content-Length`, placeholder signature headers) consume
memory before rejection.

One shared reader, `readBodyLimited(req, maxBytes, deadlineMs)`, is used by every route that
reads a body, before any collection or parsing:
- Limits: `/auth/request`, `/auth/confirm`, `/auth/signout`, `/auth/recovery` 32 KiB;
  `/api/*` 256 KiB; `/webhooks/sendgrid` 1 MiB.
- A declared `Content-Length` above the limit is rejected before reading. Without one
  (chunked), bytes are counted **as chunks arrive**; the moment the running total exceeds the
  limit, reading stops, the socket is destroyed after a `413` (or, on the auth routes, the
  normal generic envelope with no identity work, matching QQ's "malformed body = invalid
  email" rule), and nothing is buffered beyond the limit.
- A per-request read deadline (10 s) and the server's `requestTimeout`/`headersTimeout` stop
  slow uploads. An aborted or erroring stream is treated as an empty body, with no partial
  parse.
- Webhook order: size-limited read → signature check over the exact raw bytes → only then
  JSON parse. A bad or missing signature is rejected without parsing.

Tests (T-BODY, local, A4): oversized chunked body with no `Content-Length` on each route
class (rejected; process memory stays bounded); declared oversize (rejected without
reading); webhook with a placeholder or invalid signature at and over 1 MiB (rejected, no
parse); interrupted upload and slow-drip upload (no partial parse; the socket is freed; the
auth envelope is unchanged).

### Gap findings carried forward (not copied from Quote-Queue as-is)

| Item | Quote-Queue as read | Here |
|---|---|---|
| Sign-out body parsing | `app/auth/signout/route.ts:50` calls `request.formData()` with no guard, so a malformed body throws before the CSRF check | Guarded parse, the same as QQ's own request/confirm routes |
| Host log redaction of `/auth/verify?token=` | Listed as an M0 checklist item ([QQ] `docs/BUILDER_HANDOFF.md:1359`); whether it was verified is **not** in what I read | A **release gate** (doc 14 T-HYG): canary search of Render request logs, app logs, Supabase logs and SendGrid; any hit stops the release |
| Recovery login-CSRF, recovery data matrix, kind-based renewal | n/a in QQ | Doc 14 §7, findings 1–3 |
| Webhook correlation in a shared SendGrid account | QQ correlates by `qq_source` | Separate webhook endpoint and key; `tr_source` required; events from other apps ignored |

---

## 5 · Departures from Quote-Queue that remain (each a proposal for the coordinator)

| # | Departure | Evidence | Why QQ's way can't fit as-is | Minimal adaptation | Effect on staff / security / testing |
|---|---|---|---|---|---|
| D1 | Database stays Supabase, not a Render Postgres | All carrier/batch data, PostGIS geometry and RPCs live there ([repo] `supabase/migrations/*`; `20260720000100_extensions.sql:7` PostGIS); production holds data (doc 08: ~514 MB, unverified now) | Moving the database is a data migration with outage and data-loss risk, outside the sign-in task | Keep Supabase. Close its public routes: grants revoked, Auth providers off, L1 (doc 14 §2.5, §5.2, §11.6) | Staff: none. Security: extra side doors to close and verify (probe matrix). Testing: the hosted probes (A5a/A5b) are needed; QQ didn't need them |
| D2 | Authorization stays in the database (RLS + RPCs), re-keyed to the server's session | Existing role rules are SQL policies and definer RPCs ([repo] `20260720001200_rls.sql`, `20260720001100_rpc.sql`) | QQ has no RLS; its permission code is QQ-specific. Rewriting all rules into server code risks changing permissions | The server validates the session (QQ code) **and** sets `app.session_hash` per transaction; the DB re-checks it on every statement | Staff: none. Security: double check; stale sessions can't act mid-request. Testing: the SQL role matrix and concurrency tests (A3) |
| D3 | SPA + JSON API instead of server-rendered business pages | The app is a Vite/React SPA ([repo] `app/`) | Rewriting the screens is out of scope | The sign-in pages are server-rendered exactly like QQ. The app's mutations use a CSRF header. The activity ping counts as deliberate use | Staff: same sign-in. Security: same CSRF strength (header and Origin). Testing: route tests for the ping and no renewal on polling |
| D4 | Existing identities have Supabase Auth accounts and `profiles.id → auth.users` | [repo] `20260720000300_profiles.sql:13` | QQ users are its own table rows | Backout window: Team "add" and email edits paused until M2 (doc 14 §5.4, §11.5) | Staff: new people can't be added until the window closes. Testing: backout rehearsal |
| D5 | Staging host | Staging today is a Cloudflare Worker serving static files ([repo] `app/wrangler.jsonc`; doc 11) | The new server is a Node process | Proposal: a Render web service for staging too (same code path as production). The free tier is acceptable for staging only if a ~1-minute cold start is acceptable for testing, **but** it breaks the timing tests. So a paid Starter for staging during the test period, or accept untimed staging | Cost decision for Hunter |
| D7 | Plain Node server with its own shutdown contract instead of Next.js `after()` | QQ uses Next.js `after()` + `maxDuration` ([QQ] `app/auth/request/route.ts:131-137`); this app is a Vite SPA with no Next.js | Adopting Next.js only to obtain `after()` would add a framework, a build system and a routing layer around an existing SPA. `after()` itself is "best effort, human-retried" in QQ, not a durable queue | §4.1: explicit tracking of accepted requests and continuations, stop admission, drain both, close the DB within the deadline. Fewer dependencies is **not** the justification; the justification is equivalent tested behaviour (T-SHUTDOWN) without adding a framework | Staff: none. Security: same envelope; abandoned sends stay `pending`/`unknown` and are never replayed. Testing: T-SHUTDOWN replaces QQ's "after() kill test" |
| D6 | Recovery codes | Coordinator directive | QQ has none | Doc 14 §7, off by flag until policy D2 | None until enabled |

---

## 6 · Provisioning and configuration (names only; nothing created)

Render web service (proposed name `recruiter-web`, Node 22, paid instance), env var **names**:
`DATABASE_URL` (session-pooler URL for `recruiter_app`), `APP_BASE_URL`, `EMAIL_MODE`
(`test` = fake adapter), `SENDGRID_API_KEY`, `SENDGRID_WEBHOOK_VERIFICATION_KEY`,
`SENDGRID_FROM_ADDRESS`, `KEY_TOKENS`, `KEY_SESSIONS`, `KEY_RATE`, `HEALTH_SECRET`,
`TEAM_ADD_ENABLED`, `TEAM_EMAIL_EDIT_ENABLED`, `RECOVERY_ENABLED`, `MAINTENANCE_MODE`, plus the
existing build-time `VITE_GOOGLE_MAPS_*`. **Removed** from the app: `VITE_SUPABASE_URL`,
`VITE_SUPABASE_ANON_KEY`. Each environment has its own keys and secrets, never shared with
Quote-Queue.

Supabase (per environment): the `recruiter_api` (NOLOGIN, privileges) and `recruiter_app`
(LOGIN, member) roles are created by the migration without a password. The password is set by
the operator out of band.

---

## 7 · What this changes in doc 14 and in the approvals

- **Replaced:** doc 14 §2.1 diagram, §2.3 (Worker routing → Node routing, same table), §2.4
  (Hyperdrive → `pg` via the session pooler), §6.4 (`waitUntil` → in-process continuation with
  SIGTERM drain), the `CF-Connecting-IP` line (→ QQ `request-ip.ts`), A4 (`wrangler dev` →
  local `node server` on 127.0.0.1), and "pool stop" in the backout order (→ suspend the Render
  service).
- **Renamed:** doc 14's runtime login role `recruiter_worker` is `recruiter_app` here (the `qq_app` equivalent); its classification as an authentication authority (doc 14 §2.1, T-CRED) is unchanged.
- **Unchanged:** behaviour contract, threat model, recovery design, probe matrix, L1, backout,
  T-HYG and the other test IDs. **Replaced tests:** doc 14's T-WRANGLER (workerd, `waitUntil`,
  CPU sample, `run_worker_first`) becomes **T-SHUTDOWN** (§4.1) plus a local Node run of the same
  flows, cookie attributes and static serving (A4). The `CF-Connecting-IP` assumption (E12)
  becomes **T-IP** (§4.2).
- **Approvals, revised:**
  - **A2** becomes: add `pg` and `@types/pg` to a new `server/` package (or to `app/`). No
    `wrangler` and no `@cloudflare/workers-types`.
  - **A4** becomes: start the local Node server on 127.0.0.1:8788 against the A3 throwaway
    database.
  - A3, A5a, A5b, A6 and A7 are unchanged.
- **Work already done:** none of the paused Worker code exists. Only docs are committed (14 at
  8dafc06; this file). `npm ci` was run under A1 and the baseline `npm run verify` passed.

## 8 · Owner actions (later, each separate; none now)

1. **Hosting decision:** approve a paid Render web service for production (and choose the
   staging option, D5). Cost per this repo's July 2026 notes: Starter $7/mo, not re-checked.
2. **SendGrid (Quote-Queue's account):** at rollout, create a Mail-Send-only API key and a
   second Event Webhook for this app, and confirm the plan allows another webhook
   (`max_allowed`). Choose the sender address.
3. **Supabase:** at rollout, set the `recruiter_app` password, check that the session pooler
   accepts it, and do the doc 14 switches (providers off, L1), each with its own "go".

## 9 · Sources

- [QQ] files listed in §2, read with `git -C … show origin/main:<path>` at f1167dc.
- Render: https://render.com/docs/free (spin-down 15 min, ~1 min wake, not for production);
  https://render.com/docs/deploys (SIGTERM, 30 s default shutdown delay up to 300 s, Pre-Deploy
  command on paid services).
- Supabase IPv4/IPv6: https://supabase.com/docs/guides/platform/ipv4-address ;
  https://supabase.com/docs/guides/troubleshooting/supabase--your-network-ipv4-and-ipv6-compatibility-cHe3BP ;
  community report https://community.render.com/t/issues-connecting-render-to-supabase-after-ipv6-transition/24156
- SendGrid multiple Event Webhooks: https://www.twilio.com/en-us/changelog/event-webhooks ;
  https://www.twilio.com/docs/sendgrid/api-reference/webhooks/get-all-event-webhooks
- [repo] `render.yaml`, `app/wrangler.jsonc`, `docs/build-plan/04-costs.md:39`, doc 14.

## 10 · Review response (Codex review of `a7bf236`, 2026-10-21)

| # | Finding | Change | Sections |
|---|---|---|---|
| 1 | Render IP trust assumed from "same host" | Marked unverified; hosted T-IP with forged headers and two independent clients; the per-IP limit is not accepted until it passes | §3 C8, §4.2 |
| 2 | Post-response replacement lacked a full shutdown contract | Tracks accepted requests and continuations (registered before the response); stop admission → drain both → close the pool within the deadline; T-SHUTDOWN at each phase replaces T-WRANGLER; recorded as departure D7 with its justification | §3 C7, §4.1, §5 D7, §7 |
| 3 | "Idempotency key" overstated SendGrid protection | Sends are one-shot; the custom header is diagnostic only; uncertain outcomes are never auto-replayed | §2 Mail row, §3 C5 |

---

## 11 · Reuse table against the Quote-Queue map (`1f7cce2`, infra-map §1–§6)

Line numbers are the map's, confirmed by symbol search at f1167dc where noted. One correction:
the map gives `app/auth/signout/route.ts:598-634` and `:599`. The file's handler is
`export async function POST` at lines 49-85, with the unguarded `request.formData()` at line
50 (confirmed by `git show`). f1167dc is the local remote-tracking revision, not a guarantee
of what GitHub or the live service runs. Quote-Queue's own fixes are under review and are
**not** treated as done.

| QQ component | QQ file / symbol | Verdict | This app's location (proposed) |
|---|---|---|---|
| Roster | `users` (0001:61-96) | **Not used**: the roster is `public.profiles` (existing rows, ids and roles kept) | `public.profiles` |
| Link ledger | `auth_tokens` (0001:286-322; 0002 split ids) | **Adapt**: same columns and CHECKs; app prefix | `internal.signin_links` (pending M1) |
| Sessions | `sessions` (0001:350-361) | **Adapt**: plus `kind`, `idle_window`, `absolute_expires_at`, `email_at_issue`, `revoked_reason` (doc 14 §3.5) | `internal.app_sessions` |
| Flood buckets | `auth_request_buckets` (0001:369-379), `lib/rate.ts` `incrementAuthRequestBuckets` :252, ceilings :212-213 | **Copy logic**; dimensions add `recovery_ip`/`recovery_email` only if recovery is enabled. Fixed 15-minute windows (2× burst at the edge) kept, for parity with QQ | `internal.auth_request_buckets` |
| Email events | `email_events` (0001:627-646; 0003) | **Adapt**: QQ-only digest dependencies are omitted (`digest_send_id REFERENCES digest_sends`, 0001:637; this app has no digest). Kept: unique `provider_event_id` (sg_event_id) for replay safety, correlation to the sign-in link **and** its snapshotted recipient, and block-clear evidence ordering (older evidence never overwrites newer; a manual clear is not undone by an older event) | `internal.email_events` |
| Block list | `blocked_email_addresses` (0001:654-697), `applyBlock` (webhook :1197) | **Adapt**. Doc 14 had no block list; adopted here. Blocks are **never** cleared automatically or for a retry, only by a manager action that is audited | `internal.blocked_email_addresses` |
| Audit | `admin_events` (0001:730-743), `lib/audit.ts` | **Adapt** | `internal.auth_events` |
| Send-status lattice | trigger `auth_tokens_send_status_monotonic_trg` (0001:340; function per 0007:45) | **Copy as-is** | trigger on `internal.signin_links` |
| Role split | `qq_app` / `qq_maintenance` / migration role; app has no DELETE on auth tables (0001:859-947) | **Adapt**: `recruiter_api` (NOLOGIN privileges) + `recruiter_app` (LOGIN, runtime) + `recruiter_maintenance` (retention, DELETE on auth ledgers only). Migrations stay operator-applied (C10). The app role reaches the auth ledgers through definer functions, not table grants | Supabase roles |
| request route | `app/auth/request/route.ts` POST :568-623; identity work :252-505; ceilings :304-366 | **Copy pattern**; `after()` → §4.1 contract | `server/routes/request.ts` |
| verify route | `app/auth/verify/route.ts` :81-113 | **Copy** | `server/routes/verify.ts` |
| confirm route | `app/auth/confirm/route.ts` (GET/POST; map :313-549, file lines differ) | **Copy** | `server/routes/confirm.ts` |
| sign-out | `app/auth/signout/route.ts` POST :49-85 | **Adapt**: guarded body parse (QQ defect D2) | `server/routes/signout.ts` |
| Session helpers | `lib/auth/session.ts` `createSession` :99-112, `validateAndRenewSession` :182-225 | **Copy logic**; kind-dependent windows | `server/auth/session.ts` |
| Revocation | `lib/auth/revoke.ts` `revokeAllForUser`, `revokeSession` | **Adapt**: also done by a **DB trigger** on profile email/role/status (QQ defect D1 fixed) | trigger + `server/auth/revoke.ts` |
| Mask, cookies, CSRF, keys | `lib/auth/mask.ts`, `lib/cookies.ts` :52-71, `lib/csrf.ts` :56/:90, `lib/keys.ts` | **Copy**; cookie names `__Host-tr_*`; strict Origin for `/api/*` mutations and recovery | `server/auth/*` |
| Client IP | `lib/request-ip.ts` `getClientIp` :44 | **Adapt after T-IP** (§4.2) | `server/http/ip.ts` |
| Security headers | `middleware.ts` :53-165 | **Adapt**: every redirect is built from `APP_BASE_URL`, never from the request URL (QQ defect D4) | `server/http/headers.ts` |
| SendGrid seam + mock | `lib/sendgrid.ts` `sendCanonical` :226-227, `getEmailAdapter` :561; `lib/sendgrid.mock.ts` | **Copy**: tracking-off guard kept; one-shot; the diagnostic header is not idempotency; uncertain → `unknown`, never replayed. Config errors never echo values or parse text (QQ defect D3) | `server/mail/*` |
| Webhook | `app/webhooks/sendgrid/route.ts`: signature :356-420, cap :383, mapping :681-705, `applyAuthSendEvidence` :973-1027, recipient re-check :869-905 | **Copy logic**; own key; `tr_source` required. Before reuse, re-validate: the meaning of negative events (`bounce` blocked vs hard, `dropped` reasons, `spamreport`, `unsubscribe`), recipient correlation, and replay via the unique `sg_event_id`. No freshness window, as in QQ (flagged unconfirmed there) | `server/routes/webhook.ts` |
| Retention | `scripts/retention.ts` (buckets 48 h; tokens/sessions 30 days past end; events 180 days) | **Copy logic**; runs as `recruiter_maintenance`. Host: one nightly step. Where it runs (a step in the existing Render cron, or its own cron at the $1/mo floor, 04-costs §7 rule 6) is an owner choice | `server/scripts/retention.ts` |
| Sign-in/confirm look | `app/signin/page.tsx`, `signin.css`, confirm page CSS | **Copy** (decisions 19/35): "CARRIER RECRUITER"; badge is byte-identical (doc 14 E11) | server-rendered pages |
| Timing test | `tests/auth-request.test.ts:433-434` allows 850–3000 ms (QQ defect D5) | **Not copied**: the acceptance band is 900–1100 ms | T-TIME |
| `/auth/verify` log handling | unverified live (QQ defect D6) | **Release gate** T-HYG | — |
| Handoff prose | `docs/BUILDER_HANDOFF.md` (Resend, three-role text stale; QQ defect D7) | **Not used** as a source without checking the code | — |
| `recover:prod` | record-repair CLI | **Not used** as a sign-in fallback | — |
| Roster edit authorization (QQ D8 / review F-1) | `lib/roster.ts` `attemptEdit` (~:737) uses an actor role captured **before** the write transaction | **Do not copy.** QQ's evidence is an in-memory probe, not a live exploit or a DB concurrency test, and nothing here was measured on this app. Here the actor is re-validated inside the write transaction from locked rows (§14.2) | — |
| Pre-response DB call (review F-2) | unbounded bucket call before the response | **Do not copy.** Bounded and uniformly fail-closed (§14.4) | — |
| Recovery codes | none in QQ | **New** (doc 14 §7), off by flag, policy centralized | — |
| Keys, DB, sender, webhook key, API key, origin | per app | **Per app only**, never shared | Render env (names in §6) |

**Minimal justified deviations** (details in §5): D1 the database stays Supabase; D2 permission
rules stay in the database and are re-keyed (double check with the server); D3 SPA + JSON API
with a header CSRF token and an activity ping; D4 Supabase identities need a backout window;
D5 staging host choice; D6 recovery codes (new); D7 plain Node shutdown contract instead of
`after()`. Plus the QQ defect fixes D1–D6 above, which are not deviations in behaviour.

---

## 12 · Data-access and permission migration boundary inventory (evidence at 9fc3425)

The map's list of unavoidable differences does not cover this app's own integration work. This
section is that work. Every item is either **moves**, **re-keyed** or **unchanged**.

### 12.1 App → database calls (all move behind the server)

Measured with `grep` over `app/src` (tests excluded). Each call becomes a named server route
executed as `recruiter_app` with `app.session_hash` set, so the same RLS and RPC rules apply.

| File:line | Call | Kind | Server route (proposed) |
|---|---|---|---|
| `app/guards.tsx:29` | `from('profiles')` own row | read | `GET /api/session` (from the session row; no profile read for recovery) |
| `app/guards.tsx:43, 49, 143` | `auth.getSession`, `onAuthStateChange`, `signOut` | auth | `GET /api/session`; 401 → full navigation; sign-out form |
| `app/Sidebar.tsx:49` | `from('profiles')` pending count | read | `GET /api/team/pending-count` (manager) — or removed with the pending badge |
| `app/Sidebar.tsx:141` | `auth.signOut` | auth | `POST /auth/signout` form |
| `features/auth/Login.tsx:31`, `Register.tsx:21`, `Forgot.tsx:18`, `Reset.tsx:24, 43`, `Pending.tsx:15` | `signInWithPassword`, `signUp`, `resetPasswordForEmail`, `getSession`, `updateUser`, `signOut` | auth | **removed** (server-rendered `/signin` replaces them) |
| `features/batch/BatchPage.tsx:33` | update `batch_carriers.status` | write | `POST /api/batch-carriers/status` |
| `features/batch/BatchPage.tsx:60` | `batches` + `batch_zones` | read | `GET /api/batches/:id` |
| `features/batch/BatchPage.tsx:79` | `batch_activity` + `profiles(full_name)` | read | `GET /api/batches/:id/activity` |
| `features/batch/BatchPage.tsx:92` | insert `batch_activity` comment | write | `POST /api/batches/:id/comments` (actor from the session) |
| `features/batch/BatchPage.tsx:103` | insert `contact_logs` | write | `POST /api/contact-logs` (user from the session) |
| `features/batch/sheet/ContactSheet.tsx:31` | `batches` header | read | `GET /api/batches/:id/sheet-header` |
| `features/batch/sheet/ContactSheet.tsx:32, 38` | `auth.getSession` + own `profiles` name/email | auth/read | from `GET /api/session` |
| `features/carrier/CarrierProfile.tsx:18-25` | `carriers`, `carrier_insurance`, `carrier_safety`, `carrier_inspections`, `carrier_warnings`, `contact_logs`(+profiles, batches), `batch_carriers`(+batches), `contact_suppressions` | read ×8 | `GET /api/carriers/:dot/profile` (one transaction) |
| `features/carrier/CarrierProfile.tsx:68` | update `batch_carriers.promoted_at` | write | `POST /api/batch-carriers/promote` |
| `features/carrier/CarrierProfile.tsx:79` | insert `contact_logs` | write | `POST /api/contact-logs` |
| `features/dashboard/Dashboard.tsx:42` | `batch_dashboard` view | read | `GET /api/dashboard` |
| `features/users/UsersAdmin.tsx:10, 24` | list / update `profiles` | read/write | Team routes `GET /api/team`, `POST /api/team/{edit,deactivate,reactivate}` (definer functions with B10 checks) |
| `lib/dnc.ts:8, 9` | `carriers.do_not_contact`, `contact_suppressions` | read | `POST /api/dnc/lookup` |
| `lib/rpc.ts:103-364` | 17 RPCs: `search_carriers`, `count_carriers`, `facet_other_values`, `facet_suggested_keywords`, `facet_cargo_flags`, `create_batch`, `refresh_batch`, `bulk_set_status`, `set_do_not_contact`, `log_export`, `batch_members`, `batch_members_map`, `search_carriers_map` (:310), `generate_contact_sheet`, `batch_status_counts`, `dashboard_totals`, `is_contactable` | rpc | `POST /api/rpc/:name`, allow-list = exactly these 17 (= the grants in `20260722223300_security_hardening.sql:39-57`); `rpc.ts` keeps its exported signatures |

Totals: **24 table calls, 17 RPC wrappers, 11 Auth calls.** Auth, exactly: 11 calls: `app/guards.tsx:43` getSession, `:49` onAuthStateChange, `:143` signOut; `app/Sidebar.tsx:141` signOut; `features/auth/Forgot.tsx:18` resetPasswordForEmail; `Login.tsx:31` signInWithPassword; `Pending.tsx:15` signOut; `Register.tsx:21` signUp; `Reset.tsx:24` getSession, `:43` updateUser; `features/batch/sheet/ContactSheet.tsx:32` getSession. (Earlier docs said 12: that `grep -c` also counted the comment at `lib/supabase.ts:72`.)

No `.storage`, `.channel` or Realtime use in the app (`Topbar.tsx:60` TODO). `lib/supabase.ts`
and the `VITE_SUPABASE_*` variables leave the bundle.

### 12.2 Database permission dependencies

| Dependency | Evidence | Change |
|---|---|---|
| `auth.uid()` in trigger functions `log_bc_change` (4 uses), `log_bc_delete` (1) | `20260720000800_activity.sql:25, 27, 31, 33, 44` | **re-keyed** → `internal.current_staff_id()` (bodies otherwise identical); the comment at :53 updated |
| `auth.uid()` in definer RPCs `create_batch` (3), `refresh_batch` (1), `bulk_set_status` (2), `log_export` (1) | `20260720001100_rpc.sql:400, 424, 426, 485, 512, 522, 599` | **re-keyed** |
| `auth.uid()` in `set_do_not_contact` | original `20260720001100_rpc.sql:541`; current body `20260723010400_dnc_activity_enum_cast.sql:17` | **re-keyed** (from the latest body) |
| `auth.uid()` in `current_app_role()` | `20260720001200_rls.sql:43` | **re-keyed** to the session ledger, `kind='link'` only; `is_staff`/`can_edit`/`is_manager` (:45-50) follow unchanged |
| `auth.uid()` in policies `profiles_select`, `profiles_update_self`, `batches_write`, `logs_insert`, `act_comment` | `20260720001200_rls.sql:78, 80, 118, 143, 153` | `profiles_select` → staff (link session) only; `profiles_update_self` dropped; `profiles_update_mgr` (:82) dropped (Team routes use definer functions); the other three re-keyed |
| All other policies (`is_staff`/`can_edit`/`is_manager` only) | `20260720001200_rls.sql:91-163`; `20260720001400_pipeline_tables.sql:115-119` | **unchanged** text; behaviour follows the re-keyed helpers |
| Views `carrier_warnings`, `batch_dashboard`, `sync_runs` (security_invoker) | `20260720000900_warnings.sql:50`; `20260720001100_rpc.sql:790`; `20260720001400_pipeline_tables.sql:128` | **unchanged**; their grants move from `authenticated` to `recruiter_api` (`rls.sql:170-171`, `pipeline_tables.sql:154`) |
| Column-limited update grants | `20260720001200_rls.sql:94-97` (`carriers`), `:111-112` (`cargo_other_values`) | **mirrored** to `recruiter_api`; revoked from `authenticated` |
| Function grants to `authenticated` | `rls.sql:176-196`; `security_hardening.sql:35-74`; `dnc_activity_enum_cast.sql` last 2 lines | **moved** to `recruiter_api`; `anon`/`authenticated` lose all |
| Table/sequence privileges of `anon`/`authenticated` (Supabase default privileges) | `rls.sql:9-13` comment | **revoked**; default privileges revoked for objects the migration role creates (objects created by other platform roles: **[assume]**, probed by A5a) |
| `guard_profile_update()` uses `auth.role()` for the service-role bypass and `is_manager()` | `20260723004500_profile_service_bootstrap.sql:10-23` | **unchanged** (manager path now session-based) |
| `handle_new_user` trigger on `auth.users` | `20260720000300_profiles.sql:29-37` | **unchanged**; signups off, so it no longer fires in practice |
| `profiles.id → auth.users(id) on delete cascade` | `20260720000300_profiles.sql:13` | **unchanged in M1**; dropped in M2 only after the backout window (D8) |
| Realtime publication (6 tables) | `20260720001300_realtime.sql:9-11` | removed in M1 (reversible in backout); not used by the app |
| DNC guard trigger on `contact_logs` | `20260723020000_contact_logs_dnc_guard.sql` | **unchanged** (no `auth.*` use) |
| Staging role matrix uses `request.jwt.claims` + `set local role authenticated` | `supabase/staging/verify-role-matrix.sql:15, 46, 53` | **updated** to session fixtures + `recruiter_api` |

### 12.3 Pipeline, service-role and operator paths (unchanged)

| Path | Evidence | Effect of the change |
|---|---|---|
| Pipeline supabase-js with the service-role key (PostgREST): `pipeline_runs`, `data_quality_reports` | `pipeline/src/db.ts:65`; `runs.ts:60, 86, 118, 214`; `dq-report.ts:192` | none: `service_role` keeps its grants (`20260720001500_service_role_pipeline_grants.sql`); PostgREST stays enabled for it |
| Pipeline direct `pg` (`SUPABASE_DB_URL`): inserts into `carriers`, `carrier_insurance`, `carrier_insurance_filings`, `carrier_safety`, `cargo_other_values` | `pipeline/src/db.ts:74`; `pipeline/src/**` insert statements | none: no `auth.uid()` on those tables; no `app.session_hash`, so `current_staff_id()` is null exactly as `auth.uid()` is today |
| Pipeline never touches `batch_carriers`, `batch_activity`, `profiles` | `grep` over `pipeline/src`: no match | the re-keyed triggers are not on its path |
| Staging fixture scripts, SQL runner, marker, reset, cleanup and their offline checks | `scripts/seed-auth-users.ts`, `scripts/cleanup-auth-users.ts`, `pipeline/src/staging-sql-runner.ts`, `supabase/staging/*`, `scripts/verify-staging-*.mjs`, `scripts/check-hosted-fixtures.mjs` | **adapted**, see §12.5 (not unchanged) |

### 12.4 What stays unchanged

Business tables and all rows; profile ids, emails, roles (manager/edit/view → Manager/Editor/
Viewer) and statuses, including legacy pending/guest; every policy predicate apart from the
5 `auth.uid()` policies; every RPC body apart from the `auth.uid()` swap; the matcher, PostGIS
and warnings; the pipeline and its schedule; the SPA screens (only the data layer changes);
Google Maps.


### 12.5 Staging SQL adaptations (behaviour before and after M2)

Today, staging identities are Supabase Auth rows tagged in `raw_user_meta_data` (`test_only`,
`test_run_id`), and several scripts use that tag as the proof of ownership. After M2 removes
the `profiles → auth.users` FK, new profile-only fixtures have no Auth row, and deleting from
`auth.users` no longer removes the profile. So these files change. Every production-refusal
protection stays: the runner's target parser and production-ref refusal, the
`app.staging_runner_verified_ref` check, the marker table with its fixed id, the
confirmation phrases, the "never in `supabase/migrations`" rule, and the offline
production-ref scans.

| File (evidence) | Today | M1 (FK kept; backout window) | After M2 (FK dropped) |
|---|---|---|---|
| `supabase/staging/profile-fixtures.sql` (inserts into `auth.users` at :8 with tag metadata, then updates `profiles` at :31) | Auth rows + profiles; includes pending (…0005) and guest (…0006) | Unchanged rows. Add app-session fixtures only inside role-matrix transactions (rolled back) | Fixtures become **profile-only**, registered in a new `staging_identity.fixture_identities(profile_id, test_run_id)` table (the ownership registry for identities, alongside `fixture_rows`). No `auth.users` insert. Pending/guest fixtures are kept, as legacy-state probes |
| `supabase/staging/install-staging-identity-marker.sql` (`v_other_profiles` at :45-56 recognises fixtures through `auth.users` metadata) | refuses if any profile is not a tagged fixture or the owner | unchanged | Recognises fixtures through `fixture_identities` **or** the existing Auth tag, so it works on both old and new databases. Still refuses unknown profiles (refusal logic kept); still deletes nothing |
| `supabase/staging/cleanup-fixtures.sql` (fixture ids from `auth.users` metadata at :50-52; `delete from auth.users` at :104) | deletes registered business rows, then fixture Auth users (profiles cascade) | Adds: revoke and delete fixture rows in `internal.app_sessions`, `internal.signin_links`, `internal.recovery_codes`, `internal.email_events`, `internal.blocked_email_addresses` and `internal.auth_events` for fixture profile ids only, **before** the identity delete (they reference `profiles`) | Deletes fixture **profiles** listed in `fixture_identities` (and any legacy tagged Auth users), after the auth-ledger rows; refuses if a non-fixture row still references a fixture profile (existing check at :99 kept) |
| `supabase/staging/reset-fictional-data.sql` (`v_other_profiles` at :76-79 via `auth.users`; `v_fixture_profiles <> 7`; preserves `auth.users` and `profiles`, :124) | resets business rows only | Unchanged, plus clears fixture auth-ledger rows (sessions, links, buckets) so each reset starts clean | Ownership through `fixture_identities`; the count check becomes the registry count; never deletes non-fixture profiles |
| `supabase/staging/verify-role-matrix.sql` (`request.jwt.claims` at :15; `set local role anon/authenticated` at :46, :53) | JWT claims + Supabase roles | Probes as `recruiter_api` with `app.session_hash` fixture sessions (link and recovery kinds) inserted inside the rolled-back transaction; adds the doc 14 probes (revoked, expired, idle, recovery matrix, Viewer recovery write, own-profile read) and **anon/authenticated must now be denied everything** | Same |
| `scripts/seed-auth-users.ts`, `scripts/cleanup-auth-users.ts` (Admin API `createUser`/`deleteUser`, :90, :121, :53, :101) | create/delete hosted Auth fixtures with passwords | Kept only for the L1 and A5b probes (pre-cutover tokens); otherwise unused | Retired for app tests (staff never use Supabase Auth). Kept only if A5b still needs Auth fixtures; same guards |
| `scripts/verify-staging-contract.mjs` (requires `encrypted_password` and `raw_user_meta_data->>'test_only'` in fixtures/cleanup, :26-33) | static checks | Adds checks: cleanup clears the auth ledgers for fixture ids only; role matrix uses `recruiter_api` + `app.session_hash` and rolls back | Fixture checks switch to `fixture_identities`; the production-ref, staging-ref, marker, no-delete-in-installer and not-in-migrations checks are unchanged |
| `scripts/verify-staging-reset.mjs` (`v_fixture_profiles <> 7`, "reset must preserve auth.users/profiles", :43, :60-61) | static checks | Adds: the auth-ledger clean-up is scoped to fixture ids | Ownership via `fixture_identities`; "never delete non-fixture profiles" replaces the `auth.users` rule |
| `scripts/check-hosted-fixtures.mjs` (scans the seed/cleanup scripts) | static checks | unchanged | Retired with the scripts, or unchanged if they are kept |
| `pipeline/src/staging-sql-runner.ts` | target guard, actions, confirmations | Adds actions for the new staging scripts (same guard and confirmations) | Same |

These are staging-only files (never in `supabase/migrations`), changed in the staging slice
and reviewed with it. The M2 column applies only after Hunter closes the backout window.

## 13 · Review response (Codex review of `85032d7`, 2026-10-21)

| # | Finding | Change | Sections |
|---|---|---|---|
| 1 | Plain Node loses QQ's framework body cap | Streaming `readBodyLimited` enforced before collection/parsing, per-route limits, read deadline, signature before parse; T-BODY tests (chunked oversize, invalid signature, interrupted and slow uploads) | §4.3 |
| 2 | Staging SQL is not unchanged | Inventory of fixtures, ownership registry, marker, reset, cleanup, role matrix, Auth fixture scripts, offline checks and runner: today / M1 / after M2; all production-refusal protections kept | §12.3, §12.5 |
| 3 | Email events are Adapt, not Copy | Digest dependency omitted; uniqueness, recipient correlation and block-clear ordering kept | §11 |
| 4 | Auth call count | Exactly 11 (listed); the earlier 12 counted a comment. Doc 14 corrected too | §12.1; doc 14 §4.2, E10 |

---

## 14 · In-transaction authorization boundary (QQ review F-1 to F-4)

Quote-Queue's reviewer (thr_ih34gmismw) found its design 9c34608 **not ready**. Its findings
are under revision in QQ and are **not** completed fixes. This section shows how this app
avoids each one. Nothing here is measured; the tests in §14.6 are the evidence still to come
(they need A3/A4).

### 14.1 Privileged mutations: exact role set and session kind per operation

`user_role` is declared `('manager','edit','view','guest')`
(`20260720000200_enums.sql:9`), and PostgreSQL orders enum values by declaration. So
`role >= …` comparisons would **reverse** permissions. They are forbidden. Permissions use
**explicit allowed-role sets** only:

- `STAFF = {manager, edit, view}`
- `EDITOR = {manager, edit}`
- `MANAGER = {manager}`

Status must be `approved`, and `guest` is never in any set. An offline contract check fails
the build if any SQL compares `user_role` with `<`, `>`, `<=` or `>=`, or uses `max`/`min` on
it.

| # | Mutation | Path | Allowed roles | Session kinds | Other conditions kept |
|---|---|---|---|---|---|
| M1 | Team: edit name | `internal.team_update` | MANAGER | link | B10 not self |
| M2 | Team: change role | `internal.team_update` | MANAGER | link | B10 never self; last active manager kept (under roster lock) |
| M3 | Team: deactivate / reactivate | `internal.team_set_active` | MANAGER | link | B10; last active manager kept |
| M4 | Team: change email | `internal.team_update` | MANAGER | link | paused in the backout window (trigger) |
| M5 | Team: add | `internal.team_add` | MANAGER | link | disabled until M2 |
| M6 | Team: revoke recovery codes; clear email block | `internal.team_recovery_revoke`, `internal.team_block_clear` | MANAGER | link | audited |
| M7 | DNC set / restore | `set_do_not_contact` | EDITOR | link | — |
| M8 | Promote | UPDATE `batch_carriers.promoted_at` via `bc_update` | EDITOR | link | — |
| M9 | Status change (single) | UPDATE `batch_carriers.status` via `bc_update` | EDITOR | link | — |
| M10 | Bulk status | `bulk_set_status` | EDITOR | link | — |
| M11 | Create / refresh batch | `create_batch`, `refresh_batch` | EDITOR | link | — |
| M12 | Log export | `log_export` | EDITOR | link | — |
| M13 | Comment | INSERT `batch_activity` via `act_comment` | EDITOR | link | `activity_type = 'comment'` and `actor_id = current_staff_id()` |
| M14 | Contact log | INSERT `contact_logs` via `logs_insert` | EDITOR | link | `user_id = current_staff_id()`; DNC guard trigger |
| M15 | Direct batch insert | INSERT `batches` via `batches_write` (`rls.sql:118`) | EDITOR | link | `created_by = current_staff_id()` |
| M16 | Recovery: single status change | `public.recovery_set_status` | EDITOR (the person's ordinary role) | **recovery only** | §7.3 matrix; DNC carriers refused |
| M17 | Own session: sign out; activity ping | `internal.auth_session_revoke`, `internal.auth_session_touch` | STAFF | **link or recovery** | own session row only; touch uses the row's kind windows |
| M18 | Own recovery set: enroll | `internal.recovery_enroll` | STAFF (D2 may narrow to MANAGER) | link, created ≤ 15 min ago | §14.5 |

**Every write policy, with its exact guard** (`20260720001200_rls.sql`; M1–M6 have no write
policy because `profiles_update_mgr` (:82) and `profiles_update_self` (:80) are dropped, so
profiles change only through the Team functions):

| Policy (line) | Command | Today | New guard (role set, kind = link) | Other conditions kept |
|---|---|---|---|---|
| `carriers_update` (:92-93) | update | `can_edit()` | `actor_can_write(EDITOR)` | column grants (:94-97) |
| `cov_update_mgr` (:109-110) | update | `is_manager()` | `actor_can_write(MANAGER)` | column grants (:111-112) |
| `batches_write` (:118) | insert | `can_edit() and created_by = auth.uid()` | `actor_can_write(EDITOR)` | `created_by = current_staff_id()` |
| `batches_update` (:119) | update | `can_edit()` | `actor_can_write(EDITOR)` | — |
| `batches_delete` (:120) | delete | `is_manager()` | `actor_can_write(MANAGER)` | — |
| `zones_write` / `zones_update` / `zones_delete` (:124-126) | insert/update/delete | `can_edit()` | `actor_can_write(EDITOR)` | — |
| `bc_insert` / `bc_update` (:133-134) | insert/update | `can_edit()` | `actor_can_write(EDITOR)` | — |
| `bc_delete` (:135) | delete | `is_manager()` | `actor_can_write(MANAGER)` | — |
| `logs_insert` (:142-143) | insert | `can_edit() and user_id = auth.uid()` | `actor_can_write(EDITOR)` | `user_id = current_staff_id()` |
| `logs_delete` (:144) | delete | `is_manager()` | `actor_can_write(MANAGER)` | — |
| `act_comment` (:152-153) | insert | `can_edit() and activity_type = 'comment' and actor_id = auth.uid()` | `actor_can_write(EDITOR)` | `activity_type = 'comment'`, `actor_id = current_staff_id()` |
| `act_delete` (:154) | delete | `is_manager()` | `actor_can_write(MANAGER)` | — |
| `suppress_insert` (:162) | insert | `can_edit()` | `actor_can_write(EDITOR)` | — |
| `suppress_delete` (:163) | delete | `is_manager()` | `actor_can_write(MANAGER)` | — |

Read policies keep `(select internal.is_staff())` (stable; link sessions only). Definer
functions that today check `can_edit()` (`create_batch`, `refresh_batch`, `bulk_set_status`,
`set_do_not_contact`, `log_export`) call the lock sequence with EDITOR instead.

### 14.2 One executable lock sequence

`internal.lock_and_validate(p_roles user_role[], p_kinds text[], p_targets uuid[] default
'{}', p_roster boolean default false, p_session_mode text default 'share') returns uuid`
(volatile, security definer). It is the **only** way any operation takes its identity locks,
and it runs before any other lock in the transaction:

1. If `p_roster`: `select … from internal.roster_lock for update`.
2. Resolve `app.session_hash` to (session id, actor id) with a plain read (no lock).
3. Let `P` = sorted distinct (`{actor}` ∪ `p_targets`), ascending by id. For each id in
   order, take its **final** mode at once: `FOR NO KEY UPDATE` if the id is a target (the id
   never changes, and this mode does not block other transactions' foreign-key checks on
   that profile), otherwise `FOR SHARE`. (Actor = target, as in enrollment, takes `FOR UPDATE` once.) There is never a
   lock upgrade.
4. Lock the actor's session row in its final mode: `FOR UPDATE` when the operation updates it
   (M17), otherwise `FOR SHARE`.
5. Validate **from the locked rows**:
   - session unrevoked; `expires_at` and `absolute_expires_at` in the future;
   - `kind = any(p_kinds)`;
   - profile `status = 'approved'` and `role = any(p_roles)`;
   - `email_at_issue = profiles.email`;
   - plus operation checks that need locked targets (B10, last manager).

   Failure → `raise insufficient_privilege` (fixed SQLSTATE).
6. Record in a transaction-local setting (session id, actor, role, kind, set of locked ids
   and modes).

Later locks in the same transaction follow the global order in §17.2: business rows (classes
B1–B7), then other people's sessions (revocation trigger), links, and recovery sets and
codes. Nothing takes a profile or roster lock after step 6.

Who calls it:
- **Team functions** (M1–M6): one call with `p_roster = true` for M2, M3 and M5,
  `p_targets = {target}`, `p_roles = MANAGER`, `p_kinds = {link}`. The server calls only the
  function, so the function's call is the transaction's first locking step, also when
  `recruiter_app` calls it directly.
- **Definer RPCs** (M7, M10–M12) and `recovery_set_status` (M16), `recovery_enroll` (M18),
  `auth_session_revoke`/`touch` (M17): each makes its single call with its row's role set
  and kinds, as its first statement.
- **Policy writes** (M8, M9, M13–M15 and the M15-class rows above): `actor_can_write(roles)`
  reads the transaction-local record. If absent, it calls
  `lock_and_validate(roles, '{link}')` (actor only: no targets, no roster, so steps 1 and 3
  are trivially in order). If present, it checks the recorded role is in `roles` and the
  recorded kind is link. It never takes a new identity lock in a different order. The server
  starts such transactions with an explicit `lock_and_validate` call with the same arguments.
- A function that finds an existing record **for a different, incompatible lock set** (for
  example, a Team function after a policy write in the same transaction) raises instead of
  locking out of order. The server never combines such operations in one transaction.

**Why a stale snapshot cannot win** (unchanged in substance from revision 5). Take a change T
on person X racing X's write W:
- **W's step 3 locks X first:** T waits on X; W commits first and stands (ordered before; no
  retroactive cancellation; audited).
- **T locks X first:** W waits, re-reads the committed row, and fails at step 5.
- **T committed before W started:** W fails at step 5.

Authority comes only from rows locked in the transaction. Two Team operations take the roster
lock (when either may change the manager set) and then profiles in id order, so opposing edits
cannot hold one actor while waiting for the other. Enrollment takes its single
`FOR UPDATE` at step 3, with no share-then-upgrade.

### 14.3 (merged into §14.2)

### 14.4 Pre-response work is bounded through transaction completion, and fail-closed (F-2)

Deadlines are enforced on the **transaction**, not just on the JavaScript promise:
- **Server-side limits** set `LOCAL` at the start of every transaction: `lock_timeout` 200 ms,
  `statement_timeout` 400 ms, `idle_in_transaction_session_timeout` 1 s. The database
  therefore aborts a stalled statement or an abandoned open transaction by itself.
  (`transaction_timeout` exists only from PostgreSQL 17; the hosted version is 15, so it is
  not relied on.)
- **Client side:** pool acquisition ≤ 250 ms. If the operation's deadline passes **before
  `COMMIT` was sent**, the server sends a cancel for the running query and **destroys** the
  connection (`client.release(err)`, never returned to the pool). An uncommitted transaction
  is rolled back when its backend notices the cancel or the closed connection, within the
  statement and lock timeouts above.
- **The response follows the known outcome.** Success is reported only when `COMMIT` was
  acknowledged. If `COMMIT` was sent but no acknowledgement arrived by the decision point (a
  **lost ack**), the outcome is **uncertain**: the connection is destroyed and the user gets
  the operation's generic failure. The uncertain case is handled honestly per route:
  - `/auth/request` bucket: a late commit only makes limits stricter. Identity work is skipped.
  - `/auth/recovery`: the deadline is the decision point at 900 ms (before the 1000 ± 100 ms
    envelope). On a lost ack the code may have been consumed and a session row created, but
    that session's raw value never left the server, so nobody can use it. It expires at the
    1-hour idle limit, and the person uses another code. The audit row (written in the same
    transaction) shows "code used, session delivery unconfirmed" (it is written before COMMIT, so it cannot know the outcome) for managers. There are no
    automatic retries.
  - `/auth/confirm` (link redeem): on a lost ack the link may be consumed. The page shows
    "This link was already used or has expired.", and the person requests a new link. The
    orphan session is unusable, as above.
  - `/api/*` writes: a lost ack → `503 {"error":"outcome_unknown"}`. The SPA shows "We couldn't
    confirm the save. Refresh to check before trying again." and never auto-retries a
    mutation (there is no idempotency key).
- `/auth/request` and `/auth/recovery` give the identical generic response at the envelope
  for every error, timeout or uncertain case; no identity work runs on a failed admission;
  no profile is locked before a valid recovery code (§14.5).

### 14.5 Recovery consumption and enrollment ordering (F-3, F-4)

**Consumption** (`POST /auth/recovery`, after the anonymous checks of doc 14 §7.2):
1. **Non-locking pre-check:** `select c.id, s.user_id from recovery_codes c join
   recovery_sets s … join profiles p … where c.code_hash = $1 and lower(p.email) = $2 and
   c.used_at is null and c.revoked_at is null and s.revoked_at is null and c.expires_at >
   now()`. No row → record a failure in the email-hash-keyed counter and return the generic
   failure. **No profile is locked on any wrong-code path.**
2. Only after a valid code: lock the profile `FOR SHARE` (order step 2). The requester has
   already proved possession of a valid code for that address, so this wait reveals nothing
   new.
3. `update recovery_codes set used_at = now() where id = $id and used_at is null and
   revoked_at is null returning id` (step 5). Zero rows (a concurrent revocation or use won) →
   generic failure.
4. Re-validate the locked profile (active staff, ordinary role per §7.3) → insert
   `app_sessions(kind='recovery', recovery_code_id = $id, …)` (unique, so one session per
   code) → commit.

This ordering satisfies `check (used_at is null or revoked_at is null)`: revocation updates only
unused codes, and consumption only unrevoked ones, each under the same row lock.

**Enrollment:** one `lock_and_validate(STAFF, '{link}', p_targets => {actor})` call (profile
`FOR UPDATE` once, no upgrade) → session `FOR SHARE` → re-validate under lock (link session
created ≤ 15 minutes ago) → revoke the active set → insert the new set → commit.
The `unique (user_id) where revoked_at is null` index on `recovery_sets` is the backstop: two
concurrent enrollments serialize on the profile lock, and the second revokes the first set. If
anything slips past, the index refuses a second active set.

### 14.6 Tests (T-AUTHZ; two DB connections with `pg_sleep` and advisory-lock choreography; A3, plus A4 for the server paths)

| Case | Expected |
|---|---|
| Role loss: X starts a protected write (has passed `lock_and_validate`), M demotes X | demotion waits; X's write commits first; then X's sessions are revoked; audit order matches |
| Role loss, reverse: M's demotion holds X's row; X's write arrives | X waits, then fails with `insufficient_privilege`; no row written |
| Same two orders for deactivation, and for email change (with the window closed in the test DB) | same |
| Self-repromotion: manager X demoted while X's Team call (promote X, or promote Y) is in flight | refused when the demotion committed first; B10 refuses self-change in every order |
| Two managers demote each other concurrently | serialized on `roster_lock`; the last-manager rule holds |
| Direct `recruiter_app` SQL: writes through each policy and RPC without calling the server | `lock_and_validate` runs (seen in `pg_locks`); stale/revoked sessions refused |
| Recovery capability: recovery session calls EDITOR paths, policy writes and normal RPCs | refused; `recovery_set_status` works only for ordinary edit/manager |
| Recovery wrong code while another transaction holds the profile `FOR UPDATE` | returns at the envelope **without waiting** (no lock taken) |
| Recovery consumption vs revocation, both orders | exactly one of "used + session" or "revoked + refused"; the check constraint is never violated |
| Two concurrent enrollments | exactly one active set; the other set revoked or refused |
| Slow or unavailable DB: pool exhausted, bucket row locked > 200 ms, `pg_sleep` > 400 ms, connection refused | `/auth/request` and `/auth/recovery` return the identical generic response at 900–1100 ms with no identity work; verify/confirm show the fail-closed page; `/api/*` returns 503 |
| Deadlock probe: opposite-order Team edits on two profiles | no deadlock (ascending-id order) |
| **Role matrix:** every role state (manager, edit, view, guest, pending, disabled) × every operation M1–M18 and every write policy, for link and recovery sessions | allowed exactly per §14.1; guest/pending/disabled always refused |
| **Editor denial:** a valid Editor (link session) attempts every MANAGER operation: `batches_delete`, `bc_delete`, `logs_delete`, `act_delete`, `suppress_delete`, `cov_update_mgr`, M1–M6, direct and through the server | all refused; no row changed |
| Viewer attempts every EDITOR operation, including direct `batches` insert (M15) | all refused |
| Enum-order guard: offline check scans the migration for `user_role` ordering comparisons | none found |
| Kinds: recovery session on M16 (allowed if ordinary role is EDITOR), on M7–M15 (refused), on M17 (allowed); link session on M16 (refused) | as stated |
| Lock sequence: Team edit A→B and B→A concurrently; enrollment twice concurrently; Team edit vs the target's policy write | no deadlock; `pg_locks` shows roster → profiles ascending → sessions; no upgrade |
| **Late consumption:** the recovery consume statement is held behind a lock past the deadline | the client cancels and destroys the connection; afterwards the code is unused and no session exists |
| **Stalled transport:** an in-process TCP relay (Node `net`, no dependency) stops forwarding mid-transaction | deadline hit; connection destroyed; the server-side transaction rolls back (checked from a second connection after `idle_in_transaction_session_timeout`); the pool is not poisoned |
| **Lost commit ack:** the relay forwards `COMMIT` and drops the reply | generic failure to the user; the code shows used with an undelivered session (unusable raw value), the audit row present; for `/api/*` the response is `outcome_unknown` |

## 15 · Review response (coordinator-relayed QQ findings, 2026-10-21)

| Item | Change | Sections |
|---|---|---|
| (1) QQ D8 on the do-not-copy list | Added (and F-2) | §11 |
| (2) Privileged-mutation inventory | M1–M18 | §14.1 |
| (3) Re-validate session + actor role inside the write transaction | (revision 5: `require_actor`; superseded by `lock_and_validate`, §16) from locked rows: first statement, inside definer RPCs, in write policies | §14.3 |
| (4) Lock order shared with demotion/deactivation/email change; committed-before ordering defined | §14.2 order; the "why a stale snapshot cannot win" cases; no retroactive cancellation | §14.2, §14.3 |
| (5) F-2 bounded, uniform fail-closed, no identifiable lock before generic rejection | Bounds and responses; recovery locks only after a valid code | §14.4, §14.5; doc 14 §3.1 |
| (6) F-3/F-4 recovery ordering and enrollment | Consumption order consistent with constraints; enrollment under the profile lock with a one-active-set index | §14.5; doc 14 §7.2 |
| (7) Tests | T-AUTHZ table | §14.6 |

## 16 · Review response (Codex review of `7aa6043`, 2026-10-21)

| # | Finding | Change | Sections |
|---|---|---|---|
| 1 | **Blocker:** `role >= min` is reversed by enum order | Explicit role sets STAFF/EDITOR/MANAGER; offline check forbids ordering comparisons on `user_role`; full role × permission matrix test | §14.1, §14.6 |
| 2 | **Blocker:** manager-only write policies and direct batch insert not mapped | Per-policy table with exact role set and retained conditions (incl. `batches_write` :118 and the manager-only rows :110, :120, :135, :144, :154, :163); Editor-denial tests for every manager-only operation | §14.1, §14.6 |
| 3 | "require_actor first" conflicts with the lock order | One executable sequence `lock_and_validate`: roster → all profiles ascending in final modes → session → validate; used by Team functions, definer RPCs and policies; no upgrades; incompatible re-entry raises | §14.2 |
| 4 | Ignoring a late result doesn't stop the transaction | Server-side timeouts; cancel + destroy the connection before COMMIT; success only on an acknowledged COMMIT; lost-ack handling per route; tests for late consumption, stalled transport, lost ack | §14.4, §14.6 |
| 5 | Session kind per operation | Kinds column per operation (M16 recovery only, M17 both, M18 fresh link) | §14.1 |

---

## 17 · Global lock order including business tables (QQ 8111f3c C7, C8/D9)

Quote-Queue's corrected design (8111f3c) passed independent **design** review. Its code is
**not** fixed or tested, so nothing here relies on QQ source as repaired, and a design pass is
not test evidence.

### 17.1 What QQ C7 found and how it applies here

QQ C7 requires authorization to be checked **under the operation's complete lock set**, taken
in one global class order, with the actor's rows as ordinary members of that set. QQ found a
real ordering conflict in its code: deactivation locks `users` and then the person's leads,
while Reassign locks the lead and then `users`. That is a wait cycle.

This app checked the same risk by evidence:
- **No ownership or reassignment path exists.** Profiles are referenced by business rows only as
  **attribution**: `batches.created_by`, `batch_activity.actor_id`, `contact_logs.user_id`,
  `carriers.dnc_set_by`, `contact_suppressions.created_by`,
  `batch_carriers.status_changed_by/promoted_by`, `profiles.approved_by`. None has an
  `ON DELETE` action, and profiles are never deleted. `grep -i "owner|assign|reassign"`
  over `supabase/migrations` finds only a comment and a function-owner check. Deactivation,
  demotion, email change and revocation therefore touch **no** business rows, and no business
  write needs to lock another person's profile.
- **Business writes reference only the actor's own profile** (inserted as `created_by`,
  `actor_id`, `user_id`, `dnc_set_by` or `status_changed_by`). Their implicit foreign-key
  `KEY SHARE` lock lands on a row the transaction already holds `FOR SHARE` (from
  `lock_and_validate`), so it adds no wait.
- QQ puts business classes first (leads, then users). This app puts identity first. That is
  safe because no path discovers identity rows from business rows. If a future feature adds
  ownership (for example, assigning batches to a person), its reassignment must discover the
  people from the request without locks, lock profiles first (§17.2 I2), then the business
  rows, and re-check that the discovered set is unchanged (QQ C7 step 4: retry once, then the
  generic "try again").

### 17.2 The one global order (classes in this order; a transaction skips classes it doesn't need; rows ascending within a class)

| Class | Rows | Mode | Taken by |
|---|---|---|---|
| I1 | `internal.roster_lock` | FOR UPDATE | M2, M3, M5 |
| I2 | `public.profiles`, ascending id (actor and targets) | targets FOR NO KEY UPDATE; actor FOR SHARE; once, final mode | `lock_and_validate`; link redeem; recovery consumption/enrollment |
| I3 | the actor's own `internal.app_sessions` row | FOR SHARE (FOR UPDATE for M17) | `lock_and_validate` |
| B1 | `public.batches`, ascending id | FOR NO KEY UPDATE when updated; FOR UPDATE when deleted | M11 (refresh), `batches_update`/`batches_delete` |
| B2 | `public.batch_zones`, ascending id | row locks of update/delete | M11, zone policies |
| B3 | `public.batch_carriers`, ascending (batch_id, dot_number) | FOR NO KEY UPDATE | M8, M9, M10, M16, `bc_delete` |
| B4 | `public.carriers`, ascending dot_number | FOR NO KEY UPDATE | M7 (DNC), `carriers_update` |
| B5 | `public.contact_suppressions`, ascending (dot_number, channel) | row locks | M7, `suppress_*` |
| B6 | `public.contact_logs`, `public.batch_activity` (insert; deletes ascending id) | row locks | M13, M14, activity triggers, manager deletes |
| B7 | `public.cargo_other_values`, ascending value | FOR NO KEY UPDATE | `cov_update_mgr` |
| A1 | other people's `internal.app_sessions` rows | updated by the revocation trigger | M1–M4 (Team) |
| A2 | `internal.signin_links` | row locks | link redeem; revocation; mint (post-response) |
| A3 | `internal.recovery_sets` → `internal.recovery_codes` | row locks | recovery; revocation; enrollment |
| A4 | email-block lock, then `internal.blocked_email_addresses`, `internal.email_events` | as QQ (block lock then rows) | webhook; M6 block clear |

Rules:
- **Implicit foreign-key locks.** Inserting a child row takes `FOR KEY SHARE` on its parent
  (for example, a contact log on its carrier (B4) and batch (B1)). That is a "backwards" class,
  so it is allowed only because `KEY SHARE` conflicts with nothing except a parent **delete or
  key update**, and every deleting path takes the parent first and then cascades to the
  children: deleting `batches` cascades to zones, members and activity and sets
  `contact_logs.batch_id` to null (`20260720000600_batches.sql:27, 47, 62`;
  `20260720000700_contact.sql:9`; `20260720000800_activity.sql:8`). No app path deletes
  carriers. The pipeline's carrier cascades never run against identity rows. This is covered
  by the tests below.
- **Bodies adjusted to the order.** These are behaviour-preserving changes, permitted by the
  offline contract check in addition to the `auth.uid()` swap:
  - `refresh_batch` locks its batch row `FOR NO KEY UPDATE` **before** inserting members
    (today it updates the batch after the inserts, `20260720001100_rpc.sql` refresh body).
  - `bulk_set_status` first locks the target member rows with
    `select … order by dot_number for no key update` and then updates them. Today a
    multi-row `update … where dot_number = any(…)` locks in scan order, so two overlapping
    bulk updates could deadlock with each other. That is an existing risk, fixed here.
  - `set_do_not_contact` takes its one carrier (B4), then the suppressions (B5), then the
    activity inserts (B6). That is already its order.
- **Team operations take no business rows** (I1 → I2 → trigger A1 → A2 → A3), and business
  writes take no other person's identity rows. So deactivation, demotion, email change and
  revocation cannot form a cycle with batch, status, DNC, contact or comment writes.
- **The pipeline** (`service_role`/direct `pg`) takes only B4 and the carrier satellites plus
  `cargo_other_values` (B7) and `pipeline_runs`/`data_quality_reports`, never identity
  classes, and in its own fixed order. It shares no class with identity, so it cannot join a
  cycle with Team operations. Against app DNC writes it is single-class (B4) plus B7: it never
  holds B7 and then waits on B4 while the app holds B4 and waits on B7 (the app takes B7 only in
  `cov_update_mgr`, alone).
- **Deadlock backstop.** `deadlock_timeout` stays the default; SQLSTATE 40P01 maps to the
  generic retry outcome (never a 500) and is logged with the operation name, so a remaining
  ordering bug is visible (as QQ C7).
- **Retry-once discovery** (QQ C7 step 4) applies to operations whose lock set is computed from
  reads. Here those are `bulk_set_status` (its member set) and `refresh_batch` (new members).
  If the re-read under lock differs, roll back and retry once, then return "try again".

### 17.3 D9 / C8 comparison (bounded pre-response work)

QQ C8: pool checkout with a connection timeout; the bucket transaction with `SET LOCAL
statement_timeout` and `lock_timeout` inside the envelope; a response timer independent of the
bucket write; fail closed (no identity work, identical 303, sanitized log). This app's §14.4
matches on every point, and goes further: it cancels and destroys the connection at the
deadline instead of letting a late write finish, and it handles a lost commit acknowledgement
explicitly. The host query-string logging for `/auth/verify` remains an **unresolved release
gate** (T-HYG; QQ lists it as unverified too).

### 17.4 Ordering and deadlock tests (added to T-AUTHZ; two real connections, interleavings forced with advisory-lock barriers at named points, not sleeps)

| Case | Expected |
|---|---|
| Deactivate X ‖ X's status change (M9), both arrival orders | no 40P01; either the write is ordered first and stands, or it is refused |
| Demote X ‖ X's `bulk_set_status` over 50 members | same |
| Email change of X (window closed in the test DB) ‖ X's DNC set (M7) | same |
| Revoke X's session (sign-out elsewhere) ‖ X's contact log (M14) | write refused if the revocation committed first |
| Two overlapping `bulk_set_status` calls in opposite member order | no deadlock (sorted locking) |
| `refresh_batch` ‖ `batches_delete` of the same batch | no deadlock; the refresh either finishes first or finds the batch gone |
| Contact log insert ‖ `batches_delete` of its batch (FK `KEY SHARE` vs cascade) | no deadlock; the log keeps `batch_id` or gets null |
| Status change ‖ `bc_delete` of the same member | no deadlock |
| DNC set on carrier C ‖ contact log on C | no deadlock; the DNC guard decides by commit order |
| Team edit A→B ‖ B→A (managers) | no deadlock (I1, then I2 ascending) |
| Pipeline-style carrier upsert batch ‖ DNC set on one of those carriers | no deadlock; bounded waits |
| Any 40P01 forced by a deliberately mis-ordered test transaction | mapped to the generic retry outcome and logged; never a 500 |

## 18 · Review response (coordinator-relayed QQ 8111f3c, 2026-10-21)

| Item | Change | Sections |
|---|---|---|
| C7 global order across all privileged routes | Identity classes I1–I3, business classes B1–B7, auth-ledger classes A1–A4, with modes and owners; targets now `FOR NO KEY UPDATE` | §14.2, §17.2 |
| QQ deadlock lesson (users vs leads) | No ownership/reassignment path exists (evidence); Team ops take no business rows; implicit FK lock rule; two RPC bodies reordered (`refresh_batch`, `bulk_set_status`); future-reassignment rule | §17.1, §17.2 |
| D9 | Compared with QQ C8; §14.4 matches and adds cancel/destroy and lost-ack handling; log redaction still an open gate | §17.3 |
| Tests | Ordering and deadlock cases | §17.4 |
