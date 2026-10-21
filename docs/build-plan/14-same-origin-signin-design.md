# 14 · Same-origin team sign-in — design for review (Gate 1)

Status: **design only. Nothing built, run, installed or touched live.** Written 2026-10-21 UTC on
local branch `auth/same-origin-signin` (from `docs/auth-spec-m0-signoff`, 9fc3425), by the
sign-in implementation owner (thread thr_pn5gr4mx94). Needs independent security review before
any code is written.
**Revision 2 (2026-10-21 UTC):** addresses the Gate 1 review of `3b841a7` (Codex, thr_9ftwddufse,
"approved to implement — yes after edits"; 2 blockers, 5 should-fix). See §13.
**Revision 3 (2026-10-21 UTC):** addresses the re-review of `7f8a918` (2 blockers,
1 should-fix). See §14.
**Revision 5 (2026-10-21 UTC):** in-transaction authorization, uniform fail-closed admission and
recovery ordering, after QQ review findings F-1 to F-4; see doc 15 §14.
**Revision 4 (2026-10-21 UTC):** addresses the review of `ecc2751` (2 blockers, 1 should-fix,
all rollout/backout). See §15.

**What this replaces.** Spec 13 (`13-team-sign-in-spec.md`) wherever it relies on
browser-held Supabase tokens, Supabase OTP links, the Send Email hook, or accepted gaps (its
§3.1–3.7, §5, §6, §9, §11 Q4). Its behaviour contract (B1–B16), its test ideas and its §6 gap
list are carried forward where still valid; B11 (Resend) and B12/G2 (Supabase link replacement)
are dropped. Its migration steps "scramble all passwords" and "convert pending/guest to
disabled" are **withdrawn** (not authorized).

Source labels: **[QQ]** = Quote-Queue `origin/main` f1167dc, read with `git show` only;
**[repo]** = this repository at 9fc3425; **[CF]** / **[SB]** = Cloudflare / Supabase docs read
2026-10-21 (URLs in §12); **[assume]** = not yet verified, with the test that will verify it.


> **Coordinator decision, 2026-10-21 (authoritative over anything below that conflicts):**
> - The QQ-style **plain Node server** (doc 15) is the selected **local implementation
>   direction**. The Vite UI, the existing Supabase Postgres data and the database-enforced
>   permissions are kept. The Cloudflare Worker, Hyperdrive, `waitUntil`, `wrangler` and
>   `@cloudflare/workers-types` parts of doc 14 are **superseded**. Approval A2 is `pg` +
>   `@types/pg` only.
> - **Not approved by that decision:** buying or provisioning Render, any paid database
>   add-on, dependency installation, live settings, a schema migration or cutover, account
>   changes.
> - **Unapproved proposals (not plan facts):** dropping the `profiles.id → auth.users` link
>   (D8, "M2"), and freezing email edits and new-user adds during a backout window (D10).
>   RLS re-keying and legacy Auth retirement (L1) remain **reviewed migration gates**. Every
>   gate preserves all user data.
> - Post-response, shutdown, body-limit and client-IP behaviour are **properties to prove
>   with explicit tests** (T-SHUTDOWN, T-BODY, T-IP, T-TIME), not guarantees inferred from
>   Quote-Queue or from a platform.

---

## 1 · Plain-language summary (for Hunter)

**What the team sees** is the same as Quote-Queue's sign-in, with "CARRIER RECRUITER" under
the black TNBS badge:

1. The sign-in page shows one email box and one button, **Email me a sign-in link**. No
   password, no "create account", no "forgot password", no "remember me".
2. After pressing it, the page always says: **"Check your email.** If that address is on the
   roster, we emailed a sign-in link. It works once and expires in 15 minutes." with a **Use a
   different address** link. It says this whether or not the address is on the team list, and
   it always takes about one second.
3. Clicking the link in the email opens a page that says "Finish signing in as
   j•••@twistednail.com." with one button, plus **Not you? Use a different address**. Pressing
   the button signs you in. (Opening the email does not use up the link; only the button does.
   This stops email scanners from using it.)
4. An old or used link shows: **"This link was already used or has expired."** with a **Get a
   new link** button.
5. You stay signed in on that computer until you press **Sign out**, a manager changes your
   email, role or active status, you don't **actually use** the app for 30 days (a tab left open
   doesn't count), or 90 days pass.

**What changes underneath.** Today the browser holds Supabase passwords and tokens that any
script on the page could read. In this design the browser holds only a locked cookie that page
scripts cannot read. Our own small server (the Cloudflare Worker that already serves the app)
checks that cookie on every request and talks to the database for you. The public Supabase
"front doors" (its own sign-in, sign-up and password-reset addresses, and its data API) are shut,
so there is no side way in.

**Who can get in.** Only people a manager adds on the Team page, as Manager, Editor or Viewer.
Everyone's existing account, role and history are kept exactly as they are. Nobody is deleted,
no password is scrambled, and nobody's status is changed by this work. Old "pending" or "guest"
accounts simply still have no access, as today. What to do with them is your later decision,
once someone has counted them.

**If email is down.** People already signed in keep working. For new sign-ins during an email
outage, this design proposes **recovery codes**: a short list of one-time codes each person can
print and keep. A code signs you in for a limited time (one hour without use, twelve hours at
most) and shows only a short, fixed list of screens. By default those screens show no phone
numbers, emails, contact names or call notes, and there is no Team page, no export and no way to
make new codes. Whether to adopt recovery codes, and whether contact details should be visible
during an outage, is a cross-app decision still open (§7).

**What you need to do now:** nothing. The decisions and approvals listed in §11 come to you
through the manager, one at a time, before anything live happens.

---

## 2 · Architecture

### 2.1 Shape

```
Browser ──HTTPS──▶ Cloudflare Worker (same origin as the app)
                     ├─ static SPA assets (env.ASSETS)
                     ├─ server-rendered pages: /signin, /auth/confirm, /signin/recovery
                     ├─ auth routes: /auth/request, /auth/verify, /auth/confirm (POST),
                     │               /auth/recovery, /auth/signout
                     ├─ data API: /api/*  (replaces every supabase-js call in the SPA)
                     └─ mail webhook: /webhooks/sendgrid
                          │
                          │ Postgres wire protocol, TLS, as LOGIN role recruiter_worker
                          ▼  (via Hyperdrive, caching disabled; or direct connect())
                     Supabase Postgres  ── RLS + definer functions decide everything
                          ▲
   pipeline (Render) ─────┘ service_role / direct pg — unchanged
```

- **No custom JWT signing.** Supabase Auth is not used by staff at all. The Worker never holds
  `service_role` or the JWT secret. It holds: the `recruiter_worker` DB credential, three HMAC
  keys (links, sessions, rate/recovery), the mail provider's send key and webhook public key,
  and `APP_ORIGIN`.
- **Identity reaches the database only as a secret's hash.** Each DB transaction starts with
  `select set_config('app.session_hash', $1, true)` (transaction-local). `$1` is
  HMAC-SHA256(`KEY_SESSIONS`, raw cookie value). The database resolves it against the
  session ledger on every statement. There is no "user id" GUC that a caller could set.
- **The Worker DB credential is an authentication authority (review finding 4).** Whoever holds
  the `recruiter_worker` credential can call the mint and redeem functions with values of their
  own choosing. That gives them a valid session for any active staff member **without** the
  Worker's HMAC keys and without any email being delivered. The database cannot tell this
  apart from the Worker, because no proof exists that the Worker holds but a credential holder
  does not. So this credential is classified and protected exactly like a signing key: Worker
  secret only, never on a laptop or in CI, rotated on any suspicion, and covered by the
  emergency sign-out (D1). Detective tripwires (not proof) are in §5.2 P12. The precise
  credential-only attack is a test (T-CRED) that is expected to **succeed**, so the
  classification stays honest.
- **No credential in any log (review finding 7).** Session values and hashes, link tokens and
  URLs, recovery codes, cookies and DB bind parameters must be absent from Worker, Hyperdrive,
  Postgres (normal and error) and provider logs. This is a **release gate** (§8 T-HYG, §11.2),
  not a residual risk. If any of them cannot be shown absent, the release stops.
- **The SPA keeps its screens.** Only its data layer changes: `lib/supabase.ts` is removed from
  the bundle, `lib/rpc.ts` keeps its function signatures but calls `/api/rpc/<name>`, and the
  direct table queries move to named `/api/...` endpoints (§4.2). No Supabase URL or key ships
  to the browser any more.

### 2.2 Why same-origin pages for the sign-in screens

`/signin`, `/auth/confirm` and `/signin/recovery` are plain HTML rendered by the Worker with
native `<form method="post">`, mirroring [QQ] (`app/auth/confirm/route.ts:145-182` renders its
confirm page as a server string). They work without JavaScript, can carry a strict CSP with no
script at all, and every result is a 303 + full navigation. The React SPA only loads for a
signed-in person.

### 2.3 Worker request routing

`wrangler.jsonc` gains `main` (Worker entry), `compatibility_flags: ["nodejs_compat"]` (needed by
the Postgres driver [assume, CF driver docs]), an `ASSETS` binding, `run_worker_first`, and a
`hyperdrive` binding. `run_worker_first` is needed so that **document navigations** pass through
the Worker (session check + activity renewal + security headers) [CF static-assets routing:
"always run your Worker script before serving static assets" with `true`, or an array of route
patterns]. Hashed build assets (`/assets/*`, `/fonts/*`, `/brand/*`) can be served directly.
Whether the array form accepts negative patterns is **[assume]**; if not, use `true` and let the
Worker pass asset paths straight to `env.ASSETS` (costs one Worker invocation per asset request;
§10 R7).

| Request | Worker behaviour |
|---|---|
| `GET /assets/*`, `/fonts/*`, `/brand/*`, `/favicon*` | `env.ASSETS.fetch` (immutable, cacheable) |
| `GET /signin`, `GET /signin?sent=1`, `GET /signin/recovery` | server HTML; if a valid session cookie is present → 303 `/` |
| `POST /auth/request`, `GET /auth/verify`, `GET|POST /auth/confirm`, `POST /auth/recovery` | §3 |
| `POST /auth/signout` | §3.6 |
| `POST /webhooks/sendgrid` | §3.8 |
| `GET|POST /api/*` | session required → JSON; otherwise `401 {"error":"signed_out"}` |
| `GET /login`, `/register`, `/forgot`, `/reset`, `/pending` (old routes) | 303 `/signin` |
| any other `GET` with `Sec-Fetch-Mode: navigate` (SPA routes) | valid session → renew activity (§3.5) → `index.html` with headers; no/invalid session → 303 `/signin` (and clear the cookie) |
| any other method/path | 404 |

Headers on every Worker HTML response (copied from [QQ] `middleware.ts:72-156`): CSP
(`default-src 'self'; script-src 'self'` (+ Google Maps origins for the SPA only, already in
use); `style-src 'self'`; `img-src 'self' data:` (+ maps tiles); `connect-src 'self'` (+ maps);
`object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`), HSTS,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`
(`no-referrer` on `/auth/*`), `Permissions-Policy`, `Cache-Control: private, no-store` on
everything except hashed assets. The exact maps CSP list is taken from the current app at build
time **[assume: current Google Maps loader origins]**.

### 2.4 Database access from the Worker (validation item (a))

| Option | Low-privilege role? | Notes | Verdict |
|---|---|---|---|
| **Hyperdrive → Supabase direct connection**, `pg` driver | yes, `recruiter_worker` LOGIN role | [CF Hyperdrive/Supabase]: "use the Direct connection connection string rather than the pooled ones"; a dedicated `CREATE ROLE … LOGIN` is supported, "In practice, you want to create a role with lesser privileges." Included on Workers Free: "100,000 / day" queries [CF Hyperdrive pricing]. Query cache **must be disabled** (`--caching-disabled`) because cached reads would bypass per-request session checks; per [CF] stable/volatile functions are not cached anyway, but disabling removes the doubt. | **Recommended** |
| Worker `connect()` directly to the Supavisor pooler, transaction mode | yes, if Supavisor accepts custom roles (`recruiter_worker.<ref>` user name) **[assume — not documented; SB search found no confirmation]** | TLS + SCRAM handshake on every request; slower, more CPU | Fallback |
| PostgREST with a custom role | needs a JWT with `role=recruiter_worker` → **custom JWT signing**, excluded | — | Rejected |
| PostgREST with `service_role` / secret key | no: bypasses RLS | — | Rejected |

Transaction-local session id: every Worker DB unit of work is `BEGIN; select
set_config('app.session_hash', $1, true); …; COMMIT;` on one pooled connection, so transaction
pooling cannot leak it to another request. Measured evidence: none yet (needs the test DB, §8).

**Driver dependency.** The Worker needs a Postgres driver. `pg` (^8.13) is already a dependency of
`pipeline/` [repo `pipeline/package.json`]; adding it (and `wrangler`, `@cloudflare/workers-types`
as dev tools) to `app/` is a **new dependency for this package → approval A2**. I will not write a
Postgres wire-protocol client by hand.

**IPv6 / plan limits [assume].** Supabase's direct host may be IPv6-only without a paid IPv4
add-on; whether Hyperdrive reaches it is unverified. Workers Free allows **10 ms CPU per
request** [CF limits]; password hashing during a driver handshake, HMACs and JSON should fit,
but this must be measured; if it doesn't, Workers Paid is a spending decision (D5).

### 2.5 Roles and grants (validation item (c), data side)

New migration (never edit old ones):

- `recruiter_api` (NOLOGIN): receives exactly the table/column/function privileges
  `authenticated` has today (select on tables/views it reads, the column-limited updates of
  `20260720001200_rls.sql:94-112`, insert/update/delete where policies exist, execute on the
  17 public RPCs listed in `20260722223300_security_hardening.sql:39-57`, usage on `internal`
  and the helper grants), plus execute on the new `internal.auth_*` definer functions (§5). No
  direct privileges on any auth ledger table.
- `recruiter_worker` (LOGIN, `NOBYPASSRLS`, `INHERIT`, member of `recruiter_api`,
  `connection limit` small): password set by the operator out of band (never in repo/chat).
- **Revoke from `anon` and `authenticated`**: all privileges on all tables, views and sequences in
  `public`; execute on all functions in `public` and `internal`; usage on `internal`. Also
  `alter default privileges … revoke … from anon, authenticated` so future objects stay closed.
  After this, the public key reaches **no data** through PostgREST, GraphQL (`pg_graphql`
  respects grants) or Realtime postgres_changes (needs SELECT) **[assume until §8 T-API run]**.
- RLS stays enabled everywhere and every policy is re-keyed to the session ledger (§4.1), so even
  a forgotten grant yields no rows to a caller without a valid `app.session_hash`.
- `service_role` / `postgres` (pipeline, operator) are untouched.

---

## 3 · Sign-in flows (behaviour equal to [QQ])

Keys (Worker secrets, 32 random bytes each, generated by the operator, never in repo/chat):
`KEY_LINKS` (link tokens), `KEY_SESSIONS` (session + CSRF), `KEY_RATE` (IP/address buckets and
recovery codes). Same split as [QQ] `lib/keys.ts:34-58`.

### 3.1 Request — `POST /auth/request`

Mirrors [QQ] `app/auth/request/route.ts:568-623` and BUILDER_HANDOFF §8 (lines 1298-1350).

Before the response (anonymous work only):

1. Start timer: target = 1000 ms ± uniform 100 ms jitter from receipt.
2. Client IP = `CF-Connecting-IP` (set by Cloudflare's edge, not spoofable by the client when
   traffic goes through Cloudflare) **[assume: verify header present on workers.dev and custom
   domain]**; canonicalize (IPv4-mapped IPv6 folded) → `hmac(KEY_RATE, ip)` or the
   `sentinel:no-ip` hash.
3. Body preflight exactly like [QQ] `extractRawEmailField` (`:544-566`): form content types
   only, declared length ≤ 32 KiB, guarded parse, exactly one string `email` field; any failure →
   `""`. Syntactically valid → normalized (trim, lower-case) → `hmac(KEY_RATE, email)`;
   otherwise the `sentinel:invalid-email` hash.
4. One short transaction: `internal.auth_bucket_hit(ip_hash, email_hash, 'request')` — both
   upserts with window floors from one `clock_timestamp()`; returns both counts.
   `SET LOCAL lock_timeout='200ms', statement_timeout='400ms'`.
5. Admit = valid email AND ip count ≤ 20 AND address count ≤ 10.
6. Wait until the timer; respond `303 /signin?sent=1`, `Cache-Control: no-store`.

After the response (identity work), inside `ctx.waitUntil` (§6.4):

7. `internal.auth_link_mint(email)` in one transaction, `SET LOCAL lock_timeout='5s'`: lock the
   profile row whose `lower(email)` matches and which is **active staff** (`status='approved'`
   and `role in ('manager','edit','view')`); read the newest link and its `send_status`; counts in
   the trailing minute / hour / **America/Chicago calendar day** (bounds computed in SQL with
   `(now() at time zone 'America/Chicago')::date` → `timezone('America/Chicago', d::timestamp)`,
   DST-correct, no `::date` on UTC); apply exactly [QQ] `:323-366`: if the newest link is
   `definite_failure` → revoke it (`send_failed`) and skip only the 1/minute check and the
   2-minute courtesy; hour (5) and day (10) still apply; else refuse if minute ≥ 1, hour ≥ 5,
   day ≥ 10, or the newest link is `pending|accepted|unknown` and < 2 minutes old. Mint: 256-bit
   CSPRNG raw token (Worker) — the function receives only `hmac(KEY_LINKS, token)` and stores
   it with `recipient_email`, `expires_at = now() + 15 min`, `send_status='pending'`. Commit.
   Returns link id or null. (The raw token is generated in the Worker and only used if the
   function returns an id.)
8. After commit: send through the mail adapter (§3.8), 8-second timeout, idempotency key
   `auth-<link id>`, click/open tracking off, `custom_args` carrying source + link id only.
9. Record the outcome with [QQ]'s guarded single statement (`:479-498`): never leave
   `definite_failure`; `accepted` only to `definite_failure`; `unknown` never back to `pending`
   (DB trigger copies [QQ] migrations 0006/0007).
10. Every failure in 7–9 is caught and logged as a category only (no address, no token, no
    link id in logs).

**Uniform fail-closed handling (revised; doc 15 §14.4).** Step 4 is bounded: pool acquisition
≤ 250 ms, `lock_timeout` 200 ms, `statement_timeout` 400 ms, overall admission deadline 600 ms.
If it fails or times out for **any** reason (database unreachable, pool exhausted, slow), the
request gets the **same** generic 303 at the same envelope, and no identity work runs. Only the
error category is logged. (This replaces the earlier plain-503 proposal: one response for every
outcome. [QQ] lets its route throw here, which is QQ gap F-2 and is not copied.)
After the response, failures cannot change what the person saw. They are recorded on the link
row (`unknown` or `definite_failure`), and a human retries.

### 3.2 Opening the email — `GET /auth/verify?token=…`

Mirrors [QQ] `app/auth/verify/route.ts:65-113`. Does **not** consume the link.

1. If the token is present and `internal.auth_link_check(hmac(KEY_LINKS, token))` says it is
   unused, unrevoked, unexpired and its person is still active staff → set
   `__Host-tr_confirm = <token>.<nonce>`; `Secure; HttpOnly; SameSite=Lax; Path=/`; no `Domain`;
   `Max-Age=300`. `nonce` = 128-bit random, non-secret.
2. Always (valid or not) 303 → `/auth/confirm?x=<nonce>`, `Cache-Control: no-store`,
   `Referrer-Policy: no-referrer`. The token leaves the address bar immediately. The landing
   binding is created **when the email is opened**, on whichever device opens it, so
   cross-device works (the request device does not matter).
3. The `token` query string must never reach logs. Cloudflare Workers Logs / Logpush / Tail may
   record the request URL **[assume]**. The Worker itself never logs URLs, headers, cookies or
   bodies on auth routes. Platform logging must be shown to exclude them by the canary test in
   §8 T-HYG. That is a **release gate**: if the URL cannot be shown absent, the release stops.
   There is no "accept and document" path.

### 3.3 Confirm page — `GET /auth/confirm?x=…`

Mirrors [QQ] `:200-246`. If the cookie is missing, malformed, or its nonce ≠ `x` → the
fail-closed page. Otherwise re-check the link (read-only). If it is valid, render "Finish signing
in as **\<masked\>**." (mask = first character + `•••` + `@domain`, [QQ] `lib/auth/mask.ts:37-46`),
a form with hidden `nonce` and `csrf_token`, a button, and "Not you? Use a different address".
Set `__Host-tr_csrf` (5 min). Stale tab, other account's newer link, or a different device's
cookie all fail closed.

Button label: [QQ] code says **"Confirm sign-in"** (`:178`); the coordinator text says "one
button". I copy QQ's label exactly.

### 3.4 Redeem — `POST /auth/confirm`

Mirrors [QQ] `:263-303`, `:360-436`.

1. Body preflight (form only, ≤ 32 KiB, single-valued fields).
2. CSRF: if `Origin` is present it must equal `APP_ORIGIN` exactly, and a present-but-wrong
   `Origin` (including `null`) fails with **no** fallback to `Host`. Only when `Origin` is absent
   must `Host` equal the canonical host. Neither → fail. Then `__Host-tr_csrf` must be present
   and `csrf_token == hmac(KEY_SESSIONS, cookie)`, compared in constant time ([QQ]
   `lib/csrf.ts:90-137`, same order). One shared `checkOrigin(strict: boolean)` serves every
   route. `strict=true` (Origin required, never Host) is used for `/auth/recovery` (§7.2) and
   all `/api/*` mutations.
3. Form nonce == cookie nonce.
4. `internal.auth_link_redeem(hmac(KEY_LINKS, token), hmac(KEY_SESSIONS, new_session_raw))` in
   one transaction, `lock_timeout='5s'`: find the link's user id → lock the profile row
   `FOR UPDATE` → lock the link row `FOR UPDATE` with all validity predicates → require active
   staff → set `used_at` → insert session (`kind='link'`, `last_seen_at=now()`,
   `expires_at=now()+30 days`, `absolute_expires_at=now()+90 days`) → commit.
5. Success → clear the confirm and CSRF cookies; set `__Host-tr_session=<raw>` and
   `__Host-tr_app_csrf=<raw>` (both `Secure; HttpOnly; SameSite=Lax; Path=/`,
   `Max-Age = 90 days`, as [QQ] I-07); 303 → `/`.
6. Any failure → the fail-closed page, and both short-lived cookies cleared.

### 3.5 Sessions

- Cookie `__Host-tr_session`: opaque 256-bit value; DB stores only `hmac(KEY_SESSIONS, value)`.
  Attributes exactly as required: `Secure; HttpOnly; SameSite=Lax; Path=/`, `__Host-` prefix,
  no `Domain`. No adaptation is needed.
- **Validity (checked in SQL on every statement through `internal.current_session()`):** row
  exists, `revoked_at is null`, `expires_at > now()`, `absolute_expires_at > now()`, the profile
  is `approved` with role manager/edit/view, and `profiles.email` still equals the email the
  session was minted for (belt and braces with §5.3).
- **Renewal depends on the session kind (review finding 3).** Each session row stores its kind's
  idle window at creation: `idle_window = '30 days'` for `kind='link'` (absolute 90 days),
  `'1 hour'` for `kind='recovery'` (absolute 12 hours). A check constraint ties each kind to its
  windows, so the Worker cannot pass a longer window. `internal.auth_session_touch()` sets
  `last_seen_at=now()` and `expires_at = least(now() + idle_window, absolute_expires_at)`.
  The throttle (QQ's 5 minutes, [QQ] `session.ts:211-222`) is 5 minutes for link sessions and
  1 minute for recovery sessions. A one-hour idle window must not lose up to 5 minutes of
  precision, and it is never longer than the window. Nothing in the touch path reads a
  constant 30 days. Tests in T-REC: recovery expiry after navigation, mutation, activity ping
  and background polling (the last must **not** extend it).
- **Deliberate use only.** The server calls the touch **only** for:
  (a) a document navigation (`Sec-Fetch-Mode: navigate` + `Sec-Fetch-Dest: document`) with no
  `Sec-Purpose`/`Purpose: prefetch` header; (b) a **submitted** mutation (`POST /api/*`
  other than the ping itself); (c) `POST /api/session/activity`, the SPA activity ping.
- **The activity ping** (revised 2026-10-21, coordinator item 3):
  - **When the SPA sends it:** only for actual deliberate use, i.e. an in-app navigation the
    person caused (a router transition triggered by a click, a keypress, or browser
    back/forward). A submitted mutation already renews server-side, so no ping is needed for
    it. It is **never** sent from timers or intervals, route prefetch or hover preloading,
    window focus or visibility changes, React Query background refetch or retries, or on
    app start-up. In code, the ping lives in one module (`lib/activity.ts`) called only from
    the router's user-navigation handler. A unit test and a lint check forbid importing it
    anywhere else.
  - **How the server checks it:** valid session (link or recovery); strict `Origin` equal to
    `APP_ORIGIN`; `X-CSRF-Token` equal to the session's CSRF token; method `POST` with an
    empty body; refused when a `Sec-Purpose` or `Purpose` prefetch header is present.
    Refused pings are `403` and do not touch.
  - **Throttle:** the server counts **at most one ping per session per 60 seconds**. Extra
    pings get `204` and do nothing. The database renewal behind it is further limited to
    once per 5 minutes (link) or once per minute (recovery), and never extends past the
    absolute cap.
  - **Limits of the guarantee:** the server cannot tell a ping sent by our navigation code
    from one sent by other script on the same page. That script could only keep **its own
    page's** session alive, and CSP blocks third-party script. So the guarantee is enforced by
    the SPA code and its tests, and bounded by the throttle.
  - **Tests (T-W and SPA unit tests):** a `setInterval`/`setTimeout`, a prefetch, a focus or
    visibility change, and a background refetch do **not** send a ping and do not extend
    `expires_at`; a user navigation does. A ping with no CSRF token, a wrong token, a
    foreign or missing `Origin`, or a prefetch header is refused (`403`, no touch). 100 pings
    in 60 s touch at most once. Background `GET /api/*` reads never touch. This is the
    equivalent of [QQ]'s `{renew:false}` for auto-refresh (M3 ruling 5,
    `session.ts:151-180`).
- `GET /api/session` returns `{ user: {id, name, email, role}, sessionKind, csrfToken }`.
  `csrfToken` = `hmac(KEY_SESSIONS, __Host-tr_app_csrf)`. It is readable only by same-origin
  script (JSON, no CORS headers). Every `POST /api/*` requires header `X-CSRF-Token` equal to
  it **and** an exact `Origin` match.
- Signed-out or invalid on any `/api/*` → `401`. The SPA then does
  `window.location.assign('/signin')`, a full navigation that clears in-memory caches.

### 3.6 Sign out — `POST /auth/signout`

Form post from the sidebar with the app CSRF field ([QQ] `app/auth/signout/route.ts:49-85`):
CSRF + Origin check → `internal.auth_session_revoke(hash)` → clear both cookies → 303 `/signin`
(full navigation). If CSRF fails → 403. The SPA's sidebar button becomes a real `<form>` (today
it is `supabase.auth.signOut()` with no navigation, `Sidebar.tsx:141` [repo]).

### 3.7 Pages and visual (decisions 19/35)

Copied from [QQ] `app/signin/page.tsx:38-98`, `signin.css`, and `confirm/route.ts:127-182`:

- `<main>` centred, padding 24px; shell `max-width:440px`, column, gap 24px; no card.
- Badge `/brand/tnbs-badge-black.png` 72×72 above the wordmark **CARRIER RECRUITER** (800
  weight, 14px, `letter-spacing:.16em`, uppercase, gap 14px). Asset check: this repo's
  `brand/logos/badge-black.png` has git blob `dc6d248…`, **identical** to [QQ]
  `public/brand/tnbs-badge-black.png` (both 1413×1377 PNG, 77,145 bytes; measured). It must be
  copied to `app/public/brand/` (only the white badge and wordmark are there today).
- Form: one `type=email` input, `aria-label="Email"`, `autocomplete=email`, placeholder
  `you@example.com`, height 40px; full-width 40px button **Email me a sign-in link**. No heading,
  visible label or helper.
- Result (`?sent=1`): one paragraph, `aria-live="polite"`: "**Check your email.** If that address
  is on the roster, we emailed a sign-in link. It works once and expires in 15 minutes." + inline
  link **Use a different address** → `/signin`.
- Confirm: "Finish signing in as **x•••@domain**." + button **Confirm sign-in** + link **Not you?
  Use a different address**.
- Used/expired: "This link was already used or has expired." + button-styled link **Get a new
  link** → `/signin`.
- Tokens: wash `#f7f6f4`, ink `#231f20`, navy `#1e3a6e`, Montserrat 400/700/800 from
  `app/public/fonts/montserrat` (already present), 9px radius, focus ring 2px navy. These are
  [QQ]'s literal values; this app's design system is v1.0 and [QQ]'s v1.1. The coordinator
  should confirm v1.1 is the shared reference (carried over from the manager's report, C2).
- The staging banner (today in `Login.tsx`) is kept on staging only, above the shell. It is
  not on [QQ]. Flag for the visual review.

### 3.8 Mail adapter and delivery evidence

- `MailAdapter.send(canonicalRequest, idempotencyKey) → {outcomeClass, providerMessageId?,
  providerCode?}` with classes copied from [QQ] `lib/sendgrid.ts:180-434`: `accepted`,
  `retryable_rejection` (429), `configuration_permanent` (400/401/403), `recipient_permanent`,
  `definite_rejection`, `unknown_outcome` (5xx, network, timeout). Mapped to `send_status`
  exactly as [QQ] `:437-444`.
- Implementations: `FakeMailAdapter` (tests; records calls in memory, never prints the link),
  `SendGridAdapter` (built against the documented `/v3/mail/send` shape; **not run live**).
  Which provider and sender to use is decision D3. The adapter keeps it swappable.
- `POST /webhooks/sendgrid`: verify SendGrid's ECDSA P-256 signature over `timestamp ‖ raw
  body` with WebCrypto ([QQ] webhook header). The DER signature is converted to raw r‖s for
  WebCrypto **[assume: unit-tested with SendGrid's published SDK fixture]**. Body ≤ 1 MiB.
  Events correlated by `custom_args` link id **and** `recipient_email` snapshot.
  `bounce` (not `blocked`) / `dropped` → `definite_failure` (terminal). `deferred` /
  `bounce type=blocked` → recorded `delayed`, which does **not** unlock retry. `delivered` →
  `delivered_at` set. `send_status` stays `accepted`, because **accepted is not delivered** and
  delivered is separate evidence. Duplicate events are idempotent (unique on provider event id).
- Email body: text + HTML, one link `APP_ORIGIN/auth/verify?token=…`, "This link works once and
  expires in 15 minutes. If you didn't ask for it, ignore this email." Tracking off.

---

## 4 · Data-path migration scope (validation item (b))

### 4.1 Database: replacing `auth.uid()`

Measured: `auth.uid()` appears 22 times in 4 migrations (`activity` 7, `rpc` 8, `rls` 6,
`dnc_activity_enum_cast` 1), plus `auth.role()` once in `profile_service_bootstrap.sql:18`
(`grep` at 9fc3425). One new migration:

- `internal.current_session()` (security definer, stable, `search_path` pinned): returns
  `(session_id, user_id, role, kind)` for `current_setting('app.session_hash', true)` under the
  §3.5 predicates, or no row. Index on `token_hash`.
- `internal.current_staff_id()` = `user_id` of that row. `internal.current_app_role()` is
  replaced (same signature, same grants) to return the role **only** through
  `current_session()`. So `is_staff()`, `can_edit()` and `is_manager()`, and every policy and
  definer RPC built on them, are re-keyed with no further edits.
- `create or replace` the functions that use `auth.uid()`, swapping it for
  `internal.current_staff_id()` and keeping the bodies otherwise identical: triggers
  `log_bc_change`, `log_bc_delete` and the activity insert paths (`activity.sql:25-44`); RPCs
  `create_batch`, `refresh_batch`, `bulk_set_status`, `set_do_not_contact` (latest body from
  `dnc_activity_enum_cast.sql`) and `log_export`. Policies with `auth.uid()` (`batches_write`,
  `logs_insert`, `act_comment`, `profiles_select`, `profiles_update_self`) are dropped and
  recreated with `internal.current_staff_id()`, except `profiles_select`. It loses its own-row
  exception (`id = auth.uid() or …`, `20260720001200_rls.sql:78`) and becomes
  `(select internal.is_staff())` only. `is_staff()` is true only for a valid **link**
  session, so no recovery session (and no other caller) can read any profile row, its own
  included. The signed-in person's own name and role come only from
  `internal.current_session()` through `GET /api/session` (re-review finding 1).
  `profiles_update_self` is dropped outright: roster fields change only through the Team
  routes. Policies are written as `(select internal.is_staff())` so the lookup runs once per
  statement.
- `guard_profile_update()` keeps the `auth.role() = 'service_role'` bypass for the pipeline and
  operator. The manager path now flows through `is_manager()` (session-based).
- Pipeline effect: the pipeline sets no `app.session_hash`, so `current_staff_id()` is null.
  Today `auth.uid()` is also null for `service_role`, so trigger actor columns behave exactly
  as before. Pipeline tests and the role matrix must prove this (§8).
- **Recovery sessions are denied by default at the database (review finding 2).**
  `internal.current_app_role()` returns a role **only for `kind='link'` sessions**, so for a
  recovery session `is_staff()`, `can_edit()` and `is_manager()` are all false. Every existing
  policy, view and RPC then returns nothing or refuses, including `carriers.select('*')`,
  `contact_logs`, `contact_suppressions`, the search RPCs and the contact sheet. A recovery
  session can reach data **only** through the separate `public.recovery_*` definer functions of
  the §7.3 matrix. Each one checks `internal.current_session().kind = 'recovery'` and an
  active-staff role, and returns an **explicit column list** (no `*`, no `jsonb` of whole rows).
  So adding a column to `carriers` never leaks into recovery.

### 4.2 App: every supabase-js call moves behind the Worker

Measured inventory (`grep` at 9fc3425, excluding tests): **17 RPC calls** in `lib/rpc.ts` (18 grep hits, one is a comment at `:31`);
**24 direct table calls** in `guards.tsx`, `Sidebar.tsx`, `BatchPage.tsx`, `ContactSheet.tsx`,
`CarrierProfile.tsx`, `Dashboard.tsx`, `UsersAdmin.tsx` and `dnc.ts`; **11 `supabase.auth.*`
calls** in the auth screens, guards, Sidebar and ContactSheet. No `.storage` or `.channel`
calls. Realtime is not wired (`Topbar.tsx:60` TODO).

| Today | After |
|---|---|
| `lib/rpc.ts` 17 wrappers | same exported signatures; body = `api.rpc(name, args)` → `POST /api/rpc/:name`. The Worker has an **allow-list** of the 17 RPCs granted in `security_hardening.sql:39-57`, each with a zod-free hand-written argument validator, and calls `select * from public.<fn>($1…)` with positional typed params. Unknown name → 404 |
| table reads (BatchPage, CarrierProfile, Dashboard, ContactSheet, dnc) | named GET endpoints returning the same row shapes, e.g. `GET /api/carriers/:dot/profile` (the 8 queries of `CarrierProfile.tsx:18-25` in one transaction), `GET /api/batches/:id`, `GET /api/batches/:id/activity?limit=3`, `GET /api/dashboard`, `GET /api/batches/:id/sheet-header`, `POST /api/dnc/lookup` |
| table writes (status change, promote, comment, contact log) | `POST /api/batch-carriers/status`, `POST /api/batch-carriers/promote`, `POST /api/batches/:id/comments`, `POST /api/contact-logs`. Same SQL as today, executed under RLS as `recruiter_api` with the session GUC. Actor ids come from the session, never from the body |
| `UsersAdmin.tsx` profile list/update | Team routes (§5.4) |
| `guards.tsx` `useSession` / `supabase.auth.*` | `GET /api/session`; `RequireApproved` → `RequireActive`; 401 → full navigation to `/signin` |
| `Login/Register/Forgot/Reset/Pending.tsx` | deleted (server pages replace Login; others gone) |
| `lib/supabase.ts`, `VITE_SUPABASE_*` env | removed from the app bundle |

### 4.3 Out of scope (unchanged)

The pipeline, its service role and `SUPABASE_DB_URL` stay as they are, as do the staging SQL
runner and the staging marker (the role-matrix SQL is updated to set `app.session_hash`
fixtures instead of `request.jwt.claims`), Google Maps, and Realtime (not wired; see §5.5).

---

## 5 · Threat model and full access-path coverage

### 5.1 Assets and adversaries

Assets: carrier/contact data, call notes, DNC list, the roster, sign-in links, sessions,
recovery codes. Adversaries: an outsider with the public site; an outsider with the old public
Supabase anon key (it is in old bundles); a former or demoted staff member holding old
cookies, links or passwords; an email scanner; a malicious page in another tab; a staff member
probing other people's access; someone who reads logs; a compromised Worker or DB credential
(the new trust boundary).

### 5.2 Access paths and how each is closed

| # | Path | Today | After | Evidence needed |
|---|---|---|---|---|
| P1 | Worker `/api/*` | — | session cookie → hash → `current_session()` on every statement | T-SQL, T-W |
| P2 | Worker auth routes | — | §3; generic response + timing on `/auth/request` and `/auth/recovery`; fail-closed pages | T-W, T-TIME |
| P3 | PostgREST `/rest/v1` with anon/publishable key | RLS-gated reads for `authenticated` | no grants for `anon`/`authenticated`; RLS re-keyed | **T-LIVE-A** (hosted) |
| P4 | PostgREST with a Supabase user JWT (password or OTP session of an existing user) | full staff access | same as P3: no grants, no `app.session_hash` → nothing | T-LIVE-B |
| P5 | GraphQL `/graphql/v1` | grants-gated | same as P3 | T-LIVE-A |
| P6 | Realtime postgres_changes | RLS-gated, publication has 6 tables (`20260720001300_realtime.sql`) | needs SELECT grant → none; policies need session → none. Recommended additionally: remove the 6 tables from `supabase_realtime` (reversible) | T-LIVE-A |
| P7 | Realtime Broadcast/Presence | open message bus for anon key, no DB data | no data either way; owner may enable "private channels only" (O6) | T-LIVE-A |
| P8 | Supabase Auth `/auth/v1/otp`, `/magiclink`, `/recover`, `/signup`, `/token` (password, refresh), `/verify`, `/resend`, `/user` | live; password sign-in in use | Owner disables signups and every provider (email, phone, anonymous, OAuth) (O2). Tokens that still exist reach no data (P4). Expected codes: `signup_disabled`, `email_provider_disabled`, `otp_disabled` [SB error codes]. **The actual responses must be read live** before and after the change (A5b, §8.1) | T-LIVE-B |
| P9 | Storage `/storage/v1` | enabled (`config.toml:47`); no buckets in migrations | Verify no buckets exist and `storage.objects` has no policies for anon/authenticated | T-LIVE-A |
| P10 | Edge Functions | none exist (`supabase/functions` absent) | none | repo |
| P11 | Direct Postgres (`postgres`, `service_role`, pipeline) | operator/pipeline | unchanged; trusted | — |
| P12 | `recruiter_worker` credential leak | — | **Authentication authority (finding 4).** The holder can mint a link for any active staff address with a token of their own, redeem it with a session hash of their own, and set that hash, giving full staff access with no email and no Worker keys. They cannot read the auth ledger tables (definer functions only) or bypass RLS. Protection: the credential is a Worker/Hyperdrive secret only, with rotation runbook, `connection limit`, emergency sign-out (D1). **Tripwires (detective, not proof):** every redeem is audited in `internal.auth_events` by the definer function itself; a daily operator query flags redeems whose link has `send_attempted_at is null` or no provider message id, and sessions created outside the Worker's normal request pattern. | **T-CRED** (expected to succeed; proves the classification) |
| P13 | Old SPA bundle with the anon key | — | same as P3/P8 | T-LIVE-A/B |
| P14 | Session-id GUC injection | — | `app.session_hash` is a hash of a 256-bit secret, not an identity. Setting it requires SQL access plus knowledge of a live hash | T-SQL |
| P15 | CSRF / cross-site | — | SameSite=Lax + Origin + double-submit HMAC token on every POST. Exceptions: `/auth/request` (public by design, as [QQ]: it creates no session and sets no cookie) and the webhook (signature). **`/auth/recovery` is not an exception (finding 1):** it creates a session, so it needs a strict Origin (required, exact) plus an anonymous pre-session form token (§7.2) | T-W, T-REC |
| P16 | XSS stealing the session | tokens in `localStorage` (`supabase.ts:33-52`) | HttpOnly cookie; strict CSP; sign-in pages run no script | T-W headers |
| P17 | Link in URL leaking (Referer, history, logs) | — | removed on first hop by 303; `no-referrer`; log exclusion gate | T-HYG |
| P18 | Recovery session reading normal data | — | denied at the DB: no staff role for `kind='recovery'`; only `recovery_*` functions with explicit columns (§7.3); the Worker also allow-lists recovery routes | T-REC direct requests |

### 5.3 Revocation consistency

`trg_profiles_revoke_on_change` (AFTER UPDATE on `public.profiles`, definer): when `email`,
`role` or `status` changes, in the same transaction, it sets `revoked_at` on every live
session, every unused link and every unused recovery code for that person. Because it is a
trigger, **every** path that changes these fields (Team routes, operator SQL, service role,
Studio) revokes. Also, `current_session()` re-reads the profile on every statement, so a role
change takes effect immediately even before revocation. Ceilings are **not** reset on email
change (links stay counted by user id).

### 5.4 Team (roster) routes — manager-added only

`GET /api/team`, `POST /api/team/add`, `/edit`, `/deactivate`, `/reactivate`,
`/clear-block` (if blocks are adopted), `/recovery/revoke`. All are `is_manager()` and **not**
a recovery session. Rules from spec 13 B6/B10 [repo `UsersAdmin.tsx:112`]: no self-demotion or
self-deactivation; the last active manager is protected under `internal.roster_lock`
(one-row lock table) taken before the profile row.

- **Add** creates a profile row directly (`status='approved'`, chosen role). Because
  `profiles.id` references `auth.users(id) on delete cascade` (`20260720000300_profiles.sql:13`),
  a new staff member would need an `auth.users` row. **Proposed:** a **separate, later**
  migration M2 drops that FK (existing ids and rows untouched; also removes the cascade-delete
  hazard). It is a schema decision (**D8**). M2 is applied only after the backout window
  closes (§11.5). Until then the cutover migration M1 keeps the FK, and **Add** is disabled by
  the Worker flag `TEAM_ADD_ENABLED=false` (**UNAPPROVED PROPOSAL, D8/D10**). **Email changes
  are paused too** (proposal)
  (`TEAM_EMAIL_EDIT_ENABLED=false`, enforced in the Team route **and** by an M1 trigger that
  refuses `profiles.email` updates while `internal.backout_window.open = true`). Otherwise
  `profiles.email` and the old `auth.users.email` would drift, and a backout would bring back
  an obsolete sign-in identity (re-review finding 3). Name and role edits, deactivate and
  reactivate still work. Name and status live only in `profiles`, which the old app reads too.
  There is **no exception** during the window: an address change waits until the window
  closes. Any future override needs its own separately reviewed runbook that defines a
  narrowly authorized trigger bypass and safe handling of a partial failure (review round 4,
  finding 3). It is not part of this design. So during the window every profile keeps a matching Supabase Auth account, and
  a backout restores a working old app (review finding 5). Re-adding the FK `NOT VALID` later is
  **not** a backout path and is not claimed as one. The rejected alternative, creating Supabase
  Auth users from the Worker, needs `service_role` in the Worker.
- Email uniqueness: a partial unique index on `lower(email)` for active staff. Creating it can
  fail if duplicates exist in production, so it depends on the verified inventory (O1). Until
  then, the add/edit routes check under the roster lock.
- Existing `pending`/`guest` rows are shown read-only as "No access (legacy)". This work offers
  no bulk conversion (decision deferred). A manager may activate one person through **Edit**,
  which is an ordinary roster action, as it is today in `UsersAdmin`.

### 5.5 Abuse controls on every reachable auth route

| Route | Controls |
|---|---|
| `POST /auth/request` | 20/IP, 10/address per 15 min (pre-response, atomic); per user 1/min, 5/h, 10/Chicago-day; 2-min courtesy; definite-failure exception (§3.1) |
| `POST /auth/recovery` | strict Origin (required, exact) + anonymous pre-session form token (§7.2); refused if a valid session cookie is already present; same envelope; own buckets 20/IP, 10/address per 15 min; per user ≤ 5 failed attempts per hour and 10 per Chicago day, then refused (generic) (§7) |
| `GET /auth/verify`, `GET/POST /auth/confirm` | 256-bit tokens; no oracle beyond "valid link → button"; no rate limit needed for guessing; body caps |
| `POST /webhooks/sendgrid` | signature first; body cap; no outcome leak |
| `POST /auth/signout` | CSRF |

---

## 6 · Concurrency and post-response execution (validation item (d))

1. **Lock order everywhere** (authoritative statement in doc 15 §14.2): `internal.roster_lock`
   (manager-set changes only) → `profiles` rows in ascending id order (targets `FOR NO KEY
   UPDATE`, actor `FOR SHARE`) → the actor's session → business rows → other sessions → link
   rows → recovery sets/codes (full class table: doc 15 §17.2). Every protected write
   re-validates the actor **inside** its transaction from rows locked in this order (doc 15
   §14.2, executed by `internal.lock_and_validate`).
2. **Claim vs roster change:** `auth_link_redeem` and every Team route lock the same profile row
   first. If the claim commits first, the change's trigger revokes the new session. If the
   change commits first, the link is revoked (or the person is no longer active) and the claim
   fails. Test T-CONC-1 runs both orders on two connections with `pg_sleep` choreography.
3. **Double press:** two redeems serialize on the profile row and then the link row `FOR UPDATE`.
   The second sees `used_at` set and fails closed. Exactly one session row exists (T-CONC-2). The
   browser may render the second response ("already used") although the first set the cookie,
   the same as [QQ]. Small proposed improvement: when the fail path sees a valid
   `__Host-tr_session` for the same user, it redirects to `/`.
4. **Post-response work on Workers.** [CF context docs]: `waitUntil` "can extend execution for
   up to 30 seconds after the response is sent or the client disconnects" … "If any Promises have
   not settled after 30 seconds, they are canceled." This is shared across all `waitUntil` calls
   in the request. Design: the identity work promise is created when the response timer fires
   (so it starts after the anonymous work and the envelope). It has an overall 25 s budget:
   lock wait ≤ 5 s, provider call ≤ 8 s, two short transactions. If cancelled, the link stays
   `pending` (no email sent) or `pending` with an unknown send. The 2-minute courtesy then
   expires and the person retries, which is [QQ]'s "best-effort, human-retried delivery"
   (handoff line ~1313). **Not "after flush":** Workers has no hook for "response bytes
   delivered". The response is returned at the timer and the work runs concurrently afterwards.
   Timing independence is a measured property (T-TIME), not a guarantee. Same honesty as [QQ]
   "remains best-effort".
5. **Admission vs envelope:** the bucket transaction has 200 ms lock / 400 ms statement timeouts
   and a 600 ms overall deadline (`AbortController`). Past the deadline → no identity work
   (fail closed). Late increments only make limits stricter.
6. **Webhook vs post-send write race:** handled by the DB lattice trigger and [QQ]'s guarded
   CASE update (R5-I-01).

---

## 7 · Restricted recovery codes (validation item (e)) — proposal for cross-app policy

Status: **proposed design, subject to independent security review and the coordinator's
cross-app policy.** Nothing here is decided. Disagreements go to the manager → coordinator.

### 7.1 Purpose

The outage fallback for when the mail provider cannot deliver sign-in links. It is not a second
everyday sign-in method.

### 7.2 Lifecycle

| Step | Rule |
|---|---|
| Enrollment | From the signed-in **Account** panel, any active staff member (policy option: managers only, D2) presses "Create recovery codes". **One transaction (doc 15 §14.5):** lock the actor's profile `FOR UPDATE` → lock the session `FOR SHARE` → re-validate under lock (link session, created ≤ 15 minutes ago, unrevoked, unexpired, profile active, email unchanged) → revoke the current active set and its unused codes (`regenerated`) → insert the new set and its 10 codes → commit. A partial unique index allows **one active set per person**, so concurrent enrollments serialize on the profile lock and the loser's set is revoked or refused. Codes: 16 characters from a 32-symbol alphabet without look-alikes (80 bits), shown **once** with "Print" and "I saved them". CSRF and strict Origin required |
| Storage | `internal.recovery_sets(id, user_id, created_at, revoked_at, revoked_reason)` with `unique (user_id) where revoked_at is null`; `internal.recovery_codes(id, set_id, user_id, code_hash unique, created_at, expires_at, used_at, revoked_at, revoked_reason)` with `check (used_at is null or revoked_at is null)` (a code is used **or** revoked, never both). Revocation touches only `used_at is null`; consumption only `revoked_at is null`. `app_sessions.recovery_code_id unique references recovery_codes` (one session per code). `code_hash = hmac(KEY_RATE, normalized code)`. The raw code exists only in the one `no-store` response that shows it and is never logged |
| Expiry | 180 days after creation (proposal). The Account panel shows remaining codes and the expiry. |
| Use | `GET /signin/recovery` (not linked from `/signin`, so the decision-19 page stays identical) renders the form (email + code) and sets an **anonymous pre-session CSRF cookie** `__Host-tr_pre` (random 256-bit, `Secure; HttpOnly; SameSite=Strict; Path=/`, 30 min), with hidden field `pre_token = hmac(KEY_SESSIONS, "pre:" ‖ cookie)`. If the browser already has a valid session, the page redirects to `/` instead. `POST /auth/recovery`, **before any DB work and before any code is touched (review finding 1)**: (1) `Origin` **must be present** and equal `APP_ORIGIN` exactly. A missing, `null` or different Origin is refused, never falling back to `Host`. (2) `__Host-tr_pre` present and `pre_token` matches it in constant time. (3) **No valid `__Host-tr_session` already present.** A signed-in browser is never switched to another account; the victim's existing session and cookies are left untouched. Any failure in (1)–(3) → the generic failure page, no code consumed, no cookie set or cleared. Then: same 1000 ± 100 ms envelope; anonymous buckets; then **before** the response (it must decide whether to set a cookie), one transaction locks the profile row, checks active staff and the per-user failure ceilings, and matches an unused, unrevoked, unexpired code for that user. On success: mark it used, create a session `kind='recovery'`, clear `__Host-tr_pre`, set the session and app-CSRF cookies, 303 `/recovery`. Every failure class gets the single generic page "That didn't work. Check the address and code, or ask a manager." The envelope covers the DB work (target ≤ 600 ms; over → fail closed). Tests (T-REC): a cross-site form post with a valid attacker code (no Origin, foreign Origin, `null` Origin, missing or wrong pre-token) never consumes the code and never changes the victim's cookies; a same-site post while signed in is refused and the victim's session still works. **Consumption ordering is superseded by doc 15 §14.5** (non-locking pre-check; profile lock only after a valid code; consume; revalidate; session). |
| Limits | Buckets as §5.5. Per-address failure ceilings (5 per hour, 10 per Chicago day) are keyed by `hmac(KEY_RATE, normalized email)`, **not** by user id, so counting a failure needs no user lookup and no lock. A wrong code never reveals whether the address exists, and never locks a profile (doc 15 §14.5) |
| Session restrictions | `kind='recovery'`: absolute life **12 hours**, idle **1 hour** (kind-dependent renewal, §3.5). **Deny by default at the database:** no staff role, so every normal policy, view and RPC refuses (§4.1). Only the §7.3 matrix is reachable, enforced at **both** the Worker (route allow-list per session kind) and the DB (`recovery_*` functions check the kind and return explicit columns). There is no Team page, no identity/role/status change, no exports or contact sheet, no recovery-code view or regeneration (no recovery escalation), no adding staff and no indirect grants. This app has no templates. The UI shows a reduced recovery screen with a persistent banner: "Signed in with a recovery code — limited access until email sign-in works again." Hiding buttons is **not** relied on; T-REC calls every normal endpoint and RPC directly with a recovery session and expects refusal. |
| Revocation | The §5.3 trigger (email/role/status change). Regenerating a set. Manager "Revoke recovery codes" on the Team page (needs a link session). Emergency sign-out (D1). |
| Audit | `internal.auth_events(id, at, user_id null, kind, detail jsonb)` for: set created, code used, recovery failure (with keyed IP hash, no code), set revoked, emergency sign-out. Managers see recent recovery events on the Team page. A notice email ("a recovery code was used") is queued and sent when mail works. |
| Outage drill | Staging only, quarterly (proposal): switch the mail adapter to a fault-injecting fake, sign in with a fixture user's recovery code, check every restriction (T-REC), regenerate, record a dated note. No live email involved. |

### 7.3 Recovery permission matrix (default proposal; D2 may widen it only by editing this table)

**Rule: a recovery session can never exceed the person's ordinary role (re-review finding 1).**
Effective permission = (this matrix) ∩ (what the same person's ordinary role allows). Each
`recovery_*` function checks, in SQL, both `kind = 'recovery'` and the "Minimum ordinary
role" column below, using the live profile role. So a Viewer's recovery session has no
writes at all, status change included. The Worker repeats the check (defence in depth only;
the DB check is the authority).

Field classes: **C** = contact details (phone, email, contact names and every
`contact_*_override`, street address); **N** = free-text notes (call notes, comments,
`next_steps`, DNC reasons); **I** = identity/roster data of colleagues (emails, roles).
Allowed columns are listed exactly. Everything not listed is denied.

| Recovery route (Worker) | DB function | Minimum ordinary role | Returns / does | C | N | I |
|---|---|---|---|---|---|---|
| `GET /api/session` | `internal.current_session()` | viewer | own name, role, `sessionKind='recovery'`, expiry (from the session row, not a profile read) | — | — | own name only |
| `GET /api/recovery/batches` | `public.recovery_batches()` | viewer | `id, name, customer, job, created_at`, member counts by status | no | no | no |
| `GET /api/recovery/batches/:id/members` | `public.recovery_batch_members(uuid, int, int)` | viewer | `dot_number, legal_name, dba_name, phy_city, phy_state, status, status_changed_at`, plus a DNC **flag** (boolean only) | no | no | no |
| `POST /api/recovery/batch-carriers/status` | `public.recovery_set_status(uuid, bigint, batch_carrier_status)` | **editor** (`edit` or `manager`); a Viewer is refused | single status change; DNC carriers refused; actor = session user; audited | no | no | no |
| `POST /auth/signout` | `internal.auth_session_revoke` | viewer | sign out | — | — | — |
| **everything else** (`/api/rpc/*`, `/api/carriers/*`, `/api/contact-logs`, `/api/team/*`, `/api/recovery-codes/*`, profile reads, exports, sheet, maps, search) | normal functions | — | **403 at the Worker; refused or empty at the DB** | — | — | — |

Whether contact details (C) should be visible during an outage, so people can keep calling,
is a policy choice for the coordinator (D2). If they are allowed, they are added as a new row
with an explicit column list and its own test, never by granting the staff role.

### 7.4 Consistency with the other apps

The coordinator relayed "restricted recovery codes as the proposed shared outage fallback". The
values above (10 codes, 80 bits, 180 days, 12 h / 1 h, who may enroll, the restriction list)
are **proposals to be made consistent across apps**. They are listed as D2. I have not seen
the other apps' designs.

---

## 8 · Test plan

All tests use fictional data. No live email. Links, codes and session values are passed in
memory only; a redaction check fails the run if `token=`, a 43-character base64url token, or a
recovery-code pattern appears in any test output or artifact (T-HYG).

| ID | Kind | What | Needs |
|---|---|---|---|
| T-UNIT | Vitest (Node) | Worker pure modules: cookie serialize/parse, CSRF, mask, Chicago-day bounds (incl. 2026-03-08 / 2026-11-01 DST days), IP canonicalization, body preflight, outcome mapping, webhook ECDSA verify with SendGrid's published fixture, route table, header set | A1 |
| T-W | Vitest, Worker `fetch` handler with a fake DB port + `FakeMailAdapter` | every route's status/headers/cookies; fail-closed paths; CSRF/Origin; 401 handling; activity renews only on navigate/mutation/activity | A1 |
| T-SQL | throwaway PG16 cluster, `psql -v ON_ERROR_STOP=1` scripts | Supabase shim (roles `anon`, `authenticated`, `service_role`, schema `auth` with `users`, `uid()`, `role()`, `jwt()`); the new migration on a **PostGIS-free subset** (enums, profiles, activity, contact, auth ledgers, re-keyed helpers, simplified batches without geometry). Role matrix by session kind; expired/idle/revoked/absolute; email/role/status trigger revokes sessions, links and codes; lattice trigger; ceilings at boundaries; pipeline-like writes with no GUC; anon/authenticated get permission errors on every table and function | A3 |
| T-CONC | two `psql` sessions + `pg_sleep`/advisory-lock choreography | claim vs role change (both orders); double redeem → one session; mint vs deactivate; recovery use vs regenerate; last-manager demotions racing | A3 |
| T-INT | Vitest + `pg` against the throwaway cluster | Worker auth core with the real SQL: request → (fake mail captures the link in memory) → verify → confirm → `/api/session` → sign out; cross-"device" (fresh cookie jar opens the link); stale nonce; other account's newer link | A1, A2, A3 |
| T-TIME | T-INT harness | 200 mixed requests (active, unknown, inactive, over-limit, invalid, malformed body) → body/status identical, response times within 900–1100 ms in Node. Faults: DB lock held 2 s, mail adapter 5 s delay or throw, bucket transport delay → identical envelope; no send when the admission deadline is missed | A3 |
| T-WRANGLER | `wrangler dev` locally | Same flows in workerd; `waitUntil` completion after the response; CPU-time sample; real cookie attributes; static routing (`run_worker_first`) | A2, A4 |
| T-VIS | local `wrangler dev` + bb browser automation | screenshots of the 5 states at 1280 and 390 wide vs [QQ] measurements (440 px shell, 72 px badge, 40 px controls), axe-style label check | A4, A6 |
| T-LIVE-A | hosted **staging**, stateless reads with the public anon key only (§8.1, class A) | P3, P5, P6, P7, P9 before and after cutover | A5a |
| T-LIVE-B | hosted **staging**, **stateful** fixture probes (§8.1, class B) | P4, P8 and write attempts, per fixture class, before/after | A5b (separate) |
| T-REPLAY | staging full migration replay with PostGIS (M1, backout, M1 again) | geometry RPCs under re-keyed helpers; backout rehearsal | staging approvals |
| T-REC | T-SQL + T-INT | single use; rate limits; regeneration revokes; trigger revokes. **Login-CSRF:** cross-site recovery posts (no Origin, `null`, foreign Origin, missing or wrong pre-token) never consume a code or touch cookies; a post while signed in is refused and the existing session still works. **Matrix:** with a recovery session, call **every** normal `/api/*` route, every allow-listed RPC and every table/view directly in SQL; expect 403 or refusal/empty. `recovery_*` results contain exactly the §7.3 columns (column-set assertion). **Role intersection:** a Viewer's recovery session calling `recovery_set_status` directly (Worker route and SQL) is refused, and no row changes; an Editor's succeeds; demoting the Editor to Viewer mid-session makes the next call fail. **Own profile:** with a recovery session, `select … from profiles where id = <self>` returns zero rows (direct SQL and Worker); with a link session it returns the row. **Renewal:** recovery expiry after navigation, mutation and activity ping (extension ≤ 1 h, never past 12 h) and after background polling (no extension) | A1, A3 |
| T-CRED | T-SQL | with only the `recruiter_worker` login (no Worker keys, no email): mint → redeem with a self-chosen hash → set the GUC → read staff data. **Expected to succeed**, which proves §2.1's classification; also asserts that the audit row exists and the tripwire query flags it | A3 |
| T-BACKOUT | T-SQL (local, with a reconnect loop as `recruiter_worker`), then T-REPLAY (staging) | snapshot role-matrix results and grants on the pre-M1 schema → apply M1 → retire app credentials → apply the backout script → results and grants identical to the snapshot; the old JWT-claims role matrix passes again. Plus the §11.5 rehearsal cases (a)–(d): email edit refused during the window, open `recruiter_worker` connection terminated and unable to reconnect, pre-backout session/link/code refused after M1 is re-applied, email alignment check | A3; staging approvals |
| T-HYG | **release gate**, local + staging | (1) credential-pattern scan of every test output and artifact. (2) **Canary log search**: run each flow (request, verify, confirm, recovery, sign-out, `/api/*`) plus forced error paths (statement error and lock timeout while `app.session_hash` is set, malformed bind, bad webhook signature) with harness-generated canary values. Search Worker Logs/Tail, Hyperdrive, Postgres logs (normal and error) and the mail provider's activity view for the raw cookie, the session hash, the link token and URL, the recovery code and the pre-token. **Pass = zero hits in every log; any hit stops the release** | A3/A4 local; A7 staging |
| Project checks | existing | `app`: `npm run verify`; `pipeline`: `npm test`, `npm run build`; `node scripts/verify-migration-baseline.mjs` (fresh LF checkout); `verify-staging-contract.mjs`; other offline scripts | A1 |

**Evidence limits.** T-SQL runs on PG 16.15; hosted Supabase runs PG 15 (`config.toml:17`
`major_version = 15`). It also runs without PostGIS, so the RPCs that use geometry
(`search_carriers`, matcher, maps) are not exercised against the re-keyed helpers until a
PostGIS-capable run (staging replay) happens. This is stated in every report.

### 8.1 Hosted probe matrix (review finding 6)

Run on **staging only**, against the existing staging fixture accounts
(`supabase/staging/profile-fixtures.sql`, addresses at `tnbs-recruiter.example.invalid`, which
cannot receive mail), plus one fresh, never-registered `.example.invalid` address. The fixture
passwords come from the operator's environment and are never printed.

Fixture classes: **K** known active (manager, editor, viewer) · **U** unknown address ·
**D** deactivated · **LP** legacy pending · **LG** legacy guest.

**Class A: stateless (approval A5a).** Public anon key only, no login, no write:
- `GET /rest/v1/<every table and view>`.
- `POST /rest/v1/rpc/<each read-only RPC>` (search, counts, facets, dashboard,
  `batch_status_counts`, `is_contactable`).
- A GraphQL introspection query and one read query.
- `GET /storage/v1/bucket`, and a list on any bucket found.
- A Realtime `postgres_changes` subscription to each published table for 60 s. The fixture row
  change that should trigger it is a staging write, so it belongs to A5b.

Run before and after cutover. After-cutover pass: permission errors or empty results
everywhere, and no Realtime event.

**Class B: stateful (approval A5b, separate; each item creates Auth sessions or tokens, or
attempts mail).**

| Probe | K | U | D | LP | LG | Before cutover | After: passes when |
|---|---|---|---|---|---|---|---|
| `/token?grant_type=password` | ✓ | ✓ | ✓ | ✓ | ✓ | yes (documents today's exposure) | every class gets the same provider-disabled error class; no token |
| With a token **and refresh token** obtained **before** cutover (held only in the probe process's memory): REST and GraphQL reads, every RPC including writes (`create_batch` with a `PROBE-` name), Storage list, Realtime subscribe | ✓ | — | — | ✓ | ✓ | read-only part only | everything refused or empty; no row written (the staging fixture cleanup verifies) |
| `/token?grant_type=refresh_token` with that refresh token, **after L1** (§11.6) | ✓ | — | ✓ | ✓ | ✓ | no | refused (the refresh row is gone); no new token |
| `/otp`, `/magiclink`, `/recover`, `/resend` | ✓ | ✓ | ✓ | ✓ | ✓ | **no** (would attempt mail) | identical status and error code for K/U/D/LP/LG (no roster oracle); no mail attempt in the Auth logs |
| `/signup` | — | ✓ | — | — | — | **never before signups are off** (it would create an Auth user and a profile) | `signup_disabled`; if a user is created anyway → stop, report, clean up with the existing guarded cleanup script |
| `GET /user`, and `PUT /user` proposing (a) another fixture's email and (b) a fresh `.example.invalid` address, with the pre-cutover **access** token, **after L1** and again after the access-token lifetime (3600 s, `config.toml:54`) | ✓ | — | ✓ | ✓ | ✓ | `GET` only (documents today's exposure); **no** `PUT` before L1 | refused for both (a) and (b) with the **same** status and error code, so there is no email-duplicate oracle; `auth.users` emails unchanged |
| `/verify` with a junk token | ✓ | — | — | — | — | no | refused |
| Valid pre-cutover verification credentials L-a / L-b / L-c (Admin `generateLink` for fixtures, and one fixture email-change token; §11.6) | ✓ | — | ✓ | — | — | created before O2 | L-a: any session it made is gone after L1, and `/user` is refused after W; L-b and L-c refused after L1; no email changed |

**Equivalence rule.** For each Auth route, the HTTP status, error code and body shape must be
the same across K/U/D/LP/LG. A difference is a roster oracle on Supabase's side. It blocks
production until it is closed or the coordinator rules on it. Results are recorded as classes
only: no keys, tokens, URLs or project refs.

---

## 9 · Assumptions vs evidence

| # | Claim | Status | Evidence / test |
|---|---|---|---|
| E1 | Worker can serve the SPA plus server routes on one origin | **Documented**, not measured | [CF] static-assets routing (`run_worker_first`, `env.ASSETS.fetch`); T-WRANGLER |
| E2 | Worker reaches Supabase Postgres as a custom low-privilege role via Hyperdrive | **Documented** (CF Supabase guide) | live verification needed (O3, staging); IPv6 reachability **unverified** |
| E3 | Hyperdrive on Workers Free | **Documented** "100,000 / day" | — |
| E4 | Workers Free 10 ms CPU is enough | **Unverified** | T-WRANGLER CPU sample; else D5 |
| E5 | `waitUntil` ≤ 30 s after response, then cancelled | **Documented** | T-WRANGLER |
| E6 | Transaction-local GUC is safe under transaction pooling | **Reasoned** (Postgres semantics of `set_config(..., true)`) | T-SQL, T-INT |
| E7 | Revoking anon/authenticated grants closes PostgREST, GraphQL and Realtime data | **Reasoned** from [SB] "Postgres checks table grants before RLS" | T-SQL locally; T-LIVE-A/B hosted |
| E8 | Supabase Auth endpoints answer with errors once providers are off, identically for known and unknown addresses | **Documented codes only** | T-LIVE-B before/after (A5b) |
| E9 | No storage buckets exist | **Repo only** (none in migrations) | T-LIVE-A |
| E10 | `auth.uid()` scope = 22 sites / 4 migrations; 17 RPC + 24 table + 11 auth calls in app (corrected from 12, see doc 15 §12.1) | **Measured** (`grep`, 9fc3425) | — |
| E11 | Badge asset identical to [QQ] | **Measured** (git blob `dc6d248`, 1413×1377) | — |
| E12 | `CF-Connecting-IP` is reliable | **Unverified** here | T-WRANGLER + staging |
| E13 | `pg` works in Workers with `nodejs_compat` | **Unverified** here | T-WRANGLER |
| E14 | No credential in Worker, Hyperdrive, Postgres or provider logs, including error paths and bind parameters | **Unverified; release gate** | T-HYG canary search (A7) |
| E15 | Pipeline unaffected | **Reasoned** (service role, `auth.uid()` already null) | T-SQL pipeline-like writes; pipeline smoke tests |
| E16 | Supavisor accepts custom roles | **Unverified** (no doc found) | only needed for the fallback |
| E17 | Production user/profile inventory | **Unknown** | O1 (owner-run read-only query) |
| E18 | A recovery session reaches only the §7.3 matrix | **Design** | T-REC direct calls |
| E19 | Backout restores today's working app during the window | **Design** | T-BACKOUT local + T-REPLAY staging |

---

## 10 · Residual risks

| # | Risk | Effect | Mitigation |
|---|---|---|---|
| R1 | Worker secrets or the `recruiter_worker` credential leak; **the DB credential alone is an authentication authority** (§2.1, P12) | Attacker can create a session for any active staff member | Treated as a signing key: Worker/Hyperdrive secret only, never on laptops or CI; rotation runbook; connection limit; audit plus a daily tripwire query; emergency sign-out (D1). T-CRED keeps the claim honest |
| R2 | Credentials in logs | — | **Not a residual risk: a release gate (T-HYG).** If any log is shown or suspected to contain one, the release stops and the problem is escalated. There is no "accept and document" path |
| R3 | Envelope is a measured target | Platform stalls can shift timing for any address | T-TIME; fail-closed admission deadline |
| R4 | `waitUntil` cancellation at 30 s | A link minted but not sent | Courtesy 2 min, human retry; status stays honest |
| R5 | No PostGIS locally | Geometry RPCs not exercised under the new helpers until staging | Staging replay before rollout |
| R6 | Mail provider outage | No new link sign-ins | Recovery codes (if adopted); existing sessions continue |
| R7 | `run_worker_first: true` counts asset requests | Free-plan 100k/day request cap | Array patterns for assets; measure |
| R8 | Old Supabase passwords still exist (not scrambled, per directive) | Usable only against Supabase Auth, which reaches no data; once providers are off, not usable at all | O2 + T-LIVE-B |
| R9 | Dropping the `profiles → auth.users` FK (M2, after the backout window) | Loses a referential check; ends old-app compatibility for new staff | Only after the window closes (§11.5); D8 |
| R10 | PG16 vs hosted PG15 | Version differences | Staging replay |

---

## 11 · Rollout, approvals and owner actions

### 11.1 Approvals I need before testing (exact)

- **A1 — restore existing locked packages** (`npm ci` in `app/` and in `pipeline/` inside this
  worktree only). Purpose: run project checks and unit tests. Downloads the packages already
  pinned in the lockfiles; nothing new.
- **A2 — add dependencies:** `pg` and `@types/pg` **only** (revised 2026-10-21; `wrangler` and
  `@cloudflare/workers-types` are withdrawn, superseded by the Node server in doc 15).
  Purpose: server DB access and types.
- **A3 — throwaway Postgres cluster** (no service, not the system data directory):
  - folder: `C:\Users\hunte\.bb\thread-storage\thr_pn5gr4mx94\pg-auth-test\` (data + log)
  - create: `"C:\Program Files\PostgreSQL\16\bin\initdb.exe" -D <folder>\data -U tr_test_admin
    -A scram-sha-256 --pwfile=<folder>\pw.txt -E UTF8` (the password file holds a random
    throwaway value, deleted at the end)
  - start: `"C:\Program Files\PostgreSQL\16\bin\pg_ctl.exe" -D <folder>\data -l <folder>\log.txt
    -o "-p 55432 -c listen_addresses=127.0.0.1" start`
  - stop and delete: `pg_ctl … stop -m fast`, then remove the folder.
  - Purpose: T-SQL, T-CONC, T-INT, T-TIME, T-REC. Port 55432, loopback only.
- **A4 — local server** (revised: the local Node server on 127.0.0.1:8788, doc 15 §7; the
  original Worker command below is withdrawn): ~~`npx wrangler dev --ip 127.0.0.1 --port 8788 --local`~~ in `app/`, with
  `.dev.vars` holding throwaway test keys (in thread storage, not committed) and the DB pointed
  at A3. Purpose: T-WRANGLER, T-VIS.
- **A5a — stateless staging probes** (later): class A of §8.1. Public anon key only, no login,
  no writes. Before and after cutover.
- **A5b — stateful staging probes** (later, approved separately): class B of §8.1, using the
  staging fixture accounts. They create Auth sessions and tokens, attempt mail to undeliverable
  fixture addresses after providers are off, and make one `PROBE-` write attempt that must
  fail. `/signup` runs only after signups are disabled.
- **A6 — bb browser automation** against `http://127.0.0.1:8788` only, for screenshots.
- **A7 — staging log inspection for the T-HYG gate** (later): an operator or owner searches the
  Cloudflare Worker/Hyperdrive logs and the Supabase Postgres logs for harness canary values,
  and reports hit counts only.

### 11.2 Rollout plan (each step its own owner "go")

1. Gate 1 review of this design → fixes → approval.
2. Build on this branch with A1–A4, A6 (A1 approved 2026-10-21; the others pending) → Gate 2 independent code review.
3. Staging: owner-approved staging DB migration, Hyperdrive config (caching disabled), Worker
   secrets, `recruiter_worker` password, the mail provider (or fake mail on staging), and staging
   rebuild if needed (that rebuild was deferred until after sign-in). §8.1 probes (A5a, A5b),
   T-REPLAY with the backout rehearsal, T-HYG gate (A7).
   Hunter's 5-minute walkthrough.
4. Production: read-only inventory (O1) → decisions on pending/guest and the unique index →
   pre-cutover grant/policy snapshot (read-only, §11.5) → maintenance flag on → **M1** → Worker
   deploy → owner disables the Supabase Auth providers (O2) → **L1: close legacy Supabase Auth
   sessions (§11.6, its own owner approval)** → probes as in §8.1 → T-HYG gate →
   maintenance flag off → first manager signs in. The backout window opens (§11.5).
5. Window closes (owner decision, D10) → **M2** (FK drop, D8) and `TEAM_ADD_ENABLED=true`. From
   then on, forward-fix only.

### 11.3 Open central decisions (not resolved here) and what each blocks

| ID | Decision | Owner | Blocks |
|---|---|---|---|
| D1 | Who may trigger "sign everyone out" (and how): manager role in-app, operator SQL only, or the coordinator's shared procedure | coordinator | recovery slice S6 (emergency revoke UI); rollout S8 runbook |
| D2 | Recovery-code policy: adopt? who enrolls; count; entropy; expiry; recovery-session limits; **the §7.3 permission matrix, especially whether contact details (C) are visible during an outage** | coordinator + independent review | S6 (built with the default deny matrix, behind a disabled flag, until decided) |
| D3 | Mail provider and sender (Quote-Queue's SendGrid account vs other; address) | Hunter via coordinator | live delivery S7-live and rollout S8 only; the adapter and fakes are not blocked |
| D4 | Test-environment and rollout approvals (A2–A7, staging, production; A1 approved 2026-10-21) | manager / Hunter | testing of all slices; S8 |
| D5 | Workers plan if Free CPU is insufficient (spend) | Hunter | S8 |
| D6 | DB connection path on hosted (Hyperdrive direct vs pooler; IPv4 add-on if required, which is spend) | manager / Hunter after A5 | S8 |
| D7 | Fate of legacy pending/guest rows | Hunter, after O1 | nothing in the build; production cleanup only |
| D8 | **UNAPPROVED PROPOSAL.** Drop the `profiles.id → auth.users` FK (schema change), proposed as **M2 after the backout window** | review + manager / Hunter | S5 Team "add" only; M1 and the rest are not blocked |
| D9 | Design-system version for the sign-in surfaces (v1.0 vs [QQ] v1.1) | coordinator | S4 final visual sign-off only |
| D10 | **UNAPPROVED PROPOSAL.** Whether there is a backout window that pauses email edits and Team "add"; its length; who declares it closed | Hunter via manager | M2 timing; production rollout plan |

Build slices: S1 DB migration + SQL tests · S2 Worker auth core · S3 data API + SPA port ·
S4 sign-in pages · S5 Team page · S6 recovery codes · S7 mail adapter + webhook · S8 rollout.

### 11.4 Owner actions (later, each separately approved; none now)

- O1 Run the read-only production inventory (counts of profiles by role/status, duplicate
  emails), by the existing Hunter-run read-only query route.
- O2 In Supabase (staging, then production): turn off sign-ups and every Auth provider; keep the
  project otherwise unchanged.
- O3 Create the Hyperdrive config (caching disabled) and the `recruiter_worker` password; add
  Worker secrets (keys, DB, mail).
- O4 Mail provider setup per D3 (sender, send key, signed event webhook).
- O5 Provide log access (or run the canary searches) for the T-HYG gate (A7). Set logging so
  that query strings, headers and bind parameters are excluded wherever the platform allows.
- O6 Optionally set Realtime to private channels only.

### 11.5 Backout and forward-fix (review finding 5)

> The backout **window** and its pauses (email edits, Team "add") and the M2 FK drop are
> **unapproved proposals** (D8, D10). The backout scripts and their rehearsal are reviewed
> gates that apply whatever D8/D10 decide; all user data is preserved.

**Why it works.** During the window the database still has everything the old app needs. M1
keeps the `profiles → auth.users` FK and Team "add" is off, so every profile still has its
Supabase Auth account. No password was scrambled. Data the new app writes (contact logs,
statuses, comments) uses the same profile ids, so the old app reads it unchanged. The new
ledger tables stay in place, inert, for audit.

**Prepared artifacts (in the repo, reviewed at Gate 2, rehearsed):**
- `supabase/backout/pre-cutover-snapshot.sql`: read-only. Lists every grant on `public` and
  `internal` objects, every policy definition and every function definition that M1 touches,
  plus the role-matrix results. It runs before M1, and its output is stored with the release.
- `supabase/backout/M1-backout.sql`: one transaction. It restores the exact pre-M1 bodies of
  `current_app_role`, the replaced triggers and RPCs, the dropped or recreated policies
  (including `profiles_update_self`), and the grants to `anon`/`authenticated` (generated
  from, and checked against, the snapshot). It drops the revocation trigger and the window
  email trigger. It deletes no ledger table and no data.
- `supabase/backout/retire-app-credentials` (an ordered operator procedure, not one
  transaction; review round 4, finding 2). It runs **before** the definitions are restored:
  1. **Stop the pool first.** The Worker maintenance flag must already be on (that code path
     opens no DB connection). Then delete the Hyperdrive config, or replace its stored
     password with a random throwaway value, so the pool cannot reconnect with a valid
     credential.
  2. **Commit `NOLOGIN` on its own:** `alter role recruiter_worker nologin password null;` in
     autocommit (its own committed transaction), so every *new* login fails from that
     moment. A `NOLOGIN` left uncommitted inside a larger transaction would not be visible
     to new connections.
  3. **Terminate, then confirm:**
     `select pg_terminate_backend(pid, 5000) from pg_stat_activity where usename =
     'recruiter_worker';` (the PG ≥ 14 form waits up to 5 s per backend and returns false on
     timeout). Then poll `select count(*) from pg_stat_activity where usename =
     'recruiter_worker'` every second until it reads 0 **three times in a row**. More than
     60 s without that → stop and escalate; do not continue the backout. Hosted support for
     the timeout argument is **[assume: verify the PG version]**; without it, use the plain
     form and the same poll.
  4. **Only then** revoke the ledgers in one transaction: mark every live app session, unused
     sign-in link and unused recovery code `revoked_at = now(), revoked_reason = 'backout'`.
     A later re-apply of M1 therefore resurrects nothing.
  5. Checks: zero backends for the role, a login attempt as `recruiter_worker` fails, zero
     live ledger rows.
- Re-forward after a backout uses **new** Worker keys (`KEY_LINKS`, `KEY_SESSIONS`,
  `KEY_RATE`) and a new `recruiter_worker` password, so nothing issued before the backout can
  match again.
- The pre-cutover Worker version id, recorded at deploy, for `wrangler rollback` (the previous
  static build with supabase-js).

**Backout procedure** (owner "go" required; the operator runs it):
1. Turn the maintenance flag on. It is a Worker env var: every route serves a static "Back
   shortly" page, with no DB change.
2. Run the `retire-app-credentials` procedure in its fixed order: pool stopped (Hyperdrive
   config deleted or neutralized) → `NOLOGIN` committed → backends terminated and confirmed
   gone → ledgers revoked → checks.
3. Check identity alignment: for every approved profile, `profiles.email = auth.users.email`
   (expected, because email edits were paused; any mismatch is fixed by the operator before
   step 6).
4. Apply `M1-backout.sql`.
5. Re-enable the Supabase email provider (the reverse of O2; signups stay off). Legacy
   sessions closed by L1 stay closed; people sign in again with their passwords.
6. Roll the Worker back to the recorded pre-cutover version.
7. Smoke test. On staging: a fixture signs in on the old password page, reads a batch and logs
   a test call. On production: a read-only check. Compare the role matrix with the snapshot.
8. Tell the team. Sessions from the new system are revoked; everyone signs in the old way.

**Forward-fix** is preferred for defects that don't threaten data or access control:
maintenance flag on → fix on the branch → expedited independent review → redeploy → flag off.
For access-control or credential defects, back out first and fix later.

**Rehearsal (required before production):** T-BACKOUT locally on the throwaway cluster
(snapshot → M1 → backout → identical results), then on staging inside T-REPLAY: M1 → backout
→ old app works → M1 again → new app works. The rehearsal also proves: (a) a Team email edit
during the window is refused by both the route and the trigger; (b) **concurrent
reconnection**: a client loop tries to connect as `recruiter_worker` every 50 ms throughout
the procedure, alongside two held-open connections. After the `NOLOGIN` commit, every new
attempt fails. After termination the held connections are gone, and the backend count stays
0 for 60 s while the loop keeps trying; (c) a session, link and recovery code issued before the backout are all
refused after M1 is re-applied (old keys, and the rows are revoked); (d) the
`profiles.email = auth.users.email` check passes on the fixtures.

**After the window:** M2 drops the FK and turns Team "add" on. New staff then have no Supabase
Auth account, so the M1 backout would no longer give them a working old app. That is why M2
waits for the owner to close the window.

### 11.6 L1 — closing legacy Supabase Auth credentials (re-review finding 2; round 4 finding 1)

**Why.** Turning the providers off (O2) stops **new** Supabase sign-ins. It does not end what
already exists:
- sessions and refresh tokens;
- outstanding **verification credentials**: magic-link, OTP, recovery, confirmation,
  email-change and reauthentication tokens, plus PKCE flow state. Supabase's verify endpoint
  turns a valid one into a **fresh session** (`internal/api/verify.go`, per the review).

Any of these can reach Supabase Auth's own `/user` endpoint. Its email-update path checks the
proposed address for duplicates, which could reveal whether an address belongs to a roster
member (an oracle). Having no app data behind those credentials does not close that.

**Order** (each step owner-approved; staging first, then production; the operator runs it as
`postgres`; no password is scrambled, no user is banned or disabled, and no email, password or
profile is changed):

0. **Read the hosted settings, read-only, and record them:** access-token (JWT) expiry and
   email OTP/link expiry, from the Auth settings of that project. The waiting bound **W** =
   the larger of the two, plus 5 minutes of clock margin. `config.toml` values are **not** used
   for W; they describe local dev only. If either setting cannot be read, L1 stops.
1. **Stop issuance first (O2):** signups off, and every provider off (email, phone, anonymous,
   OAuth). Then confirm with the §8.1 class-B issuance probes (`/otp`, `/magiclink`, `/recover`,
   `/resend`, `/signup`) that nothing new can be issued. A request already in flight at that
   moment can still finish issuing a credential; the steps below and the wait W cover it.
2. **Read-only shape check:** list the columns of `auth.sessions`, `auth.refresh_tokens`,
   `auth.one_time_tokens`, `auth.flow_state` and the token columns of `auth.users`. Classify
   every other `auth.*` table as credential-bearing or not. Anything credential-bearing that
   is not listed below stops L1 for review **[assume: hosted schema matches current
   supabase/auth master]**.
3. **One transaction:**
   - `delete from auth.refresh_tokens;`
   - `delete from auth.sessions;`
   - `delete from auth.one_time_tokens;`
   - `delete from auth.flow_state;`
   - `update auth.users set confirmation_token = '', recovery_token = '',
     email_change_token_new = '', email_change_token_current = '', phone_change_token = '',
     reauthentication_token = '' where <any of these is not empty>;` This clears **only**
     outstanding verification-token values. Email, pending-change target, password hash,
     ban state and every other column are untouched. This `auth.users` update is the one
     change to that table and is named explicitly in the approval request.
   - Counts before and after are recorded as numbers only.
4. **Re-count:** all four tables at 0, and no `auth.users` row with a non-empty token column.
5. **Wait W** (step 0). Any access token minted before or during steps 1–3 (including by an
   in-flight request) has then expired, whatever Auth does with its session check. A
   credential issued in flight after step 3 is caught by step 6.
6. **Second sweep:** repeat steps 3–4. Expect zero rows changed. Any non-zero → incident:
   stop and investigate.
7. **Probes** (§8.1 class B, A5b), including the **valid pre-cutover link test** below. All must
   pass.
8. **During the backout window:** daily read-only counts of the four tables and of non-empty
   token columns. Any non-zero is an incident (nothing should be able to issue one).

**Valid pre-cutover link test (staging only, fixture users, links in probe memory only, never
printed or logged).** Before step 1, the operator generates real verification credentials for
fixture users with the Admin API (`generateLink`, magic-link and recovery types):
- **L-a**, used **during** L1: redeemed after step 1 and before step 3. Whether Auth still
  accepts it then is recorded. If it does, the resulting session S-a must be gone after step 3
  (refresh refused). After W, `GET`/`PUT /user` with S-a's access token must be refused, the
  same as for any other closed session.
- **L-b**, used **after** L1 (after step 3, and again after W): it must be refused, and no
  session row may appear.
- **L-c**, an email-change token for a fixture, created before step 1 by a stateful `PUT /user`
  under A5b: after step 3 its confirmation must be refused, and the fixture's email must be
  unchanged.

**Effect on people.** Old-app sessions and any pending Supabase emails or links stop working.
Passwords, bans, emails and profiles are unchanged. On backout, people sign in to the old app
again with their existing passwords; password reset works again once the email provider is
re-enabled.

**Fallback.** If a probe after W still succeeds, the production go stops and the issue goes to
the coordinator.

**Not planned, listed only because they would close the same gap more bluntly:** scrambling
every password, banning users, or rotating the project's JWT signing key (which would also
break the pipeline's legacy keys). Each would need its own **explicit authorization** decision
and is not part of this design.

### 11.7 What changed in the approvals list (revisions 2–4)

A1 is approved (2026-10-21). A5 is split into **A5a** (stateless) and **A5b** (stateful,
separate). **A7** (staging log inspection for the T-HYG gate) is new. A2, A3, A4 and A6 are
unchanged. Revision 3 adds **L1** (§11.6) as a separately approved rollout step on staging
and production, and its `PUT /user` and refresh probes go under A5b. Revision 4 widens L1:
it also clears outstanding verification tokens (`auth.one_time_tokens`, `auth.flow_state`,
and the token columns of `auth.users`, which the approval names explicitly). It needs a
read-only reading of the hosted Auth expiry settings, and A5b now includes Admin
`generateLink` for staging fixtures (operator, service role, in memory only).

---

## 12 · Sources

- [QQ] `git -C …/Quote-Queue show origin/main:<path>` at f1167dc: `app/auth/request/route.ts`,
  `app/auth/verify/route.ts`, `app/auth/confirm/route.ts`, `app/auth/signout/route.ts`,
  `lib/auth/{session,revoke,mask}.ts`, `lib/{cookies,csrf,keys}.ts`, `middleware.ts`,
  `app/signin/{page.tsx,signin.css}`, `lib/sendgrid.ts`, `app/webhooks/sendgrid/route.ts`,
  `db/migrations/0006…, 0007…`, `docs/BUILDER_HANDOFF.md` 1298-1400 and 1545-1600,
  `docs/handoff/HANDOFF-2026-10-15-redesign-decisions.md` lines 60, 76.
- [CF] https://developers.cloudflare.com/workers/runtime-apis/context/ ;
  https://developers.cloudflare.com/workers/static-assets/routing/worker-script/ ;
  https://developers.cloudflare.com/hyperdrive/concepts/query-caching/ ;
  https://developers.cloudflare.com/hyperdrive/platform/pricing/ ;
  https://developers.cloudflare.com/workers/platform/limits/ ;
  https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/supabase/
- [SB] https://supabase.com/docs/guides/database/postgres/roles ;
  https://supabase.com/docs/guides/auth/debugging/error-codes ;
  https://supabase.com/docs/guides/api/api-keys
- Manager reports: `thr_9apu26rmg8` storage `signin-alignment-report.md`,
  `signin-correction-impact.md`, `signin-amendments-2.md`, `evidence-brief.md`,
  `manager-onboarding.json`.

---

## 13 · Review response (Codex Gate 1 review of `3b841a7`, 2026-10-21)

| # | Finding (short) | Change | Sections |
|---|---|---|---|
| 1 | **Blocker:** the recovery route allowed login CSRF | `/auth/recovery` now requires a present, exact `Origin` (no `Host` fallback; `null` refused) plus an anonymous pre-session form token (`__Host-tr_pre`, SameSite=Strict). It refuses when a valid session already exists, so a victim is never switched to another account. All three checks run before any DB work, code consumption or cookie change. One shared `checkOrigin(strict)` for every route. Tests for cross-site posts and preservation of the victim's session | §3.4, §5.2 P15, §5.5, §7.2, §8 T-REC |
| 2 | **Blocker:** recovery restrictions left sensitive reads open | Deny by default at the DB: `current_app_role()` gives no role to recovery sessions, so every normal policy, view and RPC refuses. Recovery reaches only `recovery_*` definer functions with explicit column lists. A new §7.3 permission matrix (routes × functions × returned columns × contact/notes/identity classes), enforced at both the Worker and the DB. Contact visibility during an outage becomes an explicit D2 policy question. Tests call every normal endpoint and RPC directly | §1, §4.1, §5.2 P18, §7.2, §7.3, §8 T-REC, §11.3 D2 |
| 3 | Renewal ignored recovery's idle limit | Each session row carries a constraint-bound `idle_window` per kind (30 days / 1 hour). The touch uses it, capped at the absolute expiry, with a 1-minute throttle for recovery. Tests for navigation, mutation, activity ping and polling | §3.5, §8 T-REC |
| 4 | DB-credential containment overstated | The `recruiter_worker` credential is classified as an **authentication authority** and protected like a signing key. Audit plus tripwires are labelled detective, not proof. T-CRED demonstrates the credential-only attack (expected to succeed) | §2.1, §5.2 P12, §8 T-CRED, §10 R1 |
| 5 | Rollback did not restore a working app | The FK drop moves to a later M2 after a backout window; Team "add" is off until then. A full backout procedure: snapshot, `M1-backout.sql` restoring exact pre-M1 definitions and grants, re-enabling the provider, Worker version rollback, smoke test. Forward-fix rules. Local and staging rehearsal required. `NOT VALID` re-add is no longer claimed as a backout | §5.4, §8 T-BACKOUT/T-REPLAY, §10 R9, §11.2, §11.5, D8, D10 |
| 6 | Hosted probes not read-only and not sufficient | §8.1 matrix: stateless class A (A5a) vs stateful class B (A5b, separate approval). Fixture classes known/unknown/deactivated/legacy pending/legacy guest. All P8 routes, including `/magiclink`, `/verify`, `/resend`, `/user` and refresh. `/signup` never before signups are off. Equivalence rule across classes | §8 T-LIVE-A/B, §8.1, §11.1 A5a/A5b |
| 7 | Credential logging was an accepted fallback | R2 is now a release gate (T-HYG canary search across the Worker, Hyperdrive, Postgres normal and error logs, and the provider, for cookies, session hashes, link tokens and URLs, recovery codes and pre-tokens). Any hit stops the release. "Accept and document" removed. New approval A7 | §2.1, §3.2, §8 T-HYG, §9 E14, §10 R2, §11.1 A7, O5 |

---

## 14 · Re-review response (Codex re-review of `7f8a918`, 2026-10-21)

| # | Finding (short) | Change | Sections |
|---|---|---|---|
| 1 | **Blocker:** recovery could exceed a Viewer's role; the own-profile exception was still reachable | The matrix gains a "minimum ordinary role" column. Effective permission = matrix ∩ the live ordinary role, checked in SQL by each `recovery_*` function. `recovery_set_status` requires editor or manager, so a Viewer's recovery session has no writes. `profiles_select` loses its own-row exception: profiles are readable only with a link session, and the own name comes from the session row. Direct tests: a Viewer recovery write is refused, a mid-session demotion is enforced, and a recovery own-profile read returns nothing | §4.1, §7.3, §8 T-REC |
| 2 | **Blocker:** surviving legacy Supabase Auth sessions and refresh tokens (`/user` email-duplicate oracle) | New rollout step **L1**, separately owner-approved: count, then delete `auth.refresh_tokens` and `auth.sessions` (after a shape check), re-count, wait one access-token lifetime, run the probes, monitor daily during the window. No password scrambling, banning or user changes. Those are listed only as alternatives that would need explicit authorization. Probe rows for refresh and `GET`/`PUT /user` (duplicate vs fresh email) after L1, with an identical-response rule | §11.2, §11.6, §8.1, §11.7 |
| 3 | Backout gaps: email edits, app credentials, open DB connections | Email edits paused during the window (route flag + M1 trigger; the urgent-change exception proposed here was withdrawn in revision 4). New `retire-app-credentials.sql` runs before backout: `NOLOGIN`, `pg_terminate_backend` for the role, all app sessions/links/codes revoked. Hyperdrive config disabled. Email-alignment check. New keys and password on re-forward. All four cases added to the rehearsal | §5.4, §11.5, §8 T-BACKOUT, D10 |

---

## 15 · Round 4 response (Codex review of `ecc2751`, 2026-10-21)

| # | Finding (short) | Change | Sections |
|---|---|---|---|
| 1 | **Blocker:** L1 left legacy verification credentials usable | L1 now: reads the hosted JWT and OTP expiry settings and derives the wait W from them (not `config.toml`); stops issuance first (providers and signups off, verified by probes); shape-checks `auth.*`; in one transaction deletes refresh tokens, sessions, `one_time_tokens` and `flow_state`, and clears only the verification-token columns of `auth.users`; re-counts; waits W; sweeps again; monitors daily. New staging test with valid pre-cutover credentials L-a (used during L1), L-b (after) and L-c (email change). No password scrambling, banning or email/profile changes | §11.6, §8.1, §11.7 |
| 2 | **Blocker:** reconnection race in credential retirement | Ordered procedure: maintenance flag and Hyperdrive stopped or neutralized → `NOLOGIN` + `password null` committed on its own → `pg_terminate_backend(pid, 5000)` and poll until 0 three times (60 s limit, else escalate) → ledgers revoked → checks. Rehearsal adds a 50 ms reconnect loop plus held-open connections | §11.5, §8 T-BACKOUT |
| 3 | Urgent email-change exception conflicted with the pause trigger | Removed. No exception during the window; any override is a future, separately reviewed runbook | §5.4 |
