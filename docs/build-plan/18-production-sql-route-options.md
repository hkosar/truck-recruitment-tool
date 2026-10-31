# 18 · How the production SQL files get run — route options (OPEN-1)

**DRAFT FOR HUNTER'S DECISION. Nothing here is approved, built or run.** Drafted 2026-10-30 UTC. It closes the *question* in `17-signin-cutover-runbook-draft.md` OPEN-1; it does not close the gap until Hunter picks a route.

Numbering note: the first-manager tool's design on branch `signin/first-manager-bootstrap` is also called `18-…` (`18-first-manager-bootstrap.md`). The two files have different names, so they will not overwrite each other, but the manager may want to renumber one.

---

### Pending Action

🔴 **Choose the route for production SQL (OPEN-1)** — a decision only; nothing is run, nothing is sent, no secret is needed
- **What:** pick one of three routes in the Summary below (A, B or C). The manager then writes the answer into doc 17 and plans the build, if any.
- **Why needed:** steps A2, A3, B2, B3, B4, B5, B10, B13 and the backout SQL in doc 17 all say "the production SQL route". Without a named route the cutover cannot start.
- **If skipped:** the cutover stays blocked. Nothing breaks; production is untouched.
- **Steps:**
  1. a. Read "Summary of Next Step" below (the three options and the recommendation).
  2. a. Tell the manager in chat: "Route A", "Route B", "Route C", or "A for files, B for the password statement" (the recommendation).
  3. a. If you pick A, say whether the manager may start building it. It is **not** being built yet.
- **Success check:** the manager replies with one named route and who runs it.

---

### Summary of Next Step

**What you are deciding, in plain words.** Some cutover steps change the real, live database. Those steps are written as SQL files (plain-text instructions for the database). Someone has to feed each file to the live database. The tools we already have **refuse** the live database on purpose, so they cannot do it. No document says what *will* do it. That gap is OPEN-1.

**Which files are involved** (from doc 17): the four July migrations (A2), the permission snapshot (A3), M1, M1b and M1c, the L1 sweep that closes old sign-in credentials (B13, run in stages), the `09` ledger reconciliation, and the backout files. The first-manager step is separate (OPEN-2, already has a candidate tool).

**Option A — A guarded production runner, modelled on the first-manager tool.**
- *What it is:* a new small program, like the staging runner but pointed at production. It would pin each approved file by its fingerprint (SHA-256) and refuse any file that has changed. Production address comes only from a hidden prompt (`PRODUCTION_DB_URL`). It must be told the exact target and an exact typed phrase per action. By default it only shows its plan; it runs only with `--execute`. Same shape as `pipeline/src/first-manager-runner.ts` on `e31dc29`.
- *Risk:* the runner itself is new code that touches production, so it needs its own review before the first use. A bug in it is a bug against the live database. Mitigation: plan-only default, per-file fingerprint, exact confirmations, stage support for L1.
- *Rollback:* the program changes nothing by itself. Each file's own backout (doc 17) is the rollback, and each backout goes through the same runner. A failed file runs inside one transaction and rolls back as a unit, for its SQL changes only (the one exception, ending database connections in `retire-terminate`, cannot be undone: see "Irreversible step" in the Route A section below) (M1-backout.sql has its own `begin`/`commit` at lines 11 and 550; whether each forward file is wrapped the same way is **not verified**: a text search of `M1_same_origin_signin.sql` found no `begin`/`commit` statements, only comments).
- *Evidence:* it prints fixed event names and counts, never the address or values, the way the first-manager runner does (`first-manager-runner.ts:44-51, 56-58`). Hunter can give the output file to the manager. The fingerprint list gives proof of exactly what ran.
- *Effort:* largest. Roughly: a new action table, file fingerprint list, stage splitting for L1, tests, a contract check script, and a review round. Estimate not verified; the first-manager tool is the closest size reference.

**Option B — Hunter (or Hunter with the operator watching) pastes each reviewed file into the Supabase SQL editor.**
- *What it is:* no new code. Hunter opens the production project's SQL editor and runs the file as written. This is the route doc 17 OPEN-1 already sketches.
- *Risk:* the only guard is human eyes. There is no target check beyond which project is open on screen, no fingerprint check on the pasted text, and a large file (M1 is 1,994 lines) is easy to paste partly. L1 must be pasted stage by stage by hand. Which database role the editor uses is **not verified** (doc 14 says "as `postgres`").
- *Rollback:* same as A: the backout files, pasted the same way. Any step that is not one transaction can half-apply if the paste breaks.
- *Evidence:* weakest. Hunter would copy numbers and a screenshot by hand. Nothing proves the pasted text equals the reviewed file, unless Hunter compares fingerprints by hand.
- *Effort:* none to build. Most work for Hunter at run time, and most chance of a typing/paste slip.

**Option C — "The Quote-Queue way."**
- *What QQ did (read only, QQ commit `4059789845a52e355b747371752744ffd790e135`):* production schema changes ran through its own migrate script, `scripts/migrate.ts`: files applied in name order, **one transaction per file** (`migrate.ts:290-298`), each file's SHA-256 recorded and re-checked on later runs so an edited file is refused (`migrate.ts:97-99, 278-285`), a database lock so two runs cannot overlap (`migrate.ts:95, 129`), history must be an unbroken prefix of the files on disk (`migrate.ts:255-263`). The script connects with `MIGRATE_DATABASE_URL`, falling back to a local address (`migrate.ts:110`). the homework tells Hunter to run it from their own PC with Render's connection string typed into the command (`docs/M0_HOMEWORK.md:103-106`; written instructions, not a transcript of what was run); after that, Render's Pre-Deploy Command runs `npm run migrate` before every deploy (`migrate.ts:74-76`, `docs/M0_HOMEWORK.md` and `retention.ts:170`). The one-off statement that gives a role a login was run by hand, as `ALTER ROLE qq_app LOGIN PASSWORD '<generated>'`, in `psql` or Render's SQL console (`M0_HOMEWORK.md:99-101, 113-115`; same form for `qq_maintenance` at `scripts/retention.ts:190`). QQ also had a helper that does that statement and prints the new connection string (`scripts/set-app-password.ts:45-71`), and a first-manager tool, `scripts/bootstrap-prod.ts` (`:88-111`).
- *Risk when copied here:* QQ's runner has **no production-vs-staging check at all**: it trusts whatever URL is in the variable (`migrate.ts:110`, `bootstrap-prod.ts:88`, same non-decision stated at `bootstrap-prod.ts:10-12`). The URL is typed on the command line, which is exactly the leak the hidden-prompt wrapper `scripts/run-with-secrets.mjs` was built to avoid. Auto-running at deploy cannot be used here: doc 17 needs one "go" per step, and this project has no Render pre-deploy for the Supabase database. QQ's pattern also puts the ledger in a table the script creates, while this project's ledger is Supabase's own (doc 09 is the reconciliation of it).
- *Rollback:* QQ's runner has no backout feature that I found; a failed file rolls back its own transaction (`migrate.ts:298-300`). Backouts here would still be separate files.
- *Evidence:* console lines and the stored checksum table. Good checksum evidence, no target evidence.
- *Effort:* medium (port the script), but it would still need the missing target guard bolted on, so it ends up as Option A with extra parts.

**Recommendation: Option A for the files, Option B only for the one statement that sets a database password.**
- Why A: it is the only option that proves *what* ran (fingerprint) and *where* it ran (target check), and it matches a pattern already built and reviewed for this project (hidden prompt, per-target typed phrase, plan-only default). QQ's checksum and one-transaction-per-file ideas are worth copying into it; QQ's missing target guard is not.
- Why B for the password statement: it is not a file and its value must never go through a runner's output. doc 17 already sends it to the SQL editor (doc 17 line 242), with the form borrowed from QQ and a reviewed paste box still owed.
- Fallback if Hunter does not want to wait for a build: B for the read-only steps (A1 counts, A3 snapshot) only, and hold every write step until A exists.
- Not recommended: C as is (no target guard; command-line URL; auto-deploy migration conflicts with one-go-at-a-time).

**Smallest piece that would prove A is feasible (described only, not built):** a contract check, like `scripts/verify-hardening-backout-contract.mjs`, that reads an action table and asserts three things: (1) every production file has a recorded SHA-256 (the repo already keeps one for migrations at `docs/build-plan/migration-checksums.sha256`); (2) the planning step refuses any target that is not the one recorded production project and refuses the staging address; (3) the default is plan-only. This would be a few dozen lines plus a test. It would run offline against no database. It is optional and is **not** part of this task.

---

### Summary of Previous Step

**Verified (read-only, done this task):**
- Found the QQ repo at `C:\Users\hunte\Projects\Quote-Queue` and confirmed the recorded commit exists there. Read files with `git show <commit>:<path>`; nothing checked out or changed.
- Read QQ `docs/M0_HOMEWORK.md`, `scripts/migrate.ts`, `scripts/bootstrap-prod.ts`, `scripts/set-app-password.ts` and `scripts/retention.ts` at that commit. Findings are in Option C with line numbers.
- Read this repo's staging runner (`pipeline/src/staging-sql-runner.ts:61-90`, production refused at lines 67-68; `staging-rebuilt.ts:183-184`) and the first-manager runner on `e31dc29` (read only, `git show`).
- Read doc 17 OPEN-1 and its uses of the "production SQL route".

**Not verified (attempts or gaps):**
- QQ's cutover **log** (what Hunter actually typed on the day) was not found as a single record. The route above is reconstructed from QQ's own written instructions (`M0_HOMEWORK.md`) and scripts, not from a transcript. `docs/PROJECT_LOG.md` entries 089 and 090 are cited by doc 15 for the Render deploy; they were not re-read in this task.
- I did not check whether a production database address for this project exists in Doppler, nor whether this PC can reach the production database on the session port. No network, no Doppler, no live system was touched.
- The Supabase SQL editor's role and paste limits are not verified.

**Not done on purpose:** no runner was built, no test scaffold was written, nothing was pushed or merged.

---

### Miscellaneous

- Sources: doc 17 (OPEN-1, A2, A3, B13, line 242); doc 14 §11; doc 16 §1.9; `pipeline/src/staging-sql-runner.ts`; `pipeline/src/staging-rebuilt.ts`; `pipeline/src/first-manager-runner.ts` and `first-manager-bootstrap.ts` @ `e31dc29`; `scripts/run-with-secrets.mjs` @ `e31dc29` (header); QQ @ `4059789845a52e355b747371752744ffd790e135`.
- No commands are invented. The only commands shown are quoted from QQ's own documents. Actual runner options for A would be defined when A is built.
- Open points for the manager: whether L1's "own stages" become separate runner actions; whether forward files M1/M1b/M1c should be wrapped in a transaction by the runner (unverified, see Option A); the `09` ledger reconciliation is marked "PROPOSAL ONLY — fresh Tier-3 owner decision" in its own header and still needs that decision regardless of route.

---

## Route A — BUILT, PENDING REVIEW AND HUNTER'S OPEN-1 CHOICE

**Status:** built locally on branch `bb/build-route-a-guarded-production-sql-runner-loca-thr_3d8aqs6pdj`; **not reviewed, not run against any hosted database, not approved.** It does not decide OPEN-1. If Hunter picks Route B or C it can sit unused: nothing else depends on it, and no file here is edited by it.

**What exists:** `pipeline/src/prod-sql.ts` (action table, planner, executor), `prod-sql-split.ts` (offline statement splitter and transaction-shape detector), `prod-sql-runner.ts` (command line, `npm run prod-sql` in `pipeline/`), the new `prod-sql.*` events and seven `prod_sql_*` refusal ids in `scripts/run-with-secrets.mjs`, tests `prod-sql.test.ts` (offline) and `prod-sql-a3.test.ts` (real PostgreSQL 16, loopback), and `scripts/verify-prod-sql-runner-contract.mjs` (wired into CI and `.github/ci/repository-safety.sh`).

**How it behaves (each point has a test):**
- One **action** per approved file or stage, 20 in all: the four July migrations (A2), `snapshot` (A3), `m1`, `m1b`, `m1c`, three L1 stages (`l1-shape`, `l1-counts`, `l1-sweep`), six `retire-app-credentials.sql` stages, and `backout-m1c`, `backout-m1b`, `backout-m1`. Each pins the file's SHA-256 (a stage also pins its own statements) and refuses on any mismatch; migrations must also agree with `migration-checksums.sha256`.
- **Production only:** `--target=production` has no default; the address must be the one recorded production project, on port 5432. Staging, local and anything else are refused.
- **The address** comes only through the hidden prompt of `scripts/run-with-secrets.mjs` (`--secret PRODUCTION_DB_URL`); a value already in the environment is refused.
- **One typed phrase per action** (`--confirm="RUN TNBS PRODUCTION SQL <ACTION>"`); **plan-only** unless `--execute`.
- **Transactions:** a file with no top-level `begin`/`commit` (M1, the migrations, `retire-nologin`) is wrapped in one transaction; a file with its own (M1b, M1c, the backouts, `l1-sweep`, `retire-revoke`) is run as written and never wrapped again; any other shape is refused. Read-only actions run in `begin read only` and are rolled back. Each write transaction also sets a 10-second lock wait so it cannot queue behind the live app indefinitely.
- **Output:** fixed events only (counts, enumerated words, the pinned file hash). Row-returning stages print numbers only: `snapshot` prints a SHA-256 of each result so before/after can be compared without printing rows; count stages print pinned column names with numbers.
- **L1 shape gate (doc 17 B13 stage 1):** `l1-shape` does not just hash the two schema listings. It judges them against the L1 file's own shape check and prints one `prod-sql.shape` event of fixed yes/no checks (`table_users`, `table_sessions`, `table_refresh_tokens`, `table_one_time_tokens`, `table_flow_state`, the six `users_<token column>` checks, `results_read`, `no_unreviewed_auth_tables`) plus two counts (auth tables found, auth tables not on the reviewed list). It never prints a table or column name from the database. Any failed check **stops the run** (`prod_sql_l1_shape_not_ok`). `l1-sweep` runs the same two selects first, inside its own transaction and before its first delete, and refuses on the same terms, so a sweep can never proceed on a shape the gate would refuse. The reviewed list is the five tables the file names plus `schema_migrations`; every other auth table counts as unreviewed until a person reviews it and a reviewed change adds it (the runner never deletes an unlisted table). **Expect this to stop on the hosted project** until the remaining standard Supabase auth tables have been reviewed and listed: that review is still owed and is not recorded here.
- **Stage coverage:** the stages of `L1-close-legacy-auth.sql` and `retire-app-credentials.sql` must tile their file exactly, from statement 1 through the last statement, with no gap and no overlap; a statement that no stage would run is refused at plan time, and `scripts/verify-prod-sql-runner-contract.mjs` recomputes every stage digest itself.
- **COMMIT rules (CR17):** a failed COMMIT is reported `unknown`, never retried, never rolled back; a COMMIT that returns the ROLLBACK tag is a definite failure.
- **Irreversible step: ending connections (`retire-terminate`).** This action runs `pg_terminate_backend` on every connection of the application role (doc 17 BO2 step 3). Ended connections **cannot be undone**: the rollback does not restore a connection that has already been ended, and the runner's `rolled_back`, `rollback_not_confirmed` and `unknown` results describe SQL changes only. "A failed file rolls back as a unit" (Option A above) is therefore true of SQL changes and **not** of this step. The runner warns in three places, all fixed text that the wrapper allow-lists (`prod-sql.warning`: a fixed id plus a fixed sentence, never database text):
  1. **With the plan, before anything connects**, for plan-only and `--execute` alike: `connections_end_cannot_be_undone`. The operator reads it before typing the owner's go.
  2. **After any run of that action that ends in an error** (`rolled_back`, `rollback_not_confirmed` or `unknown`): `rollback_does_not_restore_connections`, printed right after the result line.
  3. **In this section.** Doc 17 BO2 needs the same wording; the manager has the recommended text, and doc 17 is not edited on this branch.

  What the operator does after an error in this step: **STOP**, do not retry, and read the real connection count with the `retire-backends` action (a read-only count of the application role's connections). Keep the doc 17 BO2 rule: poll once a second, continue only after it reads 0 three times in a row, and if it has not read 0 three times in a row within 60 seconds, stop and escalate. The runner does not poll for the operator and never tries to reconnect ended sessions. `L1` has **no** termination statement: its irreversible effect is that the closed sign-in credentials have no backout (doc 17 B13), which is already recorded there. No extra typed phrase was added for this step beyond its own per-action phrase and the owner's go; if Hunter wants a second, distinct phrase for it, that is a separate decision. `scripts/verify-prod-sql-runner-contract.mjs` derives the set of irreversible actions from the pinned statements themselves (every action whose statements call `pg_terminate_backend`), so a new or changed action cannot skip the warning, and it fails if the warning, its wrapper allow-list entry or this paragraph is removed.

**Not runnable here (listed, not invented):** `supabase/backout/security-hardening-backout.sql` exists only on the cutover-prep branch; the profile-bootstrap and DNC-enum backouts have no file; `window-on`/`window-off` are inline statements in doc 16; the A1/BO3 read-only queries are not recorded; the `09` reconciliation is a proposal. Each is refused with `prod_sql_action_not_built`.

**Limits:** it never reads severity or message text of a database error, so an unexpected failure shows only a fixed id plus a SQLSTATE. The hosted half (Supabase's own roles and event triggers, TLS, the real login's privileges) is not covered by any local test. Whether the hosted runner login may run each file is **not verified**. Any change to a pinned file needs a new reviewed pin.
