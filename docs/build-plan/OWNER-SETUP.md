# Owner setup guide — provisioning the accounts the build needs

**Audience: Hunter.** This turns the master plan's prerequisite table (`00-master-plan.md` §3)
into do-this-now steps. Each item says exactly **where to click, what to set, and where the
resulting secret goes.** You do not need to understand the code — just create the account, copy
the value, and paste it where the "→ goes in" line says.

**The golden rule:** never paste a secret into a chat, a commit, or a public place. The
`SUPABASE_SERVICE_ROLE_KEY` in particular is a master key that bypasses all security — treat it
like the keys to the building. When you have a value, put it straight into the destination named
below (a Render/Supabase settings field or a local `.env.local` file that is git-ignored).

Legend for "→ goes in":
- **app** = `app/.env.local` locally, and the Static Site's *Environment* tab on Render in prod.
- **pipeline** = the Cron Job's *Environment* tab on Render (locally: `pipeline/.env.local`).
- **Supabase secret** = Supabase dashboard → Edge Functions → Secrets.

---

## Tier 1 — do these before the build session (they unblock the whole build)

### 1. Supabase — the database + login + realtime  · blocks everything (M1.2)

1. Create a free account at **https://supabase.com** (sign in with GitHub is easiest).
2. Create **two projects** in the same org:
   - **`twisted-nail-recruiter-prod`** — the real one. Region: **US East** (closest to TX + our
     data sources). Save the database password in your password manager.
   - **`twisted-nail-recruiter-dev`** — a throwaway for development. Same region.
3. Upgrade **only the prod project** to **Pro ($25/mo)** — Settings → Billing → upgrade. This buys
   daily backups and stops the project from auto-pausing (a shared call-tool can't lose data or
   go to sleep). **Leave dev on the free tier.** Then flip **Settings → Billing → Spend cap = ON**
   (overages error instead of surprise-billing).
4. For **each** project, grab three values from **Settings → API** and **Settings → Database**:
   - Project **URL** (e.g. `https://abcdxyz.supabase.co`) → goes in **app** (`VITE_SUPABASE_URL`,
     prod only) and **pipeline** (`SUPABASE_URL`).
   - **anon / public** key → goes in **app** (`VITE_SUPABASE_ANON_KEY`). Safe to expose in a browser.
   - **service_role** key → goes in **pipeline** (`SUPABASE_SERVICE_ROLE_KEY`). **Secret. Never the
     browser. Never committed.**
   - Database → Connection string → **Session pooler** (port 5432) → goes in **pipeline**
     (`SUPABASE_DB_URL`). Replace `PASSWORD` with the db password from step 2.

> You can also just add me (the manager) as a member of the Supabase org and I'll create the
> projects and read the keys directly — your call. Either way, Pro + spend-cap is your decision to click.

### 2. Render — hosting for the app + the nightly data job · blocks the deploy (M1.3)

1. Create a **Render** account at **https://render.com** (Hobby workspace, free) and **connect it
   to the GitHub repo** `hkosar/truck-recruitment-tool` (Render → Account → GitHub → configure).
2. That's all you do here — the repo already contains `render.yaml`, so once connected I wire the
   Static Site (the app) and the one Cron Job (the nightly data sync) from that file, and paste the
   Tier-1 secrets into their Environment tabs.

### 3. Socrata app token — lifts the FMCSA data rate limit · blocks the first data pull (M2.1)

1. Create a free account on the data portal at **https://data.transportation.gov** (Sign In →
   Sign Up), confirm email, then register an **app token** at **https://dev.socrata.com/register**
   (sign in with that same account).  *(Just the token string — you do NOT need the secret/OAuth parts.)*
2. Copy the app token → goes in **pipeline** (`SOCRATA_APP_TOKEN`).

**With Tiers 1–3 done, the data layer can go live and the build session can start in earnest.**

---

## Tier 2 — needed a little later in the build (not day one)

### 4. Google Maps — the real maps · needed before M4 (search/batch maps)

Maps are free at our scale, **but only if you set the hard caps** — Google's "budget alerts"
warn you, they do **not** stop spending; **only per-API quota caps hard-stop the bill.**

1. **https://console.cloud.google.com** → create a project `twisted-nail-recruiter`.
2. **Billing → link a billing account with a card** (mandatory even though we expect $0).
3. **APIs & Services → Enable APIs:** enable exactly **Maps JavaScript API**, **Geocoding API**,
   and **Routes API**. (Do not enable others.)
4. **APIs & Services → Quotas — set these hard caps (this is what protects you):**
   - Maps JavaScript "Dynamic Maps" → **500 / day**
   - Geocoding → **200 / day**
   - Routes (Compute Routes) → **200 / day**
   - *(Place Details → 50/day — only if/when we add enrichment; skip for now.)*
5. **Billing → Budgets & alerts → create a budget** with email alerts at **$5** and **$25** to
   your email. (Smoke detector under the hard caps.)
6. **Credentials → Create credentials → API key** → then **restrict it**: Application restriction =
   **HTTP referrers**, add the app's domain(s) (I'll give you the exact Render URL); API
   restriction = the **three** APIs above only.
7. **Maps JavaScript API → Map management → create a Map ID** (Vector) for advanced markers.
8. Copy the **API key** → **app** (`VITE_GOOGLE_MAPS_API_KEY`); copy the **Map ID** → **app**
   (`VITE_GOOGLE_MAPS_MAP_ID`). The browser key is referrer-locked, so it's safe in the app bundle.

### 5. Resend — sending domain for pipeline alerts (and later, job-offer emails) · lead time for M7

DNS changes take time to propagate, so start this early even though email sends are a later phase.

1. Create **https://resend.com** (free to start; Pro $20/mo only when the email module ships).
2. **Add a domain** → use a **subdomain** `offers.twistednail.com` (protects your main domain's
   reputation) → Resend shows SPF / DKIM / DMARC records → add them at your DNS host (GoDaddy/
   Cloudflare/wherever `twistednail.com` lives). Verify.
3. Create an **API key** → goes in **pipeline** (`RESEND_API_KEY`). Pipeline failure alerts already
   go to `hunter.kosar@gmail.com` (`ALERT_EMAIL`) — change that line if you want a different inbox.

### 6. FMCSA QCMobile WebKey — powers the on-demand inspection lookups · needed for M5.8 only

- Request a **WebKey** via a Login.gov developer account (FMCSA QCMobile). Not launch-blocking —
  the carrier profile's Inspections tile shows a graceful "no data yet" state until this exists.
- When you have it → goes in **Supabase secret** (`QCMOBILE_WEBKEY`) — it lives server-side in the
  `qc-fetch` Edge Function, **not** in the app or the pipeline.

---

## Tier 3 — right before launch

- **App domain:** a DNS record like `recruit.twistednail.com` → the Render app (I'll give you the
  target once the site exists).
- **The 5 real user emails** (you + team) so I can provision their accounts and roles
  (manager / edit / view), and you approve each from the Users screen.
- **Company physical mailing address** — legally required in the footer of any marketing email
  (only matters once the email module ships).

---

## What you can safely ignore

- **Census Bureau geocoder** — free, no key, already configured. Nothing for you to do.
- Anything asking you to choose infrastructure regions/sizes beyond what's above — the plan
  (`04-costs.md`) already fixed those for cost; I'll flag it if a real fork needs your call.

## Cost summary (from `04-costs.md`)

- **Launch MVP: ~$26/mo** — the only real bill is Supabase Pro ($25); everything else rides free
  tiers with the caps above enforced. Google Maps, Socrata, Census geocoder, Render Hobby = $0.
- **+ Email module (later): ~$46/mo** (adds Resend Pro $20).
- Every paid line has a cap or spend-toggle so there are no surprise bills.
