# Twisted Nail — Trucker Recruitment Tool
## Discovery & Requirements Brief

**Owner:** Twisted Nail (truck brokerage, twistednail.com)
**Prepared:** 2026-07-17
**Stage:** Information-gathering — COMPLETE (Phase: discovery)
**Purpose:** Canonical input document for the planning stage. Captures the product
vision, confirmed decisions, validated data feasibility, the core filtering model,
design flags, and open questions.

---

## 1. Product vision & end goal

A searchable database of U.S. motor carriers, built on public FMCSA data, that lets
Twisted Nail isolate a very specific slice of the market — **sand & gravel truckers** —
by geography and carrier attributes, then run structured recruitment outreach against
that filtered list.

The **end goal** is lead generation for hauling projects in Twisted Nail's operating
area. A qualified lead is not managed long-term in this tool; it is handed off (by
USDOT number) into Twisted Nail's separate **carrier-onboarding application** (a future,
separate build). A future integration between the two tools is envisioned but not in
scope until both exist.

**Scope today:** internal tool for Twisted Nail. **Future possibility:** if successful,
license/sell it to other brokers (multi-tenant SaaS). Build should not foreclose this,
but multi-tenancy is **not** built in the initial phases.

---

## 2. Phased roadmap

The project is explicitly **phased** — each layer ships and is proven stable before the
next is added.

| Phase | Capability | Status |
|-------|-----------|--------|
| **0** | Data pipeline: ingest FMCSA data, geocode, store, keep fresh | Foundation (required by all) |
| **1** | Searchable/filterable database **+ cold-call CRM** (track & log call attempts, carrier status pipeline) | **First build target** |
| **2** | Bulk **email** outreach (campaigns + tracking) via an email service provider | Future add-on |
| **3** | **Postcard / direct-mail** distribution via a mail service | Future add-on |
| **4** | **SMS** recruitment via Twilio | Future add-on |
| **Later** | Integration/handoff into the carrier-onboarding application | After both tools exist |

All outreach channels (call/email/mail/text) roll up into **one unified contact history
per carrier**.

---

## 3. Data foundation (FMCSA) — feasibility CONFIRMED

The application is buildable on **free, public FMCSA data**. No paid data source is
required to start.

**Primary bulk source — Company Census File** (Socrata dataset `az4n-8mr2`)
- **142 fields**, **~2.2M active carriers** (~4.5M total records incl. inactive/pending).
- **Refreshed daily** (not monthly, as is commonly assumed).
- Downloadable as CSV and via the Socrata SODA API / OData.

**Secondary source — Licensing & Insurance (L&I)** (dataset family `jeyh-5nsj`)
- Carries **operating authority status** and **insurance on file (coverage amounts)** —
  needed for the "authorized + insured" and insurance-minimum filters (see §6).
- Census "active" status ≠ verified for-hire authority + insurance; the two must be
  **joined** on USDOT number when authority/insurance accuracy matters.

**Per-carrier verification — QCMobile API** (`mobile.fmcsa.dot.gov/qc`)
- Live single-carrier lookups by USDOT / name / MC number. Requires a free WebKey
  (Login.gov). Use for on-demand verification, **not** bulk harvesting.

**Fields confirmed present** (census): legal name, DBA, physical + mailing address,
`phone`, `cell_phone`, `email_address`, `fax`, `dot_number`, MC/docket numbers,
`power_units`, `total_drivers`, operation classification (`classdef`, for-hire/private),
`carrier_operation` (interstate/intrastate), MCS-150 date/mileage, entity type,
`status_code` (`A` = active), and **30 `crgo_*` cargo flag columns** including
`crgo_cargoothr` + **`crgo_cargoothr_desc` (free-text "Other cargo" description).**

**Identifier decision:** FMCSA is phasing out MC/MX/FF numbers in favor of
USDOT-number-only identification. **USDOT number is the primary key** throughout —
which also matches what the onboarding tool keys on.

**Data caveats to design around:**
1. **No sand/gravel/aggregate cargo category exists** (see §4 — this is central).
2. **`email_address` is sparsely populated** — measure real fill-rate for Texas early;
   it gates when bulk email (Phase 2) becomes worthwhile.
3. **No latitude/longitude** in the data — addresses must be **geocoded** by us to
   enable radius/corridor search (routine build step).
4. **Public safety data is reduced** — FMCSA removed property-carrier SMS/BASIC
   percentile scores from public display (2025). "Concerning safety history" filtering
   will rely on still-public signals (crash counts, inspection / out-of-service data,
   operating status) rather than the old BASIC percentiles. Set expectations accordingly.

---

## 4. Core filter model — identifying sand & gravel carriers (THE crown jewel)

There is **no** FMCSA cargo category for sand/gravel/aggregates. Based on the owner's
direct experience with how these carriers self-classify, the matching strategy is a
**tiered signal model**, in priority order:

- **Tier 1 — HIGH confidence (primary signal): free-text match on `crgo_cargoothr_desc`.**
  Sand & gravel operators typically select **"Other"** and type variants such as
  *"Sand and Gravel," "Sand & Gravel," "Rock," "Dirt,"* and similar. A normalized
  keyword/fuzzy match on this description field is the **backbone** of the filter and the
  highest-precision signal.
- **Tier 2 — SUPPORTING (lower confidence, not guaranteed): cargo flags**
  `crgo_drybulk` (Commodities Dry Bulk), `crgo_construct` (Construction),
  `crgo_bldgmat` (Building Materials). These widen the net but produce more false
  positives; used to surface likely candidates who didn't fill the Other field cleanly.

**Guiding principle from the owner:** *"What freight do you haul? If you haul my freight
and I can book you, you're a match."* Cargo match is the dominant filter; everything else
narrows within it.

**Build note:** measure Tier-1 coverage across Texas carriers early — it validates the
whole precision story. Expect to maintain a curated, normalized list of match
terms/spellings (regex + fuzzy) for the Other-field description.

---

## 5. Search & geography

- **Region:** **Texas only** (initial). Ingest can be scoped to `phy_state = TX`, keeping
  the working dataset small and cheap.
- **Two search modes required:**
  1. **Radius from a point** — anchor can be an **address, map pindrop, city, ZIP, or
     county**; **radius is a user-input variable**, almost always **< 100 miles**.
  2. **Corridor from a route** — *"40 miles from the route"* = within X miles of **any
     point along a run**, not just the origin/destination. This is a **route-buffer**
     search (compute the route polyline, buffer it by X miles, find carriers inside the
     buffer). Technically the most demanding feature; see §14.
- **Filtered universe size:** typically **250–5,000 carriers** at a time depending on
  region — small enough for a responsive UI and inexpensive geospatial queries.
- **Implementation direction:** geocode carrier addresses (ZIP-centroid tier for speed,
  street-level where precision matters); store coordinates; use **PostGIS** (available in
  Supabase) for radius (`ST_DWithin` on points) and corridor (`ST_DWithin` against a
  route linestring) queries.

---

## 6. Filters (the market-narrowing controls)

- **Cargo / freight category** — the primary filter (see §4). Tiered sand & gravel match.
- **For-hire** — operation classification (`classdef`).
- **Truck / fleet size** — `power_units` (and/or `total_drivers`).
- **Insurance level** — **filterable threshold, not a hard exclusion.** Twisted Nail
  requires **$1MM minimum**, but wants **$500k carriers still visible/filterable** (many
  carriers carry $500k). Requires L&I insurance data. Also: "no insurance" is a
  disqualifier when the user filters for it.
- **Active carrier** — census `status_code = 'A'`.
- **Legally able to operate / authorized** — operating authority from L&I.
- **Carrier safety history** — filter out "concerning" safety (within the limits of §3
  caveat 4 — reduced public safety data).
- **Interstate / intrastate** — `carrier_operation`.
- **Geography** — radius or corridor (see §5).

**Disqualifiers (owner's words):** wrong freight categories, no insurance, concerning
safety history, insurance below the chosen filter limit, not legally able to operate.

---

## 7. Users, roles & authentication

- **~5 users from day one.**
- **Auth screens:** login, **register**, **forgot password**, **remember me**.
- **Roles (RBAC):**
  - **Manager** — full control incl. reviewing/approving accounts and assigning roles.
  - **Edit** — can modify data / log activity.
  - **View** — read-only.
  - **Guest** — newly registered/unreviewed; sees a **generic landing page only** until a
    Manager reviews and provisions the account.
- **Account-approval workflow:** self-register → lands as pending **Guest** → Manager
  reviews → assigns real role. (Supabase Auth + a profiles/roles table + Row-Level
  Security supports this directly.)

---

## 8. Phase 1 scope — searchable DB + cold-call CRM

The first shippable product: the filterable carrier database **plus** a cold-calling
workflow to recruit trucks — track each carrier's status and **log every contact
attempt**.

**Strawman status pipeline (TO BE VALIDATED in the clickable mockup — not yet confirmed):**
`New → Attempting → Contacted → Interested → Qualified → Handed Off`, with side states
`Not a Fit` and `Do Not Contact`. The exact stages, per-call log fields, callback/queue
behavior, and lead assignment across the 5 users are **open items** (see §14) — these are
precisely what the mockup + iterative feedback loop is designed to pin down.

---

## 9. Unified contact model & compliance

- **One unified contact-history timeline per carrier** spanning all channels
  (call/email/text/mail).
- **Per-carrier "Do Not Contact" flag** that **suppresses the carrier across ALL
  channels** once set.
- **Compliance built in from the start, expectations kept flexible.** Relevant regimes:
  - **TCPA** — calls/texts; heightened risk because many carrier numbers are **mobile**.
    Manual calling is lower-risk than automated dialing/texting.
  - **DNC** (Do-Not-Call registry) — scrub call lists.
  - **CAN-SPAM** — email must carry a physical address + honored opt-out.
  - FMCSA data is public and free to use; **carriers cannot opt out of the public
    dataset**, so suppression/consent is the marketer's responsibility (ours).
- **Design implication:** suppression lists, unsubscribe/opt-out tracking, and DNC
  awareness are first-class from Phase 1, even though only calling ships first.

---

## 10. Later phases — outreach channels (provider notes)

- **Email (Phase 2):** send via a **dedicated email service provider** (not raw SMTP) to
  protect domain reputation; needs **campaign tracking** (opens/clicks). Provider to be
  chosen with an itemized cost comparison.
- **Postcard / direct mail (Phase 3):** **no vendor selected**; evaluate options
  (e.g., Lob, PostGrid, Click2Mail) with a cost/feature comparison.
- **SMS (Phase 4):** **Twilio.**
- **Enrichment (experimental, not committed):** FMCSA contact data may be thin. Owner is
  **open** to enrichment but skeptical of reliable availability and wary of wasted effort.
  Possible DIY approach: cross-reference registration → find website/social profile.
  Treated as an experiment to justify, **not** a Phase-1 dependency. No paid data tools
  today; owner prefers to stay free **unless a specific, traceable benefit justifies a
  cost**.

---

## 11. Handoff to the onboarding tool

- When a lead qualifies, the handoff is simple: **pass the USDOT number.** Twisted Nail's
  onboarding tool imports the FMCSA data automatically from the USDOT number.
- Design the export/handoff around **USDOT number** now; API-connect the two tools later.

---

## 12. Technology stack & hosting (confirmed)

- **Hosting:** **Render** (web application + background/cron jobs for the daily FMCSA
  sync).
- **Data + backend services:** **Supabase** — PostgreSQL (with **PostGIS** for geo),
  **Auth** (login/register/reset + roles), **Row-Level Security** (clean path to future
  multi-tenancy), and storage.
- Rationale: low running cost, batteries-included auth/RBAC, native geospatial, and an
  easy path to the future SaaS option without re-platforming.

---

## 13. Non-functional requirements

- **Scale:** 5 users initially; 250–5,000 carriers in a typical filtered view.
- **UX bar (owner's definition of success):** ability to **generate bulk contact options
  for qualified carriers**; an **intuitive, bug-free UI/UX**; and **all processes
  functioning** reliably.
- **Budget philosophy:** no fixed ceiling, but **every cost must be justified and
  itemized** so decisions can be made line by line. Prefer free/open where it doesn't
  compromise the success criteria.
- **Timeline:** none specified.

---

## 14. Open questions / deferred decisions

Deferred by the owner for now; to be resolved via assumptions in planning and refined
during the clickable-mockup feedback loop:

1. **Cold-call CRM workflow detail (Phase 1):** exact status pipeline; per-call-attempt
   log fields (disposition, notes, callback time, best-time-to-reach); whether a
   "who-do-I-call-next" **queue + reminders** is needed vs. a filterable list; **lead
   assignment** across the 5 users (geography / round-robin / shared list); any
   **click-to-call / dialer** integration vs. pure manual tracking.
2. **Route-corridor search priority:** is *"X miles from the route"* a **Phase-1 launch
   requirement** or a fast-follow? It is the most technically demanding feature (needs a
   routing/polyline source + PostGIS buffering) and materially affects the plan.
3. **Insurance / authority join in Phase 1:** confirm L&I data is joined from the start
   (needed for the insurance-threshold and authorized/insured filters) vs. census-active
   only for a first pass.
4. **Email/postcard provider selection** (Phase 2/3) — pending itemized comparison.

---

## 15. Key risks & mitigations

| Risk | Mitigation |
|------|-----------|
| Sand/gravel precision depends on the free-text Other field being populated & consistent | Measure TX coverage early; maintain curated match terms + fuzzy matching; Tier-2 flags as backstop |
| Email coverage too thin to justify Phase 2 | Measure `email_address` fill-rate before building bulk email |
| TCPA/DNC exposure on automated calling/texting (mobile numbers) | Manual calling first; suppression/consent tracking from Phase 1; legal review before automating |
| Reduced public safety data (post-2025) limits safety filtering | Filter on still-public signals; set owner expectations |
| Corridor search complexity | Treat as a distinct, possibly-phased capability; confirm priority (§14.2) |
| Future SaaS pivot forcing a rewrite | Supabase RLS + clean tenancy boundaries from the start (build single-tenant, don't foreclose) |

---

## 16. Addendum — CRM & batch model (resolved after follow-up)

Answers to the deferred Phase-1 CRM questions (§14.1) and the newly-introduced
**batch / working-session** concept, now locked:

- **Pipeline stages:** `New → Attempted → Contacted → Interested → Not a Fit`, plus
  **Do Not Call**. Do Not Call is handled as a **global carrier flag**, not a per-batch
  stage. "Qualified/handed off" is an **action** (Send to Onboarding), not a stage.
- **Carrier profile:** one rich view of *all* FMCSA data (contact, insurance, safety,
  inspections, general) + a call panel.
- **Per-call log fields:** timestamp, who called, outcome/disposition, notes, next steps.
- **List, not a queue:** one **shared** filterable list; **status is a filter dimension**;
  updates are **live** for all ~5 users; **no dialer** (tracking layer only); no per-user
  lead assignment.

**The batch / working-session model:**
- Step 1 is defining a search (geography + filters) and "grabbing a batch" of trucks. A
  batch is **namable** ("Belt Construction Recruitment") and is the unit a user works in.
- A batch is a **snapshot** (frozen membership) with a manual **Refresh** to pull in
  newly-matching carriers. Carriers can belong to **multiple batches** (M:N).
- **Status is per-batch** (each batch is an independent working session — the same carrier
  can be "Interested" in one and "New" in another). **EXCEPTION: Do Not Call is global** —
  set anywhere, it suppresses the carrier in every batch and channel.
- **Contact history is unified per carrier** across all batches, even though status is
  per-batch.

**Deliverable produced:** a clickable, self-contained Phase-1 mockup (mock data) at
`mockup/` — all screens, both geo search modes on a live Texas map, the tiered sand &
gravel filter, the shared working list, the rich carrier profile + unified timeline, and
the manager approval flow. See `mockup/README.md` for the mock→Supabase schema mapping.
Data model, TypeScript-ready shapes, and the `search_definition` object are the
carry-forward assets into the real Render + Supabase build.

### Open items still deferred to the build-plan (Fable) stage
- Corridor search: launch requirement vs. fast-follow, and the routing-provider choice.
- Exact "Generate Contact Options" export formats (call sheet / CSV / dialer push).
- Email / postcard provider selection (Phases 2–3), with itemized costs.

---

## 17. Addendum — Feedback Round 1 ingested; full build plan produced (2026-07-17)

The owner delivered feedback round 1 (`Recruiting_tool_feedback.docx`, 24 items), the
**Twisted Nail brand assets** (monochrome wordmark/badge/icon + Montserrat; build subset
committed at `brand/`), and a screenshot of the existing Owner Operator Database tool
(Google Maps + numbered colored pins + legend + stat strip — the design language to
mirror). All feedback is itemized, resolved specifically AND generalized tool-wide in
**`docs/build-plan/03-feedback-resolution.md`** (F1–F24 × resolution × landing spot ×
G1–G10 principles).

**Structural changes it drove:** Batches screen → **Dashboard** (overview map above a
batch table; tiles removed) · **multi-lane batches** (N radius/corridor zones per batch,
union coverage — the Waco job with Austin + Dallas lanes) · corridor lanes take **custom
pickup/dropoff every time** (presets deleted; resolves §14.2 — corridor ships at launch)
· freight filter reinvented as **category checkboxes + a faceted "Other" value browser
with per-value counts and include/exclude** ("wide net" concept removed) · safety
exclusion filter removed in favor of a **pale-red warning system** propagated everywhere
a carrier renders · **contact name/phone/email** columns + a contactability filter ·
**multi-channel logging** (call/text/email) in the unified timeline · **batch activity
feed** (auto events + comments) · batch = Name (first) + **Customer + Job** · "Send to
Onboarding" → **"Mark as Promoted"** tracking action · reserved sidebar tabs for future
modules · profile restructure with **3 design variants** to be picked in the next mockup
round.

**Decisions locked with the owner (D1–D6):** Google Maps Platform (billing prereq +
hard quota caps; ~$0/mo at internal scale) · email-blast module = **fast-follow after
launch** on a dedicated sending subdomain via ESP (legitimate deliverability; no address
rotation) · L&I insurance/authority join at launch (resolves §14.3) · monochrome +
Montserrat brand chrome with orange interaction accent.

**Deliverable of this stage — the execution roadmap** at **`docs/build-plan/`**
(README + 6 docs, ~2,000 lines): milestones **M0–M8** (M0 mockup v2 + profile variants →
M1 foundations → M2 data pipeline w/ owner data-QA gate → M3 shell/auth → M4 search &
batches → M5 working list & CRM → M6 hardening/launch w/ owner UAT → M7 email →
M8 enrichment), full task cards with acceptance criteria, the Opus-manager/Sonnet-worker
execution protocol, complete Supabase schema v2 DDL + RPC/RLS/realtime spec, the FMCSA
ingestion pipeline spec, screen-by-screen frontend spec, verified itemized costs
(**$26/mo MVP · $46/mo with email**, cited), and the verification/QA gate catalog.
Development itself begins only when the owner starts the build stage.
