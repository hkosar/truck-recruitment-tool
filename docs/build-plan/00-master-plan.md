# Twisted Nail Carrier Recruiter — Master Build Plan (v2)

**Status:** approved planning baseline · **Prepared:** 2026-07-17 · **Stage:** post-feedback-round-1, pre-build
**Executor model:** an **Opus manager session** orchestrating **Sonnet worker agents** (ultracode effort), with humans (Hunter) at defined sign-off gates only.

---

## 0. How to use this plan (instructions to the executing manager)

1. **Read this file fully before any work.** Then read `03-feedback-resolution.md` (the contract with the owner) and skim `05-verification.md` (how "done" is judged).
2. **Load spec detail lazily.** Each task card cites its spec — `01-architecture.md` (schema DDL, RPCs, RLS, pipeline), `02-frontend-spec.md` (screens, components, map), `04-costs.md` (service decisions + guardrails). Give workers **file paths + section anchors**, not pasted walls of text.
3. **The contract-reconciliation section at the top of `01-architecture.md` is authoritative** wherever two spec documents differ. Do not resolve conflicts ad hoc — if a real contradiction isn't covered there, update the reconciliation section first, then proceed.
4. **Milestone gates are hard.** A gate that says "owner sign-off" means work that depends on it does not start until Hunter has said yes in chat. Gates that say "E2E green" mean the suite actually ran and passed — never mark done on "should work."
5. **Never improvise credentials or external accounts.** Everything owner-provisioned is in §3. If it's missing, ask Hunter; do not substitute.
6. Repo: `hkosar/truck-recruitment-tool`, branch `claude/trucker-recruitment-database-htewrs`. Commit per task with descriptive messages; push at milestone boundaries at minimum.

### Model & effort guidance per work type

| Work | Agent effort |
|---|---|
| Mechanical scaffolding, CRUD screens, copy, seed data | Sonnet, standard |
| PostGIS matcher SQL, RLS policies, facet SQL, migrations | Sonnet high-effort + **mandatory adversarial review pass** (second agent attempts to break it: wrong-role writes, SQL injection via sort params, zone-union edge cases) |
| Map adapter, virtualized table perf, realtime coalescing | Sonnet high-effort; Opus if two attempts stall |
| E2E harness, RLS negative tests | Sonnet high-effort |
| M0 design round (visual quality) | Opus (design judgment matters) |

### Standing execution pattern (every milestone)

```
plan tasks → fan out independent workers (worktree isolation when files overlap)
→ integrate → typecheck/lint/test → adversarial code review (fresh agent, prompt: REFUTE correctness)
→ run the milestone's E2E/gate checks from 05-verification.md
→ demo/report → gate (owner or automated) → commit+push → next
```

---

## 1. Product state & context

- **Built so far:** clickable mockup v1 (`mockup/`, self-contained, published as a private Artifact) + canonical requirements (`docs/discovery-brief.md`) + validated FMCSA data feasibility (census `az4n-8mr2` TX slice, L&I `jeyh-5nsj`, safety; all free).
- **This round ingested:** owner feedback round 1 (24 items, F1–F24 — see `03-feedback-resolution.md`), Twisted Nail brand assets (monochrome + Montserrat; in `brand/`), and a screenshot of the owner's existing Owner Operator Database tool (Google Maps, colored numbered pins + legend, stat strip — the design language to mirror).
- **Core domain model (locked):** batches = named snapshots with add-only Refresh; carrier ∈ many batches; per-batch status `new→attempted→contacted→interested→not_a_fit`; **global** `do_not_contact` overrides everything; unified per-carrier multi-channel contact timeline; USDOT = universal PK; roles manager/edit/view/guest with manager approval.

## 2. Decisions locked this round

| # | Decision |
|---|---|
| D1 | **Google Maps Platform** (Dynamic Maps + Geocoding + Routes; NO Places Autocomplete — see reconciliation) behind a provider-agnostic `MapAdapter`; MapLibre fallback documented, not built. $0/mo at our scale with hard quota caps (04-costs §1, §7). |
| D2 | **Email module = fast-follow (M7)**, immediately after launch. Sending-subdomain + ESP (Resend Pro) groundwork starts mid-build because warm-up takes weeks. Legitimate deliverability only — dedicated subdomain `offers.twistednail.com`, SPF/DKIM/DMARC, throttling, suppression synced to global DNC, CAN-SPAM. Never rotating/deceptive addresses. |
| D3 | **Corridor lanes: custom pickup/dropoff every time** (no presets), Google Routes (traffic-unaware) + turf buffer visual; PostGIS is the authoritative membership test. Corridor ships at launch. |
| D4 | **L&I authority + insurance join at launch** — powers the warning system and insurance threshold. |
| D5 | "Send to Onboarding" → **"Mark as Promoted"** tracking action (`promoted_at/by`), reflecting the real flow (per-carrier USDOT promotion into TNBS tools after a carrier asks to register). |
| D6 | **Brand:** monochrome chrome + Montserrat + one hi-vis orange interaction accent + semantic status colors; stat-strip/legend/numbered-pin kinship with the existing TNBS tool. |

## 3. Owner-provisioned prerequisites (Hunter's checklist)

Ordered by when they block work. The manager asks for each **once, at the milestone that needs it**.

| When | What | Blocks |
|---|---|---|
| Before M1 | GitHub repo access confirmed (already have); **Supabase account** + create two projects (prod, dev) or grant the manager permission to create via dashboard | M1.2 |
| Before M1 | **Render account** (Hobby workspace) connected to the repo | M1.3 |
| Before M2 | **Socrata app token** (free, data.transportation.gov signup) | M2.1 |
| Before M5.8 | **FMCSA QCMobile WebKey** (Login.gov developer account) — powers the on-demand Inspections tile fetch | M5.8 (not launch-blocking; tile shows empty/fetching states until set) |
| Before M4 | **Google Cloud billing account** (card on file — mandatory even at $0), one project, enable Maps JavaScript API + Geocoding API + Routes API, create browser key (HTTPS-referrer-locked) + set the **hard quota caps** and **$5/$25 budget alerts** exactly per `04-costs.md` §7 | M4.1 |
| During M4–M5 (calendar lead time) | **Resend account** + DNS records for `offers.twistednail.com` (SPF/DKIM/DMARC) so warm-up can begin | M7 |
| Before M7.3 | **Company physical mailing address** (CAN-SPAM footer) + explicit approval of the first campaign's audience and copy | M7.3 / M7 gate |
| Before M6.6 | DNS record for the app host (e.g. `recruit.twistednail.com` → Render) + the 5 real user emails | Launch |

## 4. Milestones & task cards

Dependency graph:

```
M0 (design round 2) ─┐
M1 (foundations) ────┼─→ M3 (shell+auth) ─┐
        └─→ M2 (pipeline) ────────────────┼─→ M4 (search+batches) → M5 (list+CRM) → M6 (launch) → M7 (email) → M8 (enrich)
M0, M1, M2 start in parallel immediately. M4 needs M0 sign-off + M2 staging data + M3 shell.
```

Task-card format: **id · name — objective. Spec: refs. Deps. AC:** acceptance criteria. **Verify:** how.

### M0 — Design Round 2 (mockup v2) — GATE: owner sign-off

The mockup (not the production app) absorbs every visual/UX feedback item first, because it is the cheapest place for Hunter to iterate. Same artifact URL, re-published per round.

- **M0.1 · Mockup v2 restructure** — apply to `mockup/`: Dashboard rename + map-over-table layout (F3/F4); wizard flow with Name/Customer/Job first (F20); lanes list with add/edit/remove radius + corridor lanes, custom pickup/dropoff entry, multi-lane map union (F21/F13 — mock geocoding/routing with plausible canned geometry is fine); anchor order Pin/Address/City/ZIP/County (F12); freight facet browser with per-value counts + include/exclude + suggested chips (F14); warnings-not-exclusions with pale-red rows + chips (F15); contact name/phone/email columns (F17) + contactability filter (F16); multi-channel log modal (F8); batch activity feed (F11); contact sheet with name+email, no USDOT copy (F9); Mark as Promoted (F23); reserved sidebar tabs (F2); **per-lane material/label field** (01 reconciliation #18). Extend mock data: officer names, other-desc value distribution, warning cases. M0.4 walkthrough explicitly asks Hunter to confirm: the material-as-lane-label treatment, that CSV export stays (F9's wording was ambiguous), and the chosen profile variant. Spec: `02-frontend-spec.md` §3 (adapt to mockup's vanilla framework). Deps: none. **AC:** every F# above demonstrably clickable; mockup's existing headless verify extended to cover new flows, ALL CLEAR. **Verify:** `bash mockup/build.sh && node mockup/verify.js` → 0 errors/0 external requests + screenshot review.
- **M0.2 · Brand application** — Montserrat (subset woff2 as data URIs to stay self-contained), monochrome chrome, real wordmark/badge from `brand/`, orange interaction accent + status colors per `02-frontend-spec.md` §1.5. Deps: M0.1. **AC:** both themes legible; brand assets render; no external font fetches. **Verify:** headless screenshots both themes.
- **M0.3 · Three carrier-profile variants** — build "Dossier", "Command Console", "Verification Ledger" per `02-frontend-spec.md` §3d behind an in-mockup switcher. Deps: M0.1. **AC:** all three fully navigable with the same carrier data; visibly distinct structures. **Verify:** screenshots of all three, both themes.
- **M0.4 · Publish + iterate to sign-off** — republish same Artifact URL; walkthrough message to Hunter; apply his notes in short cycles; record the chosen profile variant + any spec amendments in `03-feedback-resolution.md` §"Round 2". Deps: M0.1–3. **AC:** Hunter's explicit sign-off message. **Verify:** sign-off quoted in the round-2 log.

### M1 — Foundations

- **M1.1 · Monorepo scaffold** — create `app/` (Vite+React+TS+Tailwind v4, tokens/fonts/router/guards skeleton per `02-frontend-spec.md` §1), `pipeline/` (Node 22 TS script skeleton per `01-architecture.md` pipeline §6.1), `supabase/` (config + empty migration shells named per `01-architecture.md` §1), `.github/workflows/ci.yml` (typecheck+lint+test+build for app and pipeline), `render.yaml` (static site + one cron service), root README dev-setup. Deps: none. **AC:** fresh clone → `npm i && npm run check` green in both packages; CI green on push. **Verify:** CI run link.
- **M1.2 · Database v2 live** — write all migrations exactly per `01-architecture.md` §2 (extensions→enums→profiles→carriers→facets→batches→contact→activity→warnings→matcher→RPCs→RLS→realtime), plus `seed.sql` + `scripts/seed-auth-users.ts` (§8). Apply to dev project; generate `app/src/types/database.ts`. Deps: M1.1 + Supabase prereq. **AC:** `supabase db reset` clean; seed produces the §8 invariants (multi-lane batch, cross-batch carrier, DNC case, warning cases); `supabase db diff` empty; typegen committed. **Verify:** psql spot-queries listed in `05-verification.md` §3.1.
- **M1.3 · Deploy skeleton** — Render static site serving the app shell (login page stub OK) on the dev Supabase; cron service deployed running a no-op `pipeline` entry that writes a `pipeline_runs` heartbeat row. Deps: M1.1, M1.2, Render prereq. **AC:** public URL loads; heartbeat row appears nightly (or on manual trigger). **Verify:** URL + row timestamp.

**M1 gate (automated):** CI green · db reset clean · deployed shell reachable.

### M2 — Data pipeline — GATE: data-QA review with owner

- **M2.0 · Runtime verification spike (FIRST)** — run the pipeline spec's probes R1–R7 (`01-architecture.md` pipeline §7) against live Socrata/Census services: confirm officer/mailing/cargo column spellings (`crgo_motoveh` vs `crgo_motorveh`), value domains (`carrier_operation`, `classdef`), TX row volume, L&I `$select` behavior, Census-geocoder batch behavior. Record findings in an addendum block inside `01-architecture.md`; adjust field mappings if reality differs. Deps: M1.2, Socrata token. **AC:** every ⚠️R item resolved with evidence (sample rows). **Verify:** addendum committed.
- **M2.1 · sync-census** — TX slice full pull → staging COPY → row-hash diff upsert → `first_seen_at`/`last_changed_at`/`source_missing_since` semantics; `pipeline_runs` logging + failure email + non-zero exit. Spec: pipeline §2.1–2.3, §2.5. Deps: M2.0. **AC:** two consecutive runs: first ingests all, second writes only changed rows (~1–3%); missing-DOT pass works on a synthetic removal. **Verify:** `pipeline_runs` rows + count queries.
- **M2.2 · sync-authority + sync-insurance** — L&I pulls, BIPD rollup to per-carrier current state (`bipd_on_file_usd`, cancel dates), warning inputs land. Spec: pipeline §2.4. Deps: M2.1. **AC:** known-carrier spot checks match SAFER/L&I web values (5 carriers hand-verified). **Verify:** documented spot-check table.
- **M2.3 · sync-safety (monthly)** — SMS snapshot ingest, OOS rates, thresholds in `pipeline_config`. Deps: M2.1. **AC:** rates within sane bounds; thresholds configurable. **Verify:** distribution query.
- **M2.4 · cargo-facets** — normalization (§3.1) + `cargo_other_values` upsert with curation-preserving discipline + seed curation patterns. Deps: M2.1. **AC:** top-50 TX other-values with counts look like the expected sand/gravel vocabulary; curation columns survive re-run. **Verify:** facet query before/after second run.
- **M2.5 · geocode** — Census batch (10k chunks) + ZCTA Gazetteer fallback + city centroid last resort; precision recorded; nightly delta mode. Spec: pipeline §4. Deps: M2.1. **AC:** ≥95% of active TX carriers have geom (any tier); street-level share reported; zero paid geocoding calls. **Verify:** precision-tier histogram.
- **M2.6 · dq-report + cron wiring** — fill-rate report (phone/cell/email/officer/other-desc), data-health view, staleness watchdog; Render cron schedules per pipeline §6.3. Deps: M2.1–2.5. **AC:** nightly chain runs end-to-end on Render inside **60 min** (01 reconciliation #20); report queryable. **Verify:** one full scheduled run's `pipeline_runs` trace.
- **M2.7 · Real-data backfill + owner data-QA** — full TX-active backfill **on the prod Supabase Pro project** (01 reconciliation #13; the free dev project keeps synthetic seed only); produce the coverage brief for Hunter: TX totals, sand/gravel candidate counts (facet values), phone/email fill rates, warning distribution, 10 spot-check carriers he knows. Deps: M2.1–2.6. **AC/GATE:** Hunter reviews and confirms the data matches his market reality (this validates the product premise — treat objections as spec input, not annoyance). **Verify:** his reply logged in `03-feedback-resolution.md` round-2 log.

### M3 — App shell & auth

- **M3.1 · Auth flows** — login/register/forgot/reset/pending per `02-frontend-spec.md` §3f; remember-me storage behavior; suspended handling. Deps: M1.2, M1.3. **AC:** all five flows work on dev project against real Supabase Auth. **Verify:** E2E auth spec passes.
- **M3.2 · Users admin + approval** — pending queue, approve→role assignment, role change, suspend/restore. Deps: M3.1. **AC:** full lifecycle works; RLS blocks non-managers (negative test). **Verify:** role-matrix E2E.
- **M3.3 · Shell + brand chrome** — AppShell/Sidebar (incl. F2 reserved disabled tabs: Email Blasts, Texting, Postcards, Enrichment)/Topbar (truthful Live badge)/theme toggle/brand tokens+fonts. Deps: M3.1, M0 sign-off for final visual tokens (start with locked tokens; polish after M0.4). **AC:** matches 02 §1.5; both themes; guest gate verified. **Verify:** screenshot pair + guest E2E.

**M3 gate (automated):** role-matrix E2E green (guest sees only pending page; view is read-only; manager sees Users).

### M4 — Search & batches

- **M4.1 · MapCanvas + Google adapter** — loader, MapAdapter, numbered status pins, legend, radius/corridor/buffer overlays, multi-lane render, clustering >250, MapUnavailable fallback. Spec: 02 §2. Deps: M3.3, GCP prereq. **AC:** storybook-style dev page exercises every overlay type with fake data; zero console errors; **quota caps confirmed set before first deploy with the key**. **Verify:** dev-page screenshots + GCP console screenshot of caps.
- **M4.2 · Wizard steps 1–2** — Details (name-first, customer combobox, job); Lanes (5 anchor kinds in F12 order — **geocode-on-enter, not Autocomplete**; pin-drop mode; corridor pickup/dropoff geocode + Routes call debounced to drag-end; lane list CRUD; live count wired to `count_carriers`). Spec: 02 §3b; reconciliation notes in 01. Deps: M4.1, M2.7 data. **AC:** create 2-radius+1-corridor draft; counts change sensibly with every edit; per-lane contribution counts correct. **Verify:** E2E wizard spec + SQL cross-check of one count.
- **M4.3 · Wizard step 3 (freight)** — 30 flag checkboxes with scoped counts (`facet_cargo_flags`) + FacetBrowser (`facet_other_values`: search, suggested chips, virtualized list, include/exclude tri-state, summary bar). Deps: M4.2. **AC:** include/exclude semantics match 01 §4 exactly (exclude dominant); counts scoped per the SCOPE RULE. **Verify:** E2E + 3 hand-computed SQL comparisons.
- **M4.4 · Wizard step 4 + create** — filters (insurance threshold + keep-below-visible, size, toggles, contactability; NO safety exclusion), review summary, coverage stats, preview, `create_batch`, navigate. Deps: M4.3. **AC:** created batch's `batch_zones`/members match the live preview exactly. **Verify:** E2E + row-count equality check.
- **M4.5 · Dashboard** — stat strip, overview map (all batches' zones + numbered batch pins, hover-highlight), batch table per 02 §3a, realtime on `batches`. Deps: M4.4. **AC:** F4 behaviors: row click navigates; map/legend click navigates; tiles deleted. **Verify:** E2E dashboard spec.
- **M4.6 · Refresh** — `refresh_batch` wiring + toast + activity row + "+N since snapshot" surfacing. Deps: M4.4. **AC:** add-only semantics proven (delete a member's matching attribute upstream → member remains; new matching carrier → added with `added_via_refresh`). **Verify:** scripted scenario on dev data.

**M4 gate:** E2E: multi-lane batch created on staging real data; `count_carriers` result equals `batch_carriers` count equals a hand-run SQL of the matcher.

### M5 — Working list & CRM

- **M5.1 · Batch page frame** — header (name/customer/job/lane chips), ActivityFeed (auto+comments, infinite, realtime), StatStrip, status chips with counts, toolbar (search, insurance, size, contactability, warnings-only, sort, List⇄Map). Spec: 02 §3c. Deps: M4.4. **AC:** all filters drive `batch_members` server-side; URL-synced. **Verify:** E2E filter matrix.
- **M5.2 · Members table** — server-paginated + virtualized; columns per 02 §3c-6 incl. contact name/phone/email, #, warnings wash+chips, StatusSelect w/ DNC escape, last-contact summary, split Log button (Call/Text/Email). Deps: M5.1. **AC:** smooth at 5,000 members (perf budget 05 §5); view-role renders read-only. **Verify:** perf run + role E2E.
- **M5.3 · Map view** — slim-pin fetch, numbered pins matching current list order, lane overlays, legend with per-status counts, pin→profile. Deps: M5.1, M4.1. **AC:** list # and map # agree under every sort/filter. **Verify:** E2E cross-reference check.
- **M5.4 · BulkBar** — selection semantics (page + select-all-matching capped 5k, DNC excluded), bulk status via `bulk_set_status`, single activity row. Deps: M5.2. **AC:** 1,000-row bulk update < 3s, one feed entry. **Verify:** timed E2E.
- **M5.5 · Contact sheet** — modal preview (name+email columns, DNC-excluded note, warnings visible), print route with clean print CSS, CSV export per 02 §3e. Deps: M5.4. **AC:** `generate_contact_sheet` is the single source; DNC hard-exclusion proven; print renders monochrome one-row-per-carrier with notes line. **Verify:** E2E + print-to-PDF artifact reviewed.
- **M5.6 · Carrier profile (chosen variant)** — implement the M0-selected variant with the shared content model: identity header (General+Overview absorbed), verification tiles, contact panel, 3-channel LogContactModal (channel-specific dispositions), unified timeline w/ channel filter, memberships w/ inline per-batch status, research quick-links, Mark as Promoted, global DNC. Deps: M5.1, M0.4. **AC:** every F7/F8/F15/F18/F23 behavior present; cross-batch timeline invariant demonstrated. **Verify:** E2E profile spec.
- **M5.7 · Realtime polish** — coalesced invalidations, two-session status-change propagation ≤ ~1s, truthful Live badge states. Deps: M5.2. **AC:** two-browser demo recorded. **Verify:** dual-context Playwright test.
- **M5.8 · Inspections on-demand fetch** — Supabase Edge Function `qc-fetch` (WebKey secret server-side) → QCMobile inspections/crashes → 24h cache (`carrier_qc_snapshots` → `carrier_inspections`) → Inspections verification tile populates on profile view; fetching/empty/error states. Spec: 01 reconciliation #16. Deps: M5.6 + WebKey prereq. **AC:** a real carrier's tile fills within one profile visit; second visit inside 24h hits cache (no API call); WebKey absent → graceful empty state, launch unaffected. **Verify:** E2E with stubbed function + one manual staging fetch.

**M5 gate:** full CRM E2E (wizard→batch→work list→log 3 channels→bulk→sheet→profile→promote→DNC) green on staging **+ the stubbed-map E2E subset (05 §4.15) + one manual staging map pass**.

### M6 — Hardening & launch — GATE: owner UAT

- **M6.1 · E2E suite in CI** — Playwright suite (successor to `mockup/verify.js`) covering the 05 §4 catalog, running against a seeded ephemeral dev db in CI. **AC:** suite green twice consecutively; runtime < 10 min.
- **M6.2 · RLS negative tests** — scripted role fixtures attempt every forbidden operation (05 §3.2 matrix). **AC:** all denied; failures readable.
- **M6.3 · Performance pass** — budgets in 05 §5 (5k-member page, count RPC latency, map pins, wizard debounce behavior). **AC:** all budgets met on staging data.
- **M6.4 · Observability & states** — Sentry (free tier, sampled), every screen's loading/empty/error states audited against 02. **AC:** error-state audit checklist complete; a thrown test error appears in Sentry.
- **M6.5 · Cost guardrails live** — GCP quota caps + budget alerts, Supabase spend cap ON + disk alert, Render cron-runtime alert, key referrer locks. Spec: 04 §7. **AC:** screenshots/console evidence of each control, filed in the runbook.
- **M6.6 · Production cutover** — prod data verified/topped-up (backfill already ran in M2.7 per reconciliation #13), `recruit.twistednail.com` DNS, real user invites (manager: Hunter; his 4 teammates per his role assignments), runbook (`docs/runbook.md`: deploys, sync failures, restore-from-backup, key rotation) + 1-page user guide. **AC:** Hunter + team logged in on production; one real batch created together during UAT.

**M6 gate:** Hunter UAT session on production real data → explicit launch approval. **LAUNCH.**

### M7 — Email module (fast-follow, D2)

M7.1 schema migration set (`campaigns`, `campaign_recipients`, `esp_events`) wired to `contact_suppressions`/`is_contactable` · M7.2 Resend integration (subdomain verified, webhook ingest → bounces/complaints become suppressions + timeline entries) · M7.3 compose/audience UI from batch selection (has-email + not-suppressed enforced server-side; CAN-SPAM footer with physical address + unsubscribe; test-send to self) · M7.4 send queue drained by cron with per-day ceiling + warm-up ramp config · M7.5 campaign report (delivered/opened/replied) + timeline entries per recipient (G6). **Gate:** deliverability checklist (05 §7) + Hunter approves the first live campaign's audience + copy. Spec anchors: 01 (suppression substrate), 04 §1 (Resend), D2.

### M8 — Enrichment (planned, unscheduled)

Places IDs-only search → Details (website/rating/phone) throttled ≤1,000/mo inside free tier; match-confidence UI (auto-attach only high-confidence, else suggest); officer-name cross-ref; enrichment fields feed contactability. Costed in 04 Table C. Starts only on Hunter's go.

### M9+ — SMS (Twilio; TCPA counsel review first) · Postcards — outline only, revisit after M7 results.

## 5. Risk register

| Risk | Mitigation |
|---|---|
| Census column names/domains differ from spec | M2.0 probes FIRST; mappings adjusted before dependent tasks |
| Facet/matcher SQL performance on other-desc | trgm + GiST indexes specced; M4 gate includes SQL cross-checks; 05 §5 budgets |
| Geocode street-match rate lower than expected | Tiered fallback is acceptable per discovery §5; report precision honestly (G10) |
| Google SKU misuse creeps cost | NO Autocomplete (reconciliation); drag-end debounced Routes; hard quota caps before key ships (M4.1 AC) |
| Realtime volume / flood | carriers excluded from publication; coalesced invalidation; D8 |
| RLS recursion/bypass bugs | SECURITY DEFINER helpers per 01 §6; M6.2 negative matrix is a launch gate |
| Email deliverability damage | D2 architecture; warm-up ramp; ceiling; suppression enforcement server-side; Hunter approves first campaign |
| Owner-gate latency stalls the line | M0/M2.7/M6 are the only owner gates; parallel tracks keep workers busy while waiting |
| Scope drift from new feedback | All new feedback lands in `03-feedback-resolution.md` as a new round with F-numbers before implementation |

## 6. Change control

- Every future owner-feedback round gets itemized (F25+…) in `03-feedback-resolution.md` with resolutions before code changes.
- Schema changes = new migration + update to 01; never edit shipped migrations.
- The reconciliation section in 01 is the single arbiter of cross-doc conflicts; amend it explicitly.
