-- ============================================================================
-- 20260720000100_extensions.sql
-- Extensions + the internal (non-PostgREST-exposed) schema.
-- Spec: docs/build-plan/01-architecture.md Part A §2.1; amendment #7 (citext).
-- ============================================================================

create extension if not exists postgis;   -- geo: ST_DWithin radius + corridor (F6/F13/F21, G1)
create extension if not exists pg_trgm;   -- fuzzy match on cargo other-desc + carrier names (F14, brief §4)
create extension if not exists citext;    -- case-insensitive carriers.email_address (01 reconciliation amendment #7)
-- gen_random_uuid() is built-in on Postgres 15 (pgcrypto not required).

create schema if not exists internal;
comment on schema internal is
  'Helpers, the matching-carriers keystone, and trigger functions. Not in PostgREST''s '
  'exposed schemas (api.schemas in config.toml only lists public/graphql_public). '
  'Blanket-revoked from anon/authenticated below; individual migrations grant EXECUTE '
  'on specific functions back to authenticated as they are created (01 §1).';

-- Default-deny on the schema itself; later migrations grant EXECUTE on the
-- individual internal.* functions that SECURITY INVOKER public RPCs call into.
revoke all on schema internal from anon, authenticated;
