-- ============================================================================
-- supabase-shim.sql -- A3 test cluster ONLY. Recreates the small part of a Supabase database the
-- migrations rely on, so they can run on a plain PostgreSQL 16 cluster without Supabase or PostGIS.
-- EVIDENCE LIMITS (stated in every A3 report):
--   * Not Supabase: no PostgREST, GoTrue, Realtime or Storage services; only their roles/schema.
--   * Not PostGIS: geography/geometry are text domains holding WKT and the ST_* functions below are
--     simple stand-ins (great-circle distance to points/vertices). Map and matcher geometry is
--     therefore NOT proven here; only authorization, ledgers, locking and the data paths are.
--   * pg_trgm and citext DLLs are blocked by Windows Application Control on this machine: trigram
--     indexes are skipped and citext is a plain text domain (no case-insensitive comparison).
--   * PostgreSQL 16.15, while hosted Supabase runs PostgreSQL 15.
-- ============================================================================

-- Supabase's API roles (no login) and their default grants on public.
do $roles$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end
$roles$;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

-- GoTrue's schema, reduced to what the migrations and staging fixtures use.
create schema auth;
create table auth.users (
  instance_id uuid,
  id uuid primary key,
  aud text,
  role text,
  email text,
  encrypted_password text,
  raw_app_meta_data jsonb,
  raw_user_meta_data jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  is_sso_user boolean default false,
  is_anonymous boolean default false,
  email_confirmed_at timestamptz,
  confirmation_token text default '',
  recovery_token text default '',
  email_change_token_new text default '',
  email_change_token_current text default '',
  phone_change_token text default '',
  reauthentication_token text default ''
);
create table auth.sessions (id uuid primary key, user_id uuid);
create table auth.refresh_tokens (id bigserial primary key, session_id uuid, revoked boolean default false);
create table auth.one_time_tokens (id uuid primary key, user_id uuid);
create table auth.flow_state (id uuid primary key);

create function auth.uid() returns uuid language sql stable as $$
  select nullif(coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                         nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'), '')::uuid
$$;
create function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
                  nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
$$;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;

create publication supabase_realtime;

-- citext stand-in (case-insensitive comparison NOT reproduced; evidence limit).
create domain citext as text;

-- PostGIS stand-ins (text WKT).
create domain geometry as text;
create domain geography as text;
create function st_makepoint(x float8, y float8) returns geometry language sql immutable as
$$ select ('POINT(' || x || ' ' || y || ')')::geometry $$;
create function st_setsrid(g geometry, srid int) returns geometry language sql immutable as $$ select g $$;
create function st_makeline(pts geometry[]) returns geometry language sql immutable as
$$ select ('LINESTRING(' || array_to_string(array(select regexp_replace(p::text, '^POINT\((.*)\)$', '\1') from unnest(pts) p), ', ') || ')')::geometry $$;
create function geometrytype(g geometry) returns text language sql immutable as
$$ select upper(split_part(g::text, '(', 1)) $$;
create function st_x(g geometry) returns float8 language sql immutable as
$$ select split_part(regexp_replace(g::text, '^POINT\((.*)\)$', '\1'), ' ', 1)::float8 $$;
create function st_y(g geometry) returns float8 language sql immutable as
$$ select split_part(regexp_replace(g::text, '^POINT\((.*)\)$', '\1'), ' ', 2)::float8 $$;
-- Great-circle distance from a point to the nearest vertex of the other shape, in metres.
create function st_dwithin(a geography, b geography, r float8) returns boolean language sql immutable as $$
  with pa as (
    select split_part(regexp_replace(a::text, '^POINT\((.*)\)$', '\1'), ' ', 1)::float8 as x,
           split_part(regexp_replace(a::text, '^POINT\((.*)\)$', '\1'), ' ', 2)::float8 as y
  ), vb as (
    select split_part(btrim(v), ' ', 1)::float8 as x, split_part(btrim(v), ' ', 2)::float8 as y
    from unnest(string_to_array(regexp_replace(b::text, '^[A-Z]+\((.*)\)$', '\1'), ',')) v
  )
  select coalesce(min(6371000 * 2 * asin(sqrt(
           power(sin(radians(vb.y - pa.y) / 2), 2) +
           cos(radians(pa.y)) * cos(radians(vb.y)) * power(sin(radians(vb.x - pa.x) / 2), 2)))) <= r, false)
  from pa, vb
$$;
