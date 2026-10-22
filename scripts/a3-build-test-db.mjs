#!/usr/bin/env node
// A3 ONLY: builds a disposable test database inside the task-owned throwaway cluster.
// Usage (password from the environment, never printed):
//   A3_PGPASSWORD=... node scripts/a3-build-test-db.mjs --owner-dir <task dir> --port <n> --db tr_<name> [--no-m1] [--snapshot out.json]
// Steps: (re)create the database; Supabase shim; the 20 migrations with recorded PostGIS
// substitutions; staging profile fixtures; A3 business fixtures; optionally a snapshot; M1.
//
// Ownership before anything destructive (Gate 2 review finding 8):
//   1. loopback host and a "tr_" database name only;
//   2. <owner-dir>/A3_TASK_OWNED must hold the task's random ownership token;
//   3. the server on --port must report data_directory == <owner-dir>/data (cluster identity);
//   4. an existing database is dropped only if its comment is "a3-task-owned:<token>", and
//      without FORCE (a database with other connections is refused, not cut off).
// A new database gets that comment, so only this task's own builds can ever replace it.
//
// --suites also builds one database per DB-using test suite (<db>_store, <db>_readiness,
// <db>_e2e), so suites that mutate global state (emergency sign-out revokes every staff session)
// can never share a database (Gate 2 final check 2; app/server/testing/test-db.ts).

import { createRequire } from 'node:module';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const require = createRequire(join(root, 'app', 'package.json'));
const pg = require('pg');

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
  return acc;
}, []));
const port = Number(args.port);
const dbName = args.db ?? 'tr_signin_test';
const password = process.env.A3_PGPASSWORD;
if (!password || !Number.isInteger(port) || !/^tr_[a-z0-9_]+$/.test(dbName) || !args['owner-dir']) {
  console.error('usage: A3_PGPASSWORD=... node scripts/a3-build-test-db.mjs --owner-dir <task dir> --port <n> --db tr_<name>');
  process.exit(2);
}
const ownerDir = resolve(args['owner-dir']);
let ownerToken;
try {
  ownerToken = readFileSync(join(ownerDir, 'A3_TASK_OWNED'), 'utf8').trim();
} catch {
  ownerToken = '';
}
if (!/^[A-Za-z0-9_-]{22,}$/.test(ownerToken)) {
  console.error(`REFUSED: ${join(ownerDir, 'A3_TASK_OWNED')} is missing or not an ownership token`);
  process.exit(3);
}
const OWNER_COMMENT = `a3-task-owned:${ownerToken}`;
const normPath = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const samePath = (a, b) => normPath(a) === normPath(b);
const conn = (database) => ({ host: '127.0.0.1', port, user: 'tr_test_admin', password, database });

const TRANSFORMS = [
  [/create extension if not exists postgis;/g, '-- [A3 shim] postgis replaced by supabase-shim.sql stand-ins'],
  [/geography\(Point,\s*4326\)/g, 'geography'],
  [/using gist \(geom\)/g, 'using btree (geom)'],
  // Windows Application Control blocks loading pg_trgm.dll and citext.dll on this machine.
  [/create extension if not exists pg_trgm;/g, '-- [A3 shim] pg_trgm unavailable (DLL blocked by Application Control); trigram indexes skipped'],
  [/create extension if not exists citext;/g, '-- [A3 shim] citext unavailable (DLL blocked); citext is a text domain in supabase-shim.sql'],
  [/create index [a-z_]+ +on public\.[a-z_]+ using gin \([^;]*gin_trgm_ops\);/g, '-- [A3 shim] trigram index skipped'],
];

/** Must equal DB_SUITES in app/server/testing/test-db.ts (checked by test-db.test.ts). */
const SUITES = ['store', 'readiness', 'e2e'];

async function main() {
  const admin = new pg.Client(conn('postgres'));
  await admin.connect();
  const dataDir = (await admin.query("select setting from pg_settings where name = 'data_directory'")).rows[0]?.setting ?? '';
  if (!samePath(dataDir, join(ownerDir, 'data'))) {
    await admin.end();
    console.error(`REFUSED: the server on port ${port} is not the task-owned cluster (its data directory differs from --owner-dir)`);
    process.exit(3);
  }
  const names = [dbName, ...(args.suites === 'true' ? SUITES.map((s) => `${dbName}_${s}`) : [])];
  for (const name of names) {
    const existing = await admin.query("select shobj_description(oid, 'pg_database') as comment from pg_database where datname = $1", [name]);
    if (existing.rowCount) {
      if (existing.rows[0].comment !== OWNER_COMMENT) {
        await admin.end();
        console.error(`REFUSED: database ${name} exists without this task's ownership comment; not dropping it`);
        process.exit(3);
      }
      await admin.query(`drop database ${name}`);
    }
    await admin.query(`create database ${name}`);
    await admin.query(`comment on database ${name} is '${OWNER_COMMENT}'`);
  }
  await admin.end();
  for (const name of names) await buildOne(name, name === dbName ? args.snapshot : undefined);
}

async function buildOne(dbName, snapshotPath) {
  const db = new pg.Client(conn(dbName));
  await db.connect();
  const run = async (label, sql) => {
    try {
      await db.query(sql);
    } catch (err) {
      console.error(`FAILED at ${label}: ${err.code ?? ''} ${err.message}`);
      throw err;
    }
  };
  await run('supabase-shim', readFileSync(join(root, 'supabase/tests/a3/harness/supabase-shim.sql'), 'utf8'));

  const substitutions = [];
  const migrations = readdirSync(join(root, 'supabase/migrations')).filter((f) => /^\d{14}_.+\.sql$/.test(f)).sort();
  for (const file of migrations) {
    let sql = readFileSync(join(root, 'supabase/migrations', file), 'utf8');
    for (const [re, rep] of TRANSFORMS) {
      const n = (sql.match(re) ?? []).length;
      if (n) substitutions.push(`${file}: ${n} x ${re.source}`);
      sql = sql.replace(re, rep);
    }
    await run(file, sql);
  }
  await run('profile-fixtures', readFileSync(join(root, 'supabase/staging/profile-fixtures.sql'), 'utf8'));
  await run('business-fixtures', readFileSync(join(root, 'supabase/tests/a3/harness/business-fixtures.sql'), 'utf8'));

  if (snapshotPath) {
    const snap = await snapshot(db);
    writeFileSync(snapshotPath, JSON.stringify(snap, null, 1));
  }
  if (args['no-m1'] !== 'true') {
    await run('M1', readFileSync(join(root, 'supabase/pending/M1_same_origin_signin.sql'), 'utf8'));
  }
  await db.end();
  console.log(JSON.stringify({ database: dbName, migrations: migrations.length, m1: args['no-m1'] !== 'true', substitutions }, null, 1));
}

/** Pre-cutover snapshot (supabase/backout/pre-cutover-snapshot.sql), as JSON. */
export async function snapshot(db) {
  const sql = readFileSync(join(root, 'supabase/backout/pre-cutover-snapshot.sql'), 'utf8')
    .split(/;\s*\n/).map((s) => s.replace(/--.*$/gm, '').trim()).filter(Boolean);
  const out = [];
  for (const q of sql) out.push((await db.query(q)).rows);
  return out;
}

main().catch(() => process.exit(1));
