// EXACT expected catalogue text for the retained M1c audit objects, used by the reapply-m1c state probe
// (reapply.ts). Derived from a FRESH local apply of supabase/pending/M1c_batch_delete_audit.sql on PostgreSQL 16:
//   pg_get_functiondef('internal.batch_delete_audit_append_only()')   (whitespace collapsed to single spaces)
//   the table canonical text built by TABLE_CANON_SQL below
// Nothing here is a heuristic: the probe compares the live text for EQUALITY with these constants. The
// real-catalogue test (reapply-m1c-a3.test.ts) proves a fresh apply matches them, and pipeline/src/smoke-tests.ts
// proves the function body here is the body in the reviewed M1c file, so a future edit of that file that is
// not mirrored here fails the offline checks.

/** The function definition M1c creates, as pg_get_functiondef prints it, whitespace-collapsed. */
export const AUDIT_FN_DEF_M1C = [
  'CREATE OR REPLACE FUNCTION internal.batch_delete_audit_append_only()',
  'RETURNS trigger',
  'LANGUAGE plpgsql',
  "SET search_path TO 'internal', 'pg_temp'",
  'AS $function$',
  'begin',
  "raise exception 'internal.batch_delete_audit is append-only' using errcode = 'insufficient_privilege';",
  'end',
  '$function$',
].join(' ');

/** The same function after M1's pinning step (a backed-out database that has had M1 re-applied): only the SET differs. */
export const AUDIT_FN_DEF_M1_PINNED = AUDIT_FN_DEF_M1C.replace("SET search_path TO 'internal', 'pg_temp'", "SET search_path TO 'public', 'internal', 'pg_temp'");

/** The reviewed raise statement and body markers, checked against the M1c file by the offline smoke test. */
export const AUDIT_FN_BODY_M1C = "begin\n  raise exception 'internal.batch_delete_audit is append-only' using errcode = 'insufficient_privilege';\nend";

/** Collapse whitespace the way the SQL probe does (regexp_replace(x, '\s+', ' ', 'g') then btrim). */
export const collapseWhitespace = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** SQL (against the table oid in `tb`) that builds the canonical table text compared with TABLE_CANON_M1C. */
export const TABLE_CANON_SQL = `concat_ws(' ## ',
    (select string_agg(format('%s %s notnull=%s default=%s identity=%s generated=%s', a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull, coalesce(pg_get_expr(d.adbin, d.adrelid), '-'), a.attidentity, a.attgenerated), ' ; ' order by a.attnum)
       from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where a.attrelid = tb.oid and a.attnum > 0 and not a.attisdropped),
    (select string_agg(format('%s %s', k.conname, pg_get_constraintdef(k.oid)), ' ; ' order by k.conname) from pg_constraint k where k.conrelid = tb.oid),
    (select string_agg(pg_get_indexdef(i.indexrelid), ' ; ' order by i.indexrelid::regclass::text) from pg_index i where i.indrelid = tb.oid),
    format('relkind=%s rls=%s forcerls=%s persistence=%s rules=%s partition=%s inherit=%s', tb.relkind, tb.relrowsecurity, tb.relforcerowsecurity, tb.relpersistence, tb.relhasrules, tb.relispartition,
           (select count(*) from pg_inherits h where h.inhrelid = tb.oid or h.inhparent = tb.oid)))`;

/** Columns (with types, nullability, defaults, identity, generation), constraints, indexes and table flags of the fresh apply. */
export const TABLE_CANON_M1C = [
  'id bigint notnull=t default=- identity=a generated=',
  'batch_id uuid notnull=t default=- identity= generated=',
  'batch_name text notnull=t default=- identity= generated=',
  'actor_id uuid notnull=t default=- identity= generated=',
  'deleted_at timestamp with time zone notnull=t default=now() identity= generated=',
  'member_count integer notnull=t default=- identity= generated=',
].join(' ; ') + ' ## ' + [
  'batch_delete_audit_member_count_check CHECK ((member_count >= 0))',
  'batch_delete_audit_pkey PRIMARY KEY (id)',
].join(' ; ') + ' ## CREATE UNIQUE INDEX batch_delete_audit_pkey ON internal.batch_delete_audit USING btree (id)'
  + ' ## relkind=r rls=f forcerls=f persistence=p rules=f partition=f inherit=0';
