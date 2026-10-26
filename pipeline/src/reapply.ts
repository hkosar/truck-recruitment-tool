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

/**
 * Statements sent AFTER the reapplied file, one extra step each. M1's blanket `grant execute on all functions
 * in schema internal to service_role` also reaches the retained trigger-only function, which a fresh apply
 * creates later (in M1c) and so never grants. This restores the fresh-apply ACL (manager decision, option b).
 */
export const REAPPLY_POST_SQL: Readonly<Partial<Record<ReapplyTarget, string>>> = {
  m1c: 'revoke execute on function internal.batch_delete_audit_append_only() from service_role;',
};

/**
 * `reapply-m1c` state probe: read-only, real catalogue queries (doc 16 section 3.3).
 *
 * The reapplied M1c file commits before the separate revoke runs, so a dropped connection between them leaves
 * M1c applied with an extra DIRECT service_role EXECUTE entry still on the trigger-only function. These steps
 * are NOT atomic. Before the file or the revoke is sent, the retained audit guards are verified from the
 * catalogue (not by object names alone):
 *   trigger_function : internal.batch_delete_audit_append_only() is a plpgsql trigger function, not SECURITY
 *                      DEFINER, search_path = internal, pg_temp, and its body is the reviewed "append-only" raise;
 *   triggers         : on internal.batch_delete_audit there are exactly two non-internal triggers, both enabled
 *                      (tgenabled = 'O'), both bound to that function, no arguments, no WHEN clause, no column
 *                      list: no_update_delete = BEFORE UPDATE OR DELETE FOR EACH ROW,
 *                      no_truncate = BEFORE TRUNCATE FOR EACH STATEMENT;
 *   table_shape      : an ordinary table with the six reviewed columns, in order;
 *   table_acl_clean  : PUBLIC, anon, authenticated and recruiter_api hold nothing on that table (ACL, plus the
 *                      effective privilege of each named role);
 *   function_acl_clean : the same four hold no EXECUTE on the trigger function (ACL and effective);
 *   batch_delete_acl_ok: (only when public.batch_delete exists) PUBLIC, anon and authenticated have no EXECUTE on
 *                      it and recruiter_api has it;
 *   batches_delete_clean: recruiter_api has no DELETE on public.batches (M1c revokes it, so no unaudited delete);
 *   service_role_direct_execute : the ACL holds a DIRECT EXECUTE entry for service_role (the one entry that
 *                      REVOKE ... FROM service_role can remove);
 *   service_role_other_path_execute : service_role would STILL have EXECUTE without that direct entry (PUBLIC, an
 *                      inherited role, ownership, or a null/default ACL).
 */
export const M1C_STATE_PROBE_SQL = `with
fn as (select p.oid, p.proowner, p.prorettype, p.prolang, p.prosecdef, p.proconfig, p.prosrc,
              coalesce(p.proacl, acldefault('f', p.proowner)) as acl
         from pg_proc p where p.oid = to_regprocedure('internal.batch_delete_audit_append_only()')),
fa as (select a.grantee, a.privilege_type from fn, aclexplode(fn.acl) a),
tb as (select c.oid, c.relkind, coalesce(c.relacl, acldefault('r', c.relowner)) as acl
         from pg_class c where c.oid = to_regclass('internal.batch_delete_audit')),
ta as (select a.grantee from tb, aclexplode(tb.acl) a),
bd as (select p.oid, coalesce(p.proacl, acldefault('f', p.proowner)) as acl
         from pg_proc p where p.oid = to_regprocedure('public.batch_delete(uuid)')),
bda as (select a.grantee from bd, aclexplode(bd.acl) a),
guarded as (select r.oid from pg_roles r where r.rolname in ('anon', 'authenticated', 'recruiter_api')),
tg as (select t.tgname, t.tgenabled, t.tgfoid, t.tgtype, t.tgnargs, t.tgqual, t.tgattr::text as tgattr, t.tgisinternal
         from pg_trigger t where t.tgrelid = to_regclass('internal.batch_delete_audit'))
select
  exists (select 1 from tb) as audit_table,
  exists (select 1 from fn where prorettype = 'trigger'::regtype and prolang = (select oid from pg_language where lanname = 'plpgsql')
            and not prosecdef and proconfig = array['search_path=internal, pg_temp']
            and prosrc like '%raise exception ''internal.batch_delete_audit is append-only''%') as trigger_function,
  ((select count(*) from tg where not tgisinternal) = 2
    and exists (select 1 from tg where tgname = 'batch_delete_audit_no_update_delete' and tgenabled = 'O' and tgfoid = (select oid from fn)
                  and tgtype = 27 and tgnargs = 0 and tgqual is null and tgattr = '')
    and exists (select 1 from tg where tgname = 'batch_delete_audit_no_truncate' and tgenabled = 'O' and tgfoid = (select oid from fn)
                  and tgtype = 34 and tgnargs = 0 and tgqual is null and tgattr = '')) as triggers,
  coalesce((select tb.relkind = 'r' and (select array_agg(a.attname::text order by a.attnum) from pg_attribute a
              where a.attrelid = tb.oid and a.attnum > 0 and not a.attisdropped) = array['id', 'batch_id', 'batch_name', 'actor_id', 'deleted_at', 'member_count'] from tb), false) as table_shape,
  (not exists (select 1 from ta where grantee = 0 or grantee in (select oid from guarded))
    and not exists (select 1 from guarded g, tb where has_table_privilege(g.oid, tb.oid, 'select,insert,update,delete,truncate,references,trigger'))) as table_acl_clean,
  (not exists (select 1 from fa where privilege_type = 'EXECUTE' and (grantee = 0 or grantee in (select oid from guarded)))
    and not exists (select 1 from guarded g, fn where has_function_privilege(g.oid, fn.oid, 'execute'))) as function_acl_clean,
  to_regprocedure('public.batch_delete(uuid)') is not null as batch_delete,
  coalesce((select (not exists (select 1 from bda where grantee = 0 or grantee in (select oid from pg_roles where rolname in ('anon', 'authenticated')))
                  and exists (select 1 from bda where grantee = (select oid from pg_roles where rolname = 'recruiter_api'))) from bd), true) as batch_delete_acl_ok,
  not coalesce((select has_table_privilege(r.oid, 'public.batches', 'delete') from pg_roles r where r.rolname = 'recruiter_api'), false) as batches_delete_clean,
  exists (select 1 from fa where privilege_type = 'EXECUTE' and grantee = (select oid from pg_roles where rolname = 'service_role')) as service_role_direct_execute,
  exists (select 1 from fa where privilege_type = 'EXECUTE' and grantee <> coalesce((select oid from pg_roles where rolname = 'service_role'), -1)
            and (grantee = 0 or pg_has_role((select oid from pg_roles where rolname = 'service_role'), grantee, 'usage'))) as service_role_other_path_execute`;

/** After the revoke: service_role must no longer have effective EXECUTE (false = success). */
export const M1C_POSTCONDITION_SQL = `select coalesce(has_function_privilege('service_role', to_regprocedure('internal.batch_delete_audit_append_only()'), 'execute'), false) as service_role_execute`;

export interface M1cStateFacts {
  audit_table: boolean;
  trigger_function: boolean;
  triggers: boolean;
  table_shape: boolean;
  table_acl_clean: boolean;
  function_acl_clean: boolean;
  batch_delete: boolean;
  batch_delete_acl_ok: boolean;
  batches_delete_clean: boolean;
  service_role_direct_execute: boolean;
  service_role_other_path_execute: boolean;
}

/** The retained audit guards, shared by both accepted states. Each fact must be exactly `true`. */
const GUARD_FACTS = ['audit_table', 'trigger_function', 'triggers', 'table_shape', 'table_acl_clean', 'function_acl_clean'] as const;

export interface M1cClassification {
  state: 'normal' | 'recover' | 'refuse';
  /** Names of the facts that failed (fact names only, never data). */
  failed: string[];
}

/**
 * 'normal'  : public.batch_delete is absent (the backed-out state) AND the retained audit guards are intact (or
 *             the audit table is absent altogether, which the plan's own precheck refuses with the plain-apply
 *             hint) AND service_role has no EXECUTE path other than a direct entry -> precheck + file + revoke.
 * 'recover' : the interrupted state: M1c applied, every guard and privilege invariant intact, and the ONLY
 *             unexpected privilege is the direct service_role EXECUTE entry -> send only the revoke.
 * 'refuse'  : anything else. Nothing is changed by this tool; a human inspects.
 */
export function classifyM1cState(f: M1cStateFacts): M1cClassification {
  const wrong = (names: readonly (keyof M1cStateFacts)[], want: boolean): string[] => names.filter((n) => f[n] !== want);
  if (f.batch_delete === false) {
    if (f.audit_table === false) return { state: 'normal', failed: [] };
    const failed = [...wrong(GUARD_FACTS, true), ...wrong(['service_role_other_path_execute'], false)];
    return { state: failed.length === 0 ? 'normal' : 'refuse', failed };
  }
  const failed = [
    ...wrong([...GUARD_FACTS, 'batch_delete', 'batch_delete_acl_ok', 'batches_delete_clean', 'service_role_direct_execute'], true),
    ...wrong(['service_role_other_path_execute'], false),
  ];
  return { state: failed.length === 0 ? 'recover' : 'refuse', failed };
}
