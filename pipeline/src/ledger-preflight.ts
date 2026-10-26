// Read-only compatibility assessment of the hosted migration ledger (doc 16 section 1.3 step 4 and approval 4),
// run BEFORE the 20-file replay. The replay creates supabase_migrations.schema_migrations when it is absent and
// otherwise writes into whatever is there:
//   create schema if not exists supabase_migrations;
//   create table if not exists ...schema_migrations (version text not null primary key);
//   alter table ... add column if not exists statements text[];  alter table ... add column if not exists name text;
//   insert into ...schema_migrations (version, name, statements) values ($1, $2, array[]::text[])
// so this checks, from the catalogue and as the actual runner login (current_user), that those statements will
// succeed. The contract is EXACT and deliberately narrow: an existing ledger must have only the reviewed columns
// (version text not null, statements text[] or absent, name text or absent) with no default, identity or generation,
// version as its only key, no other constraint, index, trigger, rule or row security, be OWNED BY the runner login
// itself (the unconditional ALTER TABLE ... ADD COLUMN IF NOT EXISTS needs ownership even when the column exists;
// membership in the owner role is not accepted), and be empty. Anything else, or anything uncertain, is a failed
// check: the tool stops and a human decides. The local test runs the real initialization and a ledger insert as
// the same low-privilege login for every scenario that passes. It never changes anything and reports only fixed
// check names, true/false and counts.

import type { RebuiltSqlClient } from './staging-rebuilt.js';

export interface LedgerFacts {
  profiles_absent: boolean;
  schema_exists: boolean;
  table_exists: boolean;
  db_create: boolean;
  schema_usage: boolean | null;
  schema_create: boolean | null;
  table_ordinary: boolean | null;
  version_text_not_null: boolean | null;
  statements_type: string | null;
  name_type: string | null;
  other_columns: number | null;
  special_columns: number | null;
  version_key: boolean | null;
  other_constraints: number | null;
  other_indexes: number | null;
  has_triggers_rules_rls: boolean | null;
  can_select: boolean | null;
  can_insert: boolean | null;
  owner_is_runner: boolean | null;
}

export const LEDGER_PREFLIGHT_SQL = `with
sch as (select n.oid from pg_namespace n where n.nspname = 'supabase_migrations'),
tbl as (select c.oid, c.relowner, c.relkind, c.relrowsecurity, c.relhastriggers
          from pg_class c where c.relnamespace = (select oid from sch) and c.relname = 'schema_migrations'),
cols as (select a.attnum, a.attname, a.atttypid, a.attnotnull, a.atthasdef, a.attidentity, a.attgenerated,
                format_type(a.atttypid, a.atttypmod) as typ
           from pg_attribute a where a.attrelid = (select oid from tbl) and a.attnum > 0 and not a.attisdropped),
keyc as (select c.oid, c.contype, c.conkey, c.conindid from pg_constraint c where c.conrelid = (select oid from tbl)),
vkey as (select k.oid, k.conindid from keyc k
           where k.contype in ('p', 'u') and k.conkey = array[(select attnum from cols where attname = 'version')]::int2[])
select
  to_regclass('public.profiles') is null as profiles_absent,
  exists (select 1 from sch) as schema_exists,
  exists (select 1 from tbl) as table_exists,
  has_database_privilege(current_user, current_database(), 'CREATE') as db_create,
  (select has_schema_privilege(current_user, (select oid from sch), 'USAGE') where exists (select 1 from sch)) as schema_usage,
  (select has_schema_privilege(current_user, (select oid from sch), 'CREATE') where exists (select 1 from sch)) as schema_create,
  (select relkind = 'r' from tbl) as table_ordinary,
  (select exists (select 1 from cols where attname = 'version' and attnotnull and typ = 'text') where exists (select 1 from tbl)) as version_text_not_null,
  (select case when exists (select 1 from cols where attname = 'statements') then (select typ from cols where attname = 'statements') else 'absent' end where exists (select 1 from tbl)) as statements_type,
  (select case when exists (select 1 from cols where attname = 'name') then (select typ from cols where attname = 'name') else 'absent' end where exists (select 1 from tbl)) as name_type,
  (select count(*)::int from cols where attname not in ('version', 'statements', 'name') and exists (select 1 from tbl)) as other_columns,
  (select count(*)::int from cols where attname in ('version', 'statements', 'name') and (atthasdef or attidentity <> '' or attgenerated <> '') and exists (select 1 from tbl)) as special_columns,
  (select exists (select 1 from vkey) where exists (select 1 from tbl)) as version_key,
  (select count(*)::int from keyc where oid not in (select oid from vkey) and exists (select 1 from tbl)) as other_constraints,
  (select count(*)::int from pg_index i where i.indrelid = (select oid from tbl) and i.indexrelid not in (select conindid from vkey) and exists (select 1 from tbl)) as other_indexes,
  (select (relhastriggers or relrowsecurity or exists (select 1 from pg_rewrite r where r.ev_class = tbl.oid and r.rulename <> '_RETURN')) from tbl) as has_triggers_rules_rls,
  (select has_table_privilege(current_user, (select oid from tbl), 'SELECT') where exists (select 1 from tbl)) as can_select,
  (select has_table_privilege(current_user, (select oid from tbl), 'INSERT') where exists (select 1 from tbl)) as can_insert,
  (select relowner = (select oid from pg_roles where rolname = current_user) from tbl) as owner_is_runner`;

export const LEDGER_COUNT_SQL = 'select count(*)::int as n from supabase_migrations.schema_migrations';

export type LedgerCase = 'schema_absent' | 'table_absent' | 'table_present';

export interface LedgerAssessment {
  case: LedgerCase;
  ok: boolean;
  checks: Array<{ check: string; ok: boolean; detail?: string }>;
}

/** Pure decision from the catalogue facts (and the row count when the table could be read). Every check must be exactly true. */
export function assessLedger(f: LedgerFacts, rows: number | null): LedgerAssessment {
  const kase: LedgerCase = f.schema_exists !== true ? 'schema_absent' : f.table_exists !== true ? 'table_absent' : 'table_present';
  // CREATE on the database is needed in EVERY case: PostgreSQL checks it before it looks at IF NOT EXISTS, so
  // `create schema if not exists` fails for a login without it even when the schema is already there.
  const checks: LedgerAssessment['checks'] = [{ check: 'public_profiles_absent', ok: f.profiles_absent === true }, { check: 'runner_can_create_schema', ok: f.db_create === true }];
  if (kase === 'schema_absent') {
    // nothing further: the database-level CREATE above is the whole requirement
  } else if (kase === 'table_absent') {
    checks.push({ check: 'runner_schema_usage', ok: f.schema_usage === true }, { check: 'runner_can_create_table_in_schema', ok: f.schema_create === true });
  } else {
    // The column type text is catalogue-derived, so it is never printed: only the pass/fail of the comparison is.
    const typed = (name: string, got: string | null, want: string) => ({ check: name, ok: got === 'absent' || got === want });
    checks.push(
      { check: 'runner_schema_usage', ok: f.schema_usage === true },
      { check: 'ledger_is_ordinary_table', ok: f.table_ordinary === true },
      { check: 'version_is_text_not_null', ok: f.version_text_not_null === true },
      typed('statements_is_text_array_or_absent', f.statements_type, 'text[]'),
      typed('name_is_text_or_absent', f.name_type, 'text'),
      { check: 'runner_owns_ledger_table', ok: f.owner_is_runner === true },
      { check: 'only_the_reviewed_columns', ok: f.other_columns === 0, detail: String(f.other_columns) },
      { check: 'reviewed_columns_have_no_default_identity_or_generation', ok: f.special_columns === 0, detail: String(f.special_columns) },
      { check: 'version_is_the_primary_or_unique_key', ok: f.version_key === true },
      { check: 'no_other_constraints', ok: f.other_constraints === 0, detail: String(f.other_constraints) },
      { check: 'no_other_indexes', ok: f.other_indexes === 0, detail: String(f.other_indexes) },
      { check: 'no_triggers_rules_or_row_security', ok: f.has_triggers_rules_rls === false },
      { check: 'runner_can_select', ok: f.can_select === true },
      { check: 'runner_can_insert', ok: f.can_insert === true },
      { check: 'ledger_is_empty', ok: rows === 0, detail: rows === null ? 'unreadable' : String(rows) },
    );
  }
  return { case: kase, ok: checks.every((c) => c.ok), checks };
}

/** Runs the read-only assessment on an open connection. */
export async function runLedgerPreflight(client: RebuiltSqlClient): Promise<LedgerAssessment> {
  const facts = (await client.query(LEDGER_PREFLIGHT_SQL)).rows[0] as LedgerFacts;
  let rows: number | null = null;
  if (facts.table_exists === true && facts.schema_usage === true && facts.can_select === true) {
    rows = ((await client.query(LEDGER_COUNT_SQL)).rows[0] as { n: number }).n;
  }
  return assessLedger(facts, rows);
}

/** Prints fixed check names with true/false and counts only. */
export function reportLedgerPreflight(a: LedgerAssessment): void {
  for (const c of a.checks) console.log(JSON.stringify({ msg: 'staging-sql.ledger_preflight_check', check: c.check, ok: c.ok, ...(c.detail !== undefined ? { detail: c.detail } : {}) }));
  console.log(JSON.stringify({ msg: 'staging-sql.ledger_preflight', case: a.case, ok: a.ok, checks: a.checks.length, failed: a.checks.filter((c) => !c.ok).length }));
}
