# Staging SQL for after M1 (new files; the current staging files are unchanged)

Doc 15 §12.5. These apply only once `supabase/pending/M1_same_origin_signin.sql` is on staging
(a reviewed migration gate with its own owner approval). Until then the existing files in
`supabase/staging/` remain the ones in use.

| File | Replaces / complements | What changes |
|---|---|---|
| `verify-role-matrix-m1.sql` | `../verify-role-matrix.sql` (pre-M1) | Probes as `recruiter_api` with fixture `app.session_hash` sessions (link and recovery kinds) inside the rolled-back transaction; `anon`/`authenticated` must be denied everything; adds revoked, expired and email-changed sessions, manager-only denials for editors, attribution denials, recovery restrictions, and the manager's emergency sign-out |
| `cleanup-auth-ledgers-m1.sql` | runs **before** `../cleanup-fixtures.sql`, and before `../reset-fictional-data.sql` | Deletes only the fixture identities' sign-in ledger rows, under the same runner, marker and confirmation gates |

Not changed: the fixtures, the marker installer, the reset itself, the runner, and the hosted
fixture scripts. Their after-M2 versions (profile-only fixtures, the identity registry) depend
on the unapproved proposal D8 and are not written.

Running these on staging needs two runner actions (`role-matrix-m1`,
`cleanup-auth-ledgers-m1`) added to `pipeline/src/staging-sql-runner.ts`. That is a pipeline
tooling change; it is not made here and waits for the staging rollout approval. Offline checks:
`node scripts/verify-staging-m1-contract.mjs`.
