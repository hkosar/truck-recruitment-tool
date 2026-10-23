-- ============================================================================
-- M1b-backout.sql -- undoes supabase/pending/M1b_add_person.sql. NOT EXECUTED anywhere.
-- Order: after retire-app-credentials.sql and BEFORE M1-backout.sql (doc 15 §32). One
-- transaction. Deletes no data:
--   * people added under M1b keep their profiles rows; the foreign key comes back NOT VALID, so
--     those rows are not checked (they have no old sign-in account and cannot use the old app);
--     every NEW row is checked again, exactly as before M1b;
--   * internal.staff_mobile_unverified stays, unreachable (data preserved).
-- ============================================================================
begin;

drop function if exists public.team_add_person(text, text, user_role, text);
alter table public.profiles alter column id drop default;
alter table public.profiles
  add constraint profiles_id_fkey foreign key (id) references auth.users(id) on delete cascade not valid;

commit;
