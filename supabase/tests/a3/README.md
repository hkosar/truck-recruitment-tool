# A3 database tests (local throwaway cluster only)

These run only in the approved throwaway PostgreSQL cluster (approval A3): loopback only, on a
port checked free beforehand (**never 55432**, which another process holds and must not be
stopped), in a new task-owned directory under the sign-in owner's thread storage that is
refused if it already exists, stopped with `pg_ctl -D <owned data dir> stop -m fast` and
deleted afterwards. PIDs, parent PID, start time, port and directory are recorded in the
owner's `a3-ownership.md`. Log retention: record second-level UTC times for "stop requested"
and "stop confirmed", copy the `postgres.log` tail (redacted) AFTER the stop so the shutdown
lines are kept, and only then delete the directory. Build the database with

    A3_PGPASSWORD=... node scripts/a3-build-test-db.mjs --owner-dir <task dir> --port <port> --db tr_signin_test
    A3_PGPASSWORD=... node scripts/a3-build-test-db.mjs --owner-dir <task dir> --port <port> --db tr_signin_test --run <id>

The first builds the base database (used by the SQL scripts here and the role matrix). The
second builds one database per DB-using vitest suite for ONE run (`tr_signin_test_<id>_store`,
`_readiness`, `_e2e`); `--drop-run <id>` drops them. Every concurrent test process needs its own
run id in `A3_RUN_ID`; the suites take their URLs only from `app/server/testing/test-db.ts`, refuse
to start without a valid run id, and claim their database exclusively (advisory lock) for the whole
suite, so a second process on the same database fails loudly instead of interleaving
(`test-db.test.ts` enforces this). Measured: three concurrent copies of the store suite on one
shared database produced 19 failures (2026-10-22 load run); see doc 15 §31.

The builder refuses unless `<task dir>/A3_TASK_OWNED` holds the task's token, the server on
`<port>` reports `<task dir>/data` as its data directory, and any existing database carries
the matching ownership comment (it never uses `DROP … FORCE`). They need a Supabase shim
(roles `anon`, `authenticated`, `service_role`; schema `auth` with `users` and the `uid()`,
`role()` and `jwt()` functions) plus the migrations without PostGIS, then
`supabase/pending/M1_same_origin_signin.sql`. Never run them against staging or production.

| File | What it proves | How to run |
|---|---|---|
| `fixtures.sql` | One editor with a link session that expires in a few seconds; one batch with one member; one link with one email event | `psql -v ON_ERROR_STOP=1 -f fixtures.sql` as the migration role |
| `recheck_expiry_b.sql` then `recheck_expiry_a.sql` | **T-AUTHZ "session expires during a business-lock wait":** B holds the batch row `FOR UPDATE` past the session's expiry; A's `bulk_set_status` waits on the batch lock and must then fail in `recheck_session()` (`session expired while waiting`), with the member's status unchanged. A `now()`-based recheck would wrongly pass, because `now()` is frozen at A's transaction start | start B in one terminal; within 2 s start A (as `recruiter_app`) in another; B commits after 6 s |
| `retention_fk.sql` | **Retention vs the event→link foreign key:** deleting an aged link succeeds while its email event remains; the event keeps `recipient_email` and `provider_message_id` and its `link_id` becomes null; the event is only deleted at 180 days | `psql -v ON_ERROR_STOP=1 -f retention_fk.sql` as `recruiter_maintenance` (after `fixtures.sql`) |

Each script ends with assertions that `raise exception` on failure.
