# 13 · Team sign-in — invite-only roster + emailed one-time links

Status: **spec only, not built.** Nothing in this document has been applied to staging or
production. Owner decision of 2026-10-21 (recorded in `03-feedback-resolution.md` Round 5).
Written 2026-10-21 UTC on branch `docs/auth-spec-m0-signoff` (from `fd03593`).
**Revision 2 (2026-10-21 UTC):** addresses the nine findings of the independent review
(Codex, verdict "yes after edits") — see §12.
**Revision 3 (2026-10-21 UTC):** addresses the re-review of `507c66e` (1 blocker, 2 should-fix):
each sign-in link is now bound to its exact credential and redeemed only through a trusted
server step; generated links get a staging-only bound path; admission has an overall deadline.
The generation counter and the `amr` check are removed as no longer needed — see §12.

Reference behaviour: the Quote-Queue tool (`C:\Users\hunte\Projects\Quote-Queue`,
`docs/BUILDER_HANDOFF.md` §2.3 "Roster management", §4.7 "Sign-in", §8 "Sign-in: plain magic
links"). Quote-Queue is a custom Next.js build with its own token and session tables. This
project uses React + Supabase Auth, so we copy the **behaviour and what the team sees**, not the
code. §6 lists every place where Supabase cannot match Quote-Queue exactly.

Source labels used below: **[QQ]** = Quote-Queue handoff doc or source; **[docs]** = official
Supabase or Resend documentation, read 2026-10-21; **[src]** = Supabase Auth server source on
GitHub (`supabase/auth`, master branch, read 2026-10-21 — files `internal/api/otp.go`,
`mail.go`, `verify.go`, `user.go`, `internal/models/factor.go`, `sessions.go`; **the hosted
version may differ** and every [src] fact is a release-gate test in §7); **[repo]** = this
repository at `fd03593`; **[unverified]** = not checked, must be confirmed in the build.
`@supabase/supabase-js` is **not installed** in this worktree (no `app/node_modules`), so
nothing here was checked against the installed library.

---

## 1 · Plain-language summary (for Hunter)

**What changes:** no more passwords, no "Create an account" page, no "Waiting on approval"
screen. Only people a manager has put on the team list can get in.

**Signing in, step by step (what a team member sees):**

1. Open the Carrier Recruiter. The sign-in page shows one box: **Email**, and one button:
   **Email me a sign-in link**.
2. Type your work email and press the button.
3. The page always says the same thing: *"If that address is on the roster, we emailed a
   sign-in link. It works once and expires in 15 minutes."* It says this whether or not the
   address is on the team list.
4. Open the email (from a twistednail.com address). Click **Sign in**.
5. A Carrier Recruiter page opens with one button: **Sign in**. Press it. (This extra press
   stops email security scanners from "using up" the link before you do.)
6. You land on the Dashboard. You stay signed in on that computer until you press
   **Sign out**, a manager changes your account, or the time limits below run out.

If the link is old, already used, or for someone no longer on the team, the page says
*"This sign-in link has expired or was already used. Request a new one."*

**Managing the team (managers only), on the Team page:**

- **Add person:** name, email, role (Manager, Editor or Viewer). That is the whole invite. The
  app sends no email at this point; tell the person to go to the sign-in page.
- **Edit:** change name, email or role.
- **Deactivate / Reactivate:** a deactivated person cannot sign in. Their history (calls,
  notes) stays. Nobody is ever deleted.
- Changing someone's **email, role, or active status signs them out everywhere at once** and
  cancels any sign-in link they have not used yet.
- **Changing someone's email:** the person is locked out until the change finishes. Normally
  that takes a second. If it gets stuck, their row shows **"Email change not finished —
  Retry"**; they stay locked out (the safe side) until it succeeds.
- You cannot deactivate or demote yourself, and the last active manager can never be removed.

**Roles:** Manager = everything, including the Team page. Editor = build batches, log calls,
change statuses. Viewer = look only.

**Honest limits (details in §6):**

- Supabase has a public "send me a link" address we cannot switch off. Someone technical can
  use it to **find out whether an address is on the team list**, and to make the system send a
  team member **an unwanted sign-in email** (at most 1 a minute, 5 an hour, 10 a day per
  person; that link only signs in the real owner of the mailbox). They **cannot** get in, and
  they cannot email anyone who is not on the team list.
- Supabase also lets a signed-in team member give themselves a password behind the app's back.
  We cannot stop the password being set, but **a password sign-in gets no data and is signed
  straight back out**. Only link sign-ins work.
- If the email service (Resend) is down, nobody can start a new sign-in until it is back.
  People already signed in keep working. There is no back-door sign-in for emergencies.

**What Hunter needs to do later (not now):** a few clicks in Resend and Supabase (§9), and
answer the five questions in §11. Every live step waits for your "go".

---

## 2 · Behaviour contract (what must be true when this ships)

| # | Rule | Source |
|---|------|--------|
| B1 | No self-signup. Only roster members (rows created by a manager) can ever receive a link. | Hunter 2026-10-21; [QQ] §2.3 |
| B2 | No passwords in the app, and **a password-based session never reaches data or the signed-in screens** (server-enforced). | Hunter; [QQ] §8; review finding 1 |
| B3 | Sign-in = email a one-time link; link expires **15 minutes** after it was sent; works **once**. | Hunter; [QQ] §8 |
| B4 | One identical response from the app for every outcome (on roster, not on roster, deactivated, rate-limited, mail failure): *"If that address is on the roster, we emailed a sign-in link. It works once and expires in 15 minutes."* Same words and the same response time. | Hunter; [QQ] §4.7, `app/signin/page.tsx` |
| B5 | Clicking the emailed link opens a confirm page with one button; the link is redeemed only when the button is pressed. | [QQ] §8 "The button" |
| B6 | Manager can add, edit (name, email, role), deactivate and reactivate people. Never delete. | Hunter; [QQ] §2.3 |
| B7 | Any **email, role or active** change signs that person out of every session and makes every unused link useless, atomically with the change. | Hunter; [QQ] §2.3, §8 |
| B8 | **Sign out** ends that session on the server and does a full page load to the sign-in page. | Hunter; [QQ] §4, §8 |
| B9 | Roles: `manager`, `editor`, `viewer`. No guest role, no pending state. | Hunter 2026-10-21 |
| B10 | Last active manager cannot be deactivated or demoted; a manager cannot change their own role/status. | [QQ] §2.3; "Self locked" in `UsersAdmin.tsx:112` [repo] |
| B11 | Sign-in emails go through the Quote-Queue Resend account, from a twistednail.com address. | Hunter 2026-10-21 |
| B12 | Flood limits: per IP and per address (Quote-Queue: >20 per IP or >10 per address in 15 min → no send; per person at most 1/min, 5/hour, 10/day). Per-person limits are enforced at the **unavoidable** boundary (the email hook, §3.5). | [QQ] §8 steps 1–2; review finding 3 |
| B13 | An unfinished identity (email) change leaves the person **blocked** — no data, no link — until it completes. | review finding 2 |
| B14 | Session life: signed out after 30 days without **real use** and after 90 days at most, measured by the app, not by background token refresh. | [QQ] §8, `lib/auth/session.ts:135`; review finding 9 |
| B15 | Sign-in links are credentials: never printed, logged, screenshotted or written to reports. | review finding 8 |
| B16 | A link works only if **that exact link** was issued through the gate, is unexpired, unclaimed, and was not revoked by a later roster change. A different (newer or older) issuance can never be consumed by it. | re-review finding 1 |

---

## 3 · Supabase mapping (technical spec)

### 3.1 Auth project settings (per environment)

| Setting | Value | Where | Source |
|---|---|---|---|
| Allow new users to sign up | **Off** (`auth.enable_signup = false`, `auth.email.enable_signup = false` locally) | Dashboard → Authentication | key names [docs] CLI config |
| Email provider | On (needed for email links) | Dashboard → Authentication → Providers | [docs] |
| Email OTP / link expiry | **900 seconds** (`auth.email.otp_expiry = 900`) | Dashboard → Authentication → Email | default 3600 [docs] |
| Min time between requests per user | 60 s (`auth.email.max_frequency = 1m`, default) | Rate limits | [docs]; shared with recovery mail [src mail.go] |
| Emails per hour (project-wide) | 30 | Dashboard → Authentication → Rate Limits | [docs] |
| Site URL | exact app address of that environment | URL Configuration | [docs] |
| Redirect URLs | exactly `<app address>/auth/confirm`; **no wildcards** | URL Configuration | [docs] |
| Send Email hook | On → Edge Function `send-auth-email` (§3.5) | Authentication → Hooks | [docs] |
| Custom SMTP | Not used (the hook replaces SMTP) | — | [docs] |
| Time-box / Inactivity timeout (Pro only) | Optional backstop only: 90 days / 30 days on production. The real rule is app-enforced (§3.6) and works on any plan. | Authentication → Sessions | [docs] sessions |
| JWT (access token) expiry | keep 3600 s | — | [docs]; `config.toml:54` [repo] |

### 3.2 Edge Function settings, CORS and database transport (fixed before parallel build)

| Function | `verify_jwt` | Who may call | Authorization inside | CORS |
|---|---|---|---|---|
| `request-sign-in` | `true` (anon key accepted) | browser, signed out | none needed; anonymous work only | `OPTIONS` preflight answered; `Access-Control-Allow-Origin` = the exact `APP_ORIGIN` secret for that environment (never `*`); methods `POST, OPTIONS`; headers per [docs] CORS list (`authorization, x-client-info, apikey, content-type`, …) |
| `confirm-sign-in` | `true` (anon key accepted) | browser, Confirm page | holds the link only in memory; verifies it with Supabase and claims the bound issuance (§3.4) | same as above |
| `team-admin` | `true` | browser, signed-in manager | calls every manager RPC **with the caller's own JWT**, so the SQL re-checks "active manager with a valid session" in the same transaction; Admin API calls use the service role | same as above |
| `send-auth-email` (Send Email hook) | **`false`** — the only one | Supabase Auth only | verifies the Standard Webhooks signature with `SEND_EMAIL_HOOK_SECRET` (`v1,whsec_…` format, `standardwebhooks` library, per [docs] Resend example) **before reading the body**; failure → 401, nothing sent | none (server-to-server; rejects `OPTIONS`) |

Set in `supabase/config.toml` as `[functions.send-auth-email] verify_jwt = false` and deployed
with `--no-verify-jwt` [docs function-configuration]; the others keep the default. If the
project moves to the new non-JWT publishable keys, re-check `verify_jwt = true` for the two
signed-out functions **[unverified]**.

**Link digest.** The database never stores a sign-in link or its `token_hash`. It stores
`digest = HMAC-SHA256(ISSUANCE_HMAC_KEY, token_hash)`, computed in the Edge Functions. The key is
an Edge Function secret (random 32 bytes, generated by the operator, never in the repo or chat).
A keyed hash is used because a `token_hash` is derived from a short one-time code and the
address **[src, unverified detail]**, so a plain hash might be brute-forced by someone who can
read the table.

**Database transport.** The data API exposes only `public` and `graphql_public`
(`supabase/config.toml:11` [repo]). Every SQL routine below lives in `internal` (security
definer, `search_path = public, internal, pg_temp`); each has a thin **public wrapper** with
`revoke all … from public, anon` and a grant to exactly one role. New functions get explicit
revokes/grants (the blanket grant in `20260720001200_rls.sql:176-181` [repo] ran once and does
not cover new functions).

| Public wrapper (exact signature) | Returns | Granted to | Called by |
|---|---|---|---|
| `public.auth_request_admit(p_ip_hash text, p_email_hash text)` | `boolean` (true = may proceed) | `service_role` | `request-sign-in` |
| `public.auth_link_gate(p_email text, p_digest text)` | `uuid` issuance id, or `null` = refuse | `service_role` | `send-auth-email` |
| `public.auth_link_send_failed(p_issuance_id uuid)` | `void` (marks it revoked) | `service_role` | `send-auth-email` |
| `public.auth_link_claim(p_digest text, p_user_id uuid, p_session_id uuid)` | `boolean` | `service_role` | `confirm-sign-in` |
| `public.my_session()` | `public.profiles` row or `null` | `authenticated` | app guard on every load (§3.6) |
| `public.touch_session()` | `void` (writes at most once per 5 min) | `authenticated` | app on real activity (§3.6) |
| `public.roster_activate_new(p_user_id uuid, p_full_name text, p_role user_role)` | `public.profiles` | `authenticated` (manager re-checked inside) | `team-admin` add |
| `public.roster_update(p_user_id uuid, p_full_name text, p_role user_role, p_email text)` | `jsonb {profile, email_job_id uuid or null}` | `authenticated` (manager re-checked) | `team-admin` edit |
| `public.roster_set_active(p_user_id uuid, p_active boolean)` | `jsonb {profile, auth_action text}` (`'ban'`/`'unban_and_scramble'`) | `authenticated` (manager re-checked) | `team-admin` |
| `public.roster_email_jobs_due()` | `setof internal.roster_email_jobs` | `service_role` | `team-admin` retry pass |
| `public.roster_complete_email_change(p_job_id uuid)` | `public.profiles` | `service_role` | `team-admin` after Auth update succeeds |

**One lock order everywhere:** `internal.roster_lock` (one-row table, only for routines that can
change the manager set) → the person's `profiles` row `for update` → that person's
`internal.sign_in_issuances` rows. Manager routines then re-check the caller is an active
manager with a valid session (`internal.session_is_valid()`), then B10. Errors use fixed
SQLSTATEs the function maps to plain messages.

**`internal.revoke_person(p_user_id)`** — called inside every roster change, in the same
transaction, after the row lock: mark every unclaimed issuance for the person
`revoked_at = now()`; delete their `internal.valid_sessions` rows; delete their `auth.sessions`
and `auth.one_time_tokens` rows (clean-up only — Supabase-internal tables, shape **[unverified]**
on the hosted version). Correctness does not depend on the two `auth.*` deletes: a revoked
issuance can never be claimed, and a deleted `valid_sessions` row never comes back.

### 3.3 Sign-in request — Edge Function `request-sign-in`

1. At receipt, start two timers: the **response timer** (1,000 ms ± 100 ms jitter) and the
   **admission deadline** (600 ms). Normalise the address (trim, lower-case). Invalid syntax →
   "do nothing".
2. **Admission:** call `public.auth_request_admit` (counts IP and address in one short
   transaction; 15-minute windows; keyed hashes only, never raw addresses). The whole call —
   connection, HTTP transport and database work — is wrapped in an `AbortController` tied to
   the admission deadline. Inside the database it also runs with `SET LOCAL lock_timeout =
   '200ms'` and `statement_timeout = '400ms'`. **If the deadline fires first, the request is
   refused:** the send never starts, even if the admission call later succeeds (its late result
   is ignored; a late counter increment only makes limits stricter). Over 20/IP or 10/address,
   or any error → refused.
3. If admitted before the deadline, start the send: an un-awaited promise calling
   `signInWithOtp({ email, options: { shouldCreateUser: false } })` server-side with an 8-second
   timeout and a `catch` that logs only the error category (no address), registered with
   `EdgeRuntime.waitUntil(promise)` so the instance stays alive until it settles [docs
   background-tasks]. `waitUntil` keeps work alive; it does not delay its start.
4. When the response timer fires, respond `200 {"ok":true}`. The response path never awaits the
   admission call or the send, so neither can change the body or hold the response past the
   timer.

**What is and is not promised:** the code never lets admission or sending shape the response.
The 1,000 ms envelope is a **target measured in tests, not a guarantee**: a platform stall (cold
start, CPU starvation, slow network to the browser) can delay any response, whether or not the
address is on the roster.

The function **does not** look up the roster. Eligibility and per-person limits are enforced in
the hook (§3.5), which every send — including direct calls to Supabase that bypass this function
— must pass through. Client IP: from the forwarding header Supabase passes to Edge Functions —
exact header **[unverified]**; the hook receives no IP, so per-IP limits apply only to requests
through this function (§6 G1).

### 3.4 Clicking the link — page `/auth/confirm` + Edge Function `confirm-sign-in`

- Email link: `<Site URL>/auth/confirm?token_hash=<hash>&type=email`, built by
  `send-auth-email` from the hook payload's `email_data.token_hash` [docs].
- The page copies the query into memory, immediately removes it from the address bar
  (`history.replaceState`), and shows one button: **Sign in**. The browser never calls
  `verifyOtp` itself.
- On press, the page POSTs `{ token_hash }` to `confirm-sign-in`, which:
  1. computes `digest`;
  2. calls `verifyOtp({ token_hash, type: 'email' })` server-side [docs]. Supabase checks and
     consumes the link and returns a session (access + refresh token) for user `U`. Failure →
     generic "expired or already used";
  3. calls `public.auth_link_claim(digest, U, session_id)`, with `session_id` read from the
     returned access token. In **one transaction**, after locking `U`'s profile row, it succeeds
     only if an issuance exists with **this exact digest**, for user `U`, `claimed_at is null`,
     `revoked_at is null`, `issued_at > now() - interval '15 minutes'`, and the profile is active
     with no open email job. On success it sets `claimed_at` and inserts
     `internal.valid_sessions(session_id, user_id, created_at, last_active_at)`;
  4. if the claim fails → `auth.admin.signOut(access_token)` [docs: takes the user's JWT] to end
     that Supabase session, and return the generic message. If it succeeds → return the session
     tokens in the response body; the page calls `supabase.auth.setSession(...)` and loads the
     Dashboard. Tokens and the link are never logged.
- The roster routines lock the same profile row, so a claim and a roster change cannot
  interleave: either the claim commits first (then the change deletes the new `valid_sessions`
  row) or the change commits first (then the issuance is revoked and the claim fails).
- Any Supabase session that never passes step 3 — a late token, a password sign-in, a direct
  call to Supabase's own verify endpoint — has no `valid_sessions` row, so it gets no data
  (§3.6).
- The link carries a token hash (not a PKCE code), so it should work in a different browser
  from the one that requested it **[unverified — test in §7.2]**.
- Page sets `Referrer-Policy: no-referrer` and loads no third-party resources (mirrors [QQ]).
  Per-route headers on the Cloudflare Worker host **[unverified]**.

### 3.5 Email delivery and the unavoidable gate — `send-auth-email` (Send Email hook)

Every email Supabase Auth sends goes through this hook — including requests made directly to
Supabase's public endpoint, which skip `request-sign-in` [docs send-email-hook]. So this is
where eligibility is enforced:

1. Verify the signature (§3.2). Fail → 401.
2. If `email_data.email_action_type` is not the magic-link type → **return an error, send
   nothing**. This refuses recovery (password reset), signup, invite and email-change mail.
3. Compute `digest` of `email_data.token_hash` and call `public.auth_link_gate(user.email,
   digest)`. In one transaction it locks the person's profile row, then allows only if the
   profile is active, has no open email job, and the per-person ceilings (1/min, 5/hour, 10/day,
   counted over `internal.sign_in_issuances`) are not exceeded. On allow it inserts the issuance
   `(id, user_id, digest, issued_at)` and commits — **before** any email is sent.
4. Refused → **return an error response**; Resend is never called. Per [src mail.go], when the
   hook errors Supabase does **not** save the new token (it restores the previous one), so a
   refused request neither emails anyone nor kills an earlier link. Whether the surrounding
   transaction is fully rolled back is **[unverified]** (release-gate test).
5. Allowed → send via the Resend API (8-second timeout) from the twistednail.com sender; body:
   one button, "This link works once and expires in 15 minutes. If you didn't ask for it,
   ignore this email." If Resend fails → `auth_link_send_failed(issuance_id)` marks that
   issuance revoked, then return an error (Supabase keeps the previous token, whose own issuance
   is unaffected). The link is never logged.

**Why this closes the re-review scenario.** An issuance can only be consumed by the link whose
digest it holds, so an old link can never use up a newer issuance. A roster change revokes every
unclaimed issuance in the same transaction, so a link sent before the change is dead even if
Supabase still accepts its token. A request whose gate check passed just before a change has
already committed its issuance (the gate commits before the send), so the change sees and
revokes it; a request after the change is checked against the new state.

### 3.6 One session-validity rule (data, profile, and app shell)

`internal.session_is_valid()` (security definer, stable) is true only when **all** hold:

- `auth.jwt()->>'session_id'` has a row in `auth.sessions` (Supabase deletes the row on sign-out
  [docs sessions]) **and** in `internal.valid_sessions` for `auth.uid()`;
- (no `amr` check is needed: a `valid_sessions` row is created **only** by `confirm-sign-in`
  after a bound link claim, so a session from a password sign-in, a stray token or Supabase's
  own verify endpoint never has one. Token refresh keeps the same `session_id` [docs sessions:
  access tokens carry `session_id` matching `auth.sessions`];)
- `valid_sessions.last_active_at > now() - interval '30 days'` and
  `valid_sessions.created_at > now() - interval '90 days'` (B14).

Used everywhere:

- `internal.current_app_role()` returns the role only if `status = 'approved'` **and**
  `session_is_valid()`.
- **Own-profile access is closed too** (review finding 6): `profiles_select` becomes
  `internal.session_is_valid() and (id = auth.uid() or internal.is_staff())`;
  `profiles_update_self` is removed (self-edit of `full_name`/`avatar_color`, if kept, goes
  through a guarded RPC).
- **App shell:** the guard calls `public.my_session()` on load and on every auth state change;
  `null` → `signOut({ scope: 'local' })`, clear React Query cache, full page load to `/login`.
  Any RLS/permission error on a business query triggers the same re-check.
- **No automatic downgrade.** If the check is too slow, the fix is indexing and wrapping it as
  `(select internal.session_is_valid())` in policies so it runs once per statement — or escalate
  to the owner. Dropping the check is not an option this spec allows.

**Activity (B14):** `public.touch_session()` is called by the app on real user actions only —
full navigations, route changes and mutations — never by background refetch or token refresh;
it updates `last_active_at` at most once per 5 minutes. This mirrors [QQ]
`lib/auth/session.ts:135` (automatic requests don't renew). Supabase's own inactivity timeout
counts token refreshes as activity [docs sessions], so an open, unattended tab would never time
out — which is why the rule lives in the app.

**Sign out:** `supabase.auth.signOut({ scope: 'local' })` [docs: scopes global/local/others,
default global] then `window.location.assign('/login')`. Today `Sidebar.tsx:141` [repo] uses the
default global scope without a full navigation.

### 3.7 Roster admin — `team-admin` flows

| Action | Order of operations |
|---|---|
| **add** `{name,email,role}` | 1) `auth.admin.createUser({ email, email_confirm: true })` — **no password**. The existing trigger `internal.handle_new_user` creates a fail-closed profile (disabled viewer, §4.1). If the email already exists and its profile was never activated (left over from a failed earlier add), reuse it. 2) `roster_activate_new` (manager JWT): sets name, role, `status='approved'`, `approved_by/at`, calls `revoke_person` (clean slate). |
| **edit** name/role | `roster_update`: one transaction — update, and **if role changed**: `revoke_person` (revokes unclaimed issuances, deletes sessions). |
| **edit** email | `roster_update`, one transaction: `revoke_person`; insert `internal.roster_email_jobs(id, user_id, new_email, attempts 0, next_attempt_at now(), done_at null)`. **While a job is open the person is blocked**: `my_session`, `auth_link_gate` and `auth_link_claim` all refuse. Then the function calls `auth.admin.updateUserById(id, { email, email_confirm: true })` (applied directly, no confirmation mail [docs]). On success → `roster_complete_email_change(job)`: verifies `auth.users.email` now equals `new_email`, copies it to `profiles.email`, closes the job. On failure → job stays open with `attempts+1` and back-off; **the person stays blocked** (safe side). |
| **deactivate** | `roster_set_active(id,false)`: one transaction — B10 checks, `status='disabled'`, `revoke_person`. Then `updateUserById(id, { ban_duration: '876000h' })` [docs example]. If the ban call fails, nothing is exposed (profile already disabled → no link, no data); retried on the next Team-page load. |
| **reactivate** | `updateUserById(id, { ban_duration: 'none', password: <64 random bytes, discarded> })` — re-scrambles any password set before deactivation (review finding 1). `'none'` value **[unverified]**. Then `roster_set_active(id,true)`. If the Auth call fails, the profile is not reactivated. |

**Durable retry of email jobs:** jobs are rows, so nothing is lost. `team-admin` runs
`roster_email_jobs_due()` at the start of every call (any manager opening the Team page triggers
it), and the Team page shows each open job with a **Retry** button. An optional scheduled call
(Supabase Cron) can be added later **[unverified availability; not required]**. A job open more
than 24 h is shown in red to the manager.

**Revocation primitive.** Deleting the person's rows from `auth.sessions` uses a table outside
Supabase's public API; it is the only way to end another user's sessions by user id
(`auth.admin.signOut` needs the user's JWT [docs]). With `valid_sessions` and revoked
issuances, correctness does not depend on that delete or on deleting `auth.one_time_tokens`:
even if either fails or the table shape changes, no old session or late link passes
`session_is_valid()` or `auth_link_claim()`. The deletes remain as clean-up.

---

## 4 · What changes in this repository

### 4.1 Database (one new migration; never edit old migration files)

**Authorization during the migration (review finding 5).** The existing guard
`internal.guard_profile_update()` blocks role/status changes unless the JWT role is
`service_role` or the caller is a manager (`20260723004500_profile_service_bootstrap.sql:16-20`
[repo]); a migration has no JWT. The migration uses the pattern already used and checked in
this repo's staging fixtures/cleanup: `select set_config('request.jwt.claims',
'{"role":"service_role"}', true)` (transaction-local) immediately before the data conversion and
`select set_config('request.jwt.claims', '', true)` immediately after. No trigger is disabled.

**Order inside the migration (one transaction):**

1. Create `internal.roster_lock` (1 row), `internal.valid_sessions`,
   `internal.sign_in_issuances`, `internal.auth_request_buckets`, `internal.roster_email_jobs`,
   `internal.roster_events`. `sign_in_issuances(id uuid pk, user_id uuid, digest text unique,
   issued_at, claimed_at, revoked_at)`; `valid_sessions(session_id uuid pk, user_id uuid,
   created_at, last_active_at)`.
2. Set the transaction-local service-role claim; convert data:
   `update public.profiles set status='disabled', role='view' where status='pending' or role='guest'`;
   clear the claim.
3. Add checks `profiles_role_no_guest check (role <> 'guest')` and
   `profiles_status_no_pending check (status in ('approved','disabled'))`.
4. Defaults → `role 'view'`, `status 'disabled'` (fail-closed until `roster_activate_new`).
5. Replace `guard_profile_update()` to also guard `email`.
6. Replace `current_app_role()`; add `session_is_valid()`; replace `profiles_select`; drop
   `profiles_update_self`; narrow `profiles_update_mgr` (managers change roster fields only via
   the RPCs).
7. Create internal routines + public wrappers (§3.2) with explicit revokes/grants.

Effect on deploy: no existing session is in `valid_sessions`, so **everyone is signed out** and
must sign in by link (intended; §5).

| Item | Today [repo] | Change |
|---|---|---|
| `user_role` enum | `manager, edit, view, guest` (`20260720000200_enums.sql:9`) | Keep type and stored values `edit`/`view` (UI: Editor/Viewer); `guest` blocked by check. |
| `user_status` enum | `pending, approved, disabled` (`:10`) | Keep; `pending` blocked by check; UI: Active/Deactivated. |
| `approved_by`/`approved_at` | approval | Keep; meaning "added by / added at". |
| `internal.handle_new_user()` | creates pending guest | Keep; now yields a disabled viewer. |

`app/src/types/database.ts` regenerated (or hand-mirrored per its header).

**Verification files (review finding 5):** `scripts/verify-migration-baseline.mjs` has a fixed
list of migration versions (`:25-31`) and compares against
`docs/build-plan/migration-checksums.sha256`; `scripts/verify-baseline-reconciliation.mjs:8`
reads the same manifest. Adding the new version and its checksum is an explicit baseline
decision owned by WP-AUTH-1 and called out in its report.

### 4.2 App (React)

| File [repo] | Change |
|---|---|
| `features/auth/Register.tsx`, `Forgot.tsx`, `Reset.tsx`, `Pending.tsx` | **Delete.** |
| `features/auth/Login.tsx` | Email-only sign-in (B4 copy, posts to `request-sign-in`); no password, Remember me, Forgot, Register. Keep staging banner and brand block. |
| new `features/auth/Confirm.tsx` | `/auth/confirm` (§3.4). |
| `app/router.tsx` | Remove `/register`, `/forgot`, `/reset`, `/pending`; add public `/auth/confirm`. |
| `app/guards.tsx` | `useSession` loads via `my_session()`; `RequireApproved` → `RequireActive`; invalid → local sign-out + cache clear + full load to `/login` (§3.6). |
| `lib/permissions.ts` (+ test) | Drop `isGuest`/`guest`. |
| `lib/supabase.ts` | Remove remember-me storage switch (Q5); `detectSessionInUrl: false`. |
| `app/Sidebar.tsx` | Remove pending badge (`:45-51`, `:115`); Sign out per §3.6. |
| `lib/queryKeys.ts` | Remove `pendingUsersCount`. |
| new activity hook | Calls `touch_session()` on route change / mutation (§3.6). |
| `features/users/UsersAdmin.tsx` | Rewrite as **Team** roster: table, Add, Edit, Deactivate/Reactivate, open email-job state with Retry; all via `team-admin`. |
| `types/domain.ts` | Follow regenerated types. |

### 4.3 Supabase functions and config

| File | Change |
|---|---|
| new `supabase/functions/request-sign-in/`, `confirm-sign-in/`, `team-admin/`, `send-auth-email/` | §3.2–3.7 |
| `supabase/config.toml` (local only) | `enable_signup = false` (both), `otp_expiry = 900`, local hook config, exact redirect URL, `[functions.send-auth-email] verify_jwt = false`, `[edge_runtime] policy = "per_worker"` so background work finishes locally [docs]. |

### 4.4 Test fixtures and scripts

| File [repo] | Change |
|---|---|
| `scripts/seed-auth-users.ts` | Users created with `email_confirm: true` and a random discarded password (none usable); drop `pending`/`guest` fixtures (`:77-78`); remove `TEST_USER_PASSWORD`. **No link-printing mode.** |
| new `app/e2e/` (or equivalent) staging test helper | **Staging-only bound test links (re-review finding 2).** `generateLink` does not call the email hook, so it creates no issuance. The helper: (1) calls `auth.admin.generateLink({ type: 'magiclink', email })` for a **fixture user only**; (2) takes the returned hashed token (field name **[unverified]**), computes `digest`, and records a bound issuance by calling `staging_identity.record_test_issuance(p_user_id uuid, p_digest text)` through the existing guarded staging SQL runner (refuses production, requires the exact staging project); (3) hands the link **in memory** to the browser driver in the same process, which presses Confirm normally (so `confirm-sign-in` and `auth_link_claim` are exercised unchanged). Never written to stdout, files, traces, screenshots or reports; Playwright tracing/video off for those steps; a redaction filter masks `token_hash=` and the test fails if the pattern appears in its own report (B15). |
| `supabase/staging/install-staging-identity-marker.sql` (or a new staging-only installer beside it) | Adds `staging_identity.record_test_issuance`: requires the staging marker, requires the target `auth.users` row to carry the fixture `test_only` metadata, inserts the issuance into `internal.sign_in_issuances`. Lives outside `supabase/migrations`, so it **does not exist in production**. |
| `scripts/cleanup-auth-users.ts` | Re-check after fixture change. |
| `supabase/staging/profile-fixtures.sql` | Remove/convert pending (…0005) and guest (…0006) fixtures. |
| `supabase/staging/verify-role-matrix.sql` | Remove pending/guest probes (`:52-67`). Every probe now needs a **genuine session context**: inside the rolled-back transaction insert a fixture `auth.sessions` row and `internal.valid_sessions` row and set `request.jwt.claims` with `sub`, `role`, `session_id`. Add probes: deactivated; no profile; revoked session; session with an `auth.sessions` row but **no** `valid_sessions` row (stands in for a password or stray session); open email job; stale `last_active_at`. |
| `supabase/staging/reset-fictional-data.sql`, `scripts/verify-staging-contract.mjs`, `scripts/check-hosted-fixtures.mjs` | Update anything counting removed fixtures. |
| `scripts/verify-migration-baseline.mjs`, `docs/build-plan/migration-checksums.sha256` | Add the new migration (§4.1). |
| new `scripts/bootstrap-first-manager.ts` | One-time, owner-run: first manager on an empty roster; refuses if an active manager exists. |
| Docs `01-architecture.md` §2.3/§6, `02-frontend-spec.md` §3f and line 154 | Amend to point here. |

---

## 5 · Migration plan for existing users

1. **Staging (fictional only):** apply the migration; re-run fixture reset and the seeding script.
2. **Production — read-only count first (owner-approved):** `auth.users` and `profiles` by
   role/status. Today's count is **unknown** (07-handoff said empty on 2026-07-20).
3. Apply the migration (pending/guest → disabled viewers; all sessions become invalid).
4. **Scramble the password of every Auth user — active and inactive** — via
   `updateUserById(id, { password: <64 random bytes, discarded> })`. Reactivation re-scrambles
   again (§3.7).
5. Delete all `auth.sessions` rows for these users (clean-up; already invalid by step 3).
6. If no active manager exists, run `bootstrap-first-manager.ts` with Hunter's address.
7. Hunter signs in by link, adds the team, tells them to use the sign-in page.

---

## 6 · Where Supabase cannot match Quote-Queue exactly

| # | Quote-Queue behaviour [QQ] | Supabase reality | This spec's answer and the **remaining gap** |
|---|---|---|---|
| G1 | Nobody can learn roster membership; only the app can trigger sign-in mail; IP + address flood limits. | Supabase's public endpoint `/auth/v1/otp` is callable by anyone with the public anon key. With `create_user=false` it answers **422 "Signups not allowed for otp"** for unknown addresses [src otp.go]. We found no setting that disables it while keeping email links **[unverified that none exists]**. Calls to it skip `request-sign-in`. | The hook (§3.5) re-checks active roster + per-person limits for **every** send and returns an error otherwise; on hook error Supabase keeps the previous token [src mail.go]. **Remaining gap:** (a) a direct caller learns whether an address is on the roster (422 vs not), and whether it is active/over limit (hook error vs success); (b) a direct caller can make Supabase email an **active** team member a real sign-in link, up to 1/min, 5/hour, 10/day per person and Supabase's 60 s per-user and 30/hour project limits — each new link replaces that person's previous unused link; (c) per-IP limits apply only to requests through our function. A direct caller cannot sign in, cannot email non-members, and cannot exceed those limits. |
| G2 | Each link independently valid until used/expired; 15 min; single use. | A new link replaces the previous one [src mail.go: `RecoveryToken` overwritten]; 60 s minimum between sends [docs]. | Accept; stricter than QQ. |
| G3 | Identity change revokes sessions + unused links in one transaction. | Auth Admin API calls are separate HTTP calls; no admin call ends sessions by user id [docs]; Supabase stores new tokens after the hook returns [src mail.go]. | Each link bound to its own issuance (keyed digest) and redeemed only through `confirm-sign-in`; `revoke_person` revokes unclaimed issuances and deletes `valid_sessions` in the profile-change transaction (§3.2–3.5); email jobs keep the person blocked until Auth agrees (§3.7). **Remaining gap:** a stuck email job leaves the person locked out until it succeeds (visible to managers). |
| G4 | Server-side sessions, instant revocation. | Access tokens can't be revoked before expiry [docs]. | `session_is_valid()` on every query, profile read and app load (§3.6). No residual data access. |
| G5 | 30-day idle (human use) / 90-day cap. | Supabase's timeouts are Pro-only and count token refresh as activity [docs]. | App-enforced via `valid_sessions` + `touch_session()` (§3.6); works on any plan, including staging. Pro settings optional backstop. |
| G6 | No passwords exist. | A signed-in user can set a password with `updateUser` [docs updateUser; src user.go — no hook in that path]. The password-verification hook that could reject password sign-ins needs Teams/Enterprise [reviewer, citing docs auth-hooks] — not planned. | Only `confirm-sign-in`, after a bound link claim, can create a `valid_sessions` row, so a password session is never valid (§3.4, §3.6); recovery mail refused by the hook; all passwords scrambled at migration and on reactivation. **Remaining gap:** a roster member can still set a password and Supabase will accept a password sign-in and issue tokens; those tokens get no data and the app signs them out at once. They could also use such a session to call Supabase Auth's own user endpoints (e.g. edit their own Auth metadata — harmless; request an email change — the confirmation mail is refused by the hook [src user.go: permanent users always need confirmation], so it never completes). |
| G7 | Confirm page bound to cookie + nonce. | Not needed in that form. | Token hash redeemed only by button; stale tab fails as expired/used. |
| G8 | Fixed envelope; identity work strictly after the response (Next.js `after()`). | `waitUntil` keeps work alive but does not defer its start [docs]. | Response never awaits admission or the send; admission has a 600 ms overall deadline after which nothing is sent; identity check moved to the hook (§3.3). **Remaining gap:** the envelope is a measured target, not a guarantee — platform stalls (cold start, CPU, network) can delay any response; the send runs concurrently with the response, not after it. |
| G9 | Delivery webhook, block list, clear-a-block on the roster row. | Not part of this decision. | **Out of scope**; Resend dashboard is the manual fallback. |

---

## 7 · How to test

### 7.1 Offline (no live system)

- **Unit (Vitest):** permissions without guest; sign-in page always renders B4; Confirm page
  states; guard signs out and clears cache when `my_session()` is null; `touch_session` fires on
  navigation/mutation but not on background refetch.
- **Local Supabase** (`supabase start`, Docker **[unverified installed]**; local mail catcher):
  - roster member: request → mail → button → Dashboard;
  - unknown address: same body, no mail; 50 mixed requests all at 900–1,100 ms;
  - envelope with injected faults: send delayed 5 s, send throws, admission lock held 2 s,
    **admission transport delayed** (proxy adds 2 s before the connection and before the reply)
    → response timing within the measured target and body identical; whenever admission misses
    the 600 ms deadline **no send occurs**, including when the late admission returns "allow";
  - background send completes after response with `per_worker` policy.
- **SQL (local DB, two concurrent sessions where noted):**
  - B10 last-manager / self-change under two concurrent demotions;
  - **email change:** Auth update forced to fail → person blocked (no data, `auth_link_gate`
    refuses, `auth_link_claim` refuses), job open; retry succeeds → unblocked; retry when Auth
    already changed → completes idempotently;
  - **concurrent issuance vs revocation:** hook gate passes, then roster change commits, then
    the late token is redeemed → Supabase verifies it but `auth_link_claim` refuses, the
    session is signed out and `session_is_valid` is false;
  - **re-review sequence (exact):** link L1 issued and emailed → manager changes the person's
    role (L1's issuance revoked; Supabase still holds L1's token) → a new request passes the
    gate and records issuance I2, but the Resend send fails (I2 marked revoked; Supabase keeps
    L1's token per [src mail.go]) → L1 is redeemed → Supabase accepts it, `auth_link_claim`
    finds no unrevoked issuance with L1's digest → refused, session signed out, no data. Same
    sequence with the send **succeeding**: L1 is rejected by Supabase (token replaced) and only
    the new link works;
  - a link whose issuance belongs to a different user, a claimed issuance reused, an issuance
    older than 15 minutes → refused;
  - claim and roster change racing on two connections → exactly one of "claimed then session
    deleted" or "revoked then claim refused"; never a surviving session;
  - revoked session, signed-out session, password sign-in session, a session from Supabase's
    own verify endpoint, stale `last_active_at`, 90-day-old session → no rows anywhere, own
    profile included;
  - deactivate while signed in → next query empty; reactivate → password re-scrambled;
  - **populated-database migration:** load seed + staging fixtures including pending, guest
    and disabled users, apply the migration, assert conversions, checks, guard behaviour, and
    that every old session is invalid.
- **Release-gate tests for [src] facts** (re-run on each Supabase upgrade, locally and on
  staging): the hook payload's `token_hash` is exactly what `verifyOtp` accepts; hook error
  leaves the previous link usable and creates no new one; a successful new send makes the
  previous link fail at Supabase; token refresh keeps `session_id`; `/otp` answers 422 for unknown addresses; email change by a user sends only a
  confirmation (refused by hook) and never applies.
- **Credential hygiene:** CI grep fails if `token_hash=` appears in any test output/artifact.
- Project checks: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` in `app/`;
  `node scripts/verify-migration-baseline.mjs`; `node scripts/verify-staging-contract.mjs`.

### 7.2 Staging (owner-approved live step, fictional data)

1. Owner completes §9 Part A and Part B on **staging only**.
2. Operator deploys the migration and the three functions (each owner-approved).
3. Automated: seed fictional users; bound test links via the staging-only path (§4.4); run the
   role matrix, the release-gate tests, and the email-change / revocation scenarios with two
   browsers.
4. Manual, 5 minutes, with Hunter's real address: request → email from the twistednail.com
   sender → button → Dashboard; Sign out; unknown address shows identical text; a manager
   deactivates a test user signed in on a second browser → that browser is signed out on its
   next action; open the link in a different browser from the one that requested it.
5. Record results (never links) in a dated staging note. Only then plan production.

---

## 8 · Risks

| Risk | Effect | Mitigation |
|---|---|---|
| Supabase upgrade changes a [src] behaviour (hook-error handling, token write order, token_hash format) | A guarantee silently weakens | Release-gate tests (§7.1) on every upgrade; staging first. |
| Writes to `auth.sessions` fail or change shape | Clean-up stops | Correctness relies on `valid_sessions` + revoked issuances, not on the delete. |
| Direct-endpoint probing / nuisance mail (G1) | Roster membership learned; members get unwanted links within limits | Hook limits; owner decision Q4. |
| Email job stuck | Person locked out | Visible Retry; red after 24 h; safe failure. |
| Session check cost on every query | Slower lists | Index, `(select …)` wrapping, measure on staging; escalate, never drop the check. |
| Resend outage / unverified domain | Nobody can start a new sign-in | Existing sessions continue. **No emergency link path** (re-review finding 2): fix Resend, or as an owner-approved configuration change temporarily point the hook at a second verified sender. Hunter is told in §1. |
| Hard-coded production project ref in seed/cleanup scripts [repo] | None today (deny-guard) | Leave; never copy elsewhere. |

---

## 9 · Owner-gated live setup (click steps — do not do until asked)

Dashboard labels may differ slightly **[unverified against today's screens]**. Never paste a key
into chat; paste it only into the box named.

**Part A — Resend (the Quote-Queue account)**

1. Sign in at resend.com with the Quote-Queue owner login.
2. Click **Domains**. If `twistednail.com` (or the subdomain chosen in Q1) shows **Verified**,
   skip to step 4.
3. Otherwise click **Add Domain**, type the domain, copy each DNS record into the domain's DNS
   host, then click **Verify**. Wait until it shows Verified.
4. Click **API Keys** → **Create API Key**. Name: `carrier-recruiter-staging`. Permission:
   **Sending access**. Domain: the verified domain. Click **Add**. Keep the page open — the key
   is shown once.

**Part B — Supabase staging project**

1. **Edge Functions → Secrets** → **Add new secret**: name `RESEND_API_KEY`, value = the key
   from A4. Save. Close the Resend page.
2. Same screen: add `APP_ORIGIN` = the staging app address (e.g. `https://…`, no trailing slash).
   The operator also adds `ISSUANCE_HMAC_KEY` (32 random bytes it generates; never shown in
   chat or written to the repo). Production gets its own, different value.
3. **Authentication → Sign In / Providers**: **Allow new users to sign up** off. Keep **Email**
   on. Save.
4. **Authentication → Email**: **Email OTP Expiration** = `900`. Save.
5. **Authentication → URL Configuration**: Site URL = staging address. Redirect URLs: remove
   others, add exactly `<staging address>/auth/confirm`. Save.
6. (After the operator deploys `send-auth-email`.) **Authentication → Hooks** → **Add hook** →
   **Send Email hook** → **HTTPS** → the `send-auth-email` URL → **Generate secret** → Save. The
   operator stores it as Edge Function secret `SEND_EMAIL_HOOK_SECRET` (never in chat or repo).
7. **Authentication → Rate Limits**: emails sent per hour = `30`. Save.

**Part C — Supabase production project** — same as Part B with a **separate** Resend key named
`carrier-recruiter-production` and the production address. Optional backstop: **Authentication →
Sessions** Time-box 90 days, Inactivity 30 days (Pro). Only after §7.2 passes and Hunter says go.

---

## 10 · Proposed build split (work packages)

Concurrency cap: 2 builders + 1 reviewer. Nothing live without a separate owner "go". The
contracts in §3.2 (function settings, wrapper signatures, return shapes) are **frozen** before
WP-AUTH-2 and WP-AUTH-3 start in parallel; any change goes back through the manager.

| WP | Model / effort | Owns (files) | Depends on |
|---|---|---|---|
| **WP-AUTH-1** Database + RLS + SQL tests | Opus 5.5 Medium | new `supabase/migrations/*_team_roster_auth.sql`; `supabase/staging/*.sql`; `scripts/verify-staging-contract.mjs`, `scripts/check-hosted-fixtures.mjs`, `scripts/verify-migration-baseline.mjs`, `docs/build-plan/migration-checksums.sha256`; `app/src/types/database.ts`, `app/src/types/domain.ts`; `docs/build-plan/01-architecture.md` amendments | §3.2 contracts |
| **WP-AUTH-2** Edge Functions + scripts | Opus 5.5 Medium | `supabase/functions/**`; `supabase/config.toml`; `scripts/seed-auth-users.ts`, `scripts/cleanup-auth-users.ts`, new `scripts/bootstrap-first-manager.ts`; staging e2e link helper | §3.2 contracts; WP-AUTH-1 merged before integration tests |
| **WP-AUTH-3** App screens | Sonnet 5.5 Medium | `app/src/features/auth/**`, `app/src/features/users/**`, `app/src/app/{router,guards,Sidebar}.tsx`, `app/src/lib/{permissions,permissions.test,supabase,queryKeys}.ts`, new activity hook; `docs/build-plan/02-frontend-spec.md` §3f | §3.2 contracts |
| **WP-AUTH-4** Independent review | Codex GPT-6.1 Sol High | read-only over WP-AUTH-1..3; focus G1–G8, the email-change state machine, the bound-issuance claim and its races, RLS, secrets and link hygiene | 1–3 done |
| **WP-AUTH-5** Staging rollout + test | Opus 5.5 Medium, operator | dated staging-results note only | 4 passed + owner go per live step |
| **WP-AUTH-6** Production rollout | Opus 5.5 Medium, operator | §5 steps 2–7 | 5 passed + owner go |

---

## 11 · Open questions for Hunter (each with a recommended answer)

1. **Sender address.** *Recommended:* `signin@twistednail.com`, display name "Twisted Nail
   Carrier Recruiter", kept separate from any future cold-outreach subdomain (`04-costs.md`
   suggests e.g. `offers.twistednail.com`).
2. **First manager and team list.** *Recommended:* Hunter is the only manager at launch and adds
   everyone else on the Team page.
3. **How long people stay signed in.** *Recommended:* signed out after **30 days without actually
   using the app** (a tab left open in the background does not count as use), and after **90
   days** no matter what. Enforced by the app itself, so it does **not** depend on the Supabase
   plan. (Changed in revision 2: previously tied to the Pro plan.)
4. **Accept the remaining gaps in G1 and G6?** Someone technical could (a) check whether an
   address is on the team list, and (b) cause a team member to get an unwanted sign-in email (at
   most 10 a day). A team member could set a password, but it would get them nothing.
   *Recommended:* accept — nobody can get in this way, and closing it fully would need a custom
   sign-in system instead of Supabase's. (Changed in revision 2: now also covers nuisance emails
   and passwords.)
5. **Drop "Remember me".** *Recommended:* yes, like Quote-Queue — you stay signed in on that
   computer until you sign out or the Q3 limits are reached.

---

## 12 · Review response (Codex review of revision 1, 2026-10-21)

| # | Finding (short) | Change | Section |
|---|---|---|---|
| 1 | Blocker: password sign-in still possible via `updateUser`; inactive accounts keep old passwords | Server-enforced denial (revision 2 used an `amr` check; **revision 3 replaces it**: only a bound link claim creates a valid session); scramble **all** users' passwords at migration; re-scramble on reactivation; password hook (Teams/Enterprise) not relied on; residual risk stated | §2 B2, §3.4, §3.6, §3.7, §5, §6 G6, §7.1, §11 Q4 |
| 2 | Blocker: failed Auth email update leaves old address usable; no issuance/revocation coordination | Email change opens a durable job and blocks the person (no data, no link, no claim) in the same transaction until Auth confirms; retry on every Team call + Retry button; issuance rows make late tokens unclaimable (revision 3: bound to the exact link; generation counter removed); tests listed | §2 B13, §3.5, §3.7, §6 G3, §7.1 |
| 3 | Public endpoint bypass broader than address discovery | Eligibility + per-person limits moved to the Send Email hook (every send passes it); hook error keeps old token [src]; gap restated: roster probing + bounded nuisance mail, per-IP only via our function | §2 B12, §3.3, §3.5, §6 G1, §1, §11 Q4 |
| 4 | Function/SQL calling contracts incomplete | Per-function `verify_jwt` (off only for the hook, with Standard Webhooks signature), CORS with exact origin, public wrappers over `internal` routines with exact params/returns/grants, lock order, caller re-check inside the transaction; contracts frozen before parallel build | §3.2, §10 |
| 5 | Migration authorization, verifier ownership, populated test, role-matrix session context | Transaction-local service-role claim (existing repo pattern), explicit step order, verifier + checksum manifest assigned to WP-AUTH-1, populated-DB migration test, role-matrix probes with real session rows | §4.1, §4.4, §7.1, §10 |
| 6 | Revocation leaves own-profile access and app shell; "drop if slow" downgrade | One `session_is_valid()` used by `current_app_role()`, `profiles_select`, `my_session()` and the guard; `profiles_update_self` removed; invalid → local sign-out + cache clear + full reload; no automatic downgrade | §3.6, §4.1, §4.2, §8 |
| 7 | `waitUntil` doesn't mean "after the response"; counter transaction unbounded | Guarantee restated as "send never shapes the response"; admission bounded by `lock_timeout` 200 ms / `statement_timeout` 400 ms, fail closed; identity check moved to the hook; fault-injection timing tests | §3.3, §6 G8, §7.1 |
| 8 | `--print-link` prints a credential | Removed; links passed in memory to the test browser; tracing off; redaction + CI check for `token_hash=` | §2 B15, §4.4, §7.1, §7.2, §8 |
| 9 | Supabase inactivity counts refresh, not human use | App-enforced 30-day real-use / 90-day cap via `valid_sessions.last_active_at` + `touch_session()` on real actions only (mirrors QQ `session.ts:135`); Pro settings only a backstop; Q3 reworded | §2 B14, §3.1, §3.6, §6 G5, §11 Q3 |

### Re-review response (Codex re-review of `507c66e`, 2026-10-21)

| # | Finding (short) | Change | Section |
|---|---|---|---|
| R1 | Blocker: issuances not bound to the exact link; an old link could consume a newer issuance | The hook stores a keyed digest (HMAC) of the `token_hash` it sends — never the raw value; the browser no longer calls `verifyOtp`; `confirm-sign-in` verifies the link and atomically claims the issuance with **that digest**, same user, unclaimed, unrevoked, unexpired, profile active, no open email job, under the profile row lock; failed claim → that session is signed out. Every roster change revokes all unclaimed issuances and deletes sessions and `auth.one_time_tokens` in the same transaction. Failed Resend send revokes its issuance. Removed as unnecessary: `auth_generation`, the `amr` check, `claim_session()`. The reviewer's exact sequence is a test | §2 B16, §3.2, §3.4, §3.5, §3.6, §3.7, §4.1, §6 G3/G6, §7.1 |
| R2 | `generateLink` paths bypass the gate | Emergency `generateLink` dropped (Resend outage → existing sessions continue; no back door; stated in §1). Tests use a staging-only path: `generateLink` for fixture users + `staging_identity.record_test_issuance` via the guarded staging runner; absent from production | §1, §4.4, §7.2, §8 |
| R3 | Admission can exceed the envelope; "impossible" overclaimed | Independent 600 ms deadline (`AbortController`) over the whole admission call — connection, transport, database; after it nothing is sent even if admission later succeeds; envelope restated as a measured target, not a guarantee; delayed-transport tests added | §3.3, §6 G8, §7.1 |
