# 14 · Same-origin team sign-in — design for review (Gate 1)

Status: **design only. Nothing built, run, installed or touched live.** Written 2026-10-21 UTC on
local branch `auth/same-origin-signin` (from `docs/auth-spec-m0-signoff`, 9fc3425), by the
sign-in implementation owner (thread thr_pn5gr4mx94). Needs independent security review before
any code is written.

**What this replaces.** Spec 13 (`13-team-sign-in-spec.md`) wherever it relies on
browser-held Supabase tokens, Supabase OTP links, the Send Email hook, or accepted gaps (its
§3.1–3.7, §5, §6, §9, §11 Q4). Its behaviour contract (B1–B16), its test ideas and its §6 gap
list are carried forward where still valid; B11 (Resend) and B12/G2 (Supabase link replacement)
are dropped. Its migration steps "scramble all passwords" and "convert pending/guest to
disabled" are **withdrawn** (not authorized).

Source labels: **[QQ]** = Quote-Queue `origin/main` f1167dc, read with `git show` only;
**[repo]** = this repository at 9fc3425; **[CF]** / **[SB]** = Cloudflare / Supabase docs read
2026-10-21 (URLs in §12); **[assume]** = not yet verified, with the test that will verify it.

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
print and keep. A code signs you in for a limited time with limited powers: no Team page, no
exports, no new codes. Whether to adopt them, and the exact rules, is a cross-app decision still
open (§7).

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

**Honest failure handling.** If step 4 itself fails (database unreachable), the request gets a
plain `503` "Sign-in is temporarily unavailable. Try again in a minute." for **every** address.
Only anonymous work has run at that point, so this reveals nothing about the roster. [QQ] lets
its route throw here (an uncaught 500), so this is the same behaviour with a calmer message.
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
3. The `token` query string must never reach logs. Cloudflare Workers Logs / Logpush record the
   request URL **[assume]**. So: Workers observability for this Worker is configured to exclude
   the URL query, or the operator confirms no request logging is enabled. This is a release gate
   (§8 T-HYG), not an assumption.

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
2. CSRF: `Origin` must equal `APP_ORIGIN` exactly (else `Host` must equal its host; neither →
   fail); `__Host-tr_csrf` present; `csrf_token == hmac(KEY_SESSIONS, cookie)` compared in
   constant time ([QQ] `lib/csrf.ts:90-137`).
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
- **Deliberate use only.** `internal.auth_session_touch()` (throttled to once per 5 minutes in its
  WHERE, [QQ] `session.ts:211-222`) sets `last_seen_at=now()` and
  `expires_at = least(now()+30 days, absolute_expires_at)`. The Worker calls it **only** for:
  (a) a document navigation (`Sec-Fetch-Mode: navigate` + `Sec-Fetch-Dest: document`), (b) any
  `POST /api/*` mutation, and (c) `POST /api/session/activity`, which the SPA sends on an
  in-app route change. This is the SPA equivalent of a full navigation; the SPA has no full
  navigation between screens. Background `GET /api/*` reads (React Query refetch, polling)
  never touch. A forged "activity" call can only keep the caller's own session alive, so it is
  not a privilege. This is the equivalent of [QQ]'s `{renew:false}` for auto-refresh (M3
  ruling 5, `session.ts:151-180`).
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
  recreated with `internal.current_staff_id()`. `profiles_update_self` is dropped outright:
  roster fields change only through the Team routes. Policies are written as
  `(select internal.is_staff())` so the lookup runs once per statement.
- `guard_profile_update()` keeps the `auth.role() = 'service_role'` bypass for the pipeline and
  operator. The manager path now flows through `is_manager()` (session-based).
- Pipeline effect: the pipeline sets no `app.session_hash`, so `current_staff_id()` is null.
  Today `auth.uid()` is also null for `service_role`, so trigger actor columns behave exactly
  as before. Pipeline tests and the role matrix must prove this (§8).
- Recovery sessions: `internal.is_manager()` and `internal.can_export()` (new; used by
  `log_export` and `generate_contact_sheet`) return false when `kind='recovery'` (§7.3).

### 4.2 App: every supabase-js call moves behind the Worker

Measured inventory (`grep` at 9fc3425, excluding tests): **17 RPC calls** in `lib/rpc.ts` (18 grep hits, one is a comment at `:31`);
**24 direct table calls** in `guards.tsx`, `Sidebar.tsx`, `BatchPage.tsx`, `ContactSheet.tsx`,
`CarrierProfile.tsx`, `Dashboard.tsx`, `UsersAdmin.tsx` and `dnc.ts`; **12 `supabase.auth.*`
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
| P3 | PostgREST `/rest/v1` with anon/publishable key | RLS-gated reads for `authenticated` | no grants for `anon`/`authenticated`; RLS re-keyed | **T-LIVE** (hosted) |
| P4 | PostgREST with a Supabase user JWT (password or OTP session of an existing user) | full staff access | same as P3: no grants, no `app.session_hash` → nothing | T-LIVE |
| P5 | GraphQL `/graphql/v1` | grants-gated | same as P3 | T-LIVE |
| P6 | Realtime postgres_changes | RLS-gated, publication has 6 tables (`20260720001300_realtime.sql`) | needs SELECT grant → none; policies need session → none. Recommended additionally: remove the 6 tables from `supabase_realtime` (reversible) | T-LIVE |
| P7 | Realtime Broadcast/Presence | open message bus for anon key, no DB data | no data either way; owner may enable "private channels only" (O6) | T-LIVE (read) |
| P8 | Supabase Auth `/auth/v1/otp`, `/magiclink`, `/recover`, `/signup`, `/token` (password, refresh), `/verify`, `/resend`, `/user` | live; password sign-in in use | Owner disables signups and every provider (email, phone, anonymous, OAuth) (O2). Tokens that still exist reach no data (P4). Expected codes: `signup_disabled`, `email_provider_disabled`, `otp_disabled` [SB error codes]. **The actual responses must be read live** before and after the change (A5) | T-LIVE |
| P9 | Storage `/storage/v1` | enabled (`config.toml:47`); no buckets in migrations | Verify no buckets exist and `storage.objects` has no policies for anon/authenticated | T-LIVE |
| P10 | Edge Functions | none exist (`supabase/functions` absent) | none | repo |
| P11 | Direct Postgres (`postgres`, `service_role`, pipeline) | operator/pipeline | unchanged; trusted | — |
| P12 | `recruiter_worker` credential leak | — | can only reach `recruiter_api` grants. Without a valid session hash, all reads are empty and all writes are refused. It cannot read auth ledgers (definer functions only; no table grants). It **can** mint links, but only for active staff, and they are emailed to the roster address. It **can** do anonymous bucket hits. **Residual risk R1.** | T-SQL |
| P13 | Old SPA bundle with the anon key | — | same as P3/P8 | T-LIVE |
| P14 | Session-id GUC injection | — | `app.session_hash` is a hash of a 256-bit secret, not an identity. Setting it requires SQL access plus knowledge of a live hash | T-SQL |
| P15 | CSRF / cross-site | — | SameSite=Lax + exact Origin + double-submit HMAC token on every POST except `/auth/request` and `/auth/recovery` (public by design, as [QQ]) and the webhook (signature) | T-W |
| P16 | XSS stealing the session | tokens in `localStorage` (`supabase.ts:33-52`) | HttpOnly cookie; strict CSP; sign-in pages run no script | T-W headers |
| P17 | Link in URL leaking (Referer, history, logs) | — | removed on first hop by 303; `no-referrer`; log exclusion gate | T-HYG |

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
  a new staff member would need an `auth.users` row. **Proposed:** the migration drops that FK
  (existing ids and rows are untouched; it can be re-added `NOT VALID`). This also removes the
  cascade-delete hazard. It is a schema decision for review (**D8**). The rejected alternative,
  creating Supabase Auth users from the Worker, needs `service_role` in the Worker.
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
| `POST /auth/recovery` | same envelope; own buckets 20/IP, 10/address per 15 min; per user ≤ 5 failed attempts per hour and 10 per Chicago day, then refused (generic) (§7) |
| `GET /auth/verify`, `GET/POST /auth/confirm` | 256-bit tokens; no oracle beyond "valid link → button"; no rate limit needed for guessing; body caps |
| `POST /webhooks/sendgrid` | signature first; body cap; no outcome leak |
| `POST /auth/signout` | CSRF |

---

## 6 · Concurrency and post-response execution (validation item (d))

1. **Lock order everywhere:** `internal.roster_lock` (manager-set changes only) → `profiles`
   row `FOR UPDATE` → link rows → session rows → recovery-code rows.
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
| Enrollment | From the signed-in **Account** panel, any active staff member (policy option: managers only, D2) presses "Create recovery codes". Requires a `kind='link'` session created **≤ 15 minutes ago** (fresh email proof), plus CSRF. Generates **10 codes**, each 16 characters from a 32-symbol alphabet without look-alikes (80 bits), shown **once** with "Print" and "I saved them". Generating a new set revokes the old set. |
| Storage | `internal.recovery_codes(id, user_id, set_id, code_hash unique, created_at, expires_at, used_at, revoked_at, revoked_reason)`. `code_hash = hmac(KEY_RATE, normalized code)`, keyed so a table read cannot be brute-forced offline. The raw code exists only in the one response that shows it (`no-store`) and is never logged. |
| Expiry | 180 days after creation (proposal). The Account panel shows remaining codes and the expiry. |
| Use | `GET /signin/recovery` (not linked from `/signin`, so the decision-19 page stays identical). The form takes email + code. `POST /auth/recovery`: same 1000 ± 100 ms envelope; anonymous buckets first; then, **before** the response (it must decide whether to set a cookie), one transaction locks the profile row, checks active staff and the per-user failure ceilings, and matches an unused, unrevoked, unexpired code for that user. On success: mark it used and create a session `kind='recovery'`. The response is either 303 `/` with a session, or the single generic page "That didn't work. Check the address and code, or ask a manager." for every failure class. The envelope covers the DB work (target ≤ 600 ms; over → fail closed). |
| Limits | Buckets as §5.5. Per user: 5 failed codes per hour, 10 per Chicago day, counted only after the profile lock. A wrong code never reveals whether the address exists. |
| Session restrictions | `kind='recovery'`: absolute life **12 hours**, idle **1 hour**, never renewed beyond 12 h. `is_manager()` returns **false** (no Team page, no identity/role/status changes, no curation or manager deletes). `can_export()` returns false (no contact sheet or CSV export: no bulk sensitive reveal). No recovery-code view or regeneration (no recovery escalation). No adding staff and no creating anything that grants access (no indirect grants). Templates: this app has none. The UI shows a persistent banner: "Signed in with a recovery code — limited access until email sign-in works again." |
| Revocation | The §5.3 trigger (email/role/status change). Regenerating a set. Manager "Revoke recovery codes" on the Team page (needs a link session). Emergency sign-out (D1). |
| Audit | `internal.auth_events(id, at, user_id null, kind, detail jsonb)` for: set created, code used, recovery failure (with keyed IP hash, no code), set revoked, emergency sign-out. Managers see recent recovery events on the Team page. A notice email ("a recovery code was used") is queued and sent when mail works. |
| Outage drill | Staging only, quarterly (proposal): switch the mail adapter to a fault-injecting fake, sign in with a fixture user's recovery code, check every restriction (T-REC), regenerate, record a dated note. No live email involved. |

### 7.3 Consistency with the other apps

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
| T-LIVE | hosted **staging**, read-only probes with `.invalid` addresses | P3–P9 before and after the owner's config change; full migration replay with PostGIS | A5, later approvals |
| T-REC | T-SQL + T-INT | recovery restrictions; single use; rate limits; regeneration revokes; trigger revokes | A3 |
| T-HYG | all of the above | credential-pattern scan of outputs; Worker log config check (owner, O5) | — |
| Project checks | existing | `app`: `npm run verify`; `pipeline`: `npm test`, `npm run build`; `node scripts/verify-migration-baseline.mjs` (fresh LF checkout); `verify-staging-contract.mjs`; other offline scripts | A1 |

**Evidence limits.** T-SQL runs on PG 16.15; hosted Supabase runs PG 15 (`config.toml:17`
`major_version = 15`). It also runs without PostGIS, so the RPCs that use geometry
(`search_carriers`, matcher, maps) are not exercised against the re-keyed helpers until a
PostGIS-capable run (staging replay) happens. This is stated in every report.

---

## 9 · Assumptions vs evidence

| # | Claim | Status | Evidence / test |
|---|---|---|---|
| E1 | Worker can serve the SPA plus server routes on one origin | **Documented**, not measured | [CF] static-assets routing (`run_worker_first`, `env.ASSETS.fetch`); T-WRANGLER |
| E2 | Worker reaches Supabase Postgres as a custom low-privilege role via Hyperdrive | **Documented** (CF Supabase guide) | live verification needed (A5/O3); IPv6 reachability **unverified** |
| E3 | Hyperdrive on Workers Free | **Documented** "100,000 / day" | — |
| E4 | Workers Free 10 ms CPU is enough | **Unverified** | T-WRANGLER CPU sample; else D5 |
| E5 | `waitUntil` ≤ 30 s after response, then cancelled | **Documented** | T-WRANGLER |
| E6 | Transaction-local GUC is safe under transaction pooling | **Reasoned** (Postgres semantics of `set_config(..., true)`) | T-SQL, T-INT |
| E7 | Revoking anon/authenticated grants closes PostgREST, GraphQL and Realtime data | **Reasoned** from [SB] "Postgres checks table grants before RLS" | T-SQL locally; T-LIVE hosted |
| E8 | Supabase Auth endpoints answer with errors once providers are off | **Documented codes only** | T-LIVE before/after (A5) |
| E9 | No storage buckets exist | **Repo only** (none in migrations) | T-LIVE |
| E10 | `auth.uid()` scope = 22 sites / 4 migrations; 17 RPC + 24 table + 12 auth calls in app | **Measured** (`grep`, 9fc3425) | — |
| E11 | Badge asset identical to [QQ] | **Measured** (git blob `dc6d248`, 1413×1377) | — |
| E12 | `CF-Connecting-IP` is reliable | **Unverified** here | T-WRANGLER + staging |
| E13 | `pg` works in Workers with `nodejs_compat` | **Unverified** here | T-WRANGLER |
| E14 | Worker logs exclude query strings | **Unverified** | O5 + T-HYG |
| E15 | Pipeline unaffected | **Reasoned** (service role, `auth.uid()` already null) | T-SQL pipeline-like writes; pipeline smoke tests |
| E16 | Supavisor accepts custom roles | **Unverified** (no doc found) | only needed for the fallback |
| E17 | Production user/profile inventory | **Unknown** | O1 (owner-run read-only query) |

---

## 10 · Residual risks

| # | Risk | Effect | Mitigation |
|---|---|---|---|
| R1 | Worker or `recruiter_worker` compromise is the new trust boundary | Attacker with Worker secrets can mint sessions | Secrets only in Worker env; DB role narrow; ledgers behind definer functions; key rotation runbook; emergency sign-out (D1) |
| R2 | DB statement logs might capture `app.session_hash` bind values | Session replay by someone with logs **and** the Worker DB credential | Set `log_parameter_max_length=0` for the role if Supabase permits it **[assume]**; otherwise accept and document |
| R3 | Envelope is a measured target | Platform stalls can shift timing for any address | T-TIME; fail-closed admission deadline |
| R4 | `waitUntil` cancellation at 30 s | A link minted but not sent | Courtesy 2 min, human retry; status stays honest |
| R5 | No PostGIS locally | Geometry RPCs not exercised under the new helpers until staging | Staging replay before rollout |
| R6 | Mail provider outage | No new link sign-ins | Recovery codes (if adopted); existing sessions continue |
| R7 | `run_worker_first: true` counts asset requests | Free-plan 100k/day request cap | Array patterns for assets; measure |
| R8 | Old Supabase passwords still exist (not scrambled, per directive) | Usable only against Supabase Auth, which reaches no data; once providers are off, not usable at all | O2 + T-LIVE |
| R9 | Dropping the `profiles → auth.users` FK | Loses a referential check | Reversible; reviewed as D8 |
| R10 | PG16 vs hosted PG15 | Version differences | Staging replay |

---

## 11 · Rollout, approvals and owner actions

### 11.1 Approvals I need before testing (exact)

- **A1 — restore existing locked packages** (`npm ci` in `app/` and in `pipeline/` inside this
  worktree only). Purpose: run project checks and unit tests. Downloads the packages already
  pinned in the lockfiles; nothing new.
- **A2 — add dependencies to `app/`:** `pg` (runtime, the same library the pipeline uses),
  `@types/pg`, `wrangler`, `@cloudflare/workers-types` (dev). Purpose: Worker DB access, local
  Worker runs, types.
- **A3 — throwaway Postgres cluster** (no service, not the system data directory):
  - folder: `C:\Users\hunte\.bb\thread-storage\thr_pn5gr4mx94\pg-auth-test\` (data + log)
  - create: `"C:\Program Files\PostgreSQL\16\bin\initdb.exe" -D <folder>\data -U tr_test_admin
    -A scram-sha-256 --pwfile=<folder>\pw.txt -E UTF8` (the password file holds a random
    throwaway value, deleted at the end)
  - start: `"C:\Program Files\PostgreSQL\16\bin\pg_ctl.exe" -D <folder>\data -l <folder>\log.txt
    -o "-p 55432 -c listen_addresses=127.0.0.1" start`
  - stop and delete: `pg_ctl … stop -m fast`, then remove the folder.
  - Purpose: T-SQL, T-CONC, T-INT, T-TIME, T-REC. Port 55432, loopback only.
- **A4 — local Worker:** `npx wrangler dev --ip 127.0.0.1 --port 8788 --local` in `app/`, with
  `.dev.vars` holding throwaway test keys (in thread storage, not committed) and the DB pointed
  at A3. Purpose: T-WRANGLER, T-VIS.
- **A5 — live read-only probes of hosted staging** (separate approval, later): anonymous calls to
  staging's `/auth/v1/{otp,recover,signup,token}`, `/rest/v1/<table>`, `/graphql/v1`,
  `/storage/v1/bucket` using only addresses at `example.invalid` (cannot receive mail), before and
  after the owner's config change. No writes beyond what those endpoints do for a non-existent
  address. Results recorded without keys or URLs.
- **A6 — bb browser automation** against `http://127.0.0.1:8788` only, for screenshots.

### 11.2 Rollout plan (each step its own owner "go")

1. Gate 1 review of this design → fixes → approval.
2. Build on this branch with A1–A4, A6 → Gate 2 independent code review.
3. Staging: owner-approved staging DB migration, Hyperdrive config (caching disabled), Worker
   secrets, `recruiter_worker` password, the mail provider (or fake mail on staging), and staging
   rebuild if needed (that rebuild was deferred until after sign-in). T-LIVE probes.
   Hunter's 5-minute walkthrough.
4. Production: read-only inventory (O1) → decisions on pending/guest and the FK/unique index →
   migration → Worker deploy → owner disables Supabase Auth providers (O2) → probes → first
   manager signs in. **Rollback:** redeploy the previous Worker build and re-enable the email
   provider. The migration's grant revocations have a prepared reverse script. Data is never
   touched, so rollback is configuration only.

### 11.3 Open central decisions (not resolved here) and what each blocks

| ID | Decision | Owner | Blocks |
|---|---|---|---|
| D1 | Who may trigger "sign everyone out" (and how): manager role in-app, operator SQL only, or the coordinator's shared procedure | coordinator | recovery slice S6 (emergency revoke UI); rollout S8 runbook |
| D2 | Recovery-code policy: adopt? who enrolls; count; entropy; expiry; recovery-session limits and restriction list | coordinator + independent review | S6 (built behind a disabled flag until decided) |
| D3 | Mail provider and sender (Quote-Queue's SendGrid account vs other; address) | Hunter via coordinator | live delivery S7-live and rollout S8 only; the adapter and fakes are not blocked |
| D4 | Test-environment and rollout approvals (A1–A6, staging, production) | manager / Hunter | testing of all slices; S8 |
| D5 | Workers plan if Free CPU is insufficient (spend) | Hunter | S8 |
| D6 | DB connection path on hosted (Hyperdrive direct vs pooler; IPv4 add-on if required, which is spend) | manager / Hunter after A5 | S8 |
| D7 | Fate of legacy pending/guest rows | Hunter, after O1 | nothing in the build; production cleanup only |
| D8 | Drop `profiles.id → auth.users` FK (schema change) | review + manager | S1 roster-add; alternative designs listed in §5.4 |
| D9 | Design-system version for the sign-in surfaces (v1.0 vs [QQ] v1.1) | coordinator | S4 final visual sign-off only |

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
- O5 Confirm Worker logging excludes query strings (or is off).
- O6 Optionally set Realtime to private channels only.

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
