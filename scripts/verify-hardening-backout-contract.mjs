#!/usr/bin/env node
// Offline contract check for the backout of the security_hardening migration (no database needed):
//   supabase/migrations/20260722223300_security_hardening.sql
//   supabase/backout/security-hardening-backout.sql
// It proves text-level properties only: every REVOKE of EXECUTE in the migration has a literal
// mirror GRANT in the backout, and the backout does nothing else. It never runs the SQL.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8').replace(/\r\n/g, '\n');
const failures = [];
const fail = (msg) => failures.push(msg);

const MIGRATION_PATH = ['supabase', 'migrations', '20260722223300_security_hardening.sql'];
const BACKOUT_PATH = ['supabase', 'backout', 'security-hardening-backout.sql'];
for (const p of [MIGRATION_PATH, BACKOUT_PATH]) {
  if (!existsSync(join(root, ...p))) fail(`missing ${p.join('/')}`);
}
if (failures.length) finish();

const stripComments = (sql) => sql.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
const statements = (sql) => stripComments(sql).split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
const migration = statements(read(...MIGRATION_PATH));
const backout = statements(read(...BACKOUT_PATH));
const backoutText = stripComments(read(...BACKOUT_PATH));

// A. Mirror every revoke in the migration. The expected statements are DERIVED from the migration,
//    not hard-coded, so a later edit to the migration breaks this check instead of drifting.
const expected = [];
for (const s of migration) {
  let m = /^revoke execute on all functions in schema (\w+) from ([\w, ]+)$/i.exec(s);
  if (m) expected.push(`grant execute on all functions in schema ${m[1]} to ${m[2]}`);
  m = /^alter default privileges in schema (\w+) revoke execute on functions from ([\w, ]+)$/i.exec(s);
  if (m) expected.push(`alter default privileges in schema ${m[1]} grant execute on functions to ${m[2]}`);
}
// The migration is known to carry 4 such revokes (2 schemas x function revoke and default revoke).
if (expected.length !== 4) fail(`migration: expected 4 EXECUTE revokes to mirror, found ${expected.length}`);
for (const want of expected) {
  const hits = backout.filter((s) => s.toLowerCase() === want.toLowerCase());
  if (hits.length !== 1) fail(`backout: must contain exactly once: ${want};`);
}

// B. One transaction, and nothing but begin / commit / the mirror grants.
if (backout[0]?.toLowerCase() !== 'begin' || backout[backout.length - 1]?.toLowerCase() !== 'commit') fail('backout: must be exactly one transaction (begin; ... commit;)');
const allowed = new Set([...expected.map((s) => s.toLowerCase()), 'begin', 'commit']);
for (const s of backout) {
  if (!allowed.has(s.toLowerCase())) fail(`backout: unexpected statement: ${s.slice(0, 80)}`);
}

// C. It must not touch what it deliberately leaves alone.
if (/\b(authenticated|service_role|recruiter_\w+)\b/i.test(backoutText)) fail('backout: must not mention authenticated, service_role or recruiter_* (those grants are not undone here)');
if (/\balter\s+function\b|\bset\s+search_path\b/i.test(backoutText)) fail('backout: must not change function search_path pins');
if (/\brevoke\b|\bdrop\b|\bdelete\b|\btruncate\b|\bcreate\b|\bupdate\b|\binsert\b/i.test(backoutText)) fail('backout: only GRANT and ALTER DEFAULT PRIVILEGES ... GRANT are allowed');

// D. No credentials or connection strings.
const raw = read(...BACKOUT_PATH);
if (/password\s+'[^']*'/i.test(raw)) fail('backout: contains a password literal');
if (/postgres(ql)?:\/\/|sb_secret_|eyJ[A-Za-z0-9_-]{10,}\./.test(raw)) fail('backout: contains a connection string or key');

// E. The header must say what it needs to say (so the operator is not surprised).
for (const needle of ['NOT EXECUTED', 'M1-backout', 'search_path', 'service_role']) {
  if (!raw.includes(needle)) fail(`backout header must mention: ${needle}`);
}

finish();

function finish() {
  if (failures.length) {
    console.error('security_hardening backout contract check failed:');
    for (const f of failures) console.error(`- ${f}`);
    process.exit(1);
  }
  console.log('PASS security_hardening backout contract: every EXECUTE revoke has a mirror grant, one transaction, nothing else; text-level checks only; not executed');
}
