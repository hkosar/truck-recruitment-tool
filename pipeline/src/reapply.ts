// Data-preserving re-apply of M1 / M1b / M1c after a backout (doc 16 section 3.3, T-REPLAY).
//
// The backouts keep the sign-in ledgers, the people added under M1b, the batch-delete record and
// the internal functions (they delete no data). The reviewed pending files create those objects
// unconditionally, so resending them to a backed-out database fails on the first retained object.
// This module derives, IN MEMORY, an idempotent form of the reviewed file. The file on disk is
// never edited, and only these guards are added, nothing else changes:
//   create table internal.X          -> create table if not exists internal.X
//   create [unique] index N          -> create [unique] index if not exists N
//   create function                  -> create or replace function   (same definitions)
//   create trigger N ... on T        -> drop trigger if exists N on T; create trigger N ... on T
//   insert into internal.<control> default values  ->  ... on conflict do nothing
// Existing rows are never touched: retained tables are not recreated, truncated or altered, and the
// three single-row control tables keep their current values (for example backout_window).
// Anything this does not understand fails closed: a creating statement left without a guard is
// refused, so a future edit of the pending files cannot silently bypass the guards.

export type ReapplyTarget = 'm1' | 'm1b' | 'm1c';

const CONTROL_TABLES = ['roster_lock', 'backout_window', 'recovery_policy'];

export function idempotentReapplySql(sql: string): string {
  let out = sql.replace(/\r\n/g, '\n');
  out = out.replace(/^create table internal\./gm, 'create table if not exists internal.');
  out = out.replace(/^create (unique )?index (?!if not exists)/gm, (_m, unique: string | undefined) => `create ${unique ?? ''}index if not exists `);
  out = out.replace(/^create function\b/gm, 'create or replace function');
  out = out.replace(/^create trigger (\w+)\b([\s\S]*?)\bon ([\w.]+)/gm, (m, name: string, _mid: string, table: string) => `drop trigger if exists ${name} on ${table};\n${m}`);
  out = out.replace(new RegExp(`^insert into internal\.(${CONTROL_TABLES.join('|')}) default values;`, 'gm'), 'insert into internal.$1 default values on conflict do nothing;');
  const unguarded = out.match(/^create (table (?!if not exists)|index (?!if not exists)|unique index (?!if not exists)|function\b|sequence\b|type\b|view\b|schema\b|domain\b)/gm);
  if (unguarded) throw new Error(`re-apply: unguarded creating statement left in the SQL (${[...new Set(unguarded)].join(', ')}); refusing`);
  return out;
}

/** The database must look backed-out: retained objects present, the live objects absent. Raises otherwise. */
export const REAPPLY_PRECHECKS: Readonly<Record<ReapplyTarget, string>> = {
  m1: `do $$ begin
  if to_regclass('internal.roster_lock') is null or to_regclass('internal.app_sessions') is null then
    raise exception 're-apply M1 refused: the retained sign-in tables are missing (this is not a backed-out database); use the plain apply action';
  end if;
  if to_regprocedure('public.team_list()') is not null then
    raise exception 're-apply M1 refused: M1 is still applied (public.team_list exists); run the backouts first';
  end if;
end $$;`,
  m1b: `do $$ begin
  if to_regclass('internal.staff_mobile_unverified') is null then
    raise exception 're-apply M1b refused: the retained table is missing (this is not a backed-out database); use the plain apply action';
  end if;
  if to_regprocedure('public.team_add_person(text,text,user_role,text)') is not null then
    raise exception 're-apply M1b refused: M1b is still applied; run its backout first';
  end if;
end $$;`,
  m1c: `do $$ begin
  if to_regclass('internal.batch_delete_audit') is null then
    raise exception 're-apply M1c refused: the retained audit table is missing (this is not a backed-out database); use the plain apply action';
  end if;
  if to_regprocedure('public.batch_delete(uuid)') is not null then
    raise exception 're-apply M1c refused: M1c is still applied; run its backout first';
  end if;
end $$;`,
};
