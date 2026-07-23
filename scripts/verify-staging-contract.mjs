#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');
const PRODUCTION_REF = 'ejrfobddnojbijzrjbii';
const STAGING_REF = 'yhyoxhtguyturgdhwywc';
const fixture = readFileSync(resolve(repositoryRoot, 'supabase/staging/profile-fixtures.sql'), 'utf8');
const cleanup = readFileSync(resolve(repositoryRoot, 'supabase/staging/cleanup-fixtures.sql'), 'utf8');
const roleMatrix = readFileSync(resolve(repositoryRoot, 'supabase/staging/verify-role-matrix.sql'), 'utf8');

const failures = [];
if (fixture.includes(PRODUCTION_REF) || cleanup.includes(PRODUCTION_REF) || roleMatrix.includes(PRODUCTION_REF)) {
  failures.push('staging SQL contains the production project ref');
}
if (!fixture.includes(STAGING_REF) || !cleanup.includes(STAGING_REF)) {
  failures.push('staging fixture SQL must state the exact allowed staging ref');
}
if (!fixture.includes('encrypted_password') || !/example\.invalid/gi.test(fixture)) {
  failures.push('database identities must remain no-password and use reserved fixture addresses');
}
if (!fixture.includes('stg-db-20260723-0042') || !cleanup.includes('stg-db-20260723-0042')) {
  failures.push('fixture and cleanup run IDs differ');
}
if (!cleanup.includes("raw_user_meta_data->>'test_only' = 'true'")) {
  failures.push('cleanup must require test_only metadata');
}
if (!roleMatrix.includes("'failures'") || !roleMatrix.includes('rollback;')) {
  failures.push('role matrix must report failures and roll back every probe');
}
if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exit(1);
}
console.log('PASS staging fixture, cleanup, and rollback-only role matrix are paired, non-login, and exact-ref safe');
