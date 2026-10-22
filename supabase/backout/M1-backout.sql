-- ============================================================================
-- M1-backout.sql -- restores the pre-M1 permission surface. GENERATED from the migrations
-- by copying definitions verbatim (see each section's source lines); verified offline by
-- scripts/verify-auth-migration-contract.mjs. NOT EXECUTED ANYWHERE.
--
-- Run ONLY as step 4 of doc 14 §11.5, AFTER supabase/backout/retire-app-credentials.sql
-- (pool stopped, NOLOGIN committed, recruiter connections terminated and confirmed gone,
-- app sessions/links/codes revoked). One transaction. Deletes no ledger table and no data:
-- the internal.* sign-in tables stay, inert, for audit.
-- ============================================================================
begin;

-- ---- drop M1-only triggers and functions
drop trigger if exists profiles_revoke_on_identity_change on public.profiles;
drop trigger if exists profiles_email_edit_pause on public.profiles;
drop trigger if exists batches_attribution_immutable on public.batches;
drop trigger if exists batch_carriers_insert_clean on public.batch_carriers;
drop trigger if exists batches_recheck_session on public.batches;
drop trigger if exists batch_zones_recheck_session on public.batch_zones;
drop trigger if exists batch_carriers_recheck_session on public.batch_carriers;
drop trigger if exists batch_activity_recheck_session on public.batch_activity;
drop trigger if exists contact_logs_recheck_session on public.contact_logs;
drop trigger if exists carriers_recheck_session on public.carriers;
drop trigger if exists cargo_other_values_recheck_session on public.cargo_other_values;
drop trigger if exists contact_suppressions_recheck_session on public.contact_suppressions;
drop function if exists internal.recheck_session_on_write();
drop function if exists public.team_list();
drop function if exists public.team_update(uuid, text, user_role, text);
drop function if exists public.team_set_active(uuid, boolean);
drop function if exists public.team_block_clear(text);
drop function if exists public.team_recovery_revoke(uuid);
drop function if exists public.team_sign_everyone_out();
drop function if exists public.recovery_enroll(text[]);
drop function if exists public.recovery_batches();
drop function if exists public.recovery_batch_members(uuid, int, int);
drop function if exists public.recovery_set_status(uuid, bigint, batch_carrier_status);

-- ---- internal.current_app_role (20260720001200_rls.sql:41-43)
create or replace function internal.current_app_role() returns user_role
language sql stable security definer set search_path = public as
$$ select role from public.profiles where id = auth.uid() and status = 'approved' $$;

-- ---- internal.log_bc_change (20260720000800_activity.sql:20-36)
create or replace function internal.log_bc_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if current_setting('app.suppress_row_activity', true) = 'on' then return new; end if;  -- bulk ops log once
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    new.status_changed_by := auth.uid();  new.status_changed_at := now();
    insert into public.batch_activity (batch_id, actor_id, activity_type, payload)
    values (new.batch_id, auth.uid(), 'status_change',
            jsonb_build_object('dot_number', new.dot_number, 'from', old.status, 'to', new.status));
  end if;
  if tg_op = 'UPDATE' and new.promoted_at is not null and old.promoted_at is null then
    new.promoted_by := auth.uid();
    insert into public.batch_activity (batch_id, actor_id, activity_type, payload)
    values (new.batch_id, auth.uid(), 'promoted', jsonb_build_object('dot_number', new.dot_number));  -- F23
  end if;
  return new;
end $$;

-- ---- internal.log_bc_delete (20260720000800_activity.sql:40-46)
create or replace function internal.log_bc_delete() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.batch_activity (batch_id, actor_id, activity_type, payload)
  values (old.batch_id, auth.uid(), 'carrier_removed', jsonb_build_object('dot_number', old.dot_number));
  return old;
end $$;

-- ---- public.create_batch (20260720001100_rpc.sql:374-430)
create or replace function public.create_batch(
  p_name        text,
  p_customer    text,
  p_job         text,
  p_description text,
  p_definition  jsonb
)
returns table (batch_id uuid, member_count int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch_id uuid;
  v_zone     jsonb;
  v_ord      bigint;
  v_count    int;
begin
  if not coalesce(internal.can_edit(), false) then
    raise exception 'insufficient privilege to create a batch';
  end if;
  if p_name is null or btrim(p_name) = '' then
    raise exception 'batch name is required';
  end if;

  insert into public.batches (name, customer, job, description, created_by, search_definition, snapshot_taken_at)
  values (p_name, p_customer, p_job, p_description, auth.uid(), coalesce(p_definition,'{}'::jsonb) - 'zones', now())
  returning id into v_batch_id;

  for v_zone, v_ord in
    select z, ord from jsonb_array_elements(coalesce(p_definition->'zones','[]'::jsonb)) with ordinality as t(z, ord)
  loop
    insert into public.batch_zones (batch_id, zone_type, label, params, geom, distance_miles, sort_order)
    values (
      v_batch_id,
      (v_zone->>'zone_type')::zone_type,
      coalesce(v_zone->>'label', 'Lane ' || v_ord::text),
      coalesce(v_zone->'params', '{}'::jsonb),
      internal.zone_geom(v_zone),
      coalesce((v_zone->'params'->>'radius_miles')::numeric, (v_zone->'params'->>'buffer_miles')::numeric),
      coalesce((v_zone->>'sort_order')::int, (v_ord - 1)::int)
    );
  end loop;

  insert into public.batch_carriers (batch_id, dot_number, status, added_via_refresh)
  select v_batch_id, mc.dot_number, 'new', false
  from internal.matching_carriers(p_definition) mc;
  get diagnostics v_count = row_count;

  insert into public.batch_activity (batch_id, actor_id, activity_type, payload)
  values (v_batch_id, auth.uid(), 'batch_created', jsonb_build_object('name', p_name));
  insert into public.batch_activity (batch_id, actor_id, activity_type, payload)
  values (v_batch_id, auth.uid(), 'members_added', jsonb_build_object('count', v_count));

  return query select v_batch_id, v_count;
end;
$$;

-- ---- public.refresh_batch (20260720001100_rpc.sql:432-489)
create or replace function public.refresh_batch(p_batch_id uuid)
returns table (added_count int, added_dots bigint[])
language plpgsql
security definer
set search_path = public
as $$
declare
  v_def         jsonb;
  v_zones       jsonb;
  v_added_dots  bigint[];
  v_added_count int;
begin
  if not coalesce(internal.can_edit(), false) then
    raise exception 'insufficient privilege to refresh a batch';
  end if;

  select b.search_definition into v_def from public.batches b where b.id = p_batch_id;
  if not found then
    raise exception 'batch % not found', p_batch_id;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'zone_type', z.zone_type, 'label', z.label, 'params', z.params
         ) order by z.sort_order), '[]'::jsonb)
    into v_zones
  from public.batch_zones z
  where z.batch_id = p_batch_id;

  v_def := v_def || jsonb_build_object('zones', v_zones);

  -- one 'refresh' activity row instead of N (D7); no per-row status_change rows
  -- get written either way since these are plain INSERTs (trg_bc_change only
  -- fires on UPDATE), the flag is set anyway per Part A's explicit instruction.
  perform set_config('app.suppress_row_activity', 'on', true);

  with ins as (
    insert into public.batch_carriers (batch_id, dot_number, status, added_via_refresh)
    select p_batch_id, mc.dot_number, 'new', true
    from internal.matching_carriers(v_def) mc
    on conflict (batch_id, dot_number) do nothing
    returning dot_number
  )
  select coalesce(array_agg(dot_number), '{}'), count(*)::int
    into v_added_dots, v_added_count
  from ins;

  perform set_config('app.suppress_row_activity', 'off', true);

  update public.batches
     set last_refreshed_at = now(), refresh_count = refresh_count + 1
   where id = p_batch_id;

  insert into public.batch_activity (batch_id, actor_id, activity_type, payload)
  values (p_batch_id, auth.uid(), 'refresh', jsonb_build_object('added_count', v_added_count));

  return query select v_added_count, v_added_dots;
end;
$$;

-- ---- public.bulk_set_status (20260720001100_rpc.sql:491-528)
create or replace function public.bulk_set_status(
  p_batch_id uuid,
  p_dots     bigint[],
  p_status   batch_carrier_status
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  if not coalesce(internal.can_edit(), false) then
    raise exception 'insufficient privilege to change carrier status';
  end if;

  perform set_config('app.suppress_row_activity', 'on', true);

  update public.batch_carriers bc
     set status = p_status,
         status_changed_by = auth.uid(),   -- trigger won't set these while suppressed
         status_changed_at = now()
   where bc.batch_id = p_batch_id
     and bc.dot_number = any(p_dots)
     and bc.status is distinct from p_status;
  get diagnostics v_count = row_count;

  perform set_config('app.suppress_row_activity', 'off', true);

  insert into public.batch_activity (batch_id, actor_id, activity_type, payload)
  values (p_batch_id, auth.uid(), 'bulk_status_change',
          jsonb_build_object('to', p_status, 'count', v_count,
                              'dots', (select coalesce(jsonb_agg(d), '[]'::jsonb) from unnest(p_dots[1:50]) d)));

  return v_count;
end;
$$;

-- ---- public.log_export (20260720001100_rpc.sql:580-601)
create or replace function public.log_export(
  p_batch_id  uuid,
  p_kind      text,
  p_row_count int
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not coalesce(internal.can_edit(), false) then
    raise exception 'insufficient privilege to log an export';
  end if;
  if p_kind not in ('call_sheet','csv') then
    raise exception 'invalid export kind: % (expected call_sheet or csv)', p_kind;
  end if;

  insert into public.batch_activity (batch_id, actor_id, activity_type, payload)
  values (p_batch_id, auth.uid(), 'export', jsonb_build_object('kind', p_kind, 'row_count', p_row_count));
end;
$$;

-- ---- public.set_do_not_contact (20260723010400_dnc_activity_enum_cast.sql:6-53)
create or replace function public.set_do_not_contact(
  p_dot bigint,
  p_on boolean,
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

  insert into public.batch_activity (batch_id, actor_id, activity_type, payload)
  select bc.batch_id, v_uid,
         (case when p_on then 'dnc_set' else 'dnc_cleared' end)::activity_type,
         jsonb_build_object('dot_number', p_dot, 'reason', p_reason)
  from public.batch_carriers bc
  where bc.dot_number = p_dot;
end
$$;

-- ---- internal.contact_logs_dnc_guard (20260723020000_contact_logs_dnc_guard.sql:16-38)
create or replace function internal.contact_logs_dnc_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1 from public.carriers c
    where c.dot_number = new.dot_number and c.do_not_contact
  ) or exists (
    select 1 from public.contact_suppressions cs
    where cs.dot_number = new.dot_number
      and cs.channel::text = 'all'
      and cs.value is null
      and (cs.expires_at is null or cs.expires_at > now())
  ) then
    raise exception 'carrier % is on the global do-not-contact list; contact cannot be logged', new.dot_number
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

-- ---- drop the M1 policies
drop policy if exists profiles_select on public.profiles;
drop policy if exists carriers_update on public.carriers;
drop policy if exists cov_update_mgr on public.cargo_other_values;
drop policy if exists batches_write on public.batches;
drop policy if exists batches_update on public.batches;
drop policy if exists batches_delete on public.batches;
drop policy if exists zones_write on public.batch_zones;
drop policy if exists zones_update on public.batch_zones;
drop policy if exists zones_delete on public.batch_zones;
drop policy if exists bc_insert on public.batch_carriers;
drop policy if exists bc_update on public.batch_carriers;
drop policy if exists bc_delete on public.batch_carriers;
drop policy if exists logs_insert on public.contact_logs;
drop policy if exists logs_delete on public.contact_logs;
drop policy if exists act_comment on public.batch_activity;
drop policy if exists act_delete on public.batch_activity;
drop policy if exists suppress_insert on public.contact_suppressions;
drop policy if exists suppress_delete on public.contact_suppressions;

-- ---- original policies (20260720001200_rls.sql)
create policy profiles_select on public.profiles for select
  using (id = auth.uid() or internal.is_staff());
create policy profiles_update_self on public.profiles for update
  using (id = auth.uid()) with check (id = auth.uid());
create policy profiles_update_mgr on public.profiles for update
  using (internal.is_manager()) with check (internal.is_manager());
create policy carriers_update on public.carriers for update
  using (internal.can_edit()) with check (internal.can_edit());
create policy cov_update_mgr on public.cargo_other_values for update
  using (internal.is_manager()) with check (internal.is_manager());
create policy batches_write  on public.batches for insert with check (internal.can_edit() and created_by = auth.uid());
create policy batches_update on public.batches for update using (internal.can_edit());
create policy batches_delete on public.batches for delete using (internal.is_manager());
create policy zones_write  on public.batch_zones for insert with check (internal.can_edit());
create policy zones_update on public.batch_zones for update using (internal.can_edit());
create policy zones_delete on public.batch_zones for delete using (internal.can_edit());
create policy bc_insert on public.batch_carriers for insert with check (internal.can_edit());
create policy bc_update on public.batch_carriers for update using (internal.can_edit());
create policy bc_delete on public.batch_carriers for delete using (internal.is_manager());
create policy logs_insert on public.contact_logs for insert
  with check (internal.can_edit() and user_id = auth.uid());
create policy logs_delete on public.contact_logs for delete using (internal.is_manager());
create policy act_comment on public.batch_activity for insert
  with check (internal.can_edit() and activity_type = 'comment' and actor_id = auth.uid());
create policy act_delete on public.batch_activity for delete using (internal.is_manager());
create policy suppress_insert on public.contact_suppressions for insert with check (internal.can_edit());
create policy suppress_delete on public.contact_suppressions for delete using (internal.is_manager());

-- ---- policies now reference the original helpers again; drop M1 policy helpers
drop function if exists internal.member_write_ok(user_role[], uuid, text);
drop function if exists internal.suppression_write_ok(user_role[], bigint);
drop function if exists internal.actor_can_write(user_role[]);

-- ---- grants back to the pre-M1 surface: Supabase's platform defaults for anon/authenticated
-- on public tables and sequences, then the column restrictions and function grants exactly as
-- 20260720001200_rls.sql, 20260720001400_pipeline_tables.sql, 20260722223300_security_hardening.sql
-- and 20260723010400_dnc_activity_enum_cast.sql left them. T-BACKOUT compares the result with
-- the pre-cutover snapshot (pre-cutover-snapshot.sql).
-- Platform defaults are ALL on sequences and EXECUTE on new functions (T-BACKOUT measured the
-- pre-M1 surface: anon/authenticated rwU on public sequences; default function EXECUTE for both,
-- of which the migrations only ever revoked PUBLIC).
grant all on all tables in schema public to anon, authenticated;
grant all on all sequences in schema public to anon, authenticated;
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on sequences to anon, authenticated;
alter default privileges in schema public grant execute on functions to anon, authenticated;
-- Every public function was executable by authenticated before M1 (platform default; no
-- migration revokes a public function from authenticated), including extension functions such
-- as PostGIS that no migration names. The hardening slice below then removes anon again.
grant execute on all functions in schema public to authenticated;
revoke update on public.carriers from authenticated;
grant  update (do_not_contact, dnc_reason, dnc_set_by, dnc_set_at,
               contact_name_override, contact_phone_override, contact_email_override)
  on public.carriers to authenticated;           -- everything else is service_role-only
revoke update on public.cargo_other_values from authenticated;
grant  update (match_group, is_sand_gravel) on public.cargo_other_values to authenticated;
revoke execute on all functions in schema public from public, anon;
revoke execute on all functions in schema internal from public, anon;

-- Authenticated application users may call the explicit public API. RLS guards
-- all invoker reads; the five definer writes also perform fail-closed role checks.
grant execute on function
  public.search_carriers(jsonb, int, int, text, text),
  public.count_carriers(jsonb),
  public.facet_other_values(jsonb, text, int, int),
  public.facet_suggested_keywords(jsonb),
  public.facet_cargo_flags(jsonb),
  public.create_batch(text, text, text, text, jsonb),
  public.refresh_batch(uuid),
  public.bulk_set_status(uuid, bigint[], batch_carrier_status),
  public.set_do_not_contact(bigint, boolean, text),
  public.log_export(uuid, text, int),
  public.batch_members(uuid, batch_carrier_status[], text, boolean, int, int, text, text, bigint, int, int, boolean, boolean),
  public.batch_members_map(uuid, batch_carrier_status[], text, boolean, bigint, int, int, boolean, boolean, text, text),
  public.search_carriers_map(jsonb, int),
  public.generate_contact_sheet(uuid, bigint[]),
  public.batch_status_counts(uuid),
  public.dashboard_totals(),
  public.is_contactable(bigint, contact_channel)
  to authenticated;

-- Internal helpers are not PostgREST endpoints but invoker RPCs need to call
-- them. Trigger functions remain ungranted.
grant usage on schema internal to authenticated;
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
revoke execute on function public.set_do_not_contact(bigint, boolean, text) from public, anon;
grant execute on function public.set_do_not_contact(bigint, boolean, text) to authenticated, service_role;
revoke recruiter_api from recruiter_app;
revoke all on all tables in schema public from recruiter_api;
revoke all on all sequences in schema public from recruiter_api;
revoke execute on all functions in schema public from recruiter_api;
revoke execute on all functions in schema internal from recruiter_api;
revoke usage on schema public, internal from recruiter_api;

-- ---- realtime publication members as 20260720001300_realtime.sql
do $realtime$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['batches', 'batch_zones', 'batch_carriers', 'batch_activity', 'contact_logs', 'profiles'] loop
      if not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end
$realtime$;

-- ---- hardening search_path, exactly as 20260722223300_security_hardening.sql:11-32
do $hardening$
declare
  fn regprocedure;
begin
  for fn in
    select p.oid::regprocedure
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'internal')
      and p.prokind = 'f'
      and pg_get_userbyid(p.proowner) = current_user
      and not exists (
        select 1 from pg_depend d
        where d.classid = 'pg_proc'::regclass
          and d.objid = p.oid
          and d.deptype = 'e'
      )
  loop
    execute format('alter function %s set search_path = public, internal, pg_temp', fn);
  end loop;
end
$hardening$;

-- ---- migration order: the hardening loop above ran BEFORE 20260723020000 created the DNC guard,
-- so the guard keeps its own search_path; and M1's service_role grant on internal functions
-- (M1 section 13) did not exist for it before M1.
alter function internal.contact_logs_dnc_guard() set search_path = public, pg_temp;
revoke execute on function internal.contact_logs_dnc_guard() from service_role;

commit;
