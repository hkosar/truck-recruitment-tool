#!/usr/bin/env node
// A3 ONLY: builds a disposable test database inside the task-owned throwaway cluster.
// Usage (password from the environment, never printed):
//   A3_PGPASSWORD=... node scripts/a3-build-test-db.mjs --port 55473 --db tr_signin_test [--no-m1] [--snapshot out.json]
// Steps: (re)create the database; Supabase shim; the 20 migrations with recorded PostGIS
// substitutions; staging profile fixtures; A3 business fixtures; optionally a snapshot; M1.
// Refuses any host other than 127.0.0.1 and any database name not starting with "tr_".

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
if (!password || !Number.isInteger(port) || !/^tr_[a-z0-9_]+$/.test(dbName)) {
  console.error('usage: A3_PGPASSWORD=... node scripts/a3-build-test-db.mjs --port <n> --db tr_<name>');
  process.exit(2);
}
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

async function main() {
  const admin = new pg.Client(conn('postgres'));
  await admin.connect();
  await admin.query(`drop database if exists ${dbName} with (force)`);
  await admin.query(`create database ${dbName}`);
  await admin.end();

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

  if (args.snapshot) {
    const snap = await snapshot(db);
    writeFileSync(args.snapshot, JSON.stringify(snap, null, 1));
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
