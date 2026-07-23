#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const sql = readFileSync(resolve(root, 'docs/build-plan/09-production-baseline-reconciliation.sql'), 'utf8');
const checksums = readFileSync(resolve(root, 'docs/build-plan/migration-checksums.sha256'), 'utf8');

const adopted = Array.from(sql.matchAll(/\('([0-9]{14})',\s*'([^']+)',\s*array\[\]::text\[\]\)/g), (match) => ({
  version: match[1],
  name: match[2],
}));
const expectedAdopted = [
  ['20260720000100', 'extensions'],
  ['20260720000200', 'enums'],
  ['20260720000300', 'profiles'],
  ['20260720000400', 'carriers'],
  ['20260720000500', 'cargo_other_values'],
  ['20260720000600', 'batches'],
  ['20260720000700', 'contact'],
  ['20260720000800', 'activity'],
  ['20260720000900', 'warnings'],
  ['20260720001000', 'internal_matcher'],
  ['20260720001100', 'rpc'],
  ['20260720001200', 'rls'],
  ['20260720001300', 'realtime'],
  ['20260720001400', 'pipeline_tables'],
  ['20260720001500', 'service_role_pipeline_grants'],
];
const postGeocode = [
  '20260722223300_security_hardening',
  '20260723004500_profile_service_bootstrap',
  '20260723010400_dnc_activity_enum_cast',
];
const failures = [];

if (JSON.stringify(adopted.map(({ version, name }) => [version, name])) !== JSON.stringify(expectedAdopted)) {
  failures.push('proposal must adopt exactly the fifteen pre-ledger migrations in order');
}
if (!sql.includes("version = '20260722042539'") || !sql.includes("name = 'geocode_attempt_queue'")) {
  failures.push('proposal must require the exact existing live geocode ledger row');
}
if (!sql.includes('existing_count <> 1') || !sql.includes('final_count <> 16') || !sql.includes('adopted_count <> 15')) {
  failures.push('proposal must retain exact pre/post row-count guards');
}
for (const migration of postGeocode) {
  if (!checksums.includes(`${migration}.sql`)) failures.push(`${migration} missing from checksum manifest`);
  const version = migration.slice(0, 14);
  if (!sql.includes(version)) failures.push(`${migration} is not explicitly excluded from adoption`);
  if (adopted.some((row) => row.version === version)) failures.push(`${migration} must not be adopted as already live`);
}
if (!sql.startsWith('-- PROPOSAL ONLY')) failures.push('proposal-only warning must remain the first line');
if (!sql.trimEnd().endsWith('commit;')) failures.push('transaction must end explicitly');

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exit(1);
}
console.log('PASS production baseline proposal adopts only 15 pre-ledger rows and separates 3 unapplied migrations');
