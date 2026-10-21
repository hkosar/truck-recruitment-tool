# A3 database tests (written, NOT run)

These run only in the approved throwaway PostgreSQL cluster (approval A3: loopback, port 55432,
data under the sign-in owner's thread storage, deleted afterwards). They need a Supabase shim
(roles `anon`, `authenticated`, `service_role`; schema `auth` with `users` and the `uid()`,
`role()` and `jwt()` functions) plus the migrations without PostGIS, then
`supabase/pending/M1_same_origin_signin.sql`. Never run them against staging or production.

| File | What it proves | How to run |
|---|---|---|
| `fixtures.sql` | One editor with a link session that expires in a few seconds; one batch with one member; one link with one email event | `psql -v ON_ERROR_STOP=1 -f fixtures.sql` as the migration role |
| `recheck_expiry_b.sql` then `recheck_expiry_a.sql` | **T-AUTHZ "session expires during a business-lock wait":** B holds the batch row `FOR UPDATE` past the session's expiry; A's `bulk_set_status` waits on the batch lock and must then fail in `recheck_session()` (`session expired while waiting`), with the member's status unchanged. A `now()`-based recheck would wrongly pass, because `now()` is frozen at A's transaction start | start B in one terminal; within 2 s start A (as `recruiter_app`) in another; B commits after 6 s |
| `retention_fk.sql` | **Retention vs the event→link foreign key:** deleting an aged link succeeds while its email event remains; the event keeps `recipient_email` and `provider_message_id` and its `link_id` becomes null; the event is only deleted at 180 days | `psql -v ON_ERROR_STOP=1 -f retention_fk.sql` as `recruiter_maintenance` (after `fixtures.sql`) |

Each script ends with assertions that `raise exception` on failure.
