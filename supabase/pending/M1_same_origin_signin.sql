-- ============================================================================
-- M1_same_origin_signin.sql -- PENDING. NOT EXECUTED ANYWHERE. NOT A MIGRATION YET.
--
-- Same-origin, QQ-style sign-in: server-issued links, opaque Postgres sessions, and
-- database permissions re-keyed from auth.uid() to the session ledger.
-- Design: docs/build-plan/14-same-origin-signin-design.md and
--         docs/build-plan/15-qq-infrastructure-reconciliation.md (§12, §14, §17).
--
-- Status and gates:
--   * Lives in supabase/pending/, outside supabase/migrations, so the pinned migration
--     baseline (scripts/verify-migration-baseline.mjs) is unchanged. Moving it into
--     supabase/migrations is an explicit baseline decision after it has been executed in the
--     approved throwaway test database (approval A3) and reviewed.
--   * Applying it to staging or production is a reviewed migration gate with an owner "go".
--   * Preserves every existing row. Changes no profile id, email, role or status. Keeps the
--     profiles -> auth.users foreign key (dropping it is the UNAPPROVED proposal D8, "M2").
--   * Creates the login roles WITHOUT passwords; the operator sets them out of band.
--   * Recovery codes are created but DISABLED (internal.recovery_policy.enabled = false)
--     until the cross-app policy decision D2.
--   * The backout-window email pause exists but is OFF (internal.backout_window) until the
--     UNAPPROVED proposal D10 is decided.
--
-- Roles are only ever compared by explicit set membership. user_role is declared
-- ('manager','edit','view','guest'), so ordering comparisons would reverse permissions.
-- Role sets used below: STAFF = {manager,edit,view}; EDITOR = {manager,edit};
-- MANAGER = {manager}.
--
-- Global lock order (doc 15 §17.2): I1 internal.roster_lock -> I2 public.profiles
-- (ascending id; targets FOR NO KEY UPDATE, actor FOR SHARE) -> I3 the actor's own session
-- -> B1 batches -> B2 batch_zones -> B3 batch_carriers -> B4 carriers -> B5
-- contact_suppressions -> B6 contact_logs / batch_activity -> B7 cargo_other_values ->
-- A1 other sessions -> A2 signin_links -> A3 recovery sets/codes -> A4 email blocks/events.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. Roles (no passwords here)
-- ----------------------------------------------------------------------------
do $roles$
begin
  if not exists (select 1 from pg_roles where rolname = 'recruiter_api') then
    create role recruiter_api nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'recruiter_app') then
    create role recruiter_app nologin inherit;            -- operator later: LOGIN + password
  end if;
  if not exists (select 1 from pg_roles where rolname = 'recruiter_maintenance') then
    create role recruiter_maintenance nologin;            -- retention job; operator: LOGIN + password
  end if;
end
$roles$;

grant recruiter_api to recruiter_app;

-- ----------------------------------------------------------------------------
-- 1. Control rows
-- ----------------------------------------------------------------------------
create table internal.roster_lock (
  id boolean primary key default true check (id)
);
insert into internal.roster_lock default values;

-- UNAPPROVED PROPOSAL D10: pausing email edits during a backout window. Off by default.
create table internal.backout_window (
  id boolean primary key default true check (id),
  email_edits_paused boolean not null default false
);
insert into internal.backout_window default values;

-- Recovery codes stay disabled until policy D2 is decided.
create table internal.recovery_policy (
  id boolean primary key default true check (id),
  enabled boolean not null default false
);
insert into internal.recovery_policy default values;

-- ----------------------------------------------------------------------------
-- 2. Ledgers
-- ----------------------------------------------------------------------------
create table internal.recovery_sets (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles(id),
  created_at     timestamptz not null default now(),
  revoked_at     timestamptz,
  revoked_reason text,
  constraint recovery_sets_revoked_pair check ((revoked_at is null) = (revoked_reason is null))
);
create unique index recovery_sets_one_active on internal.recovery_sets (user_id) where revoked_at is null;

create table internal.recovery_codes (
  id             uuid primary key default gen_random_uuid(),
  set_id         uuid not null references internal.recovery_sets(id),
  user_id        uuid not null references public.profiles(id),
  code_hash      text not null unique,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null,
  used_at        timestamptz,
  revoked_at     timestamptz,
  revoked_reason text,
  constraint recovery_codes_revoked_pair check ((revoked_at is null) = (revoked_reason is null)),
  constraint recovery_codes_used_xor_revoked check (used_at is null or revoked_at is null)
);
create index recovery_codes_user on internal.recovery_codes (user_id) where used_at is null and revoked_at is null;

create table internal.app_sessions (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references public.profiles(id),
  token_hash          text not null unique,
  kind                text not null check (kind in ('link', 'recovery')),
  email_at_issue      text not null,
  created_at          timestamptz not null default now(),
  last_seen_at        timestamptz not null default now(),
  idle_window         interval not null,
  expires_at          timestamptz not null,
  absolute_expires_at timestamptz not null,
  recovery_code_id    uuid unique references internal.recovery_codes(id),
  revoked_at          timestamptz,
  revoked_reason      text,
  constraint app_sessions_revoked_pair check ((revoked_at is null) = (revoked_reason is null)),
  constraint app_sessions_kind_windows check (
    (kind = 'link' and idle_window = interval '30 days'
       and absolute_expires_at = created_at + interval '90 days' and recovery_code_id is null)
    or
    (kind = 'recovery' and idle_window = interval '1 hour'
       and absolute_expires_at = created_at + interval '12 hours' and recovery_code_id is not null)
  ),
  constraint app_sessions_expiry_capped check (expires_at <= absolute_expires_at)
);
create index app_sessions_user_live on internal.app_sessions (user_id) where revoked_at is null;

create table internal.signin_links (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references public.profiles(id),
  token_hash          text not null unique,
  recipient_email     text not null,
  created_at          timestamptz not null default now(),
  expires_at          timestamptz not null,
  used_at             timestamptz,
  revoked_at          timestamptz,
  revoked_reason      text,
  send_status         text not null default 'pending'
                        check (send_status in ('pending', 'accepted', 'unknown', 'definite_failure')),
  send_attempted_at   timestamptz,
  send_error_code     text,
  provider_request_id text,          -- X-Message-Id from the send response
  provider_message_id text,          -- sg_message_id, filled once from the first event that carries it
  delivered_at        timestamptz,
  constraint signin_links_revoked_pair check ((revoked_at is null) = (revoked_reason is null)),
  constraint signin_links_used_xor_revoked check (used_at is null or revoked_at is null),
  constraint signin_links_pending_shape check ((send_status = 'pending') = (send_attempted_at is null)),
  constraint signin_links_failure_code check (send_status <> 'definite_failure' or send_error_code is not null),
  constraint signin_links_expiry check (expires_at = created_at + interval '15 minutes')
);
create index signin_links_user_created on internal.signin_links (user_id, created_at desc);

create table internal.auth_request_buckets (
  dimension    text not null check (dimension in ('ip', 'email', 'recovery_ip', 'recovery_email')),
  key_hash     text not null,
  window_start timestamptz not null,
  count        int not null,
  primary key (dimension, key_hash, window_start)
);

create table internal.recovery_failures (
  id         bigint generated always as identity primary key,
  email_hash text not null,
  at         timestamptz not null default now()
);
create index recovery_failures_email on internal.recovery_failures (email_hash, at);

-- Events outlive their links: links age out 30 days after they end, events after 180 days.
-- The link reference becomes null when its link is deleted; the event keeps its own snapshot
-- of the recipient and message id, so delivery evidence is never lost early.
create table internal.email_events (
  provider_event_id text primary key,                 -- sg_event_id: replays are no-ops
  link_id           uuid references internal.signin_links(id) on delete set null,
  recipient_email   text not null,
  provider_message_id text,
  event_type        text not null,
  reason_code       text check (reason_code is null or length(reason_code) <= 500),
  occurred_at       timestamptz not null,
  received_at       timestamptz not null default now()
);

create table internal.blocked_email_addresses (
  normalized_email text primary key,
  reason           text not null,
  evidence_at      timestamptz not null,
  evidence_event   text,
  cleared_at       timestamptz,
  cleared_by       uuid references public.profiles(id),
  constraint blocked_cleared_pair check ((cleared_at is null) = (cleared_by is null))
);

create table internal.auth_events (
  id      bigint generated always as identity primary key,
  at      timestamptz not null default now(),
  user_id uuid references public.profiles(id),
  kind    text not null,
  detail  jsonb not null default '{}'::jsonb
);

-- Delivery lattice (Quote-Queue migrations 0006/0007).
create function internal.signin_links_send_status_monotonic() returns trigger
language plpgsql
set search_path = public, internal, pg_temp
as $$
begin
  if old.send_status = 'definite_failure' and new.send_status <> 'definite_failure' then
    raise exception 'signin_links.send_status cannot leave definite_failure';
  end if;
  if old.send_status = 'accepted' and new.send_status not in ('accepted', 'definite_failure') then
    raise exception 'signin_links.send_status cannot leave accepted except to definite_failure';
  end if;
  if old.send_status = 'unknown' and new.send_status = 'pending' then
    raise exception 'signin_links.send_status cannot return from unknown to pending';
  end if;
  return new;
end
$$;
create trigger signin_links_send_status_monotonic
  before update on internal.signin_links
  for each row execute function internal.signin_links_send_status_monotonic();

-- ----------------------------------------------------------------------------
-- 3. Session resolution and the one lock sequence
-- ----------------------------------------------------------------------------
create function internal.current_session()
returns table (session_id uuid, user_id uuid, role user_role, kind text,
               created_at timestamptz, expires_at timestamptz, absolute_expires_at timestamptz)
language sql
stable
security definer
set search_path = public, internal, pg_temp
as $$
  select s.id, s.user_id, p.role, s.kind, s.created_at, s.expires_at, s.absolute_expires_at
  from internal.app_sessions s
  join public.profiles p on p.id = s.user_id
  where s.token_hash = nullif(current_setting('app.session_hash', true), '')
    and s.revoked_at is null
    and s.expires_at > now()
    and s.absolute_expires_at > now()
    and p.status = 'approved'
    and p.role in ('manager', 'edit', 'view')
    and p.email = s.email_at_issue
$$;

-- Actor attribution for both session kinds (activity rows, contact logs, DNC).
create function internal.current_staff_id() returns uuid
language sql
stable
security definer
set search_path = public, internal, pg_temp
as $$ select cs.user_id from internal.current_session() cs $$;

-- Same signature as 20260720001200_rls.sql:41. Role only for LINK sessions, so recovery
-- sessions satisfy no staff policy, view or RPC (deny by default; doc 15 §14.1).
create or replace function internal.current_app_role() returns user_role
language sql
stable
security definer
set search_path = public, internal, pg_temp
as $$ select cs.role from internal.current_session() cs where cs.kind = 'link' $$;

-- The one executable lock sequence (doc 15 §14.2). Every privileged write calls it (directly,
-- through actor_can_write, or through member_write_ok) before any other lock.
create function internal.lock_and_validate(
  p_roles        user_role[],
  p_kinds        text[],
  p_targets      uuid[] default '{}',
  p_roster       boolean default false,
  p_session_mode text default 'share'
) returns uuid
language plpgsql
volatile
security definer
set search_path = public, internal, pg_temp
as $$
declare
  v_record   text := nullif(current_setting('app.actor_locked', true), '');
  v_parts    text[];
  v_sid      uuid;
  v_uid      uuid;
  v_ids      uuid[];
  v_id       uuid;
  v_role     user_role;
  v_status   user_status;
  v_email    text;
  v_kind     text;
  v_revoked  timestamptz;
  v_expires  timestamptz;
  v_absolute timestamptz;
  v_issued   text;
  v_targets  uuid[] := coalesce(p_targets, '{}');
begin
  -- Re-entry in the same transaction: allowed only for actor-only calls, checked against the
  -- recorded role and kind. Never takes a new identity lock out of order.
  if v_record is not null then
    v_parts := string_to_array(v_record, '|');
    if cardinality(v_targets) > 0 or p_roster or p_session_mode <> 'share' then
      if v_parts[5] is distinct from array_to_string(v_targets, ',') or v_parts[6] <> p_roster::text then
        raise exception 'lock sequence already taken with a different lock set' using errcode = 'insufficient_privilege';
      end if;
    end if;
    if not (v_parts[3]::user_role = any(p_roles)) or not (v_parts[4] = any(p_kinds)) then
      raise exception 'not permitted' using errcode = 'insufficient_privilege';
    end if;
    return v_parts[2]::uuid;
  end if;

  -- I1
  if p_roster then
    perform 1 from internal.roster_lock for update;
  end if;

  -- Discovery without locks.
  select s.id, s.user_id into v_sid, v_uid
  from internal.app_sessions s
  where s.token_hash = nullif(current_setting('app.session_hash', true), '');
  if v_sid is null then
    raise exception 'no session' using errcode = 'insufficient_privilege';
  end if;

  -- I2: every profile involved, ascending id, final mode at once (no upgrade).
  select array_agg(x order by x) into v_ids
  from (select distinct unnest(array_append(v_targets, v_uid)) as x) t;
  foreach v_id in array v_ids loop
    if v_id = any(v_targets) then
      perform 1 from public.profiles where id = v_id for no key update;
    else
      perform 1 from public.profiles where id = v_id for share;
    end if;
    if not found then
      raise exception 'profile not found' using errcode = 'insufficient_privilege';
    end if;
  end loop;

  -- I3: the actor's own session, in its final mode.
  if p_session_mode = 'update' then
    select s.kind, s.revoked_at, s.expires_at, s.absolute_expires_at, s.email_at_issue
      into v_kind, v_revoked, v_expires, v_absolute, v_issued
    from internal.app_sessions s where s.id = v_sid for update;
  else
    select s.kind, s.revoked_at, s.expires_at, s.absolute_expires_at, s.email_at_issue
      into v_kind, v_revoked, v_expires, v_absolute, v_issued
    from internal.app_sessions s where s.id = v_sid for share;
  end if;

  -- Validate from the locked rows only.
  select p.role, p.status, p.email into v_role, v_status, v_email
  from public.profiles p where p.id = v_uid;
  -- clock_timestamp(), not now(): now() is frozen at transaction start, and these locks may
  -- have waited.
  if v_revoked is not null or v_expires <= clock_timestamp() or v_absolute <= clock_timestamp()
     or v_issued is distinct from v_email
     or v_status <> 'approved'
     or not (v_role = any(p_roles))
     or not (v_kind = any(p_kinds)) then
    raise exception 'not permitted' using errcode = 'insufficient_privilege';
  end if;

  perform set_config('app.actor_locked',
    concat_ws('|', v_sid, v_uid, v_role, v_kind, array_to_string(v_targets, ','), p_roster::text), true);
  return v_uid;
end
$$;

-- After any business-lock wait: the actor's session row is held FOR SHARE (so it cannot be
-- revoked meanwhile), but it can EXPIRE while we wait. Re-check it against the wall clock
-- (clock_timestamp(); now() is frozen at transaction start); raise if no longer valid.
-- Trusted callers (no lock record) are not app sessions and are not checked.
create function internal.recheck_session() returns void
language plpgsql
volatile
security definer
set search_path = public, internal, pg_temp
as $$
declare
  v_record text := nullif(current_setting('app.actor_locked', true), '');
begin
  if v_record is null then
    return;
  end if;
  if not exists (
    select 1 from internal.app_sessions s
    where s.id = (string_to_array(v_record, '|'))[1]::uuid
      and s.revoked_at is null and s.expires_at > clock_timestamp() and s.absolute_expires_at > clock_timestamp()
  ) then
    raise exception 'session expired while waiting' using errcode = 'insufficient_privilege';
  end if;
end
$$;

-- Write-policy guard: actor-only lock sequence for LINK sessions. Returns false (never raises)
-- so a refused row is simply not written.
create function internal.actor_can_write(p_roles user_role[]) returns boolean
language plpgsql
volatile
security definer
set search_path = public, internal, pg_temp
as $$
begin
  perform internal.lock_and_validate(p_roles, array['link']);
  return true;
exception when insufficient_privilege then
  return false;
end
$$;

-- Member writes: identity first, then the parent batch (B1) before the member row (B3).
create function internal.member_write_ok(p_roles user_role[], p_batch_id uuid, p_batch_mode text) returns boolean
language plpgsql
volatile
security definer
set search_path = public, internal, pg_temp
as $$
begin
  if not internal.actor_can_write(p_roles) then
    return false;
  end if;
  if p_batch_mode = 'share' then
    perform 1 from public.batches where id = p_batch_id for share;
  else
    perform 1 from public.batches where id = p_batch_id for key share;
  end if;
  if not found then
    return false;
  end if;
  perform internal.recheck_session();
  return true;
end
$$;

-- The app's own login. Checked by name, not with pg_has_role: superusers count as members of
-- every role, which would misclassify operator sessions in a test cluster.
create function internal.is_app_login() returns boolean
language sql
stable
set search_path = public, internal, pg_temp
as $$ select session_user::text = 'recruiter_app' $$;

-- ----------------------------------------------------------------------------
-- 4. Identity-change revocation (every access path: Team functions, operator SQL,
--    service role, Studio). Ceilings are never reset (links stay counted by user id).
-- ----------------------------------------------------------------------------
create function internal.revoke_on_identity_change() returns trigger
language plpgsql
security definer
set search_path = public, internal, pg_temp
as $$
declare
  v_reason text;
begin
  if (new.email, new.role, new.status) is not distinct from (old.email, old.role, old.status) then
    return null;
  end if;
  v_reason := case
    when new.email is distinct from old.email then 'email_changed'
    when new.status is distinct from old.status then 'status_changed'
    else 'role_changed' end;
  -- A1, A2, A3 in order.
  update internal.app_sessions set revoked_at = now(), revoked_reason = v_reason
   where user_id = new.id and revoked_at is null;
  update internal.signin_links set revoked_at = now(), revoked_reason = v_reason
   where user_id = new.id and used_at is null and revoked_at is null;
  update internal.recovery_sets set revoked_at = now(), revoked_reason = v_reason
   where user_id = new.id and revoked_at is null;
  update internal.recovery_codes set revoked_at = now(), revoked_reason = v_reason
   where user_id = new.id and used_at is null and revoked_at is null;
  insert into internal.auth_events (user_id, kind, detail)
  values (new.id, 'identity_changed_revoked', jsonb_build_object('reason', v_reason));
  return null;
end
$$;
create trigger profiles_revoke_on_identity_change
  after update on public.profiles
  for each row execute function internal.revoke_on_identity_change();

-- UNAPPROVED PROPOSAL D10 (off by default): refuse email changes while the window is open.
create function internal.email_edit_pause() returns trigger
language plpgsql
security definer
set search_path = public, internal, pg_temp
as $$
begin
  if new.email is distinct from old.email
     and (select w.email_edits_paused from internal.backout_window w) then
    raise exception 'email changes are paused' using errcode = 'insufficient_privilege';
  end if;
  return new;
end
$$;
create trigger profiles_email_edit_pause
  before update on public.profiles
  for each row execute function internal.email_edit_pause();

-- ----------------------------------------------------------------------------
-- 5. Attribution constraints (doc 15 §17.2)
-- ----------------------------------------------------------------------------
create function internal.batches_attribution_immutable() returns trigger
language plpgsql
security definer
set search_path = public, internal, pg_temp
as $$
begin
  if (new.created_by, new.created_at) is distinct from (old.created_by, old.created_at)
     and internal.is_app_login() then
    raise exception 'batches.created_by/created_at cannot be changed' using errcode = 'insufficient_privilege';
  end if;
  return new;
end
$$;
create trigger batches_attribution_immutable
  before update on public.batches
  for each row execute function internal.batches_attribution_immutable();

create function internal.batch_carriers_insert_clean() returns trigger
language plpgsql
security definer
set search_path = public, internal, pg_temp
as $$
begin
  if internal.is_app_login() then
    new.status := 'new';
    new.status_changed_by := null;
    new.status_changed_at := null;
    new.promoted_by := null;
    new.promoted_at := null;
  end if;
  return new;
end
$$;
create trigger batch_carriers_insert_clean
  before insert on public.batch_carriers
  for each row execute function internal.batch_carriers_insert_clean();

-- Session re-check after implicit row-lock waits. A BEFORE UPDATE/DELETE row trigger runs only
-- after PostgreSQL has locked the target row (waiting if another transaction holds it), so
-- re-validating here with clock_timestamp() (recheck_session) covers waits that a policy,
-- evaluated before the wait, cannot. No-op when no app actor is locked (pipeline, operator).
create function internal.recheck_session_on_write() returns trigger
language plpgsql
security definer
set search_path = public, internal, pg_temp
as $$
begin
  perform internal.recheck_session();
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end
$$;
do $recheck$
declare
  t text;
begin
  foreach t in array array['batches', 'batch_zones', 'batch_carriers', 'batch_activity', 'contact_logs',
                           'carriers', 'cargo_other_values', 'contact_suppressions'] loop
    execute format('create trigger %I before update or delete on public.%I for each row execute function internal.recheck_session_on_write()',
                   t || '_recheck_session', t);
  end loop;
end
$recheck$;

-- ----------------------------------------------------------------------------
-- 6. Re-keyed trigger functions and RPCs. Bodies equal their latest originals except:
--    auth.uid() -> internal.current_staff_id(); the can_edit() guard -> lock_and_validate;
--    and the lock-order additions marked "M1:".
-- ----------------------------------------------------------------------------
create or replace function internal.log_bc_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if current_setting('app.suppress_row_activity', true) = 'on' then return new; end if;  -- bulk ops log once
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    new.status_changed_by := internal.current_staff_id();  new.status_changed_at := now();
    insert into public.batch_activity (batch_id, actor_id, activity_type, payload)
    values (new.batch_id, internal.current_staff_id(), 'status_change',
            jsonb_build_object('dot_number', new.dot_number, 'from', old.status, 'to', new.status));
  end if;
  if tg_op = 'UPDATE' and new.promoted_at is not null and old.promoted_at is null then
    new.promoted_by := internal.current_staff_id();
    insert into public.batch_activity (batch_id, actor_id, activity_type, payload)
    values (new.batch_id, internal.current_staff_id(), 'promoted', jsonb_build_object('dot_number', new.dot_number));  -- F23
  end if;
  return new;
end $$;

create or replace function internal.log_bc_delete() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- M1: skip when the parent batch itself is being deleted (its activity is cascaded away).
  if not exists (select 1 from public.batches where id = old.batch_id) then return old; end if;
  insert into public.batch_activity (batch_id, actor_id, activity_type, payload)
  values (old.batch_id, internal.current_staff_id(), 'carrier_removed', jsonb_build_object('dot_number', old.dot_number));
  return old;
end $$;

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
  perform internal.lock_and_validate(array['manager','edit']::user_role[], array['link']);
  if p_name is null or btrim(p_name) = '' then
    raise exception 'batch name is required';
  end if;

  insert into public.batches (name, customer, job, description, created_by, search_definition, snapshot_taken_at)
  values (p_name, p_customer, p_job, p_description, internal.current_staff_id(), coalesce(p_definition,'{}'::jsonb) - 'zones', now())
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
  values (v_batch_id, internal.current_staff_id(), 'batch_created', jsonb_build_object('name', p_name));
  insert into public.batch_activity (batch_id, actor_id, activity_type, payload)
  values (v_batch_id, internal.current_staff_id(), 'members_added', jsonb_build_object('count', v_count));

  return query select v_batch_id, v_count;
end;
$$;

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
  perform internal.lock_and_validate(array['manager','edit']::user_role[], array['link']);

  -- M1: B1 first. Serializes concurrent refreshes and member removal on this batch.
  select b.search_definition into v_def from public.batches b where b.id = p_batch_id for no key update;
  if not found then
    raise exception 'batch % not found', p_batch_id;
  end if;
  perform internal.recheck_session();

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
  values (p_batch_id, internal.current_staff_id(), 'refresh', jsonb_build_object('added_count', v_added_count));

  return query select v_added_count, v_added_dots;
end;
$$;

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
  v_count  int;
  v_locked bigint[];
begin
  perform internal.lock_and_validate(array['manager','edit']::user_role[], array['link']);

  -- M1: B1 before B3, then lock and freeze the member set in sorted order.
  perform 1 from public.batches where id = p_batch_id for key share;
  select coalesce(array_agg(bc.dot_number order by bc.dot_number), '{}') into v_locked
  from (
    select x.dot_number from public.batch_carriers x
    where x.batch_id = p_batch_id and x.dot_number = any(p_dots)
    order by x.dot_number
    for no key update
  ) bc;
  perform internal.recheck_session();

  perform set_config('app.suppress_row_activity', 'on', true);

  update public.batch_carriers bc
     set status = p_status,
         status_changed_by = internal.current_staff_id(),   -- trigger won't set these while suppressed
         status_changed_at = now()
   where bc.batch_id = p_batch_id
     and bc.dot_number = any(v_locked)
     and bc.status is distinct from p_status;
  get diagnostics v_count = row_count;

  perform set_config('app.suppress_row_activity', 'off', true);

  insert into public.batch_activity (batch_id, actor_id, activity_type, payload)
  values (p_batch_id, internal.current_staff_id(), 'bulk_status_change',
          jsonb_build_object('to', p_status, 'count', v_count,
                              'dots', (select coalesce(jsonb_agg(d), '[]'::jsonb) from unnest(v_locked[1:50]) d)));

  return v_count;
end;
$$;

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
  v_uid uuid := internal.lock_and_validate(array['manager','edit']::user_role[], array['link']);
begin
  -- M1: B4 before B5 and B6; the contact-log guard takes this carrier FOR SHARE.
  perform 1 from public.carriers where dot_number = p_dot for no key update;
  if not found then
    raise exception 'carrier % not found', p_dot;
  end if;
  perform internal.recheck_session();

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
  perform internal.lock_and_validate(array['manager','edit']::user_role[], array['link']);
  if p_kind not in ('call_sheet','csv') then
    raise exception 'invalid export kind: % (expected call_sheet or csv)', p_kind;
  end if;

  insert into public.batch_activity (batch_id, actor_id, activity_type, payload)
  values (p_batch_id, internal.current_staff_id(), 'export', jsonb_build_object('kind', p_kind, 'row_count', p_row_count));
end;
$$;

-- Contact-log DNC guard (replaces 20260723020000). Identity first for app callers, then
-- B1, then B4 FOR SHARE, then the unchanged DNC rule. Trusted callers (service role,
-- operator, staging fixture runner) skip the identity step as today.
create or replace function internal.contact_logs_dnc_guard()
returns trigger
language plpgsql
security definer
set search_path = public, internal, pg_temp
as $$
begin
  if internal.is_app_login() then
    perform internal.lock_and_validate(array['manager','edit']::user_role[], array['link']);
    if new.user_id is distinct from internal.current_staff_id() then
      raise exception 'contact log must be recorded as yourself' using errcode = 'insufficient_privilege';
    end if;
  end if;
  if new.batch_id is not null then
    perform 1 from public.batches where id = new.batch_id for key share;
  end if;
  perform 1 from public.carriers where dot_number = new.dot_number for share;
  perform internal.recheck_session();
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

-- Suppression writes lock their carrier first (B4) so the guard above serializes with them.
create function internal.suppression_write_ok(p_roles user_role[], p_dot bigint) returns boolean
language plpgsql
volatile
security definer
set search_path = public, internal, pg_temp
as $$
begin
  if not internal.actor_can_write(p_roles) then
    return false;
  end if;
  if p_dot is not null then
    perform 1 from public.carriers where dot_number = p_dot for no key update;
    perform internal.recheck_session();
  end if;
  return true;
end
$$;

-- ----------------------------------------------------------------------------
-- 7. Policies (doc 15 §14.1 per-policy table). Read policies keep is_staff().
-- ----------------------------------------------------------------------------
drop policy profiles_select on public.profiles;
drop policy profiles_update_self on public.profiles;
drop policy profiles_update_mgr on public.profiles;
create policy profiles_select on public.profiles for select
  using ((select internal.is_staff()));

drop policy carriers_update on public.carriers;
create policy carriers_update on public.carriers for update
  using (internal.actor_can_write(array['manager','edit']::user_role[]))
  with check (internal.actor_can_write(array['manager','edit']::user_role[]));

drop policy cov_update_mgr on public.cargo_other_values;
create policy cov_update_mgr on public.cargo_other_values for update
  using (internal.actor_can_write(array['manager']::user_role[]))
  with check (internal.actor_can_write(array['manager']::user_role[]));

drop policy batches_write on public.batches;
drop policy batches_update on public.batches;
drop policy batches_delete on public.batches;
create policy batches_write on public.batches for insert
  with check (internal.actor_can_write(array['manager','edit']::user_role[]) and created_by = internal.current_staff_id());
create policy batches_update on public.batches for update
  using (internal.actor_can_write(array['manager','edit']::user_role[]));
create policy batches_delete on public.batches for delete
  using (internal.actor_can_write(array['manager']::user_role[]));

drop policy zones_write on public.batch_zones;
drop policy zones_update on public.batch_zones;
drop policy zones_delete on public.batch_zones;
create policy zones_write on public.batch_zones for insert
  with check (internal.actor_can_write(array['manager','edit']::user_role[]));
create policy zones_update on public.batch_zones for update
  using (internal.actor_can_write(array['manager','edit']::user_role[]));
create policy zones_delete on public.batch_zones for delete
  using (internal.actor_can_write(array['manager','edit']::user_role[]));

drop policy bc_insert on public.batch_carriers;
drop policy bc_update on public.batch_carriers;
drop policy bc_delete on public.batch_carriers;
create policy bc_insert on public.batch_carriers for insert
  with check (internal.member_write_ok(array['manager','edit']::user_role[], batch_id, 'key share'));
create policy bc_update on public.batch_carriers for update
  using (internal.member_write_ok(array['manager','edit']::user_role[], batch_id, 'key share'));
create policy bc_delete on public.batch_carriers for delete
  using (internal.member_write_ok(array['manager']::user_role[], batch_id, 'share'));

drop policy logs_insert on public.contact_logs;
drop policy logs_delete on public.contact_logs;
create policy logs_insert on public.contact_logs for insert
  with check (internal.actor_can_write(array['manager','edit']::user_role[]) and user_id = internal.current_staff_id());
create policy logs_delete on public.contact_logs for delete
  using (internal.actor_can_write(array['manager']::user_role[]));

drop policy act_comment on public.batch_activity;
drop policy act_delete on public.batch_activity;
create policy act_comment on public.batch_activity for insert
  with check (internal.member_write_ok(array['manager','edit']::user_role[], batch_id, 'key share')
              and activity_type = 'comment' and actor_id = internal.current_staff_id());
create policy act_delete on public.batch_activity for delete
  using (internal.actor_can_write(array['manager']::user_role[]));

drop policy suppress_insert on public.contact_suppressions;
drop policy suppress_delete on public.contact_suppressions;
create policy suppress_insert on public.contact_suppressions for insert
  with check (internal.suppression_write_ok(array['manager','edit']::user_role[], dot_number)
              and created_by = internal.current_staff_id());
create policy suppress_delete on public.contact_suppressions for delete
  using (internal.suppression_write_ok(array['manager']::user_role[], dot_number));

-- ----------------------------------------------------------------------------
-- 8. Sign-in primitives (called by the server as recruiter_app)
-- ----------------------------------------------------------------------------

-- Anonymous flood buckets, both increments in one statement-pair from one clock value.
create function internal.auth_bucket_hit(p_kind text, p_ip_hash text, p_email_hash text)
returns table (ip_count int, email_count int)
language plpgsql
volatile
security definer
set search_path = public, internal, pg_temp
as $$
declare
  v_window timestamptz := to_timestamp(floor(extract(epoch from clock_timestamp()) / 900) * 900);
  v_ip_dim text := case p_kind when 'recovery' then 'recovery_ip' else 'ip' end;
  v_email_dim text := case p_kind when 'recovery' then 'recovery_email' else 'email' end;
begin
  if p_kind not in ('request', 'recovery') then
    raise exception 'unknown bucket kind';
  end if;
  insert into internal.auth_request_buckets as b (dimension, key_hash, window_start, count)
  values (v_ip_dim, p_ip_hash, v_window, 1)
  on conflict (dimension, key_hash, window_start) do update set count = b.count + 1
  returning b.count into ip_count;
  insert into internal.auth_request_buckets as b (dimension, key_hash, window_start, count)
  values (v_email_dim, p_email_hash, v_window, 1)
  on conflict (dimension, key_hash, window_start) do update set count = b.count + 1
  returning b.count into email_count;
  return next;
end
$$;

-- Post-response mint, step 1: lock the person (I2) and read the counts under that lock.
create function internal.auth_mint_lock(p_email text, p_day_start timestamptz, p_day_end timestamptz)
returns table (user_id uuid, recipient text, blocked boolean, newest_id uuid, newest_status text,
               newest_created_at timestamptz, last_minute int, last_hour int, chicago_day int)
language plpgsql
volatile
security definer
set search_path = public, internal, pg_temp
as $$
declare
  v_id uuid;
  v_email text;
begin
  -- I1 in SHARE mode: emergency sign-out holds I1 exclusively, so it never interleaves with
  -- this credential path (Hunter decision 2026-10-21; doc 15 section 29).
  perform 1 from internal.roster_lock for share;
  select p.id into v_id from public.profiles p
  where lower(p.email) = lower(p_email) and p.status = 'approved' and p.role in ('manager', 'edit', 'view')
  order by p.id limit 1;
  if v_id is null then return; end if;

  select p.email into v_email from public.profiles p
  where p.id = v_id and p.status = 'approved' and p.role in ('manager', 'edit', 'view')
  for no key update;
  if v_email is null or lower(v_email) <> lower(p_email) then return; end if;

  return query
  select v_id, v_email,
         exists (select 1 from internal.blocked_email_addresses b
                 where b.normalized_email = lower(v_email) and b.cleared_at is null),
         n.id, n.send_status, n.created_at,
         (select count(*)::int from internal.signin_links l where l.user_id = v_id and l.created_at > now() - interval '1 minute'),
         (select count(*)::int from internal.signin_links l where l.user_id = v_id and l.created_at > now() - interval '1 hour'),
         (select count(*)::int from internal.signin_links l where l.user_id = v_id and l.created_at >= p_day_start and l.created_at < p_day_end)
  from (select 1) one
  left join lateral (
    select l.id, l.send_status, l.created_at from internal.signin_links l
    where l.user_id = v_id order by l.created_at desc limit 1
  ) n on true;
end
$$;

-- Post-response mint, step 2 (same transaction, person still locked): record the link.
create function internal.auth_mint_insert(p_user_id uuid, p_token_hash text, p_recipient text, p_revoke_link uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = public, internal, pg_temp
as $$
declare
  v_id uuid;
begin
  perform 1 from public.profiles p
  where p.id = p_user_id and p.status = 'approved' and p.role in ('manager', 'edit', 'view')
    and lower(p.email) = lower(p_recipient)
  for no key update;
  if not found then
    raise exception 'not eligible' using errcode = 'insufficient_privilege';
  end if;
  if p_revoke_link is not null then
    update internal.signin_links set revoked_at = now(), revoked_reason = 'send_failed'
     where id = p_revoke_link and user_id = p_user_id and send_status = 'definite_failure'
       and used_at is null and revoked_at is null;
  end if;
  insert into internal.signin_links (user_id, token_hash, recipient_email, created_at, expires_at)
  values (p_user_id, p_token_hash, p_recipient, now(), now() + interval '15 minutes')
  returning id into v_id;
  return v_id;
end
$$;

-- After the one-shot send: record the outcome without ever leaving definite_failure.
create function internal.auth_link_record_send(p_link_id uuid, p_status text, p_error_code text, p_provider_message_id text)
returns void
language plpgsql
volatile
security definer
set search_path = public, internal, pg_temp
as $$
begin
  if p_status not in ('accepted', 'unknown', 'definite_failure') then
    raise exception 'invalid send status';
  end if;
  update internal.signin_links l
     set send_status = case
           when l.send_status = 'definite_failure' then l.send_status
           when l.send_status = 'accepted' and p_status <> 'definite_failure' then l.send_status
           else p_status end,
         send_error_code = case
           when l.send_status = 'definite_failure' then l.send_error_code
           when p_status = 'definite_failure' then coalesce(p_error_code, 'unspecified')
           else coalesce(p_error_code, l.send_error_code) end,     -- diagnostic only for unknown
         provider_request_id = coalesce(l.provider_request_id, p_provider_message_id),
         send_attempted_at = coalesce(l.send_attempted_at, now())
   where l.id = p_link_id;
end
$$;

-- Opening the email: is this link currently valid? Does not consume it.
create function internal.auth_link_check(p_token_hash text)
returns table (recipient_email text)
language sql
stable
security definer
set search_path = public, internal, pg_temp
as $$
  select l.recipient_email
  from internal.signin_links l
  join public.profiles p on p.id = l.user_id
  where l.token_hash = p_token_hash
    and l.used_at is null and l.revoked_at is null and l.expires_at > now()
    and p.status = 'approved' and p.role in ('manager', 'edit', 'view')
    and lower(p.email) = lower(l.recipient_email)
$$;

-- The button: redeem under I2 then A2, create the session. Returns the session id or null.
create function internal.auth_link_redeem(p_token_hash text, p_session_hash text)
returns uuid
language plpgsql
volatile
security definer
set search_path = public, internal, pg_temp
as $$
declare
  v_uid     uuid;
  v_email   text;
  v_link    uuid;
  v_session uuid;
begin
  -- I1 in SHARE mode: emergency sign-out holds I1 exclusively, so it never interleaves with
  -- this credential path (Hunter decision 2026-10-21; doc 15 section 29).
  perform 1 from internal.roster_lock for share;
  select l.user_id into v_uid from internal.signin_links l where l.token_hash = p_token_hash;
  if v_uid is null then return null; end if;

  select p.email into v_email from public.profiles p
  where p.id = v_uid and p.status = 'approved' and p.role in ('manager', 'edit', 'view')
  for no key update;
  if v_email is null then return null; end if;

  select l.id into v_link from internal.signin_links l
  where l.token_hash = p_token_hash and l.user_id = v_uid
    and l.used_at is null and l.revoked_at is null and l.expires_at > clock_timestamp()
    and lower(l.recipient_email) = lower(v_email)
  for update;
  if v_link is null then return null; end if;
  -- After every lock (I1 share, I2, A2): the link may have expired while waiting.
  if not exists (select 1 from internal.signin_links l
                 where l.id = v_link and l.expires_at > clock_timestamp()) then
    return null;
  end if;

  update internal.signin_links set used_at = now() where id = v_link;
  insert into internal.app_sessions (user_id, token_hash, kind, email_at_issue, created_at, last_seen_at,
                                     idle_window, expires_at, absolute_expires_at)
  values (v_uid, p_session_hash, 'link', v_email, now(), now(),
          interval '30 days', now() + interval '30 days', now() + interval '90 days')
  returning id into v_session;
  insert into internal.auth_events (user_id, kind) values (v_uid, 'link_redeemed');
  return v_session;
end
$$;

-- GET /api/session: the caller's own identity from the session row (no profile read policy).
create function internal.auth_session_info()
returns table (user_id uuid, full_name text, email text, role user_role, kind text,
               expires_at timestamptz, absolute_expires_at timestamptz)
language sql
stable
security definer
set search_path = public, internal, pg_temp
as $$
  select cs.user_id, p.full_name, p.email, cs.role, cs.kind, cs.expires_at, cs.absolute_expires_at
  from internal.current_session() cs
  join public.profiles p on p.id = cs.user_id
$$;

-- Deliberate use (navigation, mutation, activity ping): kind-dependent renewal, throttled.
create function internal.auth_session_touch() returns void
language plpgsql
volatile
security definer
set search_path = public, internal, pg_temp
as $$
declare
  v_uid uuid := internal.lock_and_validate(array['manager','edit','view']::user_role[], array['link','recovery'], '{}', false, 'update');
begin
  update internal.app_sessions s
     set last_seen_at = now(),
         expires_at = least(now() + s.idle_window, s.absolute_expires_at)
   where s.token_hash = nullif(current_setting('app.session_hash', true), '')
     and s.user_id = v_uid
     and s.revoked_at is null
     and s.last_seen_at <= now() - case s.kind when 'recovery' then interval '1 minute' else interval '5 minutes' end;
end
$$;

-- Sign out this session only (works for expired sessions too).
create function internal.auth_session_revoke() returns void
language sql
volatile
security definer
set search_path = public, internal, pg_temp
as $$
  update internal.app_sessions
     set revoked_at = now(), revoked_reason = 'signed_out'
   where token_hash = nullif(current_setting('app.session_hash', true), '')
     and revoked_at is null
$$;

-- Verified webhook evidence (QQ route.ts:869-908, 973-1027, 510-538). Order: lock the link
-- row; the recipient must match the snapshot; the sg_message_id fills once and a different one
-- is rejected; the event id is unique (replays are no-ops); only then delivery and block
-- updates. Blocking is gated here too: bounced/complained/suppressed always; a drop only for a
-- recipient-specific reason. Quota or configuration drops never block a recipient.
create function internal.auth_apply_send_evidence(
  p_event_id text, p_link_id uuid, p_email text, p_message_id text, p_event_type text, p_reason text,
  p_status text, p_delivered boolean, p_occurred_at timestamptz
) returns boolean
language plpgsql
volatile
security definer
set search_path = public, internal, pg_temp
as $$
declare
  v_recipient text;
  v_message   text;
  v_blocks    boolean;
begin
  if p_status not in ('accepted', 'unknown', 'definite_failure') then
    raise exception 'invalid evidence status';
  end if;
  select l.recipient_email, l.provider_message_id into v_recipient, v_message
  from internal.signin_links l where l.id = p_link_id
  for update;
  if v_recipient is null or lower(v_recipient) <> lower(p_email) then
    return false;                                          -- not our recipient
  end if;
  if p_message_id is not null and v_message is not null and v_message <> p_message_id then
    insert into internal.auth_events (kind, detail) values ('webhook_message_id_mismatch', jsonb_build_object('link', p_link_id));
    return false;                                          -- conflicting message id: nothing updated
  end if;

  insert into internal.email_events (provider_event_id, link_id, recipient_email, provider_message_id,
                                     event_type, reason_code, occurred_at)
  values (p_event_id, p_link_id, lower(v_recipient), p_message_id, p_event_type, left(p_reason, 500), p_occurred_at)
  on conflict (provider_event_id) do nothing;
  if not found then
    return false;                                          -- replay
  end if;

  update internal.signin_links l
     set provider_message_id = coalesce(l.provider_message_id, p_message_id),
         send_status = case
           when l.send_status = 'definite_failure' then l.send_status
           when l.send_status = 'accepted' and p_status <> 'definite_failure' then l.send_status
           when l.send_status = 'unknown' and p_status = 'pending' then l.send_status
           else p_status end,
         send_error_code = case
           when l.send_status <> 'definite_failure' and p_status = 'definite_failure' then coalesce(l.send_error_code, 'provider_' || p_event_type)
           else l.send_error_code end,
         send_attempted_at = coalesce(l.send_attempted_at, p_occurred_at),
         delivered_at = case when p_delivered then coalesce(l.delivered_at, p_occurred_at) else l.delivered_at end
   where l.id = p_link_id;

  v_blocks := p_event_type in ('bounced', 'complained', 'suppressed')
              or (p_event_type = 'failed'
                  and p_reason in ('Bounced Address', 'Unsubscribed Address', 'Spam Reporting Address', 'Invalid Address'));
  if v_blocks then
    -- A4: newer evidence only; a manual clear is not undone by an older event.
    insert into internal.blocked_email_addresses as b (normalized_email, reason, evidence_at, evidence_event)
    values (lower(v_recipient), p_event_type, p_occurred_at, p_event_id)
    on conflict (normalized_email) do update
      set reason = excluded.reason, evidence_at = excluded.evidence_at, evidence_event = excluded.evidence_event,
          cleared_at = null, cleared_by = null
      where excluded.evidence_at > b.evidence_at
        and (b.cleared_at is null or excluded.evidence_at > b.cleared_at);
  end if;
  return true;
end
$$;

-- ----------------------------------------------------------------------------
-- 9. Team (roster) functions. Always roster lock + target and actor in id order.
--    Adding people is not created here (it depends on the UNAPPROVED proposal D8).
-- ----------------------------------------------------------------------------
create function public.team_list()
returns table (id uuid, email text, full_name text, role user_role, status user_status, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = public, internal, pg_temp
as $$
begin
  if not coalesce(internal.is_manager(), false) then
    raise exception 'not permitted' using errcode = 'insufficient_privilege';
  end if;
  return query select p.id, p.email, p.full_name, p.role, p.status, p.created_at
               from public.profiles p order by p.created_at;
end
$$;

create function public.team_update(p_target uuid, p_full_name text, p_role user_role, p_email text)
returns void
language plpgsql
volatile
security definer
set search_path = public, internal, pg_temp
as $$
declare
  v_actor uuid := internal.lock_and_validate(array['manager']::user_role[], array['link'], array[p_target], true);
  v_old   public.profiles%rowtype;
  v_email text := lower(btrim(p_email));
begin
  select * into v_old from public.profiles where id = p_target;
  if p_role is not null and p_role not in ('manager', 'edit', 'view') then
    raise exception 'invalid role' using errcode = 'check_violation';
  end if;
  if p_target = v_actor and ((p_role is not null and p_role is distinct from v_old.role)
                             or (p_email is not null and v_email is distinct from lower(v_old.email))) then
    raise exception 'you cannot change your own role or email' using errcode = 'insufficient_privilege';
  end if;
  if v_old.role = 'manager' and v_old.status = 'approved' and p_role is not null and p_role <> 'manager'
     and not exists (select 1 from public.profiles m where m.role = 'manager' and m.status = 'approved' and m.id <> p_target) then
    raise exception 'the last active manager cannot be demoted' using errcode = 'check_violation';
  end if;
  if p_email is not null and v_email is distinct from lower(v_old.email) then
    if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
      raise exception 'invalid email' using errcode = 'check_violation';
    end if;
    if exists (select 1 from public.profiles o where lower(o.email) = v_email and o.id <> p_target and o.status = 'approved') then
      raise exception 'email already used by an active person' using errcode = 'unique_violation';
    end if;
  end if;
  update public.profiles
     set full_name = coalesce(p_full_name, full_name),
         role = coalesce(p_role, role),
         email = case when p_email is null then email else v_email end
   where id = p_target;
  insert into internal.auth_events (user_id, kind, detail)
  values (p_target, 'team_update', jsonb_build_object('by', v_actor));
end
$$;

create function public.team_set_active(p_target uuid, p_active boolean)
returns void
language plpgsql
volatile
security definer
set search_path = public, internal, pg_temp
as $$
declare
  v_actor uuid := internal.lock_and_validate(array['manager']::user_role[], array['link'], array[p_target], true);
  v_old   public.profiles%rowtype;
begin
  select * into v_old from public.profiles where id = p_target;
  if p_target = v_actor then
    raise exception 'you cannot change your own status' using errcode = 'insufficient_privilege';
  end if;
  if p_active and v_old.role not in ('manager', 'edit', 'view') then
    raise exception 'choose a role before activating this person' using errcode = 'check_violation';
  end if;
  if not p_active and v_old.role = 'manager' and v_old.status = 'approved'
     and not exists (select 1 from public.profiles m where m.role = 'manager' and m.status = 'approved' and m.id <> p_target) then
    raise exception 'the last active manager cannot be deactivated' using errcode = 'check_violation';
  end if;
  update public.profiles
     set status = case when p_active then 'approved'::user_status else 'disabled'::user_status end,
         approved_by = case when p_active then v_actor else approved_by end,
         approved_at = case when p_active then now() else approved_at end
   where id = p_target;
  insert into internal.auth_events (user_id, kind, detail)
  values (p_target, case when p_active then 'team_reactivate' else 'team_deactivate' end, jsonb_build_object('by', v_actor));
end
$$;

create function public.team_block_clear(p_email text)
returns void
language plpgsql
volatile
security definer
set search_path = public, internal, pg_temp
as $$
declare
  v_actor uuid := internal.lock_and_validate(array['manager']::user_role[], array['link']);
begin
  update internal.blocked_email_addresses
     set cleared_at = now(), cleared_by = v_actor
   where normalized_email = lower(btrim(p_email)) and cleared_at is null;
  insert into internal.auth_events (user_id, kind, detail)
  values (v_actor, 'email_block_cleared', '{}'::jsonb);
end
$$;

-- Emergency sign-everyone-out (Hunter decision 4, 2026-10-21). Admin class only = manager:
-- the only role with Team/account administration (20260720001200_rls.sql:82 profiles_update_mgr,
-- 20260723004500_profile_service_bootstrap.sql:16-20 guard_profile_update; app router.tsx:77
-- RequireManager on the Users page). One atomic revocation of EVERY live app session,
-- including recovery sessions and the actor's own, plus an actor audit row.
-- OPEN DECISION (not settled here): whether this also invalidates recovery/SMS enrollments.
-- Recovery code sets are deliberately left untouched.
create function public.team_sign_everyone_out()
returns int
language plpgsql
volatile
security definer
set search_path = public, internal, pg_temp
as $$
declare
  -- Holds I1 exclusively (p_roster = true) for the whole transaction. Every credential path
  -- (mint, redeem, recovery enroll, recovery consume) takes I1 in SHARE mode first, so a
  -- concurrent one either commits before this starts (and its link, session or codes are
  -- revoked below) or waits and then finds everything revoked. Hunter decision 2026-10-21.
  v_actor    uuid := internal.lock_and_validate(array['manager']::user_role[], array['link'], '{}', true);
  v_sessions int;
  v_links    int;
  v_sets     int;
  v_codes    int;
begin
  -- All active staff sessions, normal and recovery, the actor's own included.
  update internal.app_sessions
     set revoked_at = clock_timestamp(), revoked_reason = 'emergency_sign_out'
   where revoked_at is null;
  get diagnostics v_sessions = row_count;
  -- All unused sign-in links (used links stay as they are, for audit).
  update internal.signin_links
     set revoked_at = clock_timestamp(), revoked_reason = 'emergency_sign_out'
   where used_at is null and revoked_at is null;
  get diagnostics v_links = row_count;
  -- All unused recovery credentials (held feature; used codes stay as they are).
  update internal.recovery_sets
     set revoked_at = clock_timestamp(), revoked_reason = 'emergency_sign_out'
   where revoked_at is null;
  get diagnostics v_sets = row_count;
  update internal.recovery_codes
     set revoked_at = clock_timestamp(), revoked_reason = 'emergency_sign_out'
   where used_at is null and revoked_at is null;
  get diagnostics v_codes = row_count;
  insert into internal.auth_events (user_id, kind, detail)
  values (v_actor, 'emergency_sign_out', jsonb_build_object(
    'sessions_revoked', v_sessions, 'links_cancelled', v_links,
    'recovery_sets_cancelled', v_sets, 'recovery_codes_cancelled', v_codes));
  return v_sessions;
end
$$;

-- ----------------------------------------------------------------------------
-- 10. Recovery codes (disabled until policy D2; every function checks recovery_policy)
-- ----------------------------------------------------------------------------
create function internal.recovery_require_enabled() returns void
language plpgsql
stable
security definer
set search_path = public, internal, pg_temp
as $$
begin
  if not (select rp.enabled from internal.recovery_policy rp) then
    raise exception 'recovery codes are disabled' using errcode = 'feature_not_supported';
  end if;
end
$$;

-- Enrollment: self as target (FOR NO KEY UPDATE once), fresh link session, one active set.
create function public.recovery_enroll(p_code_hashes text[])
returns uuid
language plpgsql
volatile
security definer
set search_path = public, internal, pg_temp
as $$
declare
  v_uid uuid;
  v_set uuid;
  v_created timestamptz;
begin
  perform internal.recovery_require_enabled();
  select cs.user_id into v_uid from internal.current_session() cs;
  if v_uid is null then
    raise exception 'not permitted' using errcode = 'insufficient_privilege';
  end if;
  -- I1 in SHARE mode: emergency sign-out holds I1 exclusively, so it never interleaves with
  -- this credential path (Hunter decision 2026-10-21; doc 15 section 29).
  perform 1 from internal.roster_lock for share;
  perform internal.lock_and_validate(array['manager','edit','view']::user_role[], array['link'], array[v_uid]);
  select s.created_at into v_created from internal.app_sessions s
  where s.token_hash = nullif(current_setting('app.session_hash', true), '');
  if v_created < now() - interval '15 minutes' then
    raise exception 'sign in again by email link to create recovery codes' using errcode = 'insufficient_privilege';
  end if;
  if cardinality(p_code_hashes) <> 10 then
    raise exception 'exactly 10 codes are required' using errcode = 'check_violation';
  end if;
  update internal.recovery_sets set revoked_at = now(), revoked_reason = 'regenerated'
   where user_id = v_uid and revoked_at is null;
  update internal.recovery_codes set revoked_at = now(), revoked_reason = 'regenerated'
   where user_id = v_uid and used_at is null and revoked_at is null;
  insert into internal.recovery_sets (user_id) values (v_uid) returning id into v_set;
  insert into internal.recovery_codes (set_id, user_id, code_hash, expires_at)
  select v_set, v_uid, h, now() + interval '180 days' from unnest(p_code_hashes) h;
  insert into internal.auth_events (user_id, kind) values (v_uid, 'recovery_set_created');
  return v_set;
end
$$;

-- Per-address failure ceilings (keyed by email hash; no user lookup, no lock).
create function internal.recovery_failures_allow(p_email_hash text, p_day_start timestamptz, p_day_end timestamptz)
returns boolean
language sql
stable
security definer
set search_path = public, internal, pg_temp
as $$
  select (select count(*) from internal.recovery_failures f where f.email_hash = p_email_hash and f.at > now() - interval '1 hour') < 5
     and (select count(*) from internal.recovery_failures f where f.email_hash = p_email_hash and f.at >= p_day_start and f.at < p_day_end) < 10
$$;

create function internal.recovery_record_failure(p_email_hash text) returns void
language sql
volatile
security definer
set search_path = public, internal, pg_temp
as $$ insert into internal.recovery_failures (email_hash) values (p_email_hash) $$;

-- Consumption (doc 15 §14.5): non-locking pre-check; profile lock only after a valid code;
-- consume; revalidate; recovery session. Returns the session id or null.
create function internal.recovery_consume(p_email text, p_code_hash text, p_session_hash text)
returns uuid
language plpgsql
volatile
security definer
set search_path = public, internal, pg_temp
as $$
declare
  v_code    uuid;
  v_uid     uuid;
  v_email   text;
  v_session uuid;
begin
  perform internal.recovery_require_enabled();
  select c.id, c.user_id into v_code, v_uid
  from internal.recovery_codes c
  join internal.recovery_sets s on s.id = c.set_id
  join public.profiles p on p.id = c.user_id
  where c.code_hash = p_code_hash and lower(p.email) = lower(p_email)
    and c.used_at is null and c.revoked_at is null and s.revoked_at is null and c.expires_at > now();
  if v_code is null then return null; end if;                 -- no lock taken

  -- I1 in SHARE mode: emergency sign-out holds I1 exclusively, so it never interleaves with
  -- this credential path (Hunter decision 2026-10-21; doc 15 section 29).
  perform 1 from internal.roster_lock for share;

  select p.email into v_email from public.profiles p
  where p.id = v_uid and p.status = 'approved' and p.role in ('manager', 'edit', 'view')
  for share;
  if v_email is null or lower(v_email) <> lower(p_email) then return null; end if;

  update internal.recovery_codes set used_at = now()
   where id = v_code and used_at is null and revoked_at is null and expires_at > clock_timestamp();
  if not found then return null; end if;

  insert into internal.app_sessions (user_id, token_hash, kind, email_at_issue, created_at, last_seen_at,
                                     idle_window, expires_at, absolute_expires_at, recovery_code_id)
  values (v_uid, p_session_hash, 'recovery', v_email, now(), now(),
          interval '1 hour', now() + interval '1 hour', now() + interval '12 hours', v_code)
  returning id into v_session;
  -- Written before COMMIT, so delivery of the session is unconfirmed here.
  insert into internal.auth_events (user_id, kind, detail)
  values (v_uid, 'recovery_code_used', jsonb_build_object('session_delivery', 'unconfirmed'));
  return v_session;
end
$$;

-- Recovery reads: recovery sessions only, explicit columns, no contact details or notes.
create function public.recovery_batches()
returns table (id uuid, name text, customer text, job text, created_at timestamptz, counts_by_status jsonb)
language plpgsql
stable
security definer
set search_path = public, internal, pg_temp
as $$
begin
  perform internal.recovery_require_enabled();
  if not exists (select 1 from internal.current_session() cs where cs.kind = 'recovery') then
    raise exception 'not permitted' using errcode = 'insufficient_privilege';
  end if;
  return query
  select b.id, b.name, b.customer, b.job, b.created_at,
         coalesce((select jsonb_object_agg(x.status, x.n) from (
           select bc.status::text as status, count(*) as n from public.batch_carriers bc
           where bc.batch_id = b.id group by bc.status) x), '{}'::jsonb)
  from public.batches b
  where b.archived_at is null
  order by b.created_at desc;
end
$$;

create function public.recovery_batch_members(p_batch_id uuid, p_limit int, p_offset int)
returns table (dot_number bigint, legal_name text, dba_name text, phy_city text, phy_state text,
               status batch_carrier_status, status_changed_at timestamptz, is_dnc boolean)
language plpgsql
stable
security definer
set search_path = public, internal, pg_temp
as $$
begin
  perform internal.recovery_require_enabled();
  if not exists (select 1 from internal.current_session() cs where cs.kind = 'recovery') then
    raise exception 'not permitted' using errcode = 'insufficient_privilege';
  end if;
  return query
  select c.dot_number, c.legal_name, c.dba_name, c.phy_city, c.phy_state, bc.status, bc.status_changed_at,
         (c.do_not_contact or exists (
            select 1 from public.contact_suppressions cs
            where cs.dot_number = c.dot_number and cs.channel::text = 'all' and cs.value is null
              and (cs.expires_at is null or cs.expires_at > now())))
  from public.batch_carriers bc
  join public.carriers c on c.dot_number = bc.dot_number
  where bc.batch_id = p_batch_id
  order by c.legal_name, c.dot_number
  limit least(greatest(coalesce(p_limit, 100), 1), 500) offset greatest(coalesce(p_offset, 0), 0);
end
$$;

-- Recovery write: recovery kind AND the person's ordinary role must be editor or manager.
create function public.recovery_set_status(p_batch_id uuid, p_dot bigint, p_status batch_carrier_status)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, internal, pg_temp
as $$
begin
  perform internal.recovery_require_enabled();
  perform internal.lock_and_validate(array['manager','edit']::user_role[], array['recovery']);
  perform 1 from public.batches where id = p_batch_id for key share;                -- B1
  perform 1 from public.batch_carriers where batch_id = p_batch_id and dot_number = p_dot for no key update;  -- B3
  if not found then return false; end if;
  perform internal.recheck_session();
  if exists (select 1 from public.carriers c where c.dot_number = p_dot and c.do_not_contact) then
    raise exception 'carrier is do-not-contact' using errcode = 'check_violation';
  end if;
  update public.batch_carriers set status = p_status
   where batch_id = p_batch_id and dot_number = p_dot and status is distinct from p_status;
  insert into internal.auth_events (user_id, kind, detail)
  values (internal.current_staff_id(), 'recovery_status_change', jsonb_build_object('batch', p_batch_id, 'dot', p_dot));
  return true;
end
$$;

create function public.team_recovery_revoke(p_target uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public, internal, pg_temp
as $$
declare
  v_actor uuid := internal.lock_and_validate(array['manager']::user_role[], array['link'], array[p_target]);
begin
  update internal.recovery_sets set revoked_at = now(), revoked_reason = 'manager_revoked'
   where user_id = p_target and revoked_at is null;
  update internal.recovery_codes set revoked_at = now(), revoked_reason = 'manager_revoked'
   where user_id = p_target and used_at is null and revoked_at is null;
  insert into internal.auth_events (user_id, kind, detail)
  values (p_target, 'recovery_revoked', jsonb_build_object('by', v_actor));
end
$$;

-- ----------------------------------------------------------------------------
-- 11. Grants: the public key reaches nothing; recruiter_api gets the old app surface.
-- ----------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
revoke execute on all functions in schema internal from public, anon, authenticated;
revoke usage on schema internal from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
alter default privileges in schema internal revoke execute on functions from public, anon, authenticated;

grant usage on schema public, internal to recruiter_api;
grant select on all tables in schema public to recruiter_api;        -- RLS decides rows
grant usage, select on all sequences in schema public to recruiter_api;

grant insert (name, customer, job, description, created_by, search_definition, snapshot_taken_at),
      update (name, customer, job, description, archived_at),
      delete
  on public.batches to recruiter_api;
grant insert, update, delete on public.batch_zones to recruiter_api;
grant insert (batch_id, dot_number), update (status, promoted_at), delete on public.batch_carriers to recruiter_api;
grant update (contact_name_override, contact_phone_override, contact_email_override) on public.carriers to recruiter_api;
grant update (match_group, is_sand_gravel) on public.cargo_other_values to recruiter_api;
grant insert, delete on public.contact_logs to recruiter_api;
grant insert, delete on public.batch_activity to recruiter_api;
grant insert, delete on public.contact_suppressions to recruiter_api;

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
  public.is_contactable(bigint, contact_channel),
  public.team_list(),
  public.team_update(uuid, text, user_role, text),
  public.team_set_active(uuid, boolean),
  public.team_block_clear(text),
  public.team_recovery_revoke(uuid),
  public.team_sign_everyone_out(),
  public.recovery_enroll(text[]),
  public.recovery_batches(),
  public.recovery_batch_members(uuid, int, int),
  public.recovery_set_status(uuid, bigint, batch_carrier_status)
  to recruiter_api;

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
  internal.is_contactable(bigint, contact_channel),
  internal.current_session(),
  internal.current_staff_id(),
  internal.is_app_login(),
  internal.lock_and_validate(user_role[], text[], uuid[], boolean, text),
  internal.actor_can_write(user_role[]),
  internal.member_write_ok(user_role[], uuid, text),
  internal.suppression_write_ok(user_role[], bigint),
  internal.auth_bucket_hit(text, text, text),
  internal.auth_mint_lock(text, timestamptz, timestamptz),
  internal.auth_mint_insert(uuid, text, text, uuid),
  internal.auth_link_record_send(uuid, text, text, text),
  internal.auth_link_check(text),
  internal.auth_link_redeem(text, text),
  internal.auth_session_info(),
  internal.auth_session_touch(),
  internal.auth_session_revoke(),
  internal.auth_apply_send_evidence(text, uuid, text, text, text, text, text, boolean, timestamptz),
  internal.recovery_require_enabled(),
  internal.recovery_failures_allow(text, timestamptz, timestamptz),
  internal.recovery_record_failure(text),
  internal.recovery_consume(text, text, text)
  to recruiter_api;

-- Retention job (QQ retention.ts pattern): delete aged auth rows only.
grant usage on schema internal to recruiter_maintenance;
grant select, delete on internal.auth_request_buckets, internal.signin_links, internal.app_sessions,
                       internal.email_events, internal.recovery_failures to recruiter_maintenance;

-- Service role keeps its pipeline/operator grants (20260720001500, 20260722223300).
grant execute on all functions in schema internal to service_role;

-- ----------------------------------------------------------------------------
-- 12. Realtime: not used by the app; remove the publication members (reversible).
-- ----------------------------------------------------------------------------
do $realtime$
declare
  t text;
begin
  foreach t in array array['batches', 'batch_zones', 'batch_carriers', 'batch_activity', 'contact_logs', 'profiles'] loop
    if exists (select 1 from pg_publication_tables
               where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime drop table public.%I', t);
    end if;
  end loop;
end
$realtime$;

-- ----------------------------------------------------------------------------
-- 13. Re-apply the hardening search_path to every function this migration (re)defined,
--     exactly as 20260722223300_security_hardening.sql does.
-- ----------------------------------------------------------------------------
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
