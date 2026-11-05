// Behaviour tests for the pure helpers of scripts/pg17-probe.mjs. No database, no network, no child process.
import assert from 'node:assert/strict';
import { join, parse, resolve } from 'node:path';
import { test } from 'node:test';
import { DIR_PREFIX, PROBES, isOwnProbeDir, psqlArgs, psqlEnv } from './pg17-probe.mjs';

const base = resolve(import.meta.dirname, '..');

test('cleanup only deletes a direct child of the repository root named .pg17-probe-*', () => {
  assert.equal(isOwnProbeDir(join(base, `${DIR_PREFIX}abc123`), base), true);
  assert.equal(isOwnProbeDir(base, base), false);
  assert.equal(isOwnProbeDir(join(base, '..'), base), false);
  assert.equal(isOwnProbeDir(join(base, '..', `${DIR_PREFIX}x`), base), false);
  assert.equal(isOwnProbeDir(join(base, 'scripts'), base), false);
  assert.equal(isOwnProbeDir(join(base, `${DIR_PREFIX}x`, 'data'), base), false);
  assert.equal(isOwnProbeDir(parse(base).root, base), false);
  assert.equal(isOwnProbeDir('', base), false);
  assert.equal(isOwnProbeDir(join(base, `${DIR_PREFIX}x`), ''), false);
});

test('psql: loopback only, no psqlrc, stops on error, port is a number', () => {
  const args = psqlArgs({ port: '5433', sql: 'select 1' });
  assert.deepEqual(args.slice(args.indexOf('-h'), args.indexOf('-h') + 4), ['-h', '127.0.0.1', '-p', '5433']);
  assert.ok(args.includes('-X'));
  assert.ok(args.includes('ON_ERROR_STOP=1'));
  assert.equal(args.at(-1), 'select 1');
  assert.equal(psqlArgs({ port: 'x', sql: '' })[args.indexOf('-p') + 1], 'NaN');
});

test('psql environment: read-only default, password only from the run, base environment kept, input unchanged', () => {
  const baseEnv = { PATH: 'p' };
  const env = psqlEnv(baseEnv, 'pw');
  assert.equal(env.PGOPTIONS, '-c default_transaction_read_only=on');
  assert.equal(env.PGPASSWORD, 'pw');
  assert.equal(env.PATH, 'p');
  assert.deepEqual(baseEnv, { PATH: 'p' });
});

test('probes: the five reported topics, each one read-only statement', () => {
  const ids = PROBES.map((p) => p.id).join('\n');
  for (const want of ['server_version_num', 'pg_auth_members', 'maintain_privilege_exists', 'maintain_grants', 'transaction_timeout', 'createrole_self_grant']) assert.match(ids, new RegExp(want));
  for (const p of PROBES) {
    assert.match(p.sql.trim(), /^(select|show) /i);
    assert.doesNotMatch(p.sql, /;|\b(insert|update|delete|create|alter|drop|grant|revoke|truncate|set_config)\b/i);
  }
  const members = PROBES.find((p) => p.id.includes('pg_auth_members')).sql;
  for (const col of ['admin_option', 'inherit_option', 'set_option', 'grantor']) assert.match(members, new RegExp(col));
});
