# 13 · Team sign-in — invite-only roster + emailed one-time links

Status: **spec only, not built.** Nothing in this document has been applied to staging or
production. Owner decision of 2026-10-21 (recorded in `03-feedback-resolution.md` Round 5).
Written 2026-10-21 UTC on branch `docs/auth-spec-m0-signoff` (from `fd03593`).

Reference behaviour: the Quote-Queue tool (`C:\Users\hunte\Projects\Quote-Queue`,
`docs/BUILDER_HANDOFF.md` §2.3 "Roster management", §4.7 "Sign-in", §8 "Sign-in: plain magic
links"). Quote-Queue is a custom Next.js build with its own token and session tables. This
project uses React + Supabase Auth, so we copy the **behaviour and what the team sees**, not the
code. §6 lists every place where Supabase cannot match Quote-Queue exactly.

Source labels used below: **[QQ]** = Quote-Queue handoff doc; **[docs]** = official Supabase or
Resend documentation, read 2026-10-21; **[src]** = Supabase Auth server source on GitHub
(`supabase/auth`, `internal/api/otp.go`, master branch, read 2026-10-21 — the hosted version
may differ); **[repo]** = this repository at `fd03593`; **[unverified]** = not checked, must be
confirmed in the build. `@supabase/supabase-js` is **not installed** in this worktree (no
`app/node_modules`), so nothing here was checked against the installed library.

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
   address is on the team list, so nobody can use the page to find out who works here.
4. Open the email (from a twistednail.com address). Click **Sign in**.
5. A Carrier Recruiter page opens with one button: **Sign in**. Press it. (This extra press
   stops email security scanners from "using up" the link before you do.)
6. You land on the Dashboard. You stay signed in on that computer until you press
   **Sign out**, or a manager changes your account.

If the link is old, already used, or for someone no longer on the team, the page says
*"This sign-in link has expired or was already used. Request a new one."* and offers the
sign-in page.

**Managing the team (managers only), on the Team page:**

- **Add person:** name, email, role (Manager, Editor or Viewer). That is the whole invite. The
  app sends no email at this point; tell the person to go to the sign-in page.
- **Edit:** change name, email or role.
- **Deactivate / Reactivate:** a deactivated person cannot sign in. Their history (calls,
  notes) stays. Nobody is ever deleted.
- Changing someone's **email, role, or active status signs them out everywhere at once** and
  cancels any sign-in link they have not used yet.
- You cannot deactivate or demote yourself, and the last active manager can never be removed.

**Roles:** Manager = everything, including the Team page. Editor = build batches, log calls,
change statuses. Viewer = look only.

**What Hunter needs to do later (not now):** a few clicks in Resend and Supabase (§9), and
answer the five questions in §11. Every live step waits for your "go".

---

## 2 · Behaviour contract (what must be true when this ships)

| # | Rule | Source |
|---|------|--------|
| B1 | No self-signup. Only roster members (rows created by a manager) can ever receive a link. | Hunter 2026-10-21; [QQ] §2.3 |
| B2 | No passwords anywhere in the app: no password field, no "forgot password", no reset page. | Hunter; [QQ] §8 |
| B3 | Sign-in = email a one-time link; link expires **15 minutes** after it was sent; works **once**. | Hunter; [QQ] §8 |
| B4 | One identical response for every outcome (on roster, not on roster, deactivated, rate-limited, mail failure): *"If that address is on the roster, we emailed a sign-in link. It works once and expires in 15 minutes."* Same words and the same response time. | Hunter; [QQ] §4.7, app/signin/page.tsx |
| B5 | Clicking the emailed link opens a confirm page with one button; the link is redeemed only when the button is pressed. | [QQ] §8 "The button" |
| B6 | Manager can add, edit (name, email, role), deactivate and reactivate people. Never delete. | Hunter; [QQ] §2.3 |
| B7 | Any **email, role or active** change signs that person out of every session and cancels every unused link. | Hunter; [QQ] §2.3, §8 |
| B8 | **Sign out** ends that session on the server (not just in the browser) and does a full page load to the sign-in page. | Hunter; [QQ] §4 navigation, §8 |
| B9 | Roles: `manager`, `editor`, `viewer`. No guest role, no pending state. | Hunter 2026-10-21 |
| B10 | Last active manager cannot be deactivated or demoted; a manager cannot change their own role/status. | [QQ] §2.3; existing "Self locked" in `UsersAdmin.tsx:112` [repo] |
| B11 | Sign-in emails go through the Quote-Queue Resend account, from a twistednail.com address. | Hunter 2026-10-21 |
| B12 | Flood limits: per IP and per address (Quote-Queue: >20 per IP or >10 per address in 15 min → silently no send; per person at most 1/min, 5/hour, 10/day). | [QQ] §8 steps 1–2 |

---

## 3 · Supabase mapping (technical spec)

### 3.1 Auth project settings (per environment)

| Setting | Value | Where | Source |
|---|---|---|---|
| Allow new users to sign up | **Off** (`auth.enable_signup = false`, `auth.email.enable_signup = false` locally) | Dashboard → Authentication | key names [docs] CLI config |
| Email provider | On (needed for email links) | Dashboard → Authentication → Providers | [docs] |
| Email OTP / link expiry | **900 seconds** (`auth.email.otp_expiry = 900`) | Dashboard → Authentication → Email | default 3600 [docs] passwordless + CLI config |
| Min time between requests per user | 60 s (default `auth.email.max_frequency = 1m`) | Dashboard → Rate limits | [docs] |
| Emails per hour (project-wide) | 30 (custom-mail default) — enough for a small team | Dashboard → Authentication → Rate Limits | [docs] SMTP page |
| Site URL | the exact app address of that environment | Dashboard → Authentication → URL Configuration | [docs] redirect-urls |
| Redirect URLs | exactly `<app address>/auth/confirm`; **no wildcards** in staging or production | same | [docs] recommends exact paths |
| Send Email hook | On, pointing at Edge Function `send-auth-email` (§3.5) | Dashboard → Authentication → Hooks | [docs] send-email-hook |
| Custom SMTP | Not needed when the hook is on (hook replaces SMTP) — fallback option in §3.5 | — | [docs] send-email-hook |
| Time-box sessions / Inactivity timeout | Production: 90 days / 30 days (mirrors QQ 90-day cap, 30-day idle) — **Pro plan only**; staging (free) cannot | Dashboard → Authentication → Sessions | [docs] sessions; plan per `04-costs.md` A1/A2 |
| JWT (access token) expiry | keep 3600 s | — | [docs] sessions, `config.toml:54` [repo] |

### 3.2 Sign-in request — Edge Function `request-sign-in`

The browser never calls `supabase.auth.signInWithOtp` directly. It POSTs `{ email }` to the
Edge Function `request-sign-in` (anon key). The function:

1. Starts a clock. Normalises the address (trim, lower-case); rejects only syntactically
   invalid input — and even then returns the generic response.
2. **Before responding (anonymous work only):** one transaction upserts two counters in
   `internal.auth_request_buckets` (15-minute window; IP and address each stored as a keyed
   hash, never raw). Over 20 for the IP or 10 for the address → mark "do nothing".
3. Schedules the identity work with `EdgeRuntime.waitUntil(...)` [docs background-tasks] so it
   runs **after** the response.
4. Waits until **1,000 ms ± 100 ms** after receipt, then returns `200 { ok: true }` — always
   the same body. The page shows the B4 text.
5. **Background (identity work):** look up `public.profiles` by email where
   `status = 'active'`. If none → stop. Check per-person ceilings (1/min, 5/hour, 10/day) in
   `internal.sign_in_requests`. If allowed, record the request, then call
   `signInWithOtp({ email, options: { shouldCreateUser: false } })` server-side. Supabase
   creates the one-time token and calls the Send Email hook (§3.5). Errors are logged by
   category only (no address).

Client IP: taken from the forwarding header Supabase passes to Edge Functions — exact header
**[unverified]**, confirm in WP-AUTH-2.

### 3.3 Clicking the link — page `/auth/confirm`

- Email link: `<Site URL>/auth/confirm?token_hash=<TokenHash>&type=email` (built by our
  `send-auth-email` function from the hook's `email_data.token_hash` [docs]).
- The page reads the query, immediately removes it from the address bar
  (`history.replaceState`), and shows one button: **Sign in**. (Quote-Queue also shows the
  masked address; we cannot know it before the token is redeemed without an extra lookup, so
  we skip it.)
- On press: `supabase.auth.verifyOtp({ token_hash, type: 'email' })` [docs passwordless]. This
  uses the token once. Success → load profile → if `status = 'active'` go to `/dashboard`;
  otherwise `signOut({ scope: 'local' })` and show the expired/used message.
- Because the link carries a token hash (not a PKCE code), it works even if opened in a
  different browser from the one that requested it. [docs: PKCE variant requires token hash
  in template; cross-browser behaviour **[unverified]**, test in WP-AUTH-5.]
- Page sets `Referrer-Policy: no-referrer` and loads no third-party resources (mirrors [QQ]).
  Hosting header config is part of WP-AUTH-3 **[unverified that the Cloudflare Worker setup
  allows per-route headers]**.

### 3.4 Roster admin — Edge Function `team-admin` + security-definer SQL

Browser → `team-admin` (with the manager's own JWT). The function verifies the caller with
`auth.getUser(jwt)` and then requires an active manager profile. Actions:

| Action | Steps (in this order) |
|---|---|
| `add` `{name,email,role}` | 1) SQL RPC `internal.roster_add` (service role only): lock roster, reject duplicate active email. 2) `auth.admin.createUser({ email, email_confirm: true })` — **no password**. The existing trigger `internal.handle_new_user` creates the profile row (fail-closed defaults, §4). 3) RPC sets `full_name`, `role`, `status='active'`, `added_by`, `added_at`. |
| `edit` `{id,name?,email?,role?}` | 1) RPC `internal.roster_update`: locks the manager set + target row, enforces B10, updates profile, and **if email or role changed calls `internal.revoke_member_access(id)` in the same transaction**. 2) If email changed: `auth.admin.updateUserById(id, { email, email_confirm: true })` — admin changes apply directly without a confirmation email [docs updateUserById]. |
| `deactivate` `{id}` | 1) RPC `internal.roster_set_active(id,false)`: B10 checks, `status='deactivated'`, `revoke_member_access(id)` — one transaction. 2) `auth.admin.updateUserById(id, { ban_duration: '876000h' })` [docs example "Ban a user for 100 years"] so Supabase itself refuses new sessions. |
| `reactivate` `{id}` | 1) `updateUserById(id, { ban_duration: 'none' })` **[unverified: 'none' value]**. 2) RPC sets `status='active'` and revokes again (clean slate). |

`internal.revoke_member_access(user_id)` (security definer, executable by `service_role` only):

- `delete from auth.sessions where user_id = $1` — Supabase stores sessions in
  `auth.sessions`, and signing out deletes those rows [docs sessions]. Whether refresh tokens
  are removed with them by cascade is **[unverified]** — WP-AUTH-1 must check on local Supabase
  and also delete from `auth.refresh_tokens` if needed.
- `delete from auth.one_time_tokens where user_id = $1` — cancels unused links. Table name and
  shape **[unverified]** on the hosted version; WP-AUTH-1 must confirm before relying on it.
- Writes an entry to `public.batch_activity`-style admin log **or** a new `internal.roster_events`
  table (decide in WP-AUTH-1; recommend a new small table).

Writing to the `auth` schema directly is outside Supabase's public API. It is the only way to
end another user's sessions by user id (see §6, gap G3). Keep it to these two deletes, in one
function, covered by tests.

Manager screen calls nothing else. The existing direct `profiles` PATCH in
`UsersAdmin.tsx:24` [repo] is removed; RLS `profiles_update_mgr` is narrowed so even a manager
cannot change `role`/`status`/`email` by plain PATCH — only via the RPCs.

### 3.5 Email delivery — Send Email hook → Resend

Edge Function `send-auth-email` registered as the Supabase **Send Email hook** [docs]:

- Verifies the hook signature with the hook secret.
- If `email_data.email_action_type` is the magic-link type → build the `/auth/confirm` link (§3.3)
  and send through the **Resend API** with the twistednail.com sender. Subject: "Your Carrier
  Recruiter sign-in link". Body: one button, "This link works once and expires in 15 minutes.
  If you didn't ask for it, ignore this email."
- **Any other type** (signup, recovery, email change, invite) → send nothing, return success.
  This closes the password-recovery side door (§6, gap G6).
- Resend API key lives only in Supabase Edge Function secrets.

Fallback (simpler, weaker): Supabase **custom SMTP** pointing at Resend — host
`smtp.resend.com`, port 465, user `resend`, password = Resend API key [docs Resend]. Loses the
"drop non-sign-in emails" control. Use only if the hook cannot be made to work.

### 3.6 Session rules in the app

- Client: `persistSession: true`, always `localStorage` (Quote-Queue has no "Remember me";
  §11 Q5). `detectSessionInUrl` can be turned off — we no longer receive tokens in the URL
  fragment.
- **Make revocation immediate:** extend `internal.current_app_role()` so it returns NULL
  unless the caller's `session_id` claim still has a row in `auth.sessions` — the check the
  Supabase docs suggest for detecting signed-out tokens [docs sessions]. Without this, a
  revoked or signed-out access token keeps working for up to 1 hour (JWT expiry). Note that
  role and active status are already read live from `profiles` on every query
  (`20260720001200_rls.sql:41-43` [repo]), so deactivation and role changes already bite at
  once even without the session check; the check closes the gap for Sign out and email
  change. Performance must be measured (WP-AUTH-1).
- **Sign out:** `supabase.auth.signOut({ scope: 'local' })` — ends this session on the server
  [docs signOut: scopes global/local/others, default global] — then
  `window.location.assign('/login')` (full page load, like QQ). Today
  `Sidebar.tsx:141` [repo] calls `signOut()` with the default `global` scope and no full
  navigation.

---

## 4 · What changes in this repository

### 4.1 Database (new migration; never edit old migration files)

| Item | Today [repo] | Change |
|---|---|---|
| `user_role` enum | `manager, edit, view, guest` (`20260720000200_enums.sql:9`) | Keep the type (Postgres cannot easily drop enum values). Keep stored values `edit`/`view`; UI labels them Editor/Viewer. Add `check (role <> 'guest')` on `profiles.role`. Renaming stored values to `editor`/`viewer` is optional and touches every RLS helper — **not recommended**. |
| `user_status` enum | `pending, approved, disabled` (`:10`) | Recommended: keep the type and add `check (status in ('approved','disabled'))`; UI labels them Active/Deactivated. (This spec writes `active`/`deactivated` for readability; the build uses the existing stored values.) |
| `profiles` defaults | `role 'guest'`, `status 'pending'` (`20260720000300_profiles.sql:16-17`) | Fail-closed: `role 'view'`, `status 'disabled'` until the roster RPC activates the row. |
| `approved_by` / `approved_at` | approval workflow | Keep columns; meaning becomes "added by / added at". No rename (avoids churn). |
| `internal.handle_new_user()` | creates pending guest on any signup | Keep (still needed for admin-created users); now produces a disabled viewer row until activated. |
| `internal.guard_profile_update()` | guards role/status/approved_* (`20260723004500_profile_service_bootstrap.sql`) | Also guard `email`. Today a user can change their own `profiles.email` via `profiles_update_self` (`20260720001200_rls.sql:79`) — the roster would then show a false address. |
| `profiles_update_mgr` policy | manager may PATCH any profile | Narrow: managers change roster fields only through RPCs; self-update limited to `full_name`, `avatar_color`. |
| `internal.current_app_role()` | role where `status='approved'` | Add session-row check (§3.6). |
| New | — | `internal.auth_request_buckets`, `internal.sign_in_requests`, `internal.roster_events`; RPCs `internal.roster_add/update/set_active`, `internal.revoke_member_access`; all `service_role` only, RLS on, no grants to `anon`/`authenticated`. |
| Data migration | — | `update profiles set status='disabled', role='view' where status='pending' or role='guest'` **before** adding the checks. |

`app/src/types/database.ts` regenerated (or hand-mirrored per that file's header) after the migration.

### 4.2 App (React)

| File [repo] | Change |
|---|---|
| `features/auth/Register.tsx`, `Forgot.tsx`, `Reset.tsx`, `Pending.tsx` | **Delete.** |
| `features/auth/Login.tsx` | Rewrite as email-only sign-in (B4 copy, posts to `request-sign-in`). Remove password, Remember me, Forgot, Register link. Keep staging banner and brand block. |
| new `features/auth/Confirm.tsx` | `/auth/confirm` page (§3.3). |
| `app/router.tsx` | Remove `/register`, `/forgot`, `/reset`, `/pending`; add public `/auth/confirm`. |
| `app/guards.tsx` | `RequireApproved` → `RequireActive`: no pending branch; inactive or missing profile → sign out locally + `/login`. |
| `lib/permissions.ts` (+ `.test.ts`) | Drop `isGuest`/`guest`; null role = no permissions. |
| `lib/supabase.ts` | Remove remember-me storage switch (if Q5 = yes). |
| `app/Sidebar.tsx` | Remove pending-count badge (`:45-51`, `:115`); Sign out per §3.6. |
| `lib/queryKeys.ts` | Remove `pendingUsersCount`. |
| `features/users/UsersAdmin.tsx` | Rewrite as **Team** roster: table (name, email, role, Active/Deactivated, added), Add person, Edit, Deactivate/Reactivate; all via `team-admin`. Remove Pending section and Guest option. |
| `types/domain.ts` | Follow regenerated types. |

### 4.3 Supabase functions and config

| File | Change |
|---|---|
| new `supabase/functions/request-sign-in/` | §3.2 |
| new `supabase/functions/team-admin/` | §3.4 |
| new `supabase/functions/send-auth-email/` | §3.5 |
| `supabase/config.toml` (local only) | `enable_signup = false` (both), `otp_expiry = 900`, hook section for local, exact redirect URL, `[edge_runtime] policy = "per_worker"` so background work finishes locally [docs background-tasks]. |

### 4.4 Test fixtures and scripts

| File [repo] | Change |
|---|---|
| `scripts/seed-auth-users.ts` | Create users with `email_confirm: true` and **no password**; drop `pending` and `guest` fixtures (`:77-78`); keep manager/editor/viewer/deactivated. Remove `TEST_USER_PASSWORD`. Add optional `--print-link` mode that uses `auth.admin.generateLink` for automated staging tests without sending mail (return fields **[unverified]** — docs page does not list them). |
| `scripts/cleanup-auth-users.ts` | No logic change expected; re-check after fixture change. |
| `supabase/staging/profile-fixtures.sql` | Remove the pending (…0005) and guest (…0006) fixtures or convert to `disabled`. |
| `supabase/staging/verify-role-matrix.sql` | Remove pending/guest probes (`:52-67`); add "deactivated", "no profile", and "revoked session" probes. |
| `supabase/staging/reset-fictional-data.sql`, `scripts/verify-staging-contract.mjs`, `scripts/check-hosted-fixtures.mjs` | Update anything that counts the removed fixtures. |
| new `scripts/bootstrap-first-manager.ts` | One-time, owner-run: creates the first manager on an empty roster (QQ `bootstrap:prod`). Refuses if any active manager exists. |
| Docs `01-architecture.md` §2.3/§6, `02-frontend-spec.md` §3f and line 154 | Amend to point here. |

---

## 5 · Migration plan for existing users

1. **Staging (fictional only):** apply the migration, re-run fixture reset and the new
   seeding script. All old passwords become irrelevant (fixtures are re-created).
2. **Production — read-only check first (owner-approved):** count `auth.users` and `profiles`
   by role/status. Production user count today is **unknown** (07-handoff said empty on
   2026-07-20; not re-checked).
3. Apply the migration (converts any pending/guest rows to deactivated viewers).
4. For each remaining active person: set a long random password via the admin API and discard
   it, so no one can use an old password (Supabase keeps password sign-in available for any
   user who has one; see gap G6). Recommended over trying to null the hash directly.
5. Revoke all sessions (`revoke_member_access` for every user) so everyone signs in fresh by
   link.
6. If no active manager exists, run `bootstrap-first-manager.ts` with Hunter's address.
7. Hunter signs in by link, adds the team on the Team page, tells them "go to the sign-in page".

---

## 6 · Where Supabase cannot match Quote-Queue exactly

| # | Quote-Queue behaviour [QQ] | Supabase reality | Closest safe option (this spec) |
|---|---|---|---|
| G1 | Unknown addresses get the same answer at the same speed. | Supabase's public endpoint `/auth/v1/otp` with `create_user=false` returns **HTTP 422 "Signups not allowed for otp"** for an unknown address [src otp.go]. The anon key is public by design, so anyone can call that endpoint directly and learn whether an address is on the roster. We found no setting that blocks it while keeping email links **[unverified that none exists]**. | Our app never calls it from the browser; `request-sign-in` gives identical words and timing. **Residual risk: someone determined can still test addresses directly.** Hunter decides (Q4). Possible later hardening: generate links with `auth.admin.generateLink` server-side only — but the public endpoint would still exist, so it does not close G1. |
| G2 | Each link independently valid until used/expired; 15 min; single use. | Expiry configurable (900 s) and links are single-use [docs]. Whether a newer request invalidates the older link is **[unverified]**; Supabase also enforces 60 s between requests per user [docs]. | Accept. Possibly stricter than QQ (older link may die when a new one is sent) — that is safe. |
| G3 | Change of email/role/active revokes sessions + unused links **in the same transaction**. | No admin API call ends another user's sessions by user id: `auth.admin.signOut` takes the user's JWT, not an id [docs]. Auth Admin API calls are separate HTTP calls, not part of a Postgres transaction. | Profile change + `delete from auth.sessions` + `delete from auth.one_time_tokens` in **one Postgres transaction** (security-definer RPC); Admin API calls (email change, ban) follow and are retried idempotently. Because RLS reads role/status live, the person loses data access the moment the transaction commits even if a later Admin API call fails. |
| G4 | Sessions are server-side and revocation is instant. | Access tokens (JWTs) cannot be revoked before they expire [docs signOut, sessions]. | Session-row check in `current_app_role()` (§3.6) makes revoked tokens useless for data immediately. Measure cost. |
| G5 | 30-day idle / 90-day absolute session life. | Time-box and inactivity timeout exist but are **Pro plan only** [docs sessions]. Refresh tokens otherwise never expire [docs]. | Set 90 d / 30 d on production (Pro per `04-costs.md`). Staging (free) cannot test this. Q3. |
| G6 | No passwords exist. | Supabase email provider covers both password and link sign-in; there is no switch to turn off passwords alone **[unverified that no such switch exists]**. A roster member could ask Supabase for a password-recovery email and set a password. | Send Email hook drops all non-sign-in emails (so recovery mail never goes out); migration scrambles any old passwords; app has no password UI. A deactivated person is banned and fails RLS anyway. |
| G7 | Confirmation page bound to a cookie + nonce (stale tab fails closed). | Not needed in the same form: the token hash is in the link and is redeemed only by the button press; a stale tab's button simply fails as "expired/used". | Accept. |
| G8 | Fixed 1,000 ms envelope with identity work after the response (Next.js `after()`). | Edge Functions have `EdgeRuntime.waitUntil` [docs]; time limits per Supabase limits page **[unverified values]**. | Same design via `waitUntil`; WP-AUTH-2 kill-tests that background work completes. |
| G9 | Delivery webhook, block list, "clear a blocked address" on the roster row. | Not part of this decision. | **Out of scope** for now; Resend dashboard is the manual fallback. Flag for a later package if bounces become a problem. |

---

## 7 · How to test

### 7.1 Offline (no live system)

- Unit tests (Vitest, existing setup): permissions without guest; sign-in page always renders
  the B4 text; Confirm page states (missing token, success, failure, deactivated profile).
- Local Supabase (`supabase start`; needs Docker — **[unverified]** whether Docker is installed
  on the build machine) with the local mail catcher: request a link for a roster member,
  confirm the email arrives, press the button, land on Dashboard. Request for an unknown
  address: same response, same timing (assert 900–1,100 ms for 50 mixed requests), no mail.
- SQL tests on local DB: B10 last-manager and self-change rules under two concurrent sessions;
  `revoke_member_access` removes sessions and pending tokens; a revoked access token returns no
  rows; guest/pending rows impossible after migration (check constraints).
- Role matrix (`verify-role-matrix.sql`) updated and green locally.
- Project checks: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` in `app/`.

### 7.2 Staging (owner-approved live step, fictional data)

1. Owner completes §9 Part A and Part B on **staging only**.
2. Operator deploys the three Edge Functions and the migration to staging (each owner-approved).
3. Automated: seed fictional users; use `generateLink` mode (no mail) to run the role matrix and
   the "change email/role/active → signed out" checks with two browsers.
4. Manual, 5 minutes, with Hunter's real address: request link → email arrives from the
   twistednail.com sender → button → Dashboard; Sign out; request for an unknown address shows
   identical text; manager deactivates a test user who is signed in on a second browser → that
   browser loses data within one refresh.
5. Record results in a dated staging note. Only then plan production (Part C).

---

## 8 · Risks

| Risk | Effect | Mitigation |
|---|---|---|
| Direct writes to `auth.sessions` / `auth.one_time_tokens` break on a Supabase upgrade | Revocation silently stops working | Keep in one function; staging test asserts it every release; fall back to ban + RLS (still blocks data). |
| Roster probing via public endpoint (G1) | Outsider confirms an address is staff | Accept or not (Q4); flood limits; no other info leaks. |
| Email scanners click links | Link used before the person clicks | Confirm button (B5). |
| Resend outage or domain not verified | Nobody can sign in | Already-signed-in sessions continue; break-glass: operator uses `generateLink` for a manager (owner-approved, logged). |
| Session-row check slows every query | Slower lists | Wrap as `(select internal.current_app_role())` in policies; measure on staging; drop the check if too slow (G4 then reverts to ≤1 h). |
| Background work killed early | Link never sent; user retries | Human retry is the design (as QQ); WP-AUTH-2 kill-test. |
| Hard-coded production project ref in seed/cleanup scripts [repo] | None today (used as a deny-guard) | Leave as is; do not copy elsewhere. |

---

## 9 · Owner-gated live setup (click steps — do not do until asked)

Dashboard labels may differ slightly from these names **[unverified against today's screens]**.
Never paste a key into chat; paste it only into the box named.

**Part A — Resend (the Quote-Queue account)**

1. Sign in at resend.com with the Quote-Queue owner login.
2. Click **Domains**. If `twistednail.com` (or the subdomain Quote-Queue sends from) shows
   **Verified**, skip to step 4.
3. Otherwise click **Add Domain**, type the domain, copy each DNS record into the domain's DNS
   host, then click **Verify**. Wait until it shows Verified.
4. Click **API Keys** → **Create API Key**. Name: `carrier-recruiter-staging`. Permission:
   **Sending access**. Domain: the verified domain. Click **Add**. Keep the page open — the key
   is shown once.

**Part B — Supabase staging project** (in the browser, staging project selected)

1. **Edge Functions → Secrets** → **Add new secret**: name `RESEND_API_KEY`, value = the key
   from A4. Save. Close the Resend page.
2. **Authentication → Sign In / Providers**: turn **Allow new users to sign up** off. Keep
   **Email** on. Save.
3. **Authentication → Email** (or Providers → Email): set **Email OTP Expiration** to `900`.
   Save.
4. **Authentication → URL Configuration**: Site URL = the staging app address. Redirect URLs:
   remove others, add exactly `<staging address>/auth/confirm`. Save.
5. (After the operator deploys `send-auth-email`.) **Authentication → Hooks** → **Add hook** →
   **Send Email hook** → type **HTTPS** → choose the `send-auth-email` function URL → click
   **Generate secret** → Save. The operator stores that secret as Edge Function secret
   `SEND_EMAIL_HOOK_SECRET` (it never goes in chat or the repo).
6. **Authentication → Rate Limits**: emails sent per hour = `30`. Save.

**Part C — Supabase production project** — same as Part B with a **separate** Resend key named
`carrier-recruiter-production`, the production address, plus **Authentication → Sessions**:
Time-box = 90 days, Inactivity timeout = 30 days. Only after the staging test (§7.2) passes
and Hunter says go.

---

## 10 · Proposed build split (work packages)

Concurrency cap: 2 builders + 1 reviewer. Nothing live without a separate owner "go".

| WP | Model / effort | Owns (files) | Depends on |
|---|---|---|---|
| **WP-AUTH-1** Database + RLS | Opus 5.5 Medium (difficult: auth schema, locking, RLS) | new `supabase/migrations/*_team_roster_auth.sql`; `supabase/staging/*.sql`; `scripts/verify-staging-contract.mjs`, `scripts/check-hosted-fixtures.mjs`; `app/src/types/database.ts`, `app/src/types/domain.ts`; `docs/build-plan/01-architecture.md` amendments | — |
| **WP-AUTH-2** Edge Functions + scripts | Opus 5.5 Medium (timing envelope, hook signature, admin API) | `supabase/functions/**`; `supabase/config.toml`; `scripts/seed-auth-users.ts`, `scripts/cleanup-auth-users.ts`, new `scripts/bootstrap-first-manager.ts` | WP-AUTH-1 RPC names (can start in parallel against the agreed signatures in §3.4) |
| **WP-AUTH-3** App screens | Sonnet 5.5 Medium (routine UI) | `app/src/features/auth/**`, `app/src/features/users/**`, `app/src/app/{router,guards,Sidebar}.tsx`, `app/src/lib/{permissions,permissions.test,supabase,queryKeys}.ts`; `docs/build-plan/02-frontend-spec.md` §3f | Function contracts from §3.2–3.4 |
| **WP-AUTH-4** Independent review | Codex GPT-6.1 Sol High | read-only over WP-AUTH-1..3 diff; focus: G1–G6, RLS, last-manager race, secrets | 1–3 done |
| **WP-AUTH-5** Staging rollout + test | Opus 5.5 Medium, operator | no repo files except a dated staging-results note | 4 passed + owner go for each live step |
| **WP-AUTH-6** Production rollout | Opus 5.5 Medium, operator | §5 steps 2–7 | 5 passed + owner go |

---

## 11 · Open questions for Hunter (each with a recommended answer)

1. **Sender address.** Which twistednail.com address should sign-in emails come from?
   *Recommended:* `signin@twistednail.com`, display name "Twisted Nail Carrier Recruiter" —
   kept separate from any future cold-outreach subdomain (`04-costs.md` suggests e.g.
   `offers.twistednail.com`) so marketing reputation never blocks sign-in mail.
2. **First manager and team list.** *Recommended:* Hunter's own address is the only manager at
   launch; Hunter adds everyone else on the Team page.
3. **How long people stay signed in (production).** *Recommended:* same as Quote-Queue — signed
   out after 30 days of not using it, and at most 90 days. Requires the Pro plan already in the
   cost plan; current plan of the production project is **not verified**.
4. **Accept the roster-probing gap (G1)?** Someone technical could check whether an address is
   on the team list by calling Supabase directly. *Recommended:* accept for now — the team is
   small, the page itself never reveals it, and nothing else leaks.
5. **Drop "Remember me".** *Recommended:* yes, like Quote-Queue — you stay signed in on that
   computer until you sign out or the time limit in Q3.
