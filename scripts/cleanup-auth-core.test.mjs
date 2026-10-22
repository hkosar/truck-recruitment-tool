// Tests for scripts/cleanup-auth-core.mjs. Run: node --test scripts/cleanup-auth-core.test.mjs
// An in-memory model of the Auth users, profiles and references, with or without the
// profiles -> auth.users cascade (before / after M1b).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanupRun, ORPHAN_REFUSAL } from './cleanup-auth-core.mjs';

function world({ cascade, users, profiles, references = {}, hiddenReferences = [] }) {
  const auth = new Map(users.map((u) => [u.id, u]));
  const prof = new Map(profiles.map((p) => [p.id, p]));
  const deleted = { users: [], profiles: [] };
  const api = {
    async listRunUsers() {
      return [...auth.values()].filter((u) => u.runId === 'run-1');
    },
    async orphanFixtureProfiles() {
      return [...prof.values()].filter((p) => p.email.endsWith('@fixture.invalid') && !auth.has(p.id)).map((p) => p.id);
    },
    async countReferences(table, column, ids) {
      if (table === 'profiles' && column === 'id') return ids.filter((id) => prof.has(id)).length;
      return (references[`${table}.${column}`] ?? []).filter((id) => ids.includes(id)).length;
    },
    async deleteProfiles(ids) {
      const blocked = ids.filter((id) => hiddenReferences.includes(id));
      if (blocked.length) throw new Error('update or delete on table "profiles" violates foreign key constraint');
      for (const id of ids) {
        prof.delete(id);
        deleted.profiles.push(id);
      }
    },
    async deleteUser(id) {
      auth.delete(id);
      deleted.users.push(id);
      if (cascade) prof.delete(id);
    },
  };
  return { api, auth, prof, deleted };
}
const runUser = (id) => ({ id, email: `${id}@fixture.invalid`, runId: 'run-1' });
const profile = (id) => ({ id, email: `${id}@fixture.invalid` });

test('after M1b (no cascade): the run is removed completely; no orphan profile remains', async () => {
  const w = world({ cascade: false, users: [runUser('a'), runUser('b')], profiles: [profile('a'), profile('b'), { id: 'real', email: 'real@company.example' }] });
  const lines = [];
  await cleanupRun(w.api, { runId: 'run-1', log: (l) => lines.push(l) });
  assert.deepEqual([...w.prof.keys()], ['real']);
  assert.equal(w.auth.size, 0);
  assert.match(lines.at(-1), /^PASS/);
});

test('before M1b (cascade): unchanged outcome', async () => {
  const w = world({ cascade: true, users: [runUser('a')], profiles: [profile('a')] });
  await cleanupRun(w.api, { runId: 'run-1', log: () => {} });
  assert.equal(w.prof.size, 0);
  assert.equal(w.auth.size, 0);
});

test('a re-run with orphans left by the old behaviour refuses instead of reporting success, deleting nothing', async () => {
  const w = world({ cascade: false, users: [], profiles: [profile('orphan')] });
  await assert.rejects(cleanupRun(w.api, { runId: 'run-1', log: () => {} }), (err) => err.message.includes(ORPHAN_REFUSAL));
  assert.deepEqual([...w.prof.keys()], ['orphan']);
});

test('a visible reference refuses before anything is deleted', async () => {
  const w = world({ cascade: false, users: [runUser('a')], profiles: [profile('a')], references: { 'batches.created_by': ['a'] } });
  await assert.rejects(cleanupRun(w.api, { runId: 'run-1', log: () => {} }), /batches\.created_by retains 1 row/);
  assert.deepEqual(w.deleted, { users: [], profiles: [] });
});

test('a reference the API cannot see (internal.staff_mobile_unverified, sign-in ledgers) refuses before any Auth user is deleted', async () => {
  const w = world({ cascade: false, users: [runUser('a'), runUser('b')], profiles: [profile('a'), profile('b')], hiddenReferences: ['b'] });
  await assert.rejects(cleanupRun(w.api, { runId: 'run-1', log: () => {} }), /No Auth user was deleted/);
  assert.deepEqual(w.deleted.users, []);
  assert.equal(w.auth.size, 2);
});
