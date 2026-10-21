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

// ---- Staging identity marker + fixture registry (Codex findings 1/3, round 2) -----------
const RUNNER_GATE = "current_setting('app.staging_runner_verified_ref', true) is distinct from 'yhyoxhtguyturgdhwywc'";
const runnerPath = resolve(repositoryRoot, 'pipeline/src/staging-sql-runner.ts');
const runner = existsSync(runnerPath) ? readFileSync(runnerPath, 'utf8') : '';
const deleteStatements = (sql) => [...sql.matchAll(/delete\s+from\s+[\s\S]*?;/gi)].map((match) => match[0]);
const markerIdMatch = /insert into staging_identity\.marker[\s\S]*?'staging',\s*'([0-9a-f-]{36})'/i.exec(installer);
const markerId = markerIdMatch?.[1];
if (!runner.includes('parseSupabaseDbTarget') || !runner.includes('refuses the production')
  || !runner.includes("'app.staging_runner_verified_ref'") || !runner.includes('RECORDED_PROJECT_REFS.staging')) {
  failures.push('staging SQL runner must reuse the pipeline target parser, refuse production, require the staging ref, and set the verified-ref session value');
}
if (!installer) {
  failures.push('install-staging-identity-marker.sql is missing');
} else {
  if (!markerId) failures.push('marker installer must insert one fixed marker UUID');
  for (const required of [
    RUNNER_GATE,
    'app.staging_marker_install_confirmation',
    "check (environment = 'staging')",
    "check (project_ref = 'yhyoxhtguyturgdhwywc')",
    'create table staging_identity.fixture_rows',
    'v_other_profiles <> 0',
  ]) {
    if (!installer.includes(required)) failures.push(`marker installer is missing required guard: ${required}`);
  }
  for (const role of ['anon', 'authenticated', 'service_role']) {
    if (!installer.includes(`'${role}'`)) failures.push(`marker installer must revoke access from ${role}`);
  }
  const installerGuard = installer.indexOf(RUNNER_GATE);
  const profileGuard = installer.indexOf('v_other_profiles <> 0');
  const createSchema = installer.indexOf('create schema staging_identity');
  if (!(installerGuard >= 0 && profileGuard > installerGuard && createSchema > profileGuard)) {
    failures.push('marker installer must require the runner-verified project and refuse real users before creating the marker');
  }
  if (deleteStatements(installer).length) failures.push('marker installer must not delete anything');
}
for (const migration of existsSync(migrationsDir) ? readdirSync(migrationsDir) : []) {
  if (readFileSync(resolve(migrationsDir, migration), 'utf8').includes('staging_identity')) {
    failures.push(`staging identity marker must never be defined in supabase/migrations (${migration})`);
  }
}

// ---- Round 3: first install adopts only the fingerprinted fictional baseline -------------
// The installer's fingerprint must stay in lock-step with the generator in the reset, and it
// must refuse (with per-kind counts) instead of adopting anything unrecognised.
const resetPath = resolve(stagingDir, 'reset-fictional-data.sql');
const resetSql = existsSync(resetPath) ? readFileSync(resetPath, 'utf8').replace(/\r\n/g, '\n') : '';
const installerSql = installer.replace(/\r\n/g, '\n');
const quoted = (text) => [...text.matchAll(/'((?:[^']|'')*)'/g)].map((match) => match[1]);
const resetGeoWords = quoted(/insert into tmp_geo_words \(w\) values([\s\S]*?);/.exec(resetSql)?.[1] ?? '');
const installerGeoWords = quoted(/unnest\(array\[([\s\S]*?)\]\)/.exec(installerSql)?.[1] ?? '');
if (resetGeoWords.length !== 25 || JSON.stringify(resetGeoWords) !== JSON.stringify(installerGeoWords)) {
  failures.push('installer fingerprint geo-word list must equal the reset generator list exactly');
}
for (const [generator, fingerprint, label] of [
  ['generate_series(1, 785)', 'c.dot_number between 1200137 and 1307674', 'bulk DOT index range'],
  ['(1200000 + d.i * 137 + floor(d.r_dot_jit * 130)::int)', '(c.dot_number - 1200000) % 137 < 130', 'bulk DOT formula'],
  ["'(202) 555-' || lpad((100 + (f.i % 100))::text, 4, '0')", "c.phone = '(202) 555-' || lpad((100 + (((c.dot_number - 1200000) / 137) % 100))::text, 4, '0')", 'bulk phone'],
  ["'(202) 555-' || lpad((100 + ((f.i + 37) % 100))::text, 4, '0')", "+ 37) % 100))::text, 4, '0')", 'bulk cell phone'],
  ["'(202) 555-' || lpad((100 + ((f.i + 73) % 100))::text, 4, '0')", "+ 73) % 100))::text, 4, '0')", 'bulk fax'],
  ["'@carrier.example.invalid'", "c.email_address like '%@carrier.example.invalid'", 'bulk email domain'],
  ['md5(f.dot_number::text || f.geo_word || f.zip_suffix)', 'c.row_hash = md5(c.dot_number::text || w.word || substr(c.phy_zip, 3))', 'bulk row hash'],
  ["'75' || f.zip_suffix, '75' || f.zip_suffix", 'substr(c.phy_zip, 3)', 'bulk ZIP suffix'],
  ["md5('1400015')", 'c.dot_number between 1400001 and 1400015', 'hand-authored DOT set'],
  ["md5('1400001')", 'c.row_hash = md5(c.dot_number::text)', 'hand-authored row hash'],
]) {
  if (!resetSql.includes(generator)) failures.push(`reset no longer generates the fingerprinted ${label}; update the installer fingerprint`);
  if (!installerSql.includes(fingerprint)) failures.push(`installer fingerprint is missing the ${label} check`);
}
const handAuthoredHashes = new Set(resetSql.match(/md5\('14000\d\d'\)/g) ?? []);
if (handAuthoredHashes.size !== 15) failures.push('reset must hand-author exactly DOT 1400001-1400015 with md5(dot) row hashes');
for (const [name, creator] of [
  ['Central Texas Aggregate Recruitment', 'manager@tnbs-recruiter.example.invalid'],
  ['I-35 Corridor: Austin -> San Antonio', 'editor@tnbs-recruiter.example.invalid'],
]) {
  const generated = new RegExp(`'${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'[\\s\\S]{0,1200}?p\\.email = '${creator}'`).test(resetSql);
  if (!generated) failures.push(`reset no longer creates baseline batch "${name}" as ${creator}`);
  if (!installerSql.includes(`b.name = '${name}' and u.email = '${creator}'`)) failures.push(`installer must recognise baseline batch "${name}" only from ${creator}`);
}
const resetNotes = [...resetSql.matchAll(/insert into public\.contact_logs[\s\S]*?::contact_disposition,\s*'((?:[^']|'')*)'/g)].map((match) => match[1]);
const notesBlock = /l\.notes in \(([\s\S]*?)\)/.exec(installerSql)?.[1] ?? '';
const installerNotes = quoted(notesBlock);
if (resetNotes.length !== 5 || JSON.stringify([...resetNotes].sort()) !== JSON.stringify([...installerNotes].sort())) {
  failures.push('installer contact-log fingerprint must list exactly the reset contact notes');
}
if (/insert into public\.contact_suppressions/i.test(resetSql) || !installerSql.includes('select count(*) into v_suppressions from public.contact_suppressions;')) {
  failures.push('baseline has no suppressions; the installer must treat every suppression as unrecognised');
}
const countsRefusal = installerSql.indexOf("rows not recognised as the deterministic fictional baseline: carriers %, batches %, cargo values %, contact logs %, contact suppressions %, batch members %, batch activity %, carrier DNC changes by non-fixture users %");
if (countsRefusal < 0 || countsRefusal > installerSql.indexOf('create schema staging_identity')) {
  failures.push('installer must refuse unrecognised rows, listing counts per kind, before creating the marker');
}
for (const kind of ['carriers', 'batches', 'cargo_other_values']) {
  const adoption = new RegExp(`select '${kind}', [^;]* from ([\\w.]+);`).exec(installerSql)?.[1];
  if (!adoption || !adoption.startsWith('tmp_baseline_')) {
    failures.push(`installer must register ${kind} only from the fingerprinted baseline set (found ${adoption ?? 'none'})`);
  }
}

// ---- Cleanup: runner + marker gated, scoped by explicit fixture ownership ---------------
const runnerGate = cleanup.indexOf(RUNNER_GATE);
const markerGate = cleanup.indexOf(`to_regclass('${MARKER_TABLE}')`);
const firstDelete = cleanup.search(/delete\s+from\s/i);
if (runnerGate < 0) failures.push('cleanup must require the runner-verified staging project');
if (markerGate < 0) failures.push('cleanup must check the staging identity marker in the connected database');
if (!markerId || !cleanup.includes(markerId)) failures.push('cleanup must require the exact installed marker UUID');
if (!cleanup.includes('project_ref = %L')) failures.push('cleanup must check the marker names the runner-verified project');
if (!cleanup.includes('app.staging_cleanup_confirmation')) failures.push('cleanup must require its confirmation phrase');
if (!(runnerGate >= 0 && markerGate > runnerGate && firstDelete > markerGate)) {
  failures.push('cleanup must establish database identity before its first delete');
}
for (const statement of deleteStatements(cleanup)) {
  if (!/\bwhere\b/i.test(statement)) failures.push(`cleanup contains an unscoped delete: ${statement.split('\n')[0]}`);
  else if (!/tmp_cleanup_|staging_identity\.fixture_rows/.test(statement)) {
    failures.push(`cleanup delete is not scoped by explicit fixture ownership: ${statement.split('\n')[0]}`);
  }
}
if (/between\s+1[24]00/i.test(cleanup)) failures.push('cleanup must not scope by DOT-number ranges');
if (/hunter@twistednail\.com/i.test(cleanup)) failures.push('cleanup must not scope by owner identity');
if (!cleanup.includes("raw_user_meta_data->>'test_only' = 'true'")) failures.push('cleanup must select fixture identities by explicit metadata');
// Round 2 item 4: approval references are cleared under a narrowly scoped service-role claim.
const claimOn = cleanup.indexOf(`set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
const approvalUpdate = cleanup.indexOf('set approved_by = null');
const claimOff = cleanup.indexOf(`set_config('request.jwt.claims', '{}', true)`);
if (!(claimOn > markerGate && markerGate >= 0 && approvalUpdate > claimOn && claimOff > approvalUpdate)) {
  failures.push('cleanup must clear approval references only under a transaction-local service-role claim set after the gates and cleared right after');
} else if (/\b(?:update|delete|insert)\b/i.test(cleanup.slice(cleanup.indexOf(';', approvalUpdate) + 1, claimOff))) {
  failures.push('the service-role claim in cleanup must cover only the approval update');
}
if (/truncate|drop\s+(?:table|schema|database)/i.test(cleanup)) {
  failures.push('cleanup must not truncate or drop database objects');
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exit(1);
}
console.log('PASS staging fixture, runner-gated baseline-fingerprinted marker installer, ownership-scoped cleanup, and rollback-only role matrix are paired, non-login, and exact-ref safe');
