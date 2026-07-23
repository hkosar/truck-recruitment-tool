/**
 * seed-auth-users.ts — nonproduction only. Creates run-scoped fictional users
 * through the supported Supabase Admin API, then provisions their role/status
 * fixtures in public.profiles.
 *
 * Required environment:
 *   TEST_ENVIRONMENT=staging
 *   TEST_RUN_ID=<unique lowercase run id>
 *   TEST_TARGET_PROJECT_REF=<allowlisted nonproduction ref>
 *   TEST_AUTH_DOMAIN=<owner-approved valid test domain; no messages are sent>
 *   SUPABASE_URL=https://<same ref>.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY=<secret, never log>
 *
 * Optional:
 *   TEST_USER_PASSWORD=<runtime-generated password; otherwise one is generated>
 *
 * Production is denied by the exact production ref and a required explicit
 * allowlist of permitted staging refs. This script has no "force" bypass.
 */
import { randomBytes } from "node:crypto";
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
    return "Refusing to seed the production Carrier Recruiter project";
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

const password = process.env.TEST_USER_PASSWORD ?? randomBytes(24).toString("base64url");
if (!validationError && password.length < 16) {
  throw new Error("TEST_USER_PASSWORD must be at least 16 characters");
}
const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

type Seed = {
  label: string;
  name: string;
  role: "manager" | "edit" | "view" | "guest";
  status: "approved" | "pending" | "disabled";
  color: string;
};
const USERS: Seed[] = [
  { label: "manager", name: "Fictional Manager", role: "manager", status: "approved", color: "#1e3a6e" },
  { label: "editor", name: "Fictional Editor", role: "edit", status: "approved", color: "#35547e" },
  { label: "viewer", name: "Fictional Viewer", role: "view", status: "approved", color: "#6b7482" },
  { label: "pending", name: "Fictional Pending User", role: "guest", status: "pending", color: "#8a5a2b" },
  { label: "guest", name: "Fictional Approved Guest", role: "guest", status: "approved", color: "#64748b" },
  { label: "disabled", name: "Fictional Disabled User", role: "view", status: "disabled", color: "#7f1d1d" },
];

async function main() {
  if (validationError || !url || !key || !runId) throw new Error(validationError ?? "Invalid test environment");
  const admin = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  for (const user of USERS) {
    const email = `${user.label}-${runId}@${fixtureDomain}`;
    const created = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        full_name: user.name,
        test_only: true,
        test_run_id: runId,
        expires_at: expiresAt,
      },
    });
    if (created.error) {
      if (/already/i.test(created.error.message)) {
        throw new Error(`Run ID ${runId} already has fixture users; clean that run or choose a new TEST_RUN_ID`);
      }
      throw created.error;
    }

    const updated = await admin
      .from("profiles")
      .update({
        full_name: user.name,
        role: user.role,
        status: user.status,
        avatar_color: user.color,
      })
      .eq("id", created.data.user.id)
      .eq("email", email)
      .select("id")
      .single();
    if (updated.error || !updated.data) {
      const cleanup = await admin.auth.admin.deleteUser(created.data.user.id);
      if (cleanup.error) {
        throw new Error(`Profile provisioning failed and user rollback also failed for ${email}`);
      }
      throw updated.error ?? new Error(`Profile provisioning affected no row for ${email}`);
    }
    console.log(`created ${user.label} fixture for run ${runId}`);
  }

  console.log(`created ${USERS.length} fictional users; expires ${expiresAt}`);
  console.log("password generated or supplied at runtime and intentionally not printed");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
