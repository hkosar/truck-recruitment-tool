# Twisted Nail — Carrier Recruiter · Phase-1 Clickable Mockup

An interactive, **mock-data** prototype of Phase 1 of the trucker recruitment tool:
find sand & gravel carriers across Texas (radius or route-corridor search + the tiered
cargo filter), grab them into a named **batch**, and work a shared cold-call list.

> ⚠️ Everything in here is **fabricated demo data**. No real carriers, phone numbers, or
> contacts. This is a design/UX prototype for feedback — not the production app.

## View it

- **Clickable link (published):** open the Artifact URL shared in the chat.
- **Locally:** just open `index.html` in any browser — it's a single, self-contained file
  with **no dependencies and no network calls** (works offline).

### Demo sign-in
The login screen has one-click role buttons. Roles gate what you see:
- **Manager** (Hunter) — everything, incl. the **Users** approval screen.
- **Editor / Viewer** — batches + carriers.
- **New guest** — lands on the pending-approval page only (the role gate in action).

### What to try
- **New Search** → toggle **Radius** vs **Corridor**, drag the radius/buffer, watch the
  live match count + Texas map update, then **Grab Batch**.
- A batch → filter by **status** (status is a filter, not a queue), switch **List ⇄ Map**,
  select rows → **Generate Contact Options** (the call sheet).
- A carrier → the **call panel** + **unified contact history** (spans batches), the
  **global Do-Not-Call** toggle, and **Send to Onboarding**.
- The same carrier appears in overlapping batches with **different per-batch statuses**.

## Structure

```
mockup/
  index.html        ← built, self-contained deliverable (open this / publish this)
  build.sh          ← concatenates src/* into index.html
  src/
    styles.css      ← design system ("Aggregate Dispatch Console"), light + dark
    geo.js          ← Texas outline, map projection, haversine, radius/corridor math
    data.js         ← seeded mock dataset + carrierMatchesSearch()
    ui.js           ← state, render loop, event delegation, icons, helpers
    screens.js      ← all screens, the SVG map, modals, menus
    main.js         ← action handlers + boot
  verify.js         ← headless Playwright drive-through (needs: npm i playwright-core)
```

Rebuild after editing `src/`: `bash build.sh`. Re-verify: `node verify.js`.

## Why vanilla JS (no framework)

The build proxy blocks CDNs, so the mockup is dependency-free vanilla JS with a tiny
state→render→delegate loop. Full re-render on discrete actions; text inputs and sliders
use targeted DOM patches so focus is never lost. No inline event handlers — everything is
delegated, so it's safe under the strict Artifact CSP.

## Carry-forward: how the mock maps to the real Render + Supabase build

The mock data in `src/data.js` mirrors the intended relational schema. Only the data layer
changes for production (in-memory seed → `supabase-js`); the screens, the search-definition
object, and the domain shapes carry over.

| Mock (data.js) | Production table (Supabase Postgres) | Notes |
|---|---|---|
| `carriers[]` (`dot`, `legal_name`, `lng/lat`, `cargoOther`, `tier`, `do_not_contact`) | `carriers` (PK `dot_number`, `geom geography(Point)`) | USDOT # is the universal key; `geom` = geocoded address (PostGIS); **`do_not_contact` is the global suppression flag** |
| `carrier.ins` | `carrier_insurance` (1:1, from FMCSA **L&I**) | drives the insurance-threshold + authorized filters |
| `carrier.safety` / `carrier.inspections` | `carrier_safety` (1:1) / `carrier_inspections` (1:many) | public signals only (post-2025 BASIC removal) |
| `batches[]` (`name`, `search`) | `batches` (`search_definition jsonb`, `search_geom`) | a **snapshot** + the saved search a Refresh re-runs |
| `batchCarriers[]` (`batch_id`,`dot`,`status`) | `batch_carriers` (UNIQUE(batch_id,dot_number)) | **per-batch pipeline status**; the M:N join |
| `callLogs[]` (`dot`,`batch_id`,`user_id`) | `call_logs` (`channel` enum) | keyed on `dot` → **unified timeline**; `batch_id` → per-batch view; future email/SMS/mail reuse this table |
| `users[]` (`role`,`status`) | `profiles` (extends `auth.users`) + RLS | Supabase Auth for login/register/reset; role + approval workflow |

**The two hard rules, realized in the model:** pipeline status lives on `batch_carriers`
(per-batch), while `carriers.do_not_contact` is global and overrides everywhere; a batch is
the frozen set of `batch_carriers` rows, and **Refresh** inserts only newly-matching rows.

Production swap points flagged in the code: geocoder → `carriers.geom`; routing engine →
the corridor polyline; PostGIS `ST_DWithin`/`ST_Buffer` → the JS radius/corridor tests;
Supabase Realtime → the "Live" shared-list updates; Render cron → the daily FMCSA sync.

## What's intentionally mocked / deferred

- No real FMCSA ingestion, auth, geocoding, or routing (all faked with seed data).
- `email_address` is populated on only ~20% of carriers on purpose — the real fill rate is
  thin and gates the Phase-2 email channel.
- "Print / Export / Copy" on the contact sheet are stubs (toasts) — the real exports land
  in the build.
- Email / SMS / postcard channels are later phases; the data model already accommodates
  them (`call_logs.channel`, a suppression ledger).
