/**
 * seed-auth-users.ts — dev-only. Creates the five demo users in Supabase Auth
 * and provisions their roles/statuses in public.profiles.
 *
 * Auth rows can't be reliably seeded in plain SQL across GoTrue versions, so
 * this runs via the admin API (01-architecture.md Part A §8). The on-signup
 * trigger auto-creates each profile as pending guest; we then promote.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx tsx scripts/seed-auth-users.ts
 *
 * NEVER run against production with these credentials/passwords.
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

type Seed = { email: string; name: string; role: "manager" | "edit" | "view" | "guest"; status: "approved" | "pending"; color: string };
const USERS: Seed[] = [
  { email: "hunter@twistednail.dev",  name: "Hunter Kosar",  role: "manager", status: "approved", color: "#111418" },
  { email: "marisol@twistednail.dev", name: "Marisol Vega",  role: "edit",    status: "approved", color: "#e8611d" },
  { email: "dwight@twistednail.dev",  name: "Dwight Fowler", role: "edit",    status: "approved", color: "#3a4757" },
  { email: "priya@twistednail.dev",   name: "Priya Nair",    role: "view",    status: "approved", color: "#6b7482" },
  { email: "cole@twistednail.dev",    name: "Cole Ramirez",  role: "guest",   status: "pending",  color: "#8a5a2b" },
];
const PASSWORD = "twistednail-dev";

async function main() {
  for (const u of USERS) {
    // Create (or find) the auth user.
    let id: string | undefined;
    const created = await admin.auth.admin.createUser({
      email: u.email,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: u.name },
    });
    if (created.error) {
      if (!/already/i.test(created.error.message)) throw created.error;
      const list = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
      if (list.error) throw list.error;
      id = list.data.users.find((x) => x.email === u.email)?.id;
      if (!id) throw new Error(`existing user ${u.email} not found via listUsers`);
      console.log(`= exists  ${u.email}`);
    } else {
      id = created.data.user.id;
      console.log(`+ created ${u.email}`);
    }
    // Promote the trigger-created pending-guest profile.
    const upd = await admin
      .from("profiles")
      .update({ full_name: u.name, role: u.role, status: u.status, avatar_color: u.color })
      .eq("id", id);
    if (upd.error) throw upd.error;
    console.log(`  → role=${u.role} status=${u.status}`);
  }
  console.log(`\nDone. Password for all dev users: ${PASSWORD}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
