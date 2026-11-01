# 19. Running the sign-in app locally against staging-2 (approval 7 launcher)

Launcher: `scripts/run-app-staging.mjs` (tests: `scripts/run-app-staging.test.mjs`; contract check: `scripts/verify-app-staging-contract.mjs`).
It exists because `scripts/run-with-secrets.mjs` cannot start the app: its allow-list has none of the app's names and it withholds the app's log lines.

## Future launch command (NOT RUN by the author of this change)

From the repository root, after `npm run build:server` has produced `app/dist-server/main.js` (the launcher builds and installs nothing):

    doppler run --project truck-recruitment-tool --config stg -- node scripts\run-app-staging.mjs --port 8788

Stop it with Ctrl+C in that window, or by stopping only the process that was started (by its PID).

## Doppler `stg` names the app needs (exactly four; none exist yet)

| Name | What it is | Who creates it, and how |
|---|---|---|
| `DATABASE_URL` | the `recruiter_app` login on the shared pooler, session mode: `postgresql://recruiter_app.<staging-2 ref>:<password>@<pooler host>:5432/postgres` | After approval 6b gives `recruiter_app` a password (the password is the owner's step), the secrets owner assembles this URL in Doppler `stg`. It must not be the runner or maintenance login. |
| `KEY_LINKS`, `KEY_SESSIONS`, `KEY_RATE` | three different random 256-bit keys, each at least 43 base64url characters (`app/server/config.ts`) | The secrets owner generates each one separately and writes it straight into Doppler `stg` without displaying it (command below). Values must never be reused from another environment, and production gets its own different set later. |

Command for one key (repeat for the other two names; a different random value each time; nothing is printed):

    node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))" | doppler secrets set KEY_LINKS --project truck-recruitment-tool --config stg --silent

Not read from Doppler: `APP_ORIGIN`, `EMAIL_MODE`, `HOST`, `PORT`, `TRUSTED_PROXY_HOPS`, `STAGING_BANNER` (the launcher forces them: `http://localhost:<port>`, `test`, `127.0.0.1`, the port, `0`, `true`). No `SENDGRID_*` name is accepted.

## What the launcher refuses

Wrong Doppler project or config; any of the four names missing or empty; a `DATABASE_URL` that is not the recorded staging-2 project (checked with `parseSupabaseDbTarget` and `RECORDED_PROJECT_REFS` from `pipeline/src/target-guard.ts`; production and the old staging project are named refusals), is not the `recruiter_app` login, or is not on port 5432; `EMAIL_MODE` set to anything but `test`; `HOST` set to anything but `127.0.0.1`; any `SENDGRID_*` name; a port outside 1024-65535; an unbuilt app.

## Output

Only the app's structured log lines (`{"at","event",...}`, flat, short values) and fixed configuration-error lines are shown, with the four values masked (same masking as `run-with-secrets.mjs`). Every other line (driver errors, stack traces) is withheld and counted in the final line. Environment values are never printed.
