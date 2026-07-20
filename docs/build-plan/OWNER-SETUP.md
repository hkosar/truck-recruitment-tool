# Twisted Nail Recruiter — Setup Guide (no experience needed)

This is your click-by-click list of the accounts I need you to create so I can build and launch
the tool. It assumes you've never done any of this before. Nothing is skipped.

**How to use this:** do the three tasks in **Part 1** first — those are the ones blocking me right
now. Each task ends with a **"✅ When you're done, send me:"** box. Parts 2 and 3 come later; I'll
tell you when, and we'll do them together. Work at your own pace; you can stop and come back.

**One safety rule:** a couple of the values you'll copy are like master keys. I'll mark those
**🔒 SECRET**. Don't paste a 🔒 SECRET value into our chat — I'll give you a spot to put it that
keeps it private. Everything else is safe to paste to me directly.

---

# PART 1 — The three accounts that unblock the build

Do these in order. Total time: about 30–40 minutes.

---

## Task 1 — Supabase (the database + logins)  ·  ~15 min

This is where all the trucker data and user logins live.

### 1A. Create your account
1. Open a web browser and go to **https://supabase.com**
2. Click the green **"Start your project"** button (top-right).
3. On the sign-in screen, click **"Continue with GitHub"** (you already have a GitHub account for
   this project, so this is the simplest). A window pops up asking to authorize — click the green
   **"Authorize supabase"** button.
4. If it asks you to create an **organization**: in the "Name" box type `Twisted Nail`, leave the
   plan on **Free**, and click **"Create organization"**.

### 1B. Create the first project (the real one)
1. You're now on the dashboard. Click **"New project"** (a green button, usually top-right).
2. Fill in the form:
   - **Name:** type `twisted-nail-recruiter-prod`
   - **Database Password:** click the **"Generate a password"** link. A random password appears.
     **Copy it now and paste it somewhere safe** (a note on your phone, a password manager) — you
     will need it later and it is not shown again.
   - **Region:** click the dropdown and choose **"East US (North Virginia)"** (closest to Texas).
   - Leave everything else as-is.
3. Click **"Create new project"** at the bottom. A loading screen appears — wait ~2 minutes for it
   to finish setting up. When the project dashboard loads, this one is done.

### 1C. Create the second project (a practice copy)
1. Click the project name at the top-left, then **"New project"** again.
2. **Name:** `twisted-nail-recruiter-dev` · generate + **save a new password** · same **East US**
   region · **"Create new project"**. Wait for it to finish. (This one stays free — it's my
   sandbox so I never test on your real data.)

### 1D. Turn on backups + a spending safety-net (on the REAL project only)
1. Open the **`twisted-nail-recruiter-prod`** project (click its name at top-left if you're not in it).
2. Click the **gear icon (Settings)** at the bottom of the left sidebar.
3. Click **"Billing"**.
4. Click **"Change plan"** (or **"Upgrade to Pro"**) → choose the **Pro — $25/month** plan → enter
   your card details → confirm. *(This buys daily backups and keeps the tool from falling asleep —
   both required for a real team tool. The practice project stays free.)*
5. Still under Billing, look for a setting called **"Spend cap"** (or "Cost control") and make sure
   it is **ON / enabled**. This means if something ever went over the plan, it stops instead of
   charging you extra. **Leave it on.**

### 1E. Copy the values I need
Do this for **BOTH** projects (prod first, then dev — just tell me which is which). For each project:
1. Open the project → click the **gear icon (Settings)** → click **"API"** (it may be under a
   "Configuration" or "Data API" heading).
2. You'll see:
   - **Project URL** — looks like `https://abcdefgh.supabase.co`. This is **safe to share.**
   - **Project API Keys**, with two keys:
     - **`anon` / `public`** (sometimes labeled *"publishable"*) — **safe to share.**
     - **`service_role`** (sometimes labeled *"secret"*) — click **"Reveal"** to see it. This is
       **🔒 SECRET** — a master key. Don't paste it in chat.
3. Now click **Settings → "Database"**. Find **"Connection string"**, click the **"Session pooler"**
   tab, and copy the string shown (it starts with `postgresql://`). This one is **🔒 SECRET** (it
   has your password in it).

> **✅ When you're done, send me (safe values only):**
> *"Prod URL: `https://…`, prod anon key: `…`" and the same two for dev.* Then tell me
> **"I have the two 🔒 SECRET values ready"** and I'll give you a 30-second, private way to hand
> those over (you'll paste them into a settings box in your own browser — they never touch our chat).

---

## Task 2 — Render (where the tool actually runs online)  ·  ~5 min

Render is the service that will host the website and run the nightly job that refreshes the data.

1. Go to **https://render.com** and click **"Get Started"** (or **"Sign In"**).
2. Click **"GitHub"** to sign in with your GitHub account → click **"Authorize Render"** in the popup.
3. If it asks you to create a **workspace**: name it `Twisted Nail`, pick the **Hobby (Free)** option,
   and continue.
4. Now connect the code repository so Render can see it:
   - Click your **account/profile icon** (top-right) → **"Account Settings"** → **"GitHub"** in the
     left menu → click **"Configure"** (this opens GitHub).
   - On the GitHub page, under "Repository access" choose **"Only select repositories"**, click the
     dropdown, and pick **`hkosar/truck-recruitment-tool`** → click **"Save"** (or "Install").
5. That's your part. You do **not** need to create any services — the code already contains the
   recipe (a file called `render.yaml`), and I'll build the website and the nightly job from it
   once you've connected the repo.

> **✅ When you're done, send me:** *"Render is connected to the repo."* (Nothing to copy here.)

---

## Task 3 — Socrata data token (a free pass for the government data feed)  ·  ~5 min

The trucker data comes from a public U.S. Department of Transportation dataset. Without a free
"token," they limit how fast we can download; with one, we can pull the whole Texas list.

1. Go to **https://data.transportation.gov**
2. Top-right, click **"Sign In"**, then **"Sign Up"** (or "Create account"). Enter an email and
   password, and confirm the verification email they send you.
3. Once signed in, open **https://dev.socrata.com/register** in the same browser.
4. Sign in there with the same account if asked. You'll get a short form:
   - **Application Name:** type `Twisted Nail Recruiter`
   - **Description:** type `Internal carrier recruiting tool`
   - Leave the rest blank/default.
5. Click **"Create"**. The page now shows an **"App Token"** — a string of letters and numbers.
   Copy it. *(This one is low-risk — it's just a rate-limit pass, not a key to any of your data,
   so it's safe to share.)*

> **✅ When you're done, send me:** *"Socrata token: `…`"*

---

### 🎉 That's Part 1. Once Tasks 1–3 are done and you've sent me those values, I can put the
database live, pull the first batch of real Texas carriers, and start building the actual screens.

---

# PART 2 — Needed a bit later (don't do these yet)

I'll walk you through each of these — click by click, same as above — when the build reaches the
point that needs it. Listed here just so you can see what's coming.

## Task 4 — Google Maps (for the real maps)  ·  needed before the map screens
Google Maps is free at our size, **but only if the right spending limits are set** — I'll give you
the exact numbers to type in. Rough shape: create a Google Cloud project, put a card on file (Google
requires it even though we expect $0), turn on three specific map services, set daily usage caps and
$5/$25 alert emails, and create a map "key" locked to our website. It's the fiddliest one, which is
exactly why we'll do it together step by step when the time comes.

## Task 5 — Resend (email sending), only if/when we add the job-offer email feature
This one has DNS records (settings at wherever `twistednail.com` is registered) that take a day to
"propagate," so we'll start it early even though email is a later phase.

## Task 6 — FMCSA "WebKey" (for the deep safety-inspection details on a carrier's profile)
A free developer key from the FMCSA. Not required to launch — the profile just shows "no data yet"
on that one panel until it's added.

---

# PART 3 — Right before we go live

- A web address for the tool (like `recruit.twistednail.com`) — one DNS record I'll give you.
- The **email addresses of the 5 people** who'll use the tool, so I can set up their logins and you
  can approve them.
- Your **company's physical mailing address** (only needed once we turn on marketing emails — it's
  a legal requirement in email footers).

---

## Quick reference — what each value is and how sensitive it is

| Value | From | Safe to paste in chat? |
|---|---|---|
| Supabase Project URL (prod + dev) | Task 1E | ✅ Yes |
| Supabase `anon`/public key (prod + dev) | Task 1E | ✅ Yes |
| Supabase `service_role` key | Task 1E | 🔒 No — we'll do the private handoff |
| Supabase database connection string | Task 1E | 🔒 No — we'll do the private handoff |
| Socrata App Token | Task 3 | ✅ Yes |
| Google Maps key + Map ID | Task 4 (later) | ✅ Yes (it's locked to our site) |

**Total cost once running: about $26/month** — the only real bill is the Supabase Pro plan ($25).
Everything else in Part 1 is free, and every paid service has a cap so there are no surprise charges.
