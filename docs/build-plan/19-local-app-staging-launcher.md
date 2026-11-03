# 19. Running the sign-in app locally against staging-2 (approval 7 launcher)

Launcher: `scripts/run-app-staging.mjs` (tests: `scripts/run-app-staging.test.mjs`; contract check: `scripts/verify-app-staging-contract.mjs`).
It exists because `scripts/run-with-secrets.mjs` cannot start the app: its allow-list has none of the app's names and it withholds the app's log lines.

## Future launch command (NOT RUN by the author of this change)

From the staging worktree root (the launcher must run from that folder, because the Doppler token is scoped to it: `C:\Users\hunte\.bb\plugins\environment-git-worktree\host-data\worktrees\thr_dnq6nmqppt-1\truck-recruitment-tool`), in PowerShell, after `npm run build` has produced `app/dist` (the web pages) and `npm run build:server` has produced `app/dist-server/main.js` (the launcher builds and installs nothing, and refuses if either is missing). It also cannot connect until a Supabase root certificate is pinned (see "Database connection security" below); until then the app stops at start with a fixed `DATABASE_URL:` configuration line:

    doppler --config-dir "$env:USERPROFILE\.doppler-truck-stg" --no-read-env --no-check-version --scope 'C:\Users\hunte\.bb\plugins\environment-git-worktree\host-data\worktrees\thr_dnq6nmqppt-1\truck-recruitment-tool' run --no-fallback --project truck-recruitment-tool --config stg -- node scripts\run-app-staging.mjs --port 8788

This uses only the manager's reviewed staging token (config folder `.doppler-truck-stg`). Never use Hunter's full Doppler login for this launch. Stop it with Ctrl+C in that window (on Windows the app receives Ctrl+C itself and shuts down in order; the launcher waits for it and reports its exit code), or by stopping only the process that was started (by its PID).

## Doppler `stg` names the app needs (exactly four; none exist yet)

| Name | What it is | Who creates it, and how |
|---|---|---|
| `DATABASE_URL` | the `recruiter_app` login on the shared pooler, session mode: `postgresql://recruiter_app.<staging-2 ref>:<password>@<pooler host>:5432/postgres` | After approval 6b gives `recruiter_app` a password (the password is the owner's step), the secrets owner assembles this URL in Doppler `stg`. It must not be the runner or maintenance login. |
| `KEY_LINKS`, `KEY_SESSIONS`, `KEY_RATE` | three different random 256-bit keys, each at least 43 base64url characters (`app/server/config.ts`) | The secrets owner generates each one separately and writes it straight into Doppler `stg` without displaying it (see the secrets-owner section below). Values must never be reused from another environment, and production gets its own different set later. |

Not read from Doppler: `APP_ORIGIN`, `EMAIL_MODE`, `HOST`, `PORT`, `TRUSTED_PROXY_HOPS`, `STAGING_BANNER` (the launcher forces them: `http://localhost:<port>`, `test`, `127.0.0.1`, the port, `0`, `true`). No `SENDGRID_*` name is accepted.

## What the launcher refuses

Wrong Doppler project or config; any of the four names missing or empty; a `DATABASE_URL` that is not the recorded staging-2 project (checked with `parseSupabaseDbTarget` and `RECORDED_PROJECT_REFS` from `pipeline/src/target-guard.ts`; production and the old staging project are named refusals), is not the `recruiter_app` login, or is not on port 5432; `EMAIL_MODE` set to anything but `test`; `HOST` set to anything but `127.0.0.1`; any `SENDGRID_*` name; a port outside 1024-65535; an unbuilt app (`app/dist-server/main.js` or `app/dist/index.html` missing).

## Database connection security (pipeline/src/db-tls.ts)

The app server and every pipeline runner use one policy. A hosted database (anything but localhost, 127.0.0.0/8 or ::1) is reached only over TLS with the server certificate checked against the pinned Supabase root in `pipeline/src/supabase-root-ca.ts` (Node's own certificate list is not used) and the host name checked against the certificate. There is no setting that turns the check off. Only SCRAM-SHA-256 sign-in is allowed: a server asking for a cleartext or MD5 password gets no password. SCRAM channel binding is on and used when the server offers it. A `DATABASE_URL` with query parameters (for example `?sslmode=`) is refused.

The pinned root is "Supabase Root 2021 CA" (`prod-ca-2021.crt`): self-signed, valid 2021-04-28 to 2031-04-26, SHA-256 (DER) `80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`. The code checks that fingerprint (and that the entry is one CA certificate) every time a hosted connection is configured, and refuses before dialling if it differs (`invalid_trusted_ca`); with no entry it refuses too (`no_trusted_ca`). The code has no `DB_CA_CERT` override: the pin is the only way to give it a root, and there is no fallback to `rejectUnauthorized: false`.

Provenance: downloaded by the manager thread on 2026-11-03 from https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt (HTTP 200, 1367 bytes). The same fingerprint is pinned independently by Remote Tickets (`src/lib/db-tls.mjs`, `SUPABASE_ROOT_2021_CA_SHA256`) and by the Sales app (`certs/supabase-prod-ca-2021.crt`). A password-free TLS handshake from this PC (SSLRequest, no startup message) to the staging-2 pooler host validated the chain `*.pooler.supabase.com` <- Supabase Intermediate 2021 CA <- Supabase Root 2021 CA, with the host name check, over TLSv1.3; a control using a wrong CA was refused (`SELF_SIGNED_CERT_IN_CHAIN`). **Production has NOT been checked**: this pin is verified for staging-2 only and must not be assumed to cover production. Local test databases on 127.0.0.1 are unaffected (no TLS, still SCRAM-only).

## Output

Output is an allow-list, not a cleaned-up copy. A line is shown only if it is JSON with a known app event name (listed in `APP_LOG_EVENTS` in the launcher, re-derived from the app's own `log(...)` calls by `scripts/verify-app-staging-contract.mjs`), only that event's own fields, and every value a fixed category word, a small whole number or a tight id/route shape. There is no free-text field; a line with one extra or odd field is withheld whole. The only other lines shown are the exact fixed configuration-error messages from `app/server/config.ts` (complete lines only; any other text, even starting with `ConfigError:`, is withheld). As a second layer, the four values are also masked (no minimum length; plain, URL-encoded in any upper/lower-case mix and JSON-escaped forms), but nothing relies on that. A database password under 8 characters is refused at start. Every other line (driver errors, stack traces) is withheld and counted in the final line. Environment values are never printed.

## Secrets owner, only after Hunter's direct OK in the secrets chat

The manager never runs these. Each command generates a value and writes it straight into Doppler without printing it.

KEY_LINKS (KEY_SESSIONS and KEY_RATE follow, each a different random value; nothing is printed):

    node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))" | doppler secrets set KEY_LINKS --project truck-recruitment-tool --config stg --silent

    node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))" | doppler secrets set KEY_SESSIONS --project truck-recruitment-tool --config stg --silent

    node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))" | doppler secrets set KEY_RATE --project truck-recruitment-tool --config stg --silent
