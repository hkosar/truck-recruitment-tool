// Decision logic of scripts/cleanup-auth-users.ts, free of Supabase so it can be tested
// (scripts/cleanup-auth-core.test.mjs, `node --test scripts/`).
//
// After M1b (D8, approved 2026-10-22) public.profiles no longer cascades from auth.users, so
// deleting a run's Auth users would leave their profiles behind, and a re-run would find no
// tagged users and report success while orphans remain. Therefore:
//   1. Refuse first if any fixture-domain profile has no Auth user: its run can no longer be
//      proven, so this script never deletes it; the ownership-checked SQL cleanup does
//      (supabase/staging/m1/cleanup-auth-ledgers-m1.sql, then supabase/staging/cleanup-fixtures.sql).
//   2. Check every known reference to the run's identities (all-or-nothing).
//   3. Delete the run's profiles explicitly, by id, BEFORE their Auth users, so no orphan can arise
//      with or without the cascade. Any remaining reference the API cannot see (sign-in ledgers,
//      internal.staff_mobile_unverified) refuses that delete by foreign key, before any Auth user
//      is touched.
//   4. Delete the Auth users and verify that nothing of the run remains.

/** Public columns that can reference a profile, checked before anything is deleted. */
export const PROFILE_REFERENCES = [
  ['profiles', 'approved_by'],
  ['carriers', 'dnc_set_by'],
  ['batches', 'created_by'],
  ['batch_carriers', 'status_changed_by'],
  ['batch_carriers', 'promoted_by'],
  ['contact_logs', 'user_id'],
  ['contact_suppressions', 'created_by'],
  ['batch_activity', 'actor_id'],
];

export const ORPHAN_REFUSAL =
  'fixture-domain profile(s) have no Auth user (after M1b the profiles -> auth.users cascade is gone). ' +
  'This script cannot prove which run they belong to and never deletes them; use the ownership-checked SQL cleanup ' +
  '(supabase/staging/m1/cleanup-auth-ledgers-m1.sql, then supabase/staging/cleanup-fixtures.sql).';

/**
 * @param {{
 *   listRunUsers(): Promise<Array<{ id: string, email?: string }>>,
 *   orphanFixtureProfiles(): Promise<string[]>,
 *   countReferences(table: string, column: string, ids: string[]): Promise<number>,
 *   deleteProfiles(ids: string[]): Promise<void>,
 *   deleteUser(id: string): Promise<void>,
 * }} api
 * @param {{ runId: string, log: (line: string) => void }} options
 */
export async function cleanupRun(api, { runId, log }) {
  const orphans = await api.orphanFixtureProfiles();
  if (orphans.length > 0) throw new Error(`REFUSED: ${orphans.length} ${ORPHAN_REFUSAL}`);

  const users = await api.listRunUsers();
  const ids = users.map((u) => u.id);
  if (ids.length === 0) {
    log(`PASS no test users and no orphaned fixture profiles remain for run ${runId}`);
    return;
  }

  for (const [table, column] of PROFILE_REFERENCES) {
    const n = await api.countReferences(table, column, ids);
    if (n !== 0) throw new Error(`REFUSED: ${table}.${column} retains ${n} row(s) for run ${runId}; nothing was deleted`);
  }

  try {
    await api.deleteProfiles(ids);
  } catch (err) {
    throw new Error(
      `REFUSED: the run's profiles could not be removed (${err instanceof Error ? err.message : String(err)}); ` +
        'a reference this script cannot see remains (sign-in ledgers or internal.staff_mobile_unverified). ' +
        'No Auth user was deleted; use the SQL cleanup.',
    );
  }
  for (const user of users) {
    await api.deleteUser(user.id);
    log(`deleted ${user.email ?? user.id}`);
  }

  if ((await api.countReferences('profiles', 'id', ids)) !== 0) throw new Error(`profiles remain for run ${runId}`);
  if ((await api.listRunUsers()).length !== 0) throw new Error(`Auth users remain for run ${runId}`);
  if ((await api.orphanFixtureProfiles()).length !== 0) throw new Error(`REFUSED after cleanup: orphaned fixture profiles exist`);
  log(`PASS no Auth users, profiles, or checked workflow rows remain for run ${runId}`);
}
