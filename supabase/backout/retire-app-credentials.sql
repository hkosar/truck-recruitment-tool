-- ============================================================================
-- retire-app-credentials.sql -- doc 14 §11.5 / doc 15 §14.2 review round 4. NOT EXECUTED.
--
-- An ORDERED OPERATOR PROCEDURE, not one transaction. Run each step separately, in order, as
-- the migration/operator role, with the owner's "go". Never paste values into chat or logs.
--
-- STEP 1 (outside SQL, before this file): stop the pool. Turn the server's maintenance flag on
-- (that code path opens no database connection), then suspend the web service or replace its
-- database password setting with a throwaway value so the pool cannot reconnect.
-- ============================================================================

-- STEP 2: commit NOLOGIN on its own (autocommit). From this moment every NEW login fails.
alter role recruiter_app nologin password null;

-- STEP 3: terminate existing connections, then confirm they are gone.
-- pg_terminate_backend(pid, timeout_ms) waits up to the timeout (PostgreSQL 14+).
select pid, pg_terminate_backend(pid, 5000) as terminated
from pg_stat_activity
where usename = 'recruiter_app';

-- Poll once a second; continue only after this reads 0 three times in a row.
-- More than 60 seconds without that: STOP and escalate; do not continue the backout.
select count(*) as recruiter_app_backends
from pg_stat_activity
where usename = 'recruiter_app';

-- STEP 4: only then revoke every live app credential, so a later re-apply of M1 resurrects
-- nothing. One transaction.
begin;
update internal.app_sessions
   set revoked_at = now(), revoked_reason = 'backout'
 where revoked_at is null;
update internal.signin_links
   set revoked_at = now(), revoked_reason = 'backout'
 where used_at is null and revoked_at is null;
update internal.recovery_sets
   set revoked_at = now(), revoked_reason = 'backout'
 where revoked_at is null;
update internal.recovery_codes
   set revoked_at = now(), revoked_reason = 'backout'
 where used_at is null and revoked_at is null;
insert into internal.auth_events (kind, detail) values ('backout_credentials_retired', '{}'::jsonb);
commit;

-- STEP 5: checks (all must read 0).
select
  (select count(*) from pg_stat_activity where usename = 'recruiter_app') as backends,
  (select count(*) from internal.app_sessions where revoked_at is null) as live_sessions,
  (select count(*) from internal.signin_links where used_at is null and revoked_at is null) as live_links,
  (select count(*) from internal.recovery_codes where used_at is null and revoked_at is null) as live_codes;

-- STEP 6: email/identity alignment for every approved profile (expected 0 mismatches).
select count(*) as email_mismatches
from public.profiles p
join auth.users u on u.id = p.id
where p.status = 'approved' and lower(p.email) <> lower(u.email);

-- Then: supabase/backout/M1-backout.sql (doc 14 §11.5 step 4 onward).
