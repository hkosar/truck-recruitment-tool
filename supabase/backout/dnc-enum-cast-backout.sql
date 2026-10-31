-- ============================================================================
-- DO NOT USE. DO NOT RUN THIS FILE. The Route A action for it is REFUSED (prod_sql_action_do_not_use) and is kept only as a historical record.
-- WHY: the restored body fails with SQLSTATE 42804 (column "activity_type" is of type activity_type but expression is of type text) for an authorized
-- editor setting OR clearing do-not-contact, and the whole call aborts. The forward migration exists to fix exactly this on PostgreSQL 17; production
-- is recorded as 17.6 (doc 11). Reproduced on local PostgreSQL 16 under SET LOCAL ROLE authenticated by the independent review of 2026-10-30 UTC.
-- RETAIN THE FORWARD FIX during any application backout: 20260723010400_dnc_activity_enum_cast.sql (a function repair; no table or data change to remove).
-- A replacement would be new SQL and needs its own separate review (see docs/build-plan/18-production-sql-route-options.md); none is written here.
-- ============================================================================
-- dnc-enum-cast-backout.sql -- DRAFT, PENDING REVIEW. NOT EXECUTED ANYWHERE.
-- Serves doc 17 (sign-in cutover runbook, cited at commits 301418b and f1189dc), step A2 "Backouts": "DNC enum cast -> previous body
-- (no file prepared)" and the Route A action dnc-enum-cast-backout (phrase RUN TNBS PRODUCTION SQL DNC-ENUM-CAST-BACKOUT).
-- It backs out exactly ONE migration:
--   supabase/migrations/20260723010400_dnc_activity_enum_cast.sql   (Route A action migration-dnc-activity-enum-cast)
--
-- WHAT THE MIGRATION CREATES OR CHANGES (the whole list):
--   1. Replaces the body of public.set_do_not_contact(bigint, boolean, text). The one change in the body is that the CASE expression
--      feeding batch_activity.activity_type is cast: (case ... end)::activity_type. Its search_path is public, internal, pg_temp.
--   2. Its trailing revoke/grant statements: revoke execute from public, anon; grant execute to authenticated, service_role.
-- WHAT THIS FILE REVERSES:
--   * (1) only: it puts back the body from 20260720001100_rpc.sql lines 530-577 (the earlier definition), with the search_path pin
--     public, internal, pg_temp that the hardening migration (20260722223300) applied, so the catalogue returns to the state AFTER
--     hardening and BEFORE this migration.
--   * (2) is NOT reversed, on purpose: after hardening those statements are no-ops (hardening removed PUBLIC and anon and granted
--     authenticated and service_role execute on exactly this function). CREATE OR REPLACE keeps the existing grants.
--
-- RUN ORDER: reverse of A2 (contact-logs guard, then this file, then profile-bootstrap-backout, security-hardening-backout last).
-- If M1 was applied, run the M1 backouts FIRST: M1 redefines set_do_not_contact, and M1-backout.sql restores the body of the migration
-- this file undoes (M1-backout.sql line 255). This file then takes it one step further back.
--
-- DATA: NO DATA IS DESTROYED. It changes one function body and nothing else: no table, no row, no grant, no trigger, no enum.
-- BEHAVIOUR YOU LOSE (historical; the action is refused, so none of this can happen through the runner): the migration header says the earlier body fails on PostgreSQL 17 ("column activity_type
-- is of type activity_type but expression is text") when an authorized editor sets or clears do-not-contact: the final insert aborts
-- the whole call. Restoring the earlier body brings that failure back on any server that behaves that way. It was REPRODUCED on a local
-- PostgreSQL 16 throwaway database (pipeline/src/prod-sql-a2-backouts-a3.test.ts prints it). Whether the hosted production server
-- does too is not verified.
--
-- SAFE TO REPEAT: yes. CREATE OR REPLACE with the same text changes nothing; the checks below run each time.
-- ONE TRANSACTION: it has its own begin ... commit, so the runner runs it as written. If a check fails, nothing is kept.
-- ============================================================================
begin;

-- Precondition: the function exists with this signature (it comes from 20260720001100). Otherwise stop.
do $check$
begin
  if to_regprocedure('public.set_do_not_contact(bigint,boolean,text)') is null then
    raise exception 'public.set_do_not_contact(bigint, boolean, text) does not exist; refusing';
  end if;
end
$check$;

-- The body of 20260720001100_rpc.sql lines 530-577, unchanged; only the search_path is the hardened value public, internal, pg_temp.
create or replace function public.set_do_not_contact(
  p_dot    bigint,
  p_on     boolean,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public, internal, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if not coalesce(internal.can_edit(), false) then
    raise exception 'insufficient privilege to change do-not-contact';
  end if;
  if not exists (select 1 from public.carriers where dot_number = p_dot) then
    raise exception 'carrier % not found', p_dot;
  end if;

  update public.carriers
     set do_not_contact = p_on,
         dnc_reason = case when p_on then p_reason else null end,
         dnc_set_by = case when p_on then v_uid else null end,
         dnc_set_at = case when p_on then now() else null end
   where dot_number = p_dot;

  if p_on then
    insert into public.contact_suppressions (dot_number, channel, reason, source, created_by)
    values (p_dot, 'all', p_reason, 'manual', v_uid)
    on conflict (dot_number, channel) where value is null
    do update set reason = excluded.reason, created_by = excluded.created_by,
                   created_at = now(), expires_at = null;
  else
    update public.contact_suppressions
       set expires_at = now()
     where dot_number = p_dot and channel = 'all' and value is null
       and (expires_at is null or expires_at > now());
  end if;

  -- logs into EVERY batch currently containing the carrier (locked rule, F11/G7)
  insert into public.batch_activity (batch_id, actor_id, activity_type, payload)
  select bc.batch_id, v_uid, case when p_on then 'dnc_set' else 'dnc_cleared' end,
         jsonb_build_object('dot_number', p_dot, 'reason', p_reason)
  from public.batch_carriers bc
  where bc.dot_number = p_dot;
end;
$$;

-- Postcondition: the restored body has no activity_type cast (the migration's one change is gone). Otherwise nothing is kept.
do $check$
declare
  v_src text;
begin
  select p.prosrc into v_src from pg_proc p where p.oid = 'public.set_do_not_contact(bigint,boolean,text)'::regprocedure;
  if v_src is null or v_src like '%::activity_type%' or v_src not like '%dnc_cleared%' then
    raise exception 'the restored set_do_not_contact body is not the expected one; rolling back';
  end if;
end
$check$;

commit;
