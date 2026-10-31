-- ============================================================================
-- auth-schema-inventory.sql -- READ-ONLY schema inventory of the `auth` schema. NOT EXECUTED.
-- Re-review of the production SQL runner (finding B1): the repository holds no authoritative list of
-- the hosted auth tables, so the L1 shape gate cannot be given a reviewed table list from this checkout.
-- This file is the safe way to obtain one: it reads the system catalogue only, never a row of any table.
--
-- WHAT IT RETURNS (names and types only; no row data, no JSON payload, no token, no hash, no secret):
--   1. every relation in schema `auth` (tables, partitioned tables, views, materialized views, foreign
--      tables) with each column's name, data type and NOT NULL flag;
--   2. every foreign key in schema `auth` as the catalogue prints it (column names, referenced table and
--      column names, ON DELETE / ON UPDATE actions), so cascade behaviour can be reviewed.
-- It reads pg_catalog only (not information_schema, which hides what the connecting role cannot use), so the
-- listing is complete for every role. It never names a table in `auth` after FROM or JOIN.
--
-- HOW IT IS RUN (later, with separate approval, on the rebuilt staging project only):
--   the `auth-schema-inventory` action of pipeline/src/staging-sql-runner.ts (--project=rebuilt). The runner
--   opens `begin read only` before sending this file and always rolls back after it, so a write would be refused
--   by the server as well. The file carries no transaction control of its own. The result is written to a local
--   file outside the repository; the terminal shows fixed events only.
-- A staging capture is evidence for a production review. It is not proof that production matches it.
-- ============================================================================

set local statement_timeout = '5s';
set local lock_timeout = '1s';

select c.relname as relation_name,
       c.relkind,
       a.attname as column_name,
       pg_catalog.format_type(a.atttypid, a.atttypmod) as column_type,
       a.attnotnull
from pg_catalog.pg_namespace n
join pg_catalog.pg_class c on c.relnamespace = n.oid
left join pg_catalog.pg_attribute a
  on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
where n.nspname = 'auth' and c.relkind in ('r', 'p', 'v', 'm', 'f')
order by c.relname, a.attnum;

select c.relname as relation_name,
       k.conname,
       pg_catalog.pg_get_constraintdef(k.oid) as foreign_key_definition
from pg_catalog.pg_constraint k
join pg_catalog.pg_class c on c.oid = k.conrelid
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'auth' and k.contype = 'f'
order by c.relname, k.conname;
