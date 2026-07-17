# Twisted Nail Carrier Recruiter

An internal tool for Twisted Nail (truck brokerage, [twistednail.com](https://twistednail.com)) that turns public FMCSA motor-carrier data into a searchable, geography- and cargo-filtered database — starting with sand & gravel haulers in Texas — so the team can pull a named **batch** of qualified carriers and run structured, multi-channel recruitment outreach (call/text/email, one unified per-carrier contact history) against it, with qualified leads promoted by USDOT number into Twisted Nail's separate carrier-onboarding tool.

**Start here → [`docs/build-plan/README.md`](docs/build-plan/README.md)** for the execution plan (milestones, task cards, verification). For product requirements, read [`docs/discovery-brief.md`](docs/discovery-brief.md) first.

## Monorepo layout

| Path | What |
|---|---|
| [`app/`](app/) | Production web app — Vite + React + TypeScript + Tailwind. Deployed as a Render static site. |
| [`pipeline/`](pipeline/) | Node/TypeScript cron worker that ingests FMCSA data (Socrata) into Supabase, nightly. Deployed as a Render Cron Job. |
| [`supabase/`](supabase/) | Database: migrations, RLS policies, RPCs, seed data. Postgres + PostGIS on Supabase. |
| [`mockup/`](mockup/) | Self-contained clickable prototype (no build tooling, no dependencies) used for design sign-off before production UI is built. See [`mockup/README.md`](mockup/README.md). |
| [`docs/`](docs/) | Product & engineering source of truth — [`discovery-brief.md`](docs/discovery-brief.md) (requirements) and [`build-plan/`](docs/build-plan/) (architecture, frontend spec, costs, verification). |
| [`brand/`](brand/) | Owner-provided brand assets (logos, Montserrat fonts) that `app/` and the mockup build from. |
| [`.github/workflows/`](.github/workflows/) | CI: lint/typecheck/build for `app/` and `pipeline/` on every push and PR. |
| [`render.yaml`](render.yaml) | Render Blueprint: the static site + cron services described below. |

`app/`, `pipeline/`, and `supabase/` are scaffolded per [`docs/build-plan/00-master-plan.md`](docs/build-plan/00-master-plan.md) milestone M1 — see that file for what's expected in each.

## Dev setup

Prerequisites: **Node 22**, npm, the [Supabase CLI](https://supabase.com/docs/guides/cli), and — for anything map-related — a Google Maps Platform browser key (see [`04-costs.md`](docs/build-plan/04-costs.md) for quota-cap setup before using a real key).

### `app/` — web app

```sh
cd app
npm install
cp .env.example .env.local   # fill in VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY,
                              # VITE_GOOGLE_MAPS_API_KEY, VITE_GOOGLE_MAPS_MAP_ID,
                              # VITE_MAPS_PROVIDER (see 02-frontend-spec.md §1.1)
npm run dev
```

### `pipeline/` — ingestion worker

```sh
cd pipeline
npm install
cp .env.example .env.local   # fill in SUPABASE_DB_URL, SOCRATA_APP_TOKEN, etc.
                              # (see 01-architecture.md Part B §6.2)
# Local smoke test — pulls one small page against the dev Supabase project
# (01-architecture.md Part B §6.4):
npm run job -- nightly --from=sync-census --pages=1
```

### `supabase/` — database

```sh
supabase start                                 # local Postgres stack, or:
supabase link --project-ref <dev-project-ref>  # point at the shared dev project
supabase db reset                               # applies migrations, then seed.sql
supabase gen types typescript --local > app/src/types/database.ts
```

### `mockup/` — clickable prototype

```sh
bash mockup/build.sh && node mockup/verify.js   # builds + headless-verifies index.html
```

## Deployment model

- **Supabase** — Postgres + PostGIS + Auth + Realtime. Production runs on a Supabase **Pro** project (daily backups, no idle-pausing); a separate free Supabase project is used for dev/staging, where auto-pausing is harmless.
- **Render** — `render.yaml` in this repo is a [Blueprint](https://render.com/docs/blueprint-spec) defining two services: `app/` as a free **Static Site**, and `pipeline/` as a single nightly **Cron Job** (schedule from `01-architecture.md` Part B §6.3). Connect the repo as a Blueprint in the Render dashboard to provision both.
- **Google Maps Platform** — Dynamic Maps, Geocoding, and Routes APIs power the map/lane search UI in `app/`, behind a provider-agnostic adapter (a MapLibre/OSM fallback is documented but not built). No Places Autocomplete. A browser key, HTTPS-referrer-locked, with hard per-API quota caps and budget alerts.

Verified pricing, citations, and cost-control rules for all of the above live in [`docs/build-plan/04-costs.md`](docs/build-plan/04-costs.md) (~$26/mo at MVP launch). Full architecture — schema, RPCs, RLS, and the ingestion pipeline — is in [`docs/build-plan/01-architecture.md`](docs/build-plan/01-architecture.md); screens and components are in [`docs/build-plan/02-frontend-spec.md`](docs/build-plan/02-frontend-spec.md).
