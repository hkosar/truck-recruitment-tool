/**
 * cleanup-auth-users.ts — removes one nonproduction test run's Auth users and their profiles,
 * and verifies that nothing of the run remains. After M1b (D8) profiles no longer cascade from
 * auth.users, so the profiles are removed explicitly first, and orphaned fixture profiles make
 * the script refuse (see cleanup-auth-core.mjs).
 *
 * Uses the same fail-closed environment contract as seed-auth-users.ts. The
 * script will not target the production Carrier Recruiter ref and has no force
 * bypass. Run only after the relevant application tests finish.
 */
import { createClient } from "@supabase/supabase-js";
// Plain ESM (no type declarations) so its tests run with `node --test` and no dependencies.
import { cleanupRun } from "./cleanup-auth-core.mjs";

const PRODUCTION_PROJECT_REF = "ejrfobddnojbijzrjbii";
const environment = process.env.TEST_ENVIRONMENT;
const runId = process.env.TEST_RUN_ID;
const targetRef = process.env.TEST_TARGET_PROJECT_REF;
const allowedRefs = new Set(
  (process.env.TEST_ALLOWED_PROJECT_REFS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
);
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const fixtureDomain = process.env.TEST_AUTH_DOMAIN;

const validationError = (() => {
  if (!url || !key || !runId || !targetRef || !fixtureDomain || environment !== "staging") {
    return (
      "Set TEST_ENVIRONMENT=staging, TEST_RUN_ID, TEST_TARGET_PROJECT_REF, " +
      "TEST_ALLOWED_PROJECT_REFS, TEST_AUTH_DOMAIN, SUPABASE_URL, and SUPABASE_SERVICE_ROLE_KEY"
    );
  }
  if (!/^[a-z0-9-]{6,48}$/.test(runId)) {
    return "TEST_RUN_ID must be 6-48 lowercase letters, numbers, or hyphens";
  }
  if (targetRef === PRODUCTION_PROJECT_REF || url.includes(PRODUCTION_PROJECT_REF)) {
    return "Refusing to clean the production Carrier Recruiter project";
  }
  if (!allowedRefs.has(targetRef)) {
    return "TEST_TARGET_PROJECT_REF is not in TEST_ALLOWED_PROJECT_REFS";
  }
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "https:" || parsedUrl.hostname !== `${targetRef}.supabase.co`) {
    return "SUPABASE_URL must exactly match TEST_TARGET_PROJECT_REF";
  }
  return null;
})();

let admin: ReturnType<typeof createClient>;

async function listAllUsers() {
  const users = [];
  for (let page = 1; ; page += 1) {
    const response = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (response.error) throw response.error;
    users.push(...response.data.users);
    if (response.data.users.length < 200) break;
  }
  return users;
}

async function listRunUsers() {
  return (await listAllUsers()).filter(
    (user) =>
      user.user_metadata?.test_only === true &&
      user.user_metadata?.test_run_id === runId &&
      user.email?.endsWith(`@${fixtureDomain}`)
  );
}

/** Fixture-domain profiles with no Auth user: orphans the removed cascade (M1b) can leave. */
async function orphanFixtureProfiles() {
  const authIds = new Set((await listAllUsers()).map((user) => user.id));
  const result = await admin.from("profiles").select("id").ilike("email", `%@${fixtureDomain}`);
  if (result.error) throw result.error;
  return (result.data as Array<{ id: string }>).map((row) => row.id).filter((id) => !authIds.has(id));
}

async function countReferences(table: string, column: string, values: string[]) {
  if (values.length === 0) return 0;
  const result = await admin.from(table).select("*", { count: "exact", head: true }).in(column, values);
  if (result.error) throw result.error;
  return result.count ?? 0;
}

async function main() {
  if (validationError || !url || !key || !runId) throw new Error(validationError ?? "Invalid test environment");
  admin = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  // The decision logic (orphan refusal, all-or-nothing reference checks, explicit profile removal
  // before Auth users) lives in cleanup-auth-core.mjs and is tested by cleanup-auth-core.test.mjs.
  await cleanupRun(
    {
      listRunUsers: async () => (await listRunUsers()).map((user) => ({ id: user.id, email: user.email })),
      orphanFixtureProfiles,
      countReferences,
      deleteProfiles: async (ids) => {
        const result = await admin.from("profiles").delete().in("id", ids);
        if (result.error) throw result.error;
      },
      deleteUser: async (id) => {
        const deleted = await admin.auth.admin.deleteUser(id);
        if (deleted.error) throw deleted.error;
      },
    },
    { runId, log: (line) => console.log(line) }
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
