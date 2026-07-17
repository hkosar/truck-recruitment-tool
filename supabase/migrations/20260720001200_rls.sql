-- ============================================================================
-- 20260720001200_rls.sql -- enable RLS + all policies + grants
-- Spec: docs/build-plan/01-architecture.md Part A §6, extended to the tables
-- amendment #7 added (carrier_insurance_filings, carrier_qc_snapshots) using
-- the same "satellites: read for staff" pattern §6 states in prose for the
-- existing satellites, and to cargo_other_values' curation-column grant and
-- contact_suppressions' policies, both given only as prose in §6, not SQL.
--
-- Grant philosophy (own engineering judgment -- see manifest): Supabase
-- projects normally rely on platform-level default privileges (ALTER DEFAULT
-- PRIVILEGES ... TO anon, authenticated, service_role) so table GRANTs are
-- rarely written by hand and RLS alone gates tables -- that part needs no
-- action here beyond the policies themselves. FUNCTIONS are different:
-- plain PostgreSQL grants EXECUTE to PUBLIC by default on every new function,
-- which is broader than intended for a schema (`internal`) whose whole point
-- is "not exposed". Rather than depend on whichever default happens to be in
-- effect on a given project, this migration is fully explicit: revoke
-- EXECUTE from PUBLIC everywhere, then grant it back deliberately --
-- blanket for public.* (every RPC, present and future, is meant to be
-- reachable by any authenticated user; RLS on the underlying tables is the
-- real gate) and function-by-function for the internal.* helpers that
-- SECURITY INVOKER public RPCs call into (current_app_role/is_staff/
-- can_edit/is_manager per Part A's own text, plus matching_carriers,
-- zone_geom, zone_radius_m, warning_reasons, batch_members_ordered,
-- is_contactable -- all referenced from SECURITY INVOKER function bodies
-- created in earlier migrations). The four internal.* TRIGGER functions
-- (handle_new_user, guard_profile_update, log_bc_change, log_bc_delete) are
-- deliberately left ungranted -- besides not needing direct callability,
-- Postgres refuses to invoke a trigger function outside trigger context
-- regardless of EXECUTE grants, so this is redundant-but-cheap defense in
-- depth, not a functional requirement.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Helper functions (§6) -- SECURITY DEFINER on current_app_role breaks the
-- profiles-RLS recursion (profiles_select -> is_staff -> current_app_role ->
-- select from profiles, which would otherwise re-trigger profiles_select).
-- NULL for anon, pending guests, and disabled users -> default-deny
-- everywhere = the guest landing gate (brief §7).
-- ----------------------------------------------------------------------------
create function internal.current_app_role() returns user_role
language sql stable security definer set search_path = public as
$$ select role from public.profiles where id = auth.uid() and status = 'approved' $$;

create function internal.is_staff() returns boolean language sql stable as
$$ select internal.current_app_role() in ('manager','edit','view') $$;
create function internal.can_edit() returns boolean language sql stable as
$$ select internal.current_app_role() in ('manager','edit') $$;
create function internal.is_manager() returns boolean language sql stable as
$$ select internal.current_app_role() = 'manager' $$;

-- ----------------------------------------------------------------------------
-- Enable RLS on every public table (service_role bypasses RLS -- it is the
-- only writer of sync-owned columns per D9).
-- ----------------------------------------------------------------------------
alter table public.profiles                 enable row level security;
alter table public.carriers                 enable row level security;
alter table public.carrier_insurance        enable row level security;
alter table public.carrier_insurance_filings enable row level security;
alter table public.carrier_safety           enable row level security;
alter table public.carrier_inspections      enable row level security;
alter table public.carrier_qc_snapshots     enable row level security;
alter table public.sync_runs                enable row level security;
alter table public.cargo_other_values       enable row level security;
alter table public.batches                  enable row level security;
alter table public.batch_zones              enable row level security;
alter table public.batch_carriers           enable row level security;
alter table public.contact_logs             enable row level security;
alter table public.contact_suppressions     enable row level security;
alter table public.batch_activity           enable row level security;

-- ----------------------------------------------------------------------------
-- profiles: own row always (pending guest sees own pending state); staff see
-- all (names in feeds); manager updates anyone (approval, F1); self-update
-- guarded by the §2.3 trigger.
-- ----------------------------------------------------------------------------
create policy profiles_select on public.profiles for select
  using (id = auth.uid() or internal.is_staff());
create policy profiles_update_self on public.profiles for update
  using (id = auth.uid()) with check (id = auth.uid());
create policy profiles_update_mgr on public.profiles for update
  using (internal.is_manager()) with check (internal.is_manager());
-- No INSERT/DELETE policy: rows are created only by internal.handle_new_user
-- (SECURITY DEFINER trigger on auth.users); accounts are disabled, never deleted.

-- ----------------------------------------------------------------------------
-- carriers + satellites + cargo_other_values + sync_runs: read for staff;
-- guests see nothing. carriers UPDATE: row policy for editors + COLUMN
-- grants restrict to app-owned columns (D9).
-- ----------------------------------------------------------------------------
create policy carriers_select on public.carriers for select using (internal.is_staff());
create policy carriers_update on public.carriers for update
  using (internal.can_edit()) with check (internal.can_edit());
revoke update on public.carriers from authenticated;
grant  update (do_not_contact, dnc_reason, dnc_set_by, dnc_set_at,
               contact_name_override, contact_phone_override, contact_email_override)
  on public.carriers to authenticated;           -- everything else is service_role-only

create policy carrier_insurance_select         on public.carrier_insurance          for select using (internal.is_staff());
create policy carrier_insurance_filings_select on public.carrier_insurance_filings  for select using (internal.is_staff());
create policy carrier_safety_select            on public.carrier_safety            for select using (internal.is_staff());
create policy carrier_inspections_select       on public.carrier_inspections       for select using (internal.is_staff());
create policy carrier_qc_snapshots_select      on public.carrier_qc_snapshots      for select using (internal.is_staff());
create policy sync_runs_select                 on public.sync_runs                 for select using (internal.is_staff());

create policy cov_select on public.cargo_other_values for select using (internal.is_staff());
-- curation columns UPDATE-grantable to manager only (match_group, is_sand_gravel);
-- everything else (counts, sample_raw, seen_at) is sync/service_role-only.
create policy cov_update_mgr on public.cargo_other_values for update
  using (internal.is_manager()) with check (internal.is_manager());
revoke update on public.cargo_other_values from authenticated;
grant  update (match_group, is_sand_gravel) on public.cargo_other_values to authenticated;

-- ----------------------------------------------------------------------------
-- batches / batch_zones: read staff; write editors; delete manager.
-- ----------------------------------------------------------------------------
create policy batches_select on public.batches for select using (internal.is_staff());
create policy batches_write  on public.batches for insert with check (internal.can_edit() and created_by = auth.uid());
create policy batches_update on public.batches for update using (internal.can_edit());
create policy batches_delete on public.batches for delete using (internal.is_manager());

-- batch_zones: same pattern keyed through internal.can_edit(); delete for can_edit (lane management).
create policy zones_select on public.batch_zones for select using (internal.is_staff());
create policy zones_write  on public.batch_zones for insert with check (internal.can_edit());
create policy zones_update on public.batch_zones for update using (internal.can_edit());
create policy zones_delete on public.batch_zones for delete using (internal.can_edit());

-- ----------------------------------------------------------------------------
-- batch_carriers: read staff; insert/update editors; delete manager (removal
-- is exceptional).
-- ----------------------------------------------------------------------------
create policy bc_select on public.batch_carriers for select using (internal.is_staff());
create policy bc_insert on public.batch_carriers for insert with check (internal.can_edit());
create policy bc_update on public.batch_carriers for update using (internal.can_edit());
create policy bc_delete on public.batch_carriers for delete using (internal.is_manager());

-- ----------------------------------------------------------------------------
-- contact_logs: immutable ledger. Read staff; insert editors AS THEMSELVES;
-- no update; manager delete.
-- ----------------------------------------------------------------------------
create policy logs_select on public.contact_logs for select using (internal.is_staff());
create policy logs_insert on public.contact_logs for insert
  with check (internal.can_edit() and user_id = auth.uid());
create policy logs_delete on public.contact_logs for delete using (internal.is_manager());

-- ----------------------------------------------------------------------------
-- batch_activity: read staff; direct INSERT is comments-only, as yourself
-- (auto rows come from SECURITY DEFINER triggers/RPCs); no update; manager
-- delete.
-- ----------------------------------------------------------------------------
create policy act_select on public.batch_activity for select using (internal.is_staff());
create policy act_comment on public.batch_activity for insert
  with check (internal.can_edit() and activity_type = 'comment' and actor_id = auth.uid());
create policy act_delete on public.batch_activity for delete using (internal.is_manager());

-- ----------------------------------------------------------------------------
-- contact_suppressions: read staff; insert editors; delete manager (expiring
-- preferred over deleting -- set_do_not_contact does this via SECURITY
-- DEFINER, which is why no UPDATE policy is needed here for that path).
-- ----------------------------------------------------------------------------
create policy suppress_select on public.contact_suppressions for select using (internal.is_staff());
create policy suppress_insert on public.contact_suppressions for insert with check (internal.can_edit());
create policy suppress_delete on public.contact_suppressions for delete using (internal.is_manager());

-- ----------------------------------------------------------------------------
-- Views: security_invoker=true means the view runs as the calling role and
-- respects the base-table RLS above, but the view RELATION itself still
-- needs a plain SELECT grant (views are not auto-granted).
-- ----------------------------------------------------------------------------
grant select on public.carrier_warnings  to authenticated;
grant select on public.batch_dashboard   to authenticated;

-- ----------------------------------------------------------------------------
-- Function execute grants (see file header for the philosophy).
-- ----------------------------------------------------------------------------
revoke execute on all functions in schema public   from public;
revoke execute on all functions in schema internal from public;

grant usage on schema internal to authenticated;

grant execute on all functions in schema public to authenticated;

grant execute on function
  internal.current_app_role(),
  internal.is_staff(),
  internal.can_edit(),
  internal.is_manager(),
  internal.matching_carriers(jsonb),
  internal.zone_geom(jsonb),
  internal.zone_radius_m(jsonb),
  internal.warning_reasons(text, bigint, boolean, boolean, text, numeric, numeric, int, date, date),
  internal.batch_members_ordered(uuid, batch_carrier_status[], text, boolean, bigint, int, int, boolean, boolean, text, text),
  internal.is_contactable(bigint, contact_channel)
  to authenticated;

-- ----------------------------------------------------------------------------
-- Net role behavior (§6, verbatim): guest/pending/disabled -> every query
-- empty or 403 -> frontend shows the generic pending page (brief §7). view ->
-- all reads, zero writes (all write policies require can_edit). edit -> full
-- workflow except deletes/approval. manager -> everything incl. Users screen
-- (F1), curation, deletes. RPCs are SECURITY INVOKER (except the five §5.4
-- VOLATILE ones, which re-implement the equivalent check internally because
-- SECURITY DEFINER bypasses RLS for their own writes -- see 20260720001100_rpc.sql
-- header), so this one matrix governs them too; the only definer code paths
-- are the audited helpers/triggers/§5.4 RPCs above.
-- ----------------------------------------------------------------------------
