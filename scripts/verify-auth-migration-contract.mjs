#!/usr/bin/env node
// Offline contract check for the PENDING same-origin sign-in SQL (no database needed):
//   supabase/pending/M1_same_origin_signin.sql, supabase/backout/*.sql, supabase/rollout/L1-*.sql
// Design: docs/build-plan/14-same-origin-signin-design.md, 15-qq-infrastructure-reconciliation.md.
// It proves text-level properties only. Behaviour needs the approved throwaway database (A3).

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8').replace(/\r\n/g, '\n');
const failures = [];
const fail = (msg) => failures.push(msg);

const M1_PATH = ['supabase', 'pending', 'M1_same_origin_signin.sql'];
const BACKOUT_PATH = ['supabase', 'backout', 'M1-backout.sql'];
const RETIRE_PATH = ['supabase', 'backout', 'retire-app-credentials.sql'];
const L1_PATH = ['supabase', 'rollout', 'L1-close-legacy-auth.sql'];
const M1B_PATH = ['supabase', 'pending', 'M1b_add_person.sql'];
const M1B_BACKOUT_PATH = ['supabase', 'backout', 'M1b-backout.sql'];
const M1C_PATH = ['supabase', 'pending', 'M1c_batch_delete_audit.sql'];
const M1C_BACKOUT_PATH = ['supabase', 'backout', 'M1c-backout.sql'];

for (const p of [M1_PATH, BACKOUT_PATH, RETIRE_PATH, L1_PATH, M1B_PATH, M1B_BACKOUT_PATH, M1C_PATH, M1C_BACKOUT_PATH, ['supabase', 'backout', 'pre-cutover-snapshot.sql']]) {
  if (!existsSync(join(root, ...p))) fail(`missing ${p.join('/')}`);
}
if (failures.length) finish();

const m1 = read(...M1_PATH);
const backout = read(...BACKOUT_PATH);
const retire = read(...RETIRE_PATH);
const l1 = read(...L1_PATH);
const m1b = read(...M1B_PATH);
const m1bBackout = read(...M1B_BACKOUT_PATH);
const m1c = read(...M1C_PATH);
const m1cBackout = read(...M1C_BACKOUT_PATH);
const stripComments = (sql) => sql.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
const m1Code = stripComments(m1);

// A. Still pending: nothing of M1 inside supabase/migrations.
const migrationsDir = join(root, 'supabase', 'migrations');
for (const f of readdirSync(migrationsDir)) {
  const text = readFileSync(join(migrationsDir, f), 'utf8');
  if (/recruiter_api|internal\.app_sessions|lock_and_validate/.test(text)) fail(`supabase/migrations/${f} contains M1 objects; promotion is an explicit baseline decision`);
}

// B. No credentials or connection strings in any of the new SQL.
for (const [name, text] of [['M1', m1], ['backout', backout], ['retire', retire], ['L1', l1], ['M1b', m1b], ['M1b-backout', m1bBackout], ['M1c', m1c], ['M1c-backout', m1cBackout]]) {
  if (/password\s+'[^']*'/i.test(text)) fail(`${name}: contains a password literal`);
  if (/postgres(ql)?:\/\/|sb_secret_|eyJ[A-Za-z0-9_-]{10,}\./.test(text)) fail(`${name}: contains a connection string or key`);
}

// C. No auth.uid() left in M1 code.
if (/auth\.uid\(\)/.test(m1Code)) fail('M1: auth.uid() still used in code');

// D. user_role is never compared by order.
const ordering = [
  // any identifier ending in "role" (role, v_role, p.role) compared with <, >, <=, >= ("<>" is fine)
  /role\s*(<=|>=|<(?![>=])|>(?!=))\s*['\w(]/i,
  /'(manager|edit|view|guest)'(::user_role)?\s*(<=|>=|<(?!>)|>)/,
  /\b(max|min)\s*\(\s*[\w.]*role\b/,
  /order\s+by\s+[\w.]*\brole\b/,
];
for (const [name, text] of [['M1', m1Code], ['backout', stripComments(backout)]]) {
  for (const re of ordering) if (re.test(text)) fail(`${name}: ordering comparison on user_role (${re})`);
}

// E. Every function created in M1 pins search_path (and the hardening loop runs at the end).
const fnBlocks = m1Code.split(/\ncreate (?:or replace )?function /).slice(1);
for (const block of fnBlocks) {
  const header = block.slice(0, block.indexOf('$'));
  if (!/set search_path/.test(header)) fail(`M1: function without set search_path: ${block.slice(0, 60).split('\n')[0]}`);
}
if (!/do \$hardening\$/.test(m1Code)) fail('M1: hardening search_path loop missing');

// F. Re-keyed bodies keep every original statement (subsequence), with only the allowed edits.
const norm = (lines) => lines.map((l) => l.replace(/--.*$/, '').trim().replace(/\s+/g, ' ')).filter((l) => l.length > 0);
function originalLines(file, from, to) {
  return read('supabase', 'migrations', file).split('\n').slice(from - 1, to);
}
function m1Function(signatureStart) {
  const i = m1.indexOf(signatureStart);
  if (i < 0) return undefined;
  const bodyStart = m1.indexOf('$$', i);
  const bodyEnd = m1.indexOf('$$', bodyStart + 2);
  const lineEnd = m1.indexOf('\n', bodyEnd);
  return m1.slice(i, lineEnd < 0 ? undefined : lineEnd).split('\n');
}
const GUARD = [/^if not coalesce\(internal\.can_edit\(\), false\) then$/, /^raise exception 'insufficient privilege to [^']+';$/];
function isSubsequence(needle, hay) {
  let j = 0;
  for (const line of hay) if (j < needle.length && line === needle[j]) j += 1;
  return j === needle.length ? -1 : j;
}
const rekeyed = [
  { name: 'internal.log_bc_change', file: '20260720000800_activity.sql', from: 22, to: 36, start: 'create or replace function internal.log_bc_change()' },
  { name: 'internal.log_bc_delete', file: '20260720000800_activity.sql', from: 42, to: 46, start: 'create or replace function internal.log_bc_delete()' },
  { name: 'public.create_batch', file: '20260720001100_rpc.sql', from: 383, to: 430, start: 'create or replace function public.create_batch(', guard: true },
  { name: 'public.refresh_batch', file: '20260720001100_rpc.sql', from: 435, to: 489, start: 'create or replace function public.refresh_batch(', guard: true,
    drop: [/^select b\.search_definition into v_def from public\.batches b where b\.id = p_batch_id;$/] },
  { name: 'public.bulk_set_status', file: '20260720001100_rpc.sql', from: 498, to: 528, start: 'create or replace function public.bulk_set_status(', guard: true,
    replace: [['and bc.dot_number = any(p_dots)', 'and bc.dot_number = any(v_locked)'], ['unnest(p_dots[1:50])', 'unnest(v_locked[1:50])'],
      ['returns int', 'returns jsonb'], ['v_count int;', 'v_count int;'], ['return v_count;', "return jsonb_build_object('changed', v_count, 'skipped', to_jsonb(v_skipped));"]] },
  { name: 'public.log_export', file: '20260720001100_rpc.sql', from: 587, to: 601, start: 'create or replace function public.log_export(', guard: true },
  { name: 'public.set_do_not_contact', file: '20260723010400_dnc_activity_enum_cast.sql', from: 13, to: 53, start: 'create or replace function public.set_do_not_contact(', guard: true,
    drop: [/^v_uid uuid := internal\.current_staff_id\(\);$/, /^if not exists \(select 1 from public\.carriers where dot_number = p_dot\) then$/] },
  { name: 'internal.contact_logs_dnc_guard', file: '20260723020000_contact_logs_dnc_guard.sql', from: 21, to: 38, start: 'create or replace function internal.contact_logs_dnc_guard()' },
];
for (const r of rekeyed) {
  const fn = m1Function(r.start);
  if (!fn) { fail(`M1: ${r.name} not redefined`); continue; }
  let orig = norm(originalLines(r.file, r.from, r.to)).map((l) => l.replace(/auth\.uid\(\)/g, 'internal.current_staff_id()'));
  for (const [a, b] of r.replace ?? []) orig = orig.map((l) => l.split(a).join(b));
  // Drop the can_edit guard (if line, raise, and the end if that follows it) and listed lines.
  const out = [];
  for (let k = 0; k < orig.length; k++) {
    if (r.guard && GUARD[0].test(orig[k]) && GUARD[1].test(orig[k + 1] ?? '') && orig[k + 2] === 'end if;') { k += 2; continue; }
    if ((r.drop ?? []).some((re) => re.test(orig[k]))) {
      // the carrier-existence check is replaced as a whole (if / raise / end if)
      if (/^if not exists/.test(orig[k]) && orig[k + 2] === 'end if;') k += 2;
      continue;
    }
    out.push(orig[k]);
  }
  const body = norm(fn);
  const missing = isSubsequence(out, body);
  if (missing !== -1) fail(`M1: ${r.name} lost or reordered an original statement: "${out[missing]}"`);
  if (/auth\.uid\(\)/.test(body.join('\n'))) fail(`M1: ${r.name} still uses auth.uid()`);
  if (r.guard && !body.some((l) => l.includes("internal.lock_and_validate(array['manager','edit']::user_role[], array['link'])"))) {
    fail(`M1: ${r.name} does not take the EDITOR lock sequence`);
  }
}

// G. Backout restores the exact original text.
const restored = [
  ['20260720001200_rls.sql', 41, 43], ['20260720000800_activity.sql', 20, 36], ['20260720000800_activity.sql', 40, 46],
  ['20260720001100_rpc.sql', 374, 430], ['20260720001100_rpc.sql', 432, 489], ['20260720001100_rpc.sql', 491, 528],
  ['20260720001100_rpc.sql', 580, 601], ['20260723010400_dnc_activity_enum_cast.sql', 6, 53],
  ['20260723020000_contact_logs_dnc_guard.sql', 16, 38],
  ['20260720001200_rls.sql', 77, 82], ['20260720001200_rls.sql', 92, 93], ['20260720001200_rls.sql', 109, 110],
  ['20260720001200_rls.sql', 118, 120], ['20260720001200_rls.sql', 124, 126], ['20260720001200_rls.sql', 133, 135],
  ['20260720001200_rls.sql', 142, 144], ['20260720001200_rls.sql', 152, 154], ['20260720001200_rls.sql', 162, 163],
  ['20260720001200_rls.sql', 94, 97], ['20260720001200_rls.sql', 111, 112], ['20260722223300_security_hardening.sql', 36, 75],
  ['20260723010400_dnc_activity_enum_cast.sql', 55, 56],
];
for (const [file, from, to] of restored) {
  const text = originalLines(file, from, to).join('\n').replace(/^create function /, 'create or replace function ');
  if (!backout.includes(text)) fail(`backout: does not restore ${file}:${from}-${to} verbatim`);
}
// The July hardening loop (20260722223300_security_hardening.sql:11-32) is replayed with the same
// function selection, and the same search_path unless PostGIS is outside public (review fix
// 2026-10-23: then the PostGIS schema follows public and internal, as in M1 section 13).
{
  const orig = originalLines('20260722223300_security_hardening.sql', 11, 32).join('\n');
  const selection = orig.slice(orig.indexOf('  for fn in'), orig.indexOf('  loop'));
  const bo = /do \$hardening\$[\s\S]*?\$hardening\$;/.exec(backout)?.[0] ?? '';
  if (!selection || !bo.includes(selection)) fail('backout: the hardening loop must select the same functions as 20260722223300_security_hardening.sql:11-32');
  if (!bo.includes("v_path    text := 'public, internal, pg_temp';") || !bo.includes("v_path := format('public, internal, %I, pg_temp', v_postgis);")
      || !/if v_postgis is not null and v_postgis <> 'public' then/.test(bo) || !bo.includes("execute format('alter function %s set search_path = %s', fn, v_path);")) {
    fail('backout: the replayed hardening must keep public, internal, pg_temp and add only the PostGIS schema (when not public)');
  }
}
if (!/^begin;$/m.test(backout) || !/^commit;$/m.test(backout)) fail('backout: must be one transaction');
if (/\bdrop table\b|\bdelete from\b|\btruncate\b/i.test(stripComments(backout))) fail('backout: must not drop tables or delete data');
// T-BACKOUT (A3, measured): the pre-M1 surface also includes platform defaults and migration
// order, which a verbatim replay alone misses.
{
  const code = stripComments(backout);
  for (const stmt of [
    'grant all on all sequences in schema public to anon, authenticated;',
    'alter default privileges in schema public grant all on sequences to anon, authenticated;',
    'alter default privileges in schema public grant execute on functions to anon, authenticated;',
    'grant execute on all functions in schema public to authenticated;',
  ]) if (!code.includes(stmt)) fail(`backout: T-BACKOUT restore missing: ${stmt}`);
  const loopEnd = code.indexOf('$hardening$;');
  const guardPath = code.indexOf('alter function internal.contact_logs_dnc_guard() set search_path = public, pg_temp;');
  if (guardPath === -1 || guardPath < loopEnd) fail('backout: the DNC guard search_path must be re-set AFTER the replayed hardening loop (migration order)');
  if (!code.includes('revoke execute on function internal.contact_logs_dnc_guard() from service_role;')) fail('backout: DNC guard keeps the service_role grant M1 added');
}

// H. Every write policy uses the exact role set (doc 15 §14.1).
const MANAGER = "array['manager']::user_role[]";
const EDITOR = "array['manager','edit']::user_role[]";
const policies = {
  carriers_update: EDITOR, cov_update_mgr: MANAGER, batches_write: EDITOR, batches_update: EDITOR, batches_delete: MANAGER,
  zones_write: EDITOR, zones_update: EDITOR, zones_delete: EDITOR, bc_insert: EDITOR, bc_update: EDITOR, bc_delete: MANAGER,
  logs_insert: EDITOR, logs_delete: MANAGER, act_comment: EDITOR, act_delete: MANAGER, suppress_insert: EDITOR, suppress_delete: MANAGER,
};
for (const [name, set] of Object.entries(policies)) {
  const m = new RegExp(`create policy ${name} on [\\s\\S]*?;`).exec(m1Code);
  if (!m) { fail(`M1: policy ${name} not recreated`); continue; }
  if (!m[0].includes(set)) fail(`M1: policy ${name} does not use ${set === MANAGER ? 'MANAGER' : 'EDITOR'}`);
  const other = set === MANAGER ? EDITOR : MANAGER;
  if (m[0].includes(other)) fail(`M1: policy ${name} mixes role sets`);
}
for (const [name, extra] of [['batches_write', 'created_by = internal.current_staff_id()'], ['logs_insert', 'user_id = internal.current_staff_id()'],
  ['act_comment', "activity_type = 'comment' and actor_id = internal.current_staff_id()"], ['suppress_insert', 'created_by = internal.current_staff_id()']]) {
  const m = new RegExp(`create policy ${name} on [\\s\\S]*?;`).exec(m1Code);
  if (m && !m[0].replace(/\s+/g, ' ').includes(extra)) fail(`M1: policy ${name} lost its condition "${extra}"`);
}
for (const name of ['bc_insert', 'bc_update', 'bc_delete']) {
  const m = new RegExp(`create policy ${name} on [\\s\\S]*?;`).exec(m1Code);
  if (m && !m[0].includes('internal.member_write_ok(')) fail(`M1: policy ${name} must lock the batch parent (member_write_ok)`);
}
if (!/create policy profiles_select on public\.profiles for select\s+using \(\(select internal\.is_staff\(\)\)\);/.test(m1Code)) {
  fail('M1: profiles_select must be staff (link session) only, with no own-row exception');
}
for (const dropped of ['profiles_update_self', 'profiles_update_mgr']) {
  if (!new RegExp(`drop policy ${dropped} on public\\.profiles;`).test(m1Code)) fail(`M1: ${dropped} must be dropped`);
}

// I. Grants: nothing granted to anon/authenticated/public; feature flags default off.
for (const line of m1Code.split('\n')) {
  if (/^\s*grant\b/i.test(line) && /\bto\s+(anon|authenticated|public)\b/i.test(line)) fail(`M1: grants to a public role: ${line.trim()}`);
}
if (!/grant[\s\S]*?\)\s*\n\s*to recruiter_api;/.test(m1Code)) fail('M1: recruiter_api function grants missing');
if (/grant\s+(select|insert|update|delete)[^;]*on\s+internal\./i.test(m1Code.replace(/grant select, delete on internal\.[^;]*to recruiter_maintenance;/g, ''))) {
  fail('M1: recruiter_api must not get table grants on internal ledgers');
}
if (!/enabled boolean not null default false/.test(m1Code)) fail('M1: recovery must default to disabled');
if (!/email_edits_paused boolean not null default false/.test(m1Code)) fail('M1: the D10 email pause must default to off');
for (const fn of ['recovery_enroll', 'recovery_consume', 'recovery_batches', 'recovery_batch_members', 'recovery_set_status']) {
  const body = m1Function(`function ${fn.startsWith('recovery_consume') ? 'internal' : 'public'}.${fn}(`) ?? m1Function(`function internal.${fn}(`);
  if (!body) { fail(`M1: ${fn} missing`); continue; }
  if (!body.join('\n').includes('internal.recovery_require_enabled()')) fail(`M1: ${fn} must check the recovery policy flag`);
}
const setStatus = m1Function('function public.recovery_set_status(')?.join('\n') ?? '';
if (!setStatus.includes("internal.lock_and_validate(array['manager','edit']::user_role[], array['recovery'])")) fail('M1: recovery_set_status must require recovery kind AND editor role');
if (/references auth\.users/.test(m1Code) || /drop constraint/i.test(m1Code)) fail('M1: must not touch the profiles -> auth.users link (D8 is unapproved)');
if (/create function public\.team_add|create or replace function public\.team_add/.test(m1Code)) fail('M1: team_add depends on unapproved D8');

// J. Lock sequence order inside lock_and_validate.
const lav = m1Function('function internal.lock_and_validate(')?.join('\n') ?? '';
const order = ['from internal.roster_lock for update', 'for no key update', 'from public.profiles where id = v_id for share', 'from internal.app_sessions s where s.id = v_sid for', "raise exception 'not permitted'"];
let last = -1;
for (const marker of order) {
  const at = lav.indexOf(marker, last + 1);
  if (at < 0) { fail(`M1: lock_and_validate missing or misordered step "${marker}"`); break; }
  last = at;
}

// K. Contact-log guard: identity before batch before carrier.
const guard = m1Function('function internal.contact_logs_dnc_guard()')?.join('\n') ?? '';
const gIdentity = guard.indexOf('internal.is_app_login()');
const gBatch = guard.indexOf('from public.batches where id = new.batch_id for key share');
const gCarrier = guard.indexOf('from public.carriers where dot_number = new.dot_number for share');
if (!(gIdentity >= 0 && gIdentity < gBatch && gBatch < gCarrier)) fail('M1: contact-log guard must do identity, then batch, then carrier');

// K2. Session re-checked after every business-lock wait (doc 15 C7 reconciliation).
for (const [start, lockMarker] of [
  ['function internal.member_write_ok(', 'for key share'],
  ['function internal.suppression_write_ok(', 'for no key update'],
  ['function public.refresh_batch(', 'for no key update'],
  ['function public.bulk_set_status(', 'for no key update'],
  ['function public.set_do_not_contact(', 'for no key update'],
  ['function internal.contact_logs_dnc_guard()', 'for share'],
  ['function public.recovery_set_status(', 'for no key update'],
  ['function public.log_export(', 'for key share'],
]) {
  const body = m1Function(start)?.join('\n') ?? '';
  const lockAt = body.lastIndexOf(lockMarker);
  const recheckAt = body.lastIndexOf('internal.recheck_session()');
  if (lockAt < 0 || recheckAt < lockAt) fail(`M1: ${start} must re-check the session after its last business lock`);
}
// Gate 2 re-review 1: the export log locks its batch and re-checks BEFORE inserting (an INSERT is
// not covered by the BEFORE UPDATE/DELETE re-check trigger, and its foreign key could wait).
{
  const body = stripComments(m1Function('function public.log_export(')?.join('\n') ?? '');
  const lock = body.indexOf('perform 1 from public.batches where id = p_batch_id for key share;');
  const recheck = body.indexOf('perform internal.recheck_session();');
  const insert = body.indexOf('insert into public.batch_activity');
  if (!(lock >= 0 && lock < recheck && recheck < insert)) fail('M1: log_export must lock its batch, then re-check the session, then insert');
}

// K2b. Time checks after a possible lock wait use the wall clock, never now() (frozen at
// transaction start).
const recheck = m1Function('function internal.recheck_session()')?.join('\n') ?? '';
if (!recheck.includes('clock_timestamp()') || /\bnow\(\)/.test(stripComments(recheck))) fail('M1: recheck_session must use clock_timestamp(), never now()');
const lavValidate = (m1Function('function internal.lock_and_validate(')?.join('\n') ?? '').split('-- Validate from the locked rows only.')[1] ?? '';
if (!lavValidate.includes('clock_timestamp()') || /\bnow\(\)/.test(stripComments(lavValidate))) fail('M1: lock_and_validate validation must use clock_timestamp(), never now()');
// K2d (Gate 2 review finding 2): implicit row-lock waits re-check the session in a BEFORE
// UPDATE/DELETE trigger on every app-writable business table; the comment insert locks its batch
// and re-checks (member_write_ok); link redemption re-checks expiry with the wall clock after
// all its locks; the backout removes the triggers.
{
  const TABLES = ['batches', 'batch_zones', 'batch_carriers', 'batch_activity', 'contact_logs', 'carriers', 'cargo_other_values', 'contact_suppressions'];
  const onWrite = m1Function('function internal.recheck_session_on_write()')?.join('\n') ?? '';
  if (!onWrite.includes('perform internal.recheck_session();')) fail('M1: recheck_session_on_write must call recheck_session()');
  const loop = /do \$recheck\$[\s\S]*?\$recheck\$;/.exec(m1Code)?.[0] ?? '';
  if (!/before update or delete on public\.%I for each row execute function internal\.recheck_session_on_write\(\)/.test(loop)) fail('M1: the re-check trigger must be BEFORE UPDATE OR DELETE, FOR EACH ROW');
  for (const t of TABLES) {
    if (!loop.includes(`'${t}'`)) fail(`M1: ${t} lacks the session re-check trigger`);
    if (!backout.includes(`drop trigger if exists ${t}_recheck_session on public.${t};`)) fail(`backout: does not drop ${t}_recheck_session`);
  }
  const comment = /create policy act_comment on public\.batch_activity for insert[\s\S]*?;/.exec(m1Code)?.[0] ?? '';
  if (!comment.includes("internal.member_write_ok(array['manager','edit']::user_role[], batch_id, 'key share')")) fail('M1: act_comment must lock the batch and re-check the session (member_write_ok)');
  const redeem = stripComments(m1Function('function internal.auth_link_redeem(')?.join('\n') ?? '');
  const lastLock = redeem.lastIndexOf('for update;');
  const wall = redeem.indexOf('l.expires_at > clock_timestamp()', lastLock);
  if (lastLock === -1 || wall === -1 || /expires_at > now\(\)/.test(redeem)) fail('M1: link redemption must re-check expiry with clock_timestamp() after its last lock');
}

// K2c. Events outlive links: SET NULL reference plus a snapshot, so retention never fails or loses evidence.
if (!/link_id\s+uuid references internal\.signin_links\(id\) on delete set null/.test(m1Code)) fail('M1: email_events.link_id must be ON DELETE SET NULL');
if (!/create table internal\.email_events \([\s\S]*?recipient_email\s+text not null[\s\S]*?\);/.test(m1Code)) fail('M1: email_events must snapshot the recipient');

// K3. Webhook evidence: message-id conflict rejected before any insert/update; block allowlist in SQL.
const evidence = m1Function('function internal.auth_apply_send_evidence(')?.join('\n') ?? '';
const eMismatch = evidence.indexOf('v_message <> p_message_id');
const eInsert = evidence.indexOf('insert into internal.email_events');
const eUpdate = evidence.indexOf('update internal.signin_links');
if (!(eMismatch >= 0 && eMismatch < eInsert && eInsert < eUpdate)) fail('M1: evidence must reject a conflicting message id before any insert or update');
if (!evidence.includes("'Bounced Address', 'Unsubscribed Address', 'Spam Reporting Address', 'Invalid Address'")) fail('M1: evidence must gate drop blocks on the recipient-reason allowlist');

// K4. Emergency sign-everyone-out: manager only (admin class), every live session (no user
// filter, so the actor's own and recovery sessions too), one audit row. Hunter decision
// 2026-10-21: it also cancels every unused sign-in link and unused recovery credential, under
// the roster lock held exclusively, and every credential path takes that lock in SHARE mode
// before any other lock, so no concurrent mint, redemption, enrollment or consumption survives.
const eso = m1Function('function public.team_sign_everyone_out()')?.join('\n') ?? '';
if (!eso) fail('M1: team_sign_everyone_out missing');
else {
  if (!eso.includes("internal.lock_and_validate(array['manager']::user_role[], array['link'], '{}', true)")) fail('M1: emergency sign-out must be manager-only (link session) and hold the roster lock (p_roster = true)');
  const code = stripComments(eso);
  // Staff only (Gate 2 review N3): staff = role manager/edit/view, whatever the status;
  // non-staff = role guest (legacy guest and pending rows), left untouched. Exactly this filter:
  // nothing narrower (a user or actor filter, which would spare someone) and nothing missing.
  const STAFF_FILTER = "\n     and user_id in (select p.id from public.profiles p where p.role in ('manager', 'edit', 'view'));";
  for (const [table, where] of [
    ['app_sessions', 'where revoked_at is null'],
    ['signin_links', 'where used_at is null and revoked_at is null'],
    ['recovery_sets', 'where revoked_at is null'],
    ['recovery_codes', 'where used_at is null and revoked_at is null'],
  ]) {
    const u = new RegExp(`update internal\\.${table}[\\s\\S]*?;`).exec(code)?.[0] ?? '';
    if (!u.endsWith(where + STAFF_FILTER) || (u.match(/user_id/g) ?? []).length !== 1 || !u.includes("'emergency_sign_out'")) {
      fail(`M1: emergency sign-out must cancel every ${table} row (${where}) of staff only (role manager/edit/view), with no other user filter`);
    }
  }
  if (!eso.includes("'emergency_sign_out'") || !eso.includes('insert into internal.auth_events')) fail('M1: emergency sign-out must write an actor audit row');
}
for (const sig of [
  'function internal.auth_mint_lock(',
  'function internal.auth_link_redeem(',
  'function public.recovery_enroll(',
  'function internal.recovery_consume(',
]) {
  const body = stripComments(m1Function(sig)?.join('\n') ?? '');
  const SHARE = 'perform 1 from internal.roster_lock for share;';
  const share = body.indexOf(SHARE);
  const firstLock = body.search(/\bfor (no key )?update\b|\bfor share\b|internal\.lock_and_validate\(/);
  if (share === -1 || firstLock !== share + SHARE.indexOf('for share')) fail(`M1: ${sig}) must take the roster lock in SHARE mode before any other lock (emergency sign-out coordination)`);
}

// L. Credential retirement order: NOLOGIN, terminate, confirm, then revoke.
const rNologin = retire.indexOf('alter role recruiter_app nologin');
const rTerminate = retire.indexOf('pg_terminate_backend(');
const rConfirm = retire.indexOf('as recruiter_app_backends');
const rRevoke = retire.indexOf("revoked_reason = 'backout'");
if (!(rNologin >= 0 && rNologin < rTerminate && rTerminate < rConfirm && rConfirm < rRevoke)) fail('retire: order must be NOLOGIN -> terminate -> confirm -> revoke');

// M. L1 touches only the listed credential tables/columns.
const l1Code = stripComments(l1);
if (/password|banned_until|encrypted_password|\bset\s+email\b|raw_user_meta_data/i.test(l1Code.replace(/email_change_token_(new|current)/g, ''))) fail('L1: must not change passwords, bans, emails or metadata');
if (/delete from auth\.users|delete from public\./i.test(l1Code)) fail('L1: must not delete users or app data');


// M1b (D8, approved 2026-10-22): managers add people. The profiles -> auth.users link is dropped;
// the add is MANAGER + link session only, under the exclusive roster lock, refuses any existing
// roster email, normalizes the email, audits, never sends; the mobile is internal and unverified.
// The backout restores the link NOT VALID (people added stay) and drops the function, no data.
{
  const code = stripComments(m1b);
  if (!/^begin;$/m.test(code) || !/^commit;$/m.test(code)) fail('M1b: must be one transaction');
  if (!code.includes('alter table public.profiles drop constraint if exists profiles_id_fkey;')) fail('M1b: must drop the profiles -> auth.users foreign key (D8)');
  if (!code.includes('alter table public.profiles alter column id set default gen_random_uuid();')) fail('M1b: new profile ids must default to gen_random_uuid()');
  if (/insert into auth\.users|delete from|drop table|truncate/i.test(code)) fail('M1b: must not create old sign-in accounts or delete anything');
  const add = stripComments(/create function public\.team_add_person\([\s\S]*?\$\$;/.exec(m1b)?.[0] ?? '');
  if (!add) fail('M1b: team_add_person missing');
  const firstDecl = add.indexOf('internal.lock_and_validate(');
  if (!add.includes("internal.lock_and_validate(array['manager']::user_role[], array['link'], '{}', true)") || firstDecl < 0 || add.indexOf('declare') > firstDecl || /:=\s*(?!internal\.lock_and_validate)[^;]*\bfrom\b/.test(add.slice(add.indexOf('declare'), firstDecl))) {
    fail('M1b: team_add_person must be manager-only, link session only, holding the roster lock (p_roster = true) before anything else');
  }
  if (!add.includes('lower(btrim(p_email))')) fail('M1b: the email must be normalized (lower, trimmed)');
  if (!/p_role not in \('manager', 'edit', 'view'\)/.test(add)) fail('M1b: only staff roles may be assigned (never guest)');
  const dup = add.indexOf("if exists (select 1 from public.profiles o where lower(o.email) = v_email) then");
  const ins = add.indexOf('insert into public.profiles');
  if (dup < 0 || ins < 0 || dup > ins || !/errcode = 'unique_violation'/.test(add)) fail('M1b: any existing roster email (any status) must be refused before the insert');
  if (!add.includes("'approved'") || !add.includes('approved_by')) fail('M1b: the added person is approved by the acting manager');
  if (!add.includes('insert into internal.auth_events')) fail('M1b: the add must be audited');
  if (/http|net\.|send|pg_notify/i.test(add)) fail('M1b: nothing may be sent at add time');
  if (!/create table internal\.staff_mobile_unverified/.test(code) || /public\.profiles add column/i.test(code)) fail('M1b: the optional mobile is stored internally (unverified), never on profiles');
  if (!code.includes('revoke all on function public.team_add_person(text, text, user_role, text) from public, anon, authenticated;')
      || !code.includes('grant execute on function public.team_add_person(text, text, user_role, text) to recruiter_api;')) fail('M1b: team_add_person must be callable by recruiter_api only');
  const bo = stripComments(m1bBackout);
  if (!/^begin;$/m.test(bo) || !/^commit;$/m.test(bo)) fail('M1b-backout: must be one transaction');
  if (!bo.includes('drop function if exists public.team_add_person(text, text, user_role, text);')) fail('M1b-backout: must drop team_add_person');
  if (!bo.includes('add constraint profiles_id_fkey foreign key (id) references auth.users(id) on delete cascade not valid;')) fail('M1b-backout: must restore the foreign key NOT VALID (people added stay)');
  if (/\bdrop table\b|\bdelete from\b|\btruncate\b/i.test(bo)) fail('M1b-backout: must not delete data');
}

// PostGIS (approved fix, 2026-10-23). A blanket "revoke execute on all functions in schema" also
// strips extension functions (PostGIS in public), which the app's map/search/batch SQL calls as
// recruiter_api: forbidden in M1. The revoke must skip extension members, and recruiter_api must
// get the PostGIS extension's own routines (plus schema USAGE when PostGIS is not in public), with
// a fail-closed check; the backout must undo exactly that.
{
  const code = m1Code;
  if (/revoke\s+execute\s+on\s+all\s+(functions|routines)\s+in\s+schema/i.test(code)) {
    fail('M1: blanket "revoke execute on all functions in schema" is forbidden (it strips extension functions such as PostGIS); revoke per routine, skipping extension members');
  }
  const loop = /do \$revoke_app_routines\$[\s\S]*?\$revoke_app_routines\$;/.exec(code)?.[0] ?? '';
  if (!loop || !/n\.nspname in \('public', 'internal'\)/.test(loop) || !/not exists \(\s*select 1 from pg_depend d\s+where d\.classid = 'pg_proc'::regclass and d\.objid = p\.oid\s+and d\.refclassid = 'pg_extension'::regclass and d\.deptype = 'e'\)/.test(loop)
      || !loop.includes("execute format('revoke execute on routine %s from public, anon, authenticated', r.fn);")) {
    fail('M1: the app-routine revoke must cover public and internal and exclude extension members (pg_depend deptype e)');
  }
  const pg = /do \$postgis_for_app\$[\s\S]*?\$postgis_for_app\$;/.exec(code)?.[0] ?? '';
  if (!pg) fail('M1: the PostGIS grant block for recruiter_api is missing');
  else {
    if (!/p\.proname = 'st_x'\) <> 1 then\s+raise exception/.test(pg)) fail('M1: PostGIS must be identified as exactly one extension owning st_x, or the migration stops');
    if (!pg.includes("execute format('grant execute on routine %s to recruiter_api', r.fn);") || !/d\.refobjid = v_ext/.test(pg)) fail('M1: recruiter_api must get EXECUTE on the PostGIS extension member routines only');
    if (!pg.includes("execute format('grant usage on schema %I to recruiter_api', v_schema);") || !pg.includes("execute format('alter role recruiter_app in database %I set search_path = public, %I', current_database(), v_schema);")) fail('M1: PostGIS outside public needs schema USAGE and the search_path for recruiter_app');
    if (!/not has_function_privilege\('recruiter_api', p\.oid, 'execute'\)/.test(pg) || !/raise exception 'M1: recruiter_api cannot run the PostGIS functions the app uses'/.test(pg)) fail('M1: the PostGIS grant must fail closed when recruiter_api still cannot run st_x/st_y/st_dwithin/st_makepoint/st_setsrid/st_makeline/st_distance');
    for (const fn of ['st_x', 'st_y', 'st_dwithin', 'st_makepoint', 'st_setsrid', 'st_makeline', 'st_distance']) if (!pg.includes(`'${fn}'`)) fail(`M1: the PostGIS check must name ${fn}`);
  }
  if (/grant\s+execute\s+on\s+all\s+(functions|routines)\s+in\s+schema\s+\w+\s+to\s+recruiter_api/i.test(code)) fail('M1: recruiter_api must not get EXECUTE on every function in a schema');
  if (!/raise exception 'M1: PostGIS schema % is writable by an app role; refusing to trust it'/.test(pg)
      || !['public', 'anon', 'authenticated', 'recruiter_api', 'recruiter_app'].every((r) => pg.includes(`has_schema_privilege('${r}', v_schema, 'create')`))) {
    fail('M1: a PostGIS schema outside public must be refused if any app or API role can create objects in it');
  }
  // Final hardening step: the PostGIS schema joins the pinned search_path (after public, internal).
  const hard = /do \$hardening\$[\s\S]*?\$hardening\$;/.exec(code)?.[0] ?? '';
  if (!hard.includes("v_path    text := 'public, internal, pg_temp';") || !hard.includes("v_path := format('public, internal, %I, pg_temp', v_postgis);")
      || !hard.includes("execute format('alter function %s set search_path = %s', fn, v_path);") || /set search_path = public, internal, pg_temp', fn/.test(hard)) {
    fail('M1: the final hardening step must pin public, internal, <PostGIS schema>, pg_temp when PostGIS is not in public');
  }
  // Self-check: EXECUTE spatial queries as recruiter_api AFTER the final hardening step.
  const sc = /do \$postgis_selfcheck\$[\s\S]*?\$postgis_selfcheck\$;/.exec(code)?.[0] ?? '';
  if (!sc || code.indexOf('$postgis_selfcheck$') < code.lastIndexOf('$hardening$;')) fail('M1: the PostGIS self-check must run after the final hardening step');
  else {
    if (!sc.includes("execute 'set local role recruiter_api';")) fail('M1: the PostGIS self-check must run as recruiter_api');
    for (const call of ['internal.zone_geom(', 'internal.matching_carriers(', '.st_x(', '.st_y(', '.st_distance(', 'corridor']) if (!sc.includes(call)) fail(`M1: the PostGIS self-check must execute ${call}`);
    if (!/raise exception 'M1: PostGIS self-check as recruiter_api failed: %'/.test(sc)) fail('M1: a failed PostGIS self-check must stop the migration');
  }
  const bo = stripComments(backout);
  const pgb = /do \$postgis_for_app_backout\$[\s\S]*?\$postgis_for_app_backout\$;/.exec(bo)?.[0] ?? '';
  if (!pgb || !pgb.includes("execute format('revoke execute on routine %s from recruiter_api', r.fn);") || !pgb.includes("execute format('revoke usage on schema %I from recruiter_api', v_schema);") || !pgb.includes("execute format('alter role recruiter_app in database %I reset search_path', current_database());")) {
    fail('backout: must undo the PostGIS grants symmetrically (member routines, schema USAGE, search_path)');
  }
  if (bo.indexOf('$postgis_for_app_backout$') > bo.indexOf('revoke recruiter_api from recruiter_app;')) fail('backout: undo the PostGIS grants before dismantling recruiter_api');
}

// M1c (Hunter, 2026-10-23): a permanent record of every batch delete, written in the SAME
// transaction as the manager-only delete, in a table nothing cascades into; the backout keeps it.
{
  const code = stripComments(m1c);
  if (!/^begin;$/m.test(code) || !/^commit;$/m.test(code)) fail('M1c: must be one transaction');
  const table = /create table internal\.batch_delete_audit \(([\s\S]*?)\n\);/.exec(code)?.[1] ?? '';
  if (!table) fail('M1c: internal.batch_delete_audit missing');
  for (const col of ['batch_id     uuid not null', 'batch_name   text not null', 'actor_id     uuid not null', 'deleted_at   timestamptz not null', 'member_count int not null']) {
    if (!table.includes(col)) fail(`M1c: audit column missing: ${col}`);
  }
  if (/references|cascade/i.test(table)) fail('M1c: the audit table must have no foreign key (nothing may cascade into it)');
  if (!/before update or delete on internal\.batch_delete_audit/.test(code) || !/before truncate on internal\.batch_delete_audit/.test(code)) fail('M1c: the audit table must be append-only (update, delete and truncate refused)');
  if (!code.includes('revoke all on table internal.batch_delete_audit from public, anon, authenticated, recruiter_api;') || /grant [^;]* on (table )?internal\.batch_delete_audit/i.test(code)) fail('M1c: no app role may touch the audit table directly');
  const fn = /create function public\.batch_delete\(p_batch_id uuid\)[\s\S]*?\$\$;/.exec(code)?.[0] ?? '';
  if (!fn) fail('M1c: public.batch_delete missing');
  else {
    if (!fn.includes("v_actor   uuid := internal.lock_and_validate(array['manager']::user_role[], array['link']);") || fn.indexOf('internal.lock_and_validate(') > fn.indexOf('v_name ')) fail('M1c: batch_delete must be manager-only, link session only, validated before anything else');
    if (!fn.includes("if not internal.actor_can_write(array['manager']::user_role[]) then")) fail('M1c: batch_delete must keep the delete policy check (it bypasses RLS)');
    const lock = fn.indexOf('for update;');
    const audit = fn.indexOf('insert into internal.batch_delete_audit');
    const del = fn.indexOf('delete from public.batches where id = p_batch_id;');
    if (lock < 0 || audit < 0 || del < 0 || !(lock < audit && audit < del)) fail('M1c: lock the batch, write the audit row, then delete (one function, one transaction)');
    if (!/if not found then\s+return false;/.test(fn) || fn.indexOf('return false;') > audit) fail('M1c: an unknown batch must write nothing');
    if (/exception\s+when/i.test(fn)) fail('M1c: batch_delete must not swallow errors (a failed delete must roll back its audit row)');
  }
  if (!code.includes('revoke all on function public.batch_delete(uuid) from public, anon, authenticated;') || !code.includes('grant execute on function public.batch_delete(uuid) to recruiter_api;')) fail('M1c: batch_delete must be callable by recruiter_api only');
  if (!/^revoke delete on public\.batches from recruiter_api;$/m.test(code)) fail('M1c: recruiter_api must lose direct DELETE on public.batches (batch_delete is the only way)');
  const bo = stripComments(m1cBackout);
  if (!/^begin;$/m.test(bo) || !/^commit;$/m.test(bo)) fail('M1c-backout: must be one transaction');
  if (!bo.includes('drop function if exists public.batch_delete(uuid);')) fail('M1c-backout: must drop batch_delete');
  if (!/^grant delete on public\.batches to recruiter_api;/m.test(bo)) fail('M1c-backout: must restore the direct DELETE on public.batches that M1 granted');
  if (/\bdrop table\b|\bdelete from\b|\btruncate\b|batch_delete_audit/i.test(bo)) fail('M1c-backout: must keep the permanent record (no drop, delete or truncate)');
}

finish();

function finish() {
  if (failures.length) {
    console.error('Same-origin sign-in SQL contract check failed:');
    for (const f of failures) console.error(`- ${f}`);
    process.exit(1);
  }
  console.log('PASS same-origin sign-in SQL contract (pending M1, backout, retire, L1): text-level checks only; not executed');
}
