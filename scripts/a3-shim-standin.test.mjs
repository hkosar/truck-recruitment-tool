// Behaviour tests for scripts/a3-shim-standin.mjs. No database, no network.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { hasTestExt5, shimForServer, shimWithoutTestExt5 } from './a3-shim-standin.mjs';

const root = resolve(import.meta.dirname, '..');
const shim = readFileSync(resolve(root, 'supabase/tests/a3/harness/supabase-shim.sql'), 'utf8');
const server = (n) => { const seen = []; return { seen, query: async (sql) => { seen.push(sql); return { rows: [{ n }] }; } }; };

test('the real shim: test_ext5 becomes an emptied tsm_system_rows; every stand-in is attached to it; nothing else changes', () => {
  const out = shimWithoutTestExt5(shim);
  const adds = (s, ext) => s.split('\n').filter((l) => l.startsWith(`alter extension ${ext} add `)).map((l) => l.slice(`alter extension ${ext} add `.length));
  assert.ok(adds(shim, 'test_ext5').length >= 10);
  assert.deepEqual(adds(out, 'tsm_system_rows'), adds(shim, 'test_ext5'));
  assert.ok(out.includes('create extension tsm_system_rows schema public;\nalter extension tsm_system_rows drop function public.system_rows(internal);\ndrop function public.system_rows(internal);\n'));
  assert.equal(out.split('\n').filter((l) => !l.startsWith('--') && /test_ext5/.test(l)).length, 0);
  // Every line that is not one of the replaced ones is byte-identical.
  const keep = (s) => s.split('\n').filter((l) => !/^(create|alter) extension (test_ext5|tsm_system_rows) |^drop function public\.system_rows\(internal\);$/.test(l));
  assert.deepEqual(keep(out), keep(shim));
});

test('a moved schema (a3-build-test-db --postgis-schema) is carried over', () => {
  const moved = shim.replace('create extension test_ext5 schema public;', 'create extension test_ext5 schema extensions;');
  assert.ok(shimWithoutTestExt5(moved).includes('create extension tsm_system_rows schema extensions;\nalter extension tsm_system_rows drop function extensions.system_rows(internal);\ndrop function extensions.system_rows(internal);'));
});

test('refuses a shim with no or two create lines, or test_ext5 named elsewhere', () => {
  assert.throws(() => shimWithoutTestExt5(shim.replace('create extension test_ext5 schema public;', '')), /exactly one/);
  assert.throws(() => shimWithoutTestExt5(`${shim}\ncreate extension test_ext5 schema public;\n`), /exactly one/);
  assert.throws(() => shimWithoutTestExt5(`${shim}\nselect 'test_ext5';\n`), /outside the lines/);
});

test('shimForServer: unchanged when the server has test_ext5, replaced when it does not; asks pg_available_extensions', async () => {
  const has = server(1);
  assert.equal(await shimForServer(shim, has.query), shim);
  assert.match(has.seen[0], /pg_available_extensions where name = 'test_ext5'/);
  assert.equal(await shimForServer(shim, server(0).query), shimWithoutTestExt5(shim));
  assert.equal(await hasTestExt5(server(0).query), false);
});
