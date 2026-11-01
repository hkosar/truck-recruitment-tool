# 20 · Stateless sign-in probe driver (A5a, class A of doc 14 §8.1)

Status: **built and tested locally only. NOT RUN against staging.** Approval 11 (doc 16, "scoped staging
test authorization") names the A5a stateless probes; nothing here has used that approval.

Files: `scripts/signin-probes-a5a.mjs` (driver), `scripts/signin-probes-a5a.test.mjs` (no-database tests),
the real-app test in `app/server/e2e.http.test.ts` ("A5a class-A probe driver").

## What it does

It sends 80 requests to the sign-in app on this computer and checks that each one is refused,
redirected, or answered with a fixed page. It uses no login, sends no cookie, holds no key, and calls no
mail route. Every state-changing request is refused before the app reaches the database.

| Group | Requests | Passes when |
|---|---|---|
| Readiness | `GET /readyz` | 200, body `ok` |
| Sign-in page | `GET /signin`; the five legacy paths (`/login`, `/register`, `/forgot`, `/reset`, `/pending`) | form posts to `/auth/request`, no password field, `no-store`, `nosniff`, `frame-ancestors 'none'`; legacy paths redirect to `/signin` |
| Data API, signed out | `GET` of every `/api` read route; `POST` of every `/api/rpc/<name>` (all 17, read and write, empty body, foreign Origin) and every other `/api` write route; `PUT`/`DELETE`/`PATCH`/`OPTIONS` | 401 `{"error":"signed_out"}` and nothing else in the body |
| App shell | `GET /` and a deep path as a browser navigation; `GET /` as a non-navigation | 303 to `/signin`; 404 (never the shell) |
| Email link landing | `GET /auth/verify` with a junk 43-character token, a short token, no token | 303 to `/auth/confirm?x=…`, `Referrer-Policy: no-referrer`, no cookie, no token in the address |
| Confirm / sign-out | `GET /auth/confirm` without a cookie; `POST /auth/confirm` and `POST /auth/signout` with no Origin, `null`, and a foreign Origin | stale page with no form fields; sign-out 403 `Forbidden`; no session cookie |
| No Supabase-style routes | `GET`/`POST` of `/rest/v1/…`, `/graphql/v1`, `/storage/v1/…`, `/realtime/v1/…`, `/auth/v1/…` | 404 on `GET`, 405 on `POST`, never JSON |
| Webhook | unsigned `POST /webhooks/sendgrid` | 401 or 404 |

Every response is also checked for two rules: any `Set-Cookie` must be a clearing cookie (empty value,
`Max-Age=0`), and nothing may contain `token=` followed by 16 or more token characters or a session or
confirm cookie value.

## Output

Only fixed JSON lines. Never a URL, cookie, token, link, body, header value or error text:

    {"event":"probe","id":"api-get/api/dashboard","result":"pass"}
    {"event":"probe","id":"api-get/api/dashboard","result":"fail","reason":"cookie"}
    {"event":"summary","pass":N,"fail":M,"expected":N}

Reasons: `status`, `location`, `body`, `header`, `cookie`, `leak`, `network`. Exit 0 only if every probe
passed and the expected number ran; 1 if any failed; 2 for a refused origin or bad arguments.

## Safety limits (enforced in code, covered by tests)

- `--origin` must be exactly `http://localhost:<port>` or `http://127.0.0.1:<port>`: no path, query, user
  or fragment, no other host, no https. Anything else is refused with one fixed message before any request.
- It always connects to `127.0.0.1` (the name `localhost` is never looked up).
- It never requests `/auth/request` (the only route that can start a mail). A test checks the probe table.
  The app launcher forces `EMAIL_MODE=test`, so even a mistake could not send real mail.
- It never follows a redirect, caps each response at 256 KB, and times out each request after 10 s.
- It reads no environment variable and no secret.

## The future command (NOT RUN)

Two terminals on the same computer. Needs the launcher from branch
`bb/launcher-fixes-masking-bypasses-non-json-gate-thr_nr36352ymj` (doc 19 there) and Hunter's approval to
use the scoped staging Doppler token.

1. Start the app against staging-2 (launcher binds 127.0.0.1; exact prefix and token steps are in doc 19):

       <scoped staging token prefix> doppler run --no-fallback --project truck-recruitment-tool --config stg -- node scripts/run-app-staging.mjs --port 8788

2. In a second terminal, run the probes:

       node scripts/signin-probes-a5a.mjs --origin http://127.0.0.1:8788

   Pass = exit code 0 and `{"event":"summary","pass":<N>,"fail":0,"expected":<N>}`. Run it once before
   and once after cutover (doc 14 §8.1), keep only the event lines.

## What this driver does not cover

Doc 14 §8.1 class A also lists probes of the **hosted Supabase** surface with the public anon key:
`GET /rest/v1/<every table and view>`, the read-only RPCs, a GraphQL introspection query, a Storage bucket
list, and a 60-second Realtime subscription per published table. They need the hosted project address and
the anon key, so this driver (local origins only, no key) cannot do them. They remain open until Hunter
decides how to run them (see the report that came with this build). This driver covers the same-origin
app's own surface and confirms the app serves none of those Supabase routes itself.

## Local evidence

Run against the real server (`startServer`, `EMAIL_MODE=test`) on a throwaway PostgreSQL 16 cluster on
127.0.0.1 with the A3 database build: all probes pass; the mail adapter received no message; the row
counts of `internal.app_sessions`, `internal.signin_links` and `internal.auth_request_buckets` did not
change. A front that forwards everything to the real app but answers `GET /api/dashboard` with data and a
session cookie makes exactly that probe fail (`"reason":"cookie"`).

Finding while building: `HEAD /signin` is not served (the app answers 404 because only `GET` is routed).
It is harmless and was left out of the probe list; noted for the sign-in owner.
