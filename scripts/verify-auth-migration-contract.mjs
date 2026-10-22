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

for (const p of [M1_PATH, BACKOUT_PATH, RETIRE_PATH, L1_PATH, ['supabase', 'backout', 'pre-cutover-snapshot.sql']]) {
  if (!existsSync(join(root, ...p))) fail(`missing ${p.join('/')}`);
}
if (failures.length) finish();

const m1 = read(...M1_PATH);
const backout = read(...BACKOUT_PATH);
const retire = read(...RETIRE_PATH);
const l1 = read(...L1_PATH);
const stripComments = (sql) => sql.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
const m1Code = stripComments(m1);

// A. Still pending: nothing of M1 inside supabase/migrations.
const migrationsDir = join(root, 'supabase', 'migrations');
for (const f of readdirSync(migrationsDir)) {
  const text = readFileSync(join(migrationsDir, f), 'utf8');
  if (/recruiter_api|internal\.app_sessions|lock_and_validate/.test(text)) fail(`supabase/migrations/${f} contains M1 objects; promotion is an explicit baseline decision`);
}

// B. No credentials or connection strings in any of the new SQL.
for (const [name, text] of [['M1', m1], ['backout', backout], ['retire', retire], ['L1', l1]]) {
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
    replace: [['and bc.dot_number = any(p_dots)', 'and bc.dot_number = any(v_locked)'], ['unnest(p_dots[1:50])', 'unnest(v_locked[1:50])']] },
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
  ['20260722223300_security_hardening.sql', 11, 32], ['20260723010400_dnc_activity_enum_cast.sql', 55, 56],
];
for (const [file, from, to] of restored) {
  const text = originalLines(file, from, to).join('\n').replace(/^create function /, 'create or replace function ');
  if (!backout.includes(text)) fail(`backout: does not restore ${file}:${from}-${to} verbatim`);
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
]) {
  const body = m1Function(start)?.join('\n') ?? '';
  const lockAt = body.lastIndexOf(lockMarker);
  const recheckAt = body.lastIndexOf('internal.recheck_session()');
  if (lockAt < 0 || recheckAt < lockAt) fail(`M1: ${start} must re-check the session after its last business lock`);
}

// K2b. Time checks after a possible lock wait use the wall clock, never now() (frozen at
// transaction start).
const recheck = m1Function('function internal.recheck_session()')?.join('\n') ?? '';
if (!recheck.includes('clock_timestamp()') || /\bnow\(\)/.test(stripComments(recheck))) fail('M1: recheck_session must use clock_timestamp(), never now()');
const lavValidate = (m1Function('function internal.lock_and_validate(')?.join('\n') ?? '').split('-- Validate from the locked rows only.')[1] ?? '';
if (!lavValidate.includes('clock_timestamp()') || /\bnow\(\)/.test(stripComments(lavValidate))) fail('M1: lock_and_validate validation must use clock_timestamp(), never now()');

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
// filter, so the actor's own and recovery sessions too), one audit row, recovery enrollment
// untouched (open decision).
const eso = m1Function('function public.team_sign_everyone_out()')?.join('\n') ?? '';
if (!eso) fail('M1: team_sign_everyone_out missing');
else {
  if (!eso.includes("internal.lock_and_validate(array['manager']::user_role[], array['link']")) fail('M1: emergency sign-out must be manager-only (link session)');
  const upd = /update internal\.app_sessions[\s\S]*?;/.exec(eso)?.[0] ?? '';
  if (!/where revoked_at is null;/.test(upd) || /user_id/.test(upd)) fail('M1: emergency sign-out must revoke every live session, with no user filter');
  if (!eso.includes("'emergency_sign_out'") || !eso.includes('insert into internal.auth_events')) fail('M1: emergency sign-out must write an actor audit row');
  if (/recovery_(codes|sets)/.test(stripComments(eso))) fail('M1: emergency sign-out must not touch recovery enrollment (undecided)');
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

finish();

function finish() {
  if (failures.length) {
    console.error('Same-origin sign-in SQL contract check failed:');
    for (const f of failures) console.error(`- ${f}`);
    process.exit(1);
  }
  console.log('PASS same-origin sign-in SQL contract (pending M1, backout, retire, L1): text-level checks only; not executed');
}
