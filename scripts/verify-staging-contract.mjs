#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');
// Optional argument: a directory holding the staging SQL files (defaults to supabase/staging).
const stagingDir = resolve(process.argv[2] ?? resolve(repositoryRoot, 'supabase/staging'));
const migrationsDir = resolve(repositoryRoot, 'supabase/migrations');
const PRODUCTION_REF = 'ejrfobddnojbijzrjbii';
const STAGING_REF = 'yhyoxhtguyturgdhwywc';
const MARKER_TABLE = 'staging_identity.marker';
const read = (name) => (existsSync(resolve(stagingDir, name)) ? readFileSync(resolve(stagingDir, name), 'utf8') : '');
const fixture = read('profile-fixtures.sql');
const cleanup = read('cleanup-fixtures.sql');
const roleMatrix = read('verify-role-matrix.sql');
const installer = read('install-staging-identity-marker.sql');

const failures = [];
if ([fixture, cleanup, roleMatrix, installer].some((sql) => sql.includes(PRODUCTION_REF))) {
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

// ---- Staging identity marker (Codex findings 1 and 3) ---------------------------------
const markerIdMatch = /insert into staging_identity\.marker[\s\S]*?'staging',\s*'([0-9a-f-]{36})'/i.exec(installer);
const markerId = markerIdMatch?.[1];
if (!installer) {
  failures.push('install-staging-identity-marker.sql is missing');
} else {
  if (!markerId) failures.push('marker installer must insert one fixed marker UUID');
  for (const required of [
    "app.staging_marker_install_confirmation",
    "check (environment = 'staging')",
    'v_fixture_profiles <> 7',
    'v_other_profiles <> 0',
    'v_real_range_carriers <> 0',
  ]) {
    if (!installer.includes(required)) failures.push(`marker installer is missing required guard: ${required}`);
  }
  for (const role of ['anon', 'authenticated', 'service_role']) {
    if (!installer.includes(`'${role}'`)) failures.push(`marker installer must revoke access from ${role}`);
  }
  const installerGuard = installer.indexOf('v_real_range_carriers <> 0');
  const createSchema = installer.indexOf('create schema staging_identity');
  if (!(installerGuard >= 0 && createSchema > installerGuard)) {
    failures.push('marker installer must refuse a non-fixture database before creating the marker');
  }
}
for (const migration of existsSync(migrationsDir) ? readdirSync(migrationsDir) : []) {
  if (readFileSync(resolve(migrationsDir, migration), 'utf8').includes('staging_identity')) {
    failures.push(`staging identity marker must never be defined in supabase/migrations (${migration})`);
  }
}

// ---- Cleanup must be identity-gated and scoped (Codex finding 1) ---------------------
const markerGate = cleanup.indexOf(`to_regclass('${MARKER_TABLE}')`);
const firstDelete = cleanup.search(/delete\s+from\s/i);
if (markerGate < 0) failures.push('cleanup must check the staging identity marker in the connected database');
if (!markerId || !cleanup.includes(markerId)) failures.push('cleanup must require the exact installed marker UUID');
if (!cleanup.includes("app.staging_cleanup_confirmation")) failures.push('cleanup must require its confirmation phrase');
if (!cleanup.includes('v_real_range_carriers <> 0') || !cleanup.includes('v_other_profiles <> 0')) {
  failures.push('cleanup must refuse unexpected non-fictional business data');
}
if (!(markerGate >= 0 && firstDelete > markerGate)) {
  failures.push('cleanup must establish database identity before its first delete');
}
for (const match of cleanup.matchAll(/delete\s+from\s+([\w.]+)\s*;/gi)) {
  failures.push(`cleanup contains an unscoped delete: ${match[0]}`);
}
if (/truncate|drop\s+(?:table|schema|database)/i.test(cleanup)) {
  failures.push('cleanup must not truncate or drop database objects');
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exit(1);
}
console.log('PASS staging fixture, marker installer, identity-gated scoped cleanup, and rollback-only role matrix are paired, non-login, and exact-ref safe');
