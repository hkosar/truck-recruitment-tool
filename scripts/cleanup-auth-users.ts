/**
 * cleanup-auth-users.ts — removes one nonproduction test run's Auth users and
 * verifies that trigger-cascaded profiles and user-owned workflow rows are gone.
 *
 * Uses the same fail-closed environment contract as seed-auth-users.ts. The
 * script will not target the production Carrier Recruiter ref and has no force
 * bypass. Run only after the relevant application tests finish.
 */
import { createClient } from "@supabase/supabase-js";

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

const validationError = (() => {
  if (!url || !key || !runId || !targetRef || environment !== "staging") {
    return (
      "Set TEST_ENVIRONMENT=staging, TEST_RUN_ID, TEST_TARGET_PROJECT_REF, " +
      "TEST_ALLOWED_PROJECT_REFS, SUPABASE_URL, and SUPABASE_SERVICE_ROLE_KEY"
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

async function listRunUsers() {
  const users = [];
  for (let page = 1; ; page += 1) {
    const response = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (response.error) throw response.error;
    users.push(
      ...response.data.users.filter(
        (user) =>
          user.user_metadata?.test_only === true &&
          user.user_metadata?.test_run_id === runId &&
          user.email?.endsWith("@example.invalid")
      )
    );
    if (response.data.users.length < 200) break;
  }
  return users;
}

async function assertZero(table: string, column: string, values: string[]) {
  if (values.length === 0) return;
  const result = await admin.from(table).select("*", { count: "exact", head: true }).in(column, values);
  if (result.error) throw result.error;
  if (result.count !== 0) throw new Error(`${table} retains ${result.count} rows for run ${runId}`);
}

async function main() {
  if (validationError || !url || !key || !runId) throw new Error(validationError ?? "Invalid test environment");
  admin = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const users = await listRunUsers();
  const ids = users.map((user) => user.id);
  if (users.length === 0) {
    console.log(`PASS no test users remain for run ${runId}`);
    return;
  }

  // Verify every public FK that can reference a profile before deleting any
  // Auth user. This makes cleanup all-or-nothing: if one test left business-data
  // residue, no identities are removed and the run stays inspectable.
  await assertZero("profiles", "approved_by", ids);
  await assertZero("carriers", "dnc_set_by", ids);
  await assertZero("batches", "created_by", ids);
  await assertZero("batch_carriers", "status_changed_by", ids);
  await assertZero("batch_carriers", "promoted_by", ids);
  await assertZero("contact_logs", "user_id", ids);
  await assertZero("contact_suppressions", "created_by", ids);
  await assertZero("batch_activity", "actor_id", ids);

  for (const user of users) {
    const deleted = await admin.auth.admin.deleteUser(user.id);
    if (deleted.error) throw deleted.error;
    console.log(`deleted ${user.email}`);
  }

  await assertZero("profiles", "id", ids);
  const remainingUsers = await listRunUsers();
  if (remainingUsers.length !== 0) {
    throw new Error(`${remainingUsers.length} Auth users remain for run ${runId}`);
  }
  console.log(`PASS no Auth users, profiles, or checked workflow rows remain for run ${runId}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
