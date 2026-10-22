#!/usr/bin/env node
// Offline contract check for the after-M1 staging SQL (supabase/staging/m1/). Text-level only.
// Keeps the production-refusal protections of scripts/verify-staging-contract.mjs.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dir = resolve(root, 'supabase/staging/m1');
const migrationsDir = resolve(root, 'supabase/migrations');
// The same recorded refs scripts/verify-staging-contract.mjs pins (repo constants, not secrets).
const PRODUCTION_REF = 'ejrfobddnojbijzrjbii';
const STAGING_REF = 'yhyoxhtguyturgdhwywc';
const failures = [];
const read = (name) => (existsSync(resolve(dir, name)) ? readFileSync(resolve(dir, name), 'utf8').replace(/\r\n/g, '\n') : undefined);
const matrix = read('verify-role-matrix-m1.sql');
const cleanup = read('cleanup-auth-ledgers-m1.sql');
if (!matrix) failures.push('missing verify-role-matrix-m1.sql');
if (!cleanup) failures.push('missing cleanup-auth-ledgers-m1.sql');
const code = (sql) => sql.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

if (matrix && cleanup) {
  // Production refusal and target gate.
  for (const [name, sql] of [['role matrix', matrix], ['cleanup', cleanup]]) {
    if (sql.includes(PRODUCTION_REF)) failures.push(`${name}: contains the production project ref`);
    if (!code(sql).includes(`current_setting('app.staging_runner_verified_ref', true) is distinct from '${STAGING_REF}'`)) {
      failures.push(`${name}: must refuse unless the runner verified the exact staging ref`);
    }
    if (/password\s+'|postgres(ql)?:\/\/|sb_secret_/i.test(sql)) failures.push(`${name}: contains a credential or connection string`);
  }
  // The pre-existing files are untouched by this slice: the m1 files live in their own folder.
  for (const f of readdirSync(migrationsDir)) {
    if (readFileSync(resolve(migrationsDir, f), 'utf8').includes('staging_identity')) failures.push(`staging identity referenced from supabase/migrations/${f}`);
  }

  // Role matrix: rollback-only, reports failures, covers the required probes.
  const m = code(matrix);
  if (!/^begin;$/m.test(m) || !/^rollback;\s*$/m.test(m.trimEnd().split('\n').slice(-1)[0] + '\n')) failures.push('role matrix: must begin and end with rollback');
  if (/^commit;$/m.test(m)) failures.push('role matrix: must never commit');
  if (!m.includes("'failures'")) failures.push('role matrix: must report a failure count');
  if (!m.includes('set local role recruiter_api')) failures.push('role matrix: must probe as recruiter_api');
  for (const role of ['anon', 'authenticated']) if (!m.includes(`set local role ${role}`)) failures.push(`role matrix: must prove ${role} is denied`);
  const requiredProbes = [
    'probe-editor-revoked', 'probe-editor-expired', 'probe-editor-old-email', 'probe-editor-recovery', 'probe-viewer-recovery',
    'delete batch (manager only)', 'delete member (manager only)', 'delete contact log (manager only)', 'delete activity (manager only)',
    'delete suppression (manager only)', 'curate cargo values (manager only)', 'insert batch directly', 'change batches.created_by',
    'set carriers.dnc_set_by directly', 'insert member with status_changed_by', 'insert member with promoted_by',
    'insert suppression as someone else', 'recovery_set_status (viewer has no writes)', 'select own profile',
    'team_sign_everyone_out (manager only)', 'sign everyone out: staff sessions incl. own revoked, non-staff kept',
    'sees the probe member (control)', 'sees the probe rows (control)', 'generate_contact_sheet sees the probe batch (control)',
  ];
  for (const probe of requiredProbes) if (!matrix.includes(probe)) failures.push(`role matrix: missing probe "${probe}"`);
  // Gate 2 review finding 9: no false positives.
  // - A savepoint rollback would also delete the probe's result row (the old allowed probes and
  //   the emergency check were never recorded); probes isolate themselves in inner blocks instead.
  if (/\bsavepoint\b|\brollback to\b/i.test(m)) failures.push('role matrix: no savepoints (a rollback to a savepoint discards the probe result)');
  // - Denials must raise the expected SQLSTATE; any other error is a failure, not a pass.
  if (!m.includes('sqlstate = any (p_states)')) failures.push('role matrix: record_denied must require the expected SQLSTATE');
  if (/exception when others then\s+insert into _results values \([^;]*, true\);/i.test(m)) failures.push('role matrix: no helper may pass on an arbitrary error');
  // - Allowed probes check their effect as the migration role; refused writes check the target is unchanged.
  for (const helper of ['record_allowed', 'record_unchanged']) {
    const body = new RegExp(`function pg_temp\\.${helper}\\([\\s\\S]*?\\$\\$;`).exec(m)?.[0] ?? '';
    if (!body.includes('reset role;') || !body.includes('execute p_check into v_ok;')) failures.push(`role matrix: ${helper} must check the effect as the migration role`);
  }
  for (const call of m.match(/select pg_temp\.record_allowed\([\s\S]*?\$\$\);/g) ?? []) {
    if ((call.match(/\$\$/g) ?? []).length !== 4) failures.push(`role matrix: allowed probe without an effect check: ${call.slice(0, 80)}`);
  }
  // - Targets are created by the matrix itself (known, non-null), never picked under a session's RLS view.
  if (!m.includes('create temporary table _t (') || !/raise exception 'role matrix needs/.test(m)) failures.push('role matrix: probe targets must be created up front and checked non-null');
  if (/\(select (id|batch_id|dot_number|value) from public\.(batches|batch_carriers|contact_logs|batch_activity|contact_suppressions|cargo_other_values)( [a-z]+)? (order by [^)]*)?limit 1\)/.test(m)) failures.push('role matrix: probe targets must come from _t, not RLS-filtered subqueries');

  // Cleanup: gated, one transaction, every delete scoped to the fixture identities.
  const c = code(cleanup);
  for (const gate of ['staging_identity.marker', "app.staging_auth_ledger_cleanup_confirmation", 'stg-db-20260723-0042', "raw_user_meta_data->>'test_only' = 'true'", 'encrypted_password is null']) {
    if (!c.includes(gate)) failures.push(`cleanup: missing gate or ownership condition "${gate}"`);
  }
  const statements = c.split(';').map((s) => s.trim()).filter(Boolean);
  for (const stmt of statements.filter((s) => /^delete\s+from/i.test(s))) {
    if (!/tmp_fixture_people/.test(stmt)) failures.push(`cleanup: delete not scoped to fixture identities: ${stmt.slice(0, 80)}`);
    if (!/^delete from internal\./i.test(stmt)) failures.push(`cleanup: may delete only sign-in ledger rows: ${stmt.slice(0, 80)}`);
  }
  if (/delete from (auth|public)\./i.test(c)) failures.push('cleanup: must not delete identities or business rows (cleanup-fixtures.sql does that)');
  const gateAt = c.indexOf('staging_identity.marker');
  const firstDelete = c.search(/delete from/i);
  if (!(gateAt >= 0 && gateAt < firstDelete)) failures.push('cleanup: gates must run before any delete');
}

if (failures.length) {
  console.error('After-M1 staging SQL contract check failed:');
  for (const f of failures) console.error(`- ${f}`);
  process.exit(1);
}
console.log('PASS after-M1 staging SQL (role matrix, sign-in ledger cleanup): runner/marker gated, production-ref free, rollback-only matrix, fixture-scoped deletes');
