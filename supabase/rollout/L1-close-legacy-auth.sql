-- ============================================================================
-- L1-close-legacy-auth.sql -- doc 14 §11.6. NOT EXECUTED. A separately owner-approved rollout
-- step (staging first, then production), run by the operator as postgres, AFTER O2 (Supabase
-- signups and every Auth provider turned off, confirmed by the issuance probes).
--
-- Changes NO password, ban state, email, profile or other auth.users column: only outstanding
-- sessions, refresh tokens, one-time tokens, PKCE flow state, and the six verification-token
-- columns of auth.users are cleared. Counts only are recorded; never print tokens or ids.
-- The wait W comes from the HOSTED settings read in step 0 (not from supabase/config.toml).
-- ============================================================================

-- STEP 2 (read-only shape check): the tables and columns this script expects. Stop if any is
-- missing, and review any other credential-bearing auth.* table before continuing.
select table_name, column_name
from information_schema.columns
where table_schema = 'auth'
  and (table_name in ('sessions', 'refresh_tokens', 'one_time_tokens', 'flow_state')
       or (table_name = 'users' and column_name in ('confirmation_token', 'recovery_token',
           'email_change_token_new', 'email_change_token_current', 'phone_change_token',
           'reauthentication_token')))
order by 1, 2;

select table_name from information_schema.tables where table_schema = 'auth' order by 1;

-- Counts before (numbers only).
select
  (select count(*) from auth.sessions) as sessions,
  (select count(*) from auth.refresh_tokens) as refresh_tokens,
  (select count(*) from auth.one_time_tokens) as one_time_tokens,
  (select count(*) from auth.flow_state) as flow_state,
  (select count(*) from auth.users
    where coalesce(confirmation_token, '') <> '' or coalesce(recovery_token, '') <> ''
       or coalesce(email_change_token_new, '') <> '' or coalesce(email_change_token_current, '') <> ''
       or coalesce(phone_change_token, '') <> '' or coalesce(reauthentication_token, '') <> '') as users_with_tokens;

-- STEP 3: one transaction.
begin;
delete from auth.refresh_tokens;
delete from auth.sessions;
delete from auth.one_time_tokens;
delete from auth.flow_state;
update auth.users
   set confirmation_token = '', recovery_token = '', email_change_token_new = '',
       email_change_token_current = '', phone_change_token = '', reauthentication_token = ''
 where coalesce(confirmation_token, '') <> '' or coalesce(recovery_token, '') <> ''
    or coalesce(email_change_token_new, '') <> '' or coalesce(email_change_token_current, '') <> ''
    or coalesce(phone_change_token, '') <> '' or coalesce(reauthentication_token, '') <> '';
commit;

-- STEP 4: re-count (the "counts before" query above); every number must be 0.
-- STEP 5: wait W. STEP 6: run STEP 3 again and expect zero rows changed.
-- STEP 7: the doc 14 §8.1 class-B probes. STEP 8: the counts query daily during the window.
