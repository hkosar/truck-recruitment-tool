#!/usr/bin/env node
// LOCAL ONLY (TRUCKRECRU-144): starts a throwaway PostgreSQL 17 cluster on 127.0.0.1 from the portable install, runs read-only probe
// queries against it, stops it with pg_ctl -D <its own folder> and deletes the folder. It reports what hosted staging-2 (PostgreSQL 17)
// behaviour depends on: server_version_num, every pg_auth_members row (admin/inherit/set options, grantor), whether the MAINTAIN
// privilege exists and on which relations it is explicitly granted (to anyone other than the owner: listed; the owner's own entries:
// counted), transaction_timeout and createrole_self_grant (quoted, so the empty default shows as '').
// It contacts no hosted or staging database, reads no secret store, installs nothing and needs no node_modules (it uses psql).
//
// How to run (from the repository root):
//   node --import ./scripts/net-guard.mjs scripts/pg17-probe.mjs                 (Windows: --import=file:///C:/.../scripts/net-guard.mjs)
//   PG_BIN="<PostgreSQL 17 folder>\bin" node scripts/pg17-probe.mjs              (default bin: C:\Users\hunte\.bb\tools\pg17\bin)
// Only a pg_ctl reporting major 17 is accepted (the version gate of run-real-db-suites.mjs). The cluster folder is
// <repository root>/.pg17-probe-<random>; nothing outside it is written. Every query runs with default_transaction_read_only=on.
// Exit code 0 only if every step succeeded and cleanup is complete; any error is printed and the exit code is 1 (2 = refused before start).
// Undo: delete this script and pg17-probe.test.mjs.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeSh, maskSecrets, nonLoopbackConnectionVars, scrubbedEnv, supportedPgMajor } from './run-real-db-suites.mjs';

const root = resolve(import.meta.dirname, '..');
export const DEFAULT_PG17_BIN = 'C:\\Users\\hunte\\.bb\\tools\\pg17\\bin';
export const DIR_PREFIX = '.pg17-probe-';
const ADMIN_USER = 'tr_probe_admin';

/** The probes, in output order. Each is one read-only statement; psql prints its rows unaligned with a header line. */
export const PROBES = [
  { id: 'server_version_num', sql: 'show server_version_num' },
  {
    id: 'role_membership (pg_auth_members)',
    sql: `select r.rolname as role, m.rolname as member, g.rolname as grantor, am.admin_option, am.inherit_option, am.set_option
from pg_catalog.pg_auth_members am
join pg_catalog.pg_roles r on r.oid = am.roleid
join pg_catalog.pg_roles m on m.oid = am.member
left join pg_catalog.pg_roles g on g.oid = am.grantor
order by 1, 2, 3`,
  },
  {
    id: 'maintain_privilege_exists',
    sql: `select exists (select 1 from pg_catalog.pg_roles where rolname = 'pg_maintain') as pg_maintain_role_exists,
  pg_catalog.has_table_privilege(current_user, 'pg_catalog.pg_class', 'MAINTAIN') as maintain_privilege_accepted`,
  },
  {
    id: 'maintain_grants (explicit relacl entries to a grantee other than the relation owner)',
    sql: `select n.nspname as schema, c.relname as relation, c.relkind, coalesce(gr.rolname, 'PUBLIC') as grantee, gt.rolname as grantor, a.is_grantable
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
cross join lateral pg_catalog.aclexplode(c.relacl) a
left join pg_catalog.pg_roles gr on gr.oid = a.grantee
left join pg_catalog.pg_roles gt on gt.oid = a.grantor
where a.privilege_type = 'MAINTAIN' and a.grantee <> c.relowner
order by 1, 2, 4`,
  },
  {
    id: 'maintain_owner_entries (explicit relacl entries where the owner holds its own MAINTAIN)',
    sql: `select count(*) as relations, count(distinct c.relnamespace) as schemas
from pg_catalog.pg_class c
cross join lateral pg_catalog.aclexplode(c.relacl) a
where a.privilege_type = 'MAINTAIN' and a.grantee = c.relowner`,
  },
  {
    id: 'maintain_default_acl_relations (relacl null: owner holds MAINTAIN by default)',
    sql: `select count(*) as relations_with_default_acl from pg_catalog.pg_class where relacl is null and relkind in ('r', 'p', 'm', 'v', 'f', 'S')`,
  },
  { id: 'transaction_timeout', sql: 'show transaction_timeout' },
  { id: 'createrole_self_grant', sql: `select pg_catalog.quote_literal(pg_catalog.current_setting('createrole_self_grant')) as createrole_self_grant_quoted` },
];

/** True only if dir is a direct child of base whose name starts with DIR_PREFIX. A drive root, base itself, a parent, a sibling or a
 *  relative-escape path is refused. Pure. */
export function isOwnProbeDir(dir, base) {
  if (!dir || !base) return false;
  const rel = relative(resolve(base), resolve(dir));
  if (rel === '' || isAbsolute(rel) || rel.split(/[\\/]/).length !== 1 || rel === '..') return false;
  return rel.startsWith(DIR_PREFIX) && basename(resolve(dir)) === rel;
}

/** The psql arguments of one probe: loopback host, no psqlrc, stop on the first error, unaligned output with headers. Pure. */
export function psqlArgs({ port, sql }) {
  return ['-X', '-q', '-w', '-h', '127.0.0.1', '-p', String(Number(port)), '-U', ADMIN_USER, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1',
    '-A', '-F', ' | ', '-P', 'footer=off', '-P', 'null=NULL', '-c', sql];
}

/** The child environment of psql: the scrubbed allow-list plus the throwaway password and a read-only default. Pure. */
export function psqlEnv(baseEnv, password) {
  return { ...baseEnv, PGPASSWORD: password, PGOPTIONS: '-c default_transaction_read_only=on', PGCONNECT_TIMEOUT: '15' };
}

const exe = (bin, name) => (existsSync(join(bin, name + '.exe')) ? join(bin, name + '.exe') : join(bin, name));

function freePort() {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
}

async function run() {
  const pgBin = process.env.PG_BIN || DEFAULT_PG17_BIN;
  const baseEnv = scrubbedEnv(process.env);
  const sh = makeSh(baseEnv);
  const password = randomBytes(24).toString('base64url').replace(/[^A-Za-z0-9]/g, 'x');
  const mask = (text) => maskSecrets(String(text ?? ''), [password]);
  let dir;
  let dataDir;
  let started = false;
  let failed = false;
  const fail = (msg) => { failed = true; console.error(`ERROR: ${mask(msg)}`); };

  const bad = nonLoopbackConnectionVars(process.env);
  if (bad.length) {
    console.error(`REFUSED: these environment variables point somewhere other than loopback (values not shown): ${bad.join(', ')}. Unset them and run again.`);
    return 2;
  }
  if (!existsSync(exe(pgBin, 'initdb')) || !existsSync(exe(pgBin, 'pg_ctl')) || !existsSync(exe(pgBin, 'psql'))) {
    console.error(`REFUSED: initdb, pg_ctl or psql not found in ${pgBin}. Set PG_BIN to a PostgreSQL 17 bin folder.`);
    return 2;
  }
  const ver = sh(exe(pgBin, 'pg_ctl'), ['--version']);
  if (supportedPgMajor(ver) !== 17) {
    console.error(`REFUSED: ${pgBin} is not PostgreSQL 17 (pg_ctl --version: ${String(ver.stdout ?? '').trim().slice(0, 80) || 'no output'}).`);
    return 2;
  }
  console.log(`PostgreSQL major 17 (bin folder ${pgBin})`);

  try {
    dir = mkdtempSync(join(root, DIR_PREFIX));
    dataDir = join(dir, 'data');
    const pwFile = join(dir, 'pw.txt');
    writeFileSync(pwFile, password);
    const init = sh(exe(pgBin, 'initdb'), ['-D', dataDir, '-U', ADMIN_USER, '-A', 'scram-sha-256', `--pwfile=${pwFile}`, '-E', 'UTF8']);
    rmSync(pwFile, { force: true });
    if (init.error || init.status !== 0) throw new Error('initdb failed: ' + `${init.error ?? ''}${init.stdout ?? ''}${init.stderr ?? ''}`.split('\n').slice(-6).join(' | '));
    let port = await freePort();
    while (port === 5432 || port === 6543) port = await freePort();
    const logFile = join(dir, 'server.log');
    started = true; // from here on, cleanup tries pg_ctl stop on our own folder
    const start = sh(exe(pgBin, 'pg_ctl'), ['-D', dataDir, '-l', logFile, '-o', `-p ${port} -c listen_addresses=127.0.0.1`, '-w', 'start'], { stdio: 'ignore' }); // not pipes: the server would inherit them
    if (start.error || start.status !== 0) {
      let tail = '';
      try { tail = readFileSync(logFile, 'utf8').split('\n').filter(Boolean).slice(-4).join(' | '); } catch { /* no log */ }
      throw new Error(`pg_ctl start failed (status ${start.status}): ${tail}`);
    }
    let pid = '?';
    try { pid = readFileSync(join(dataDir, 'postmaster.pid'), 'utf8').split('\n')[0]; } catch { /* reported as ? */ }
    console.log(`cluster: 127.0.0.1:${port}, postmaster pid ${pid}, folder ${dataDir}`);

    for (const p of PROBES) {
      const r = sh(exe(pgBin, 'psql'), psqlArgs({ port, sql: p.sql }), { env: psqlEnv(baseEnv, password), timeout: 60000 });
      console.log(`\n== ${p.id}`);
      if (r.error || r.status !== 0 || r.signal) {
        fail(`probe ${p.id} failed (status ${r.status}${r.signal ? `, signal ${r.signal}` : ''}): ${`${r.error ?? ''}${r.stderr ?? ''}${r.stdout ?? ''}`.trim()}`);
        continue;
      }
      process.stdout.write(mask(r.stdout));
      if (r.stderr && r.stderr.trim()) fail(`probe ${p.id} wrote to stderr: ${r.stderr.trim()}`);
    }
  } catch (e) {
    fail(e?.message ?? String(e));
  } finally {
    const problems = [];
    if (started && existsSync(join(dataDir, 'postmaster.pid'))) {
      const stop = sh(exe(pgBin, 'pg_ctl'), ['-D', dataDir, 'stop', '-m', 'fast', '-w'], { stdio: 'ignore' });
      if (stop.error || stop.status !== 0) problems.push(`pg_ctl stop did not report success (status ${stop.status})`);
    }
    if (dir) {
      if (!isOwnProbeDir(dir, root)) problems.push('refused to delete a folder this run did not create');
      else if (!problems.length) {
        try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { problems.push('could not delete the cluster folder'); }
        if (existsSync(dir)) problems.push(`cluster folder still exists: ${dir}`);
      } else problems.push(`cluster folder kept because the server may still be running: ${dir}`);
    }
    console.log(problems.length ? `\nCLEANUP INCOMPLETE: ${problems.join('; ')}` : '\nCLEANUP OK: cluster stopped with pg_ctl -D <own folder>, folder deleted');
    if (problems.length) failed = true;
  }
  console.log(failed ? 'RESULT: FAILED' : 'RESULT: OK');
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run().then((code) => { process.exitCode = code; }, (e) => { console.error(`ERROR: ${e?.message ?? e}`); process.exitCode = 1; });
}
