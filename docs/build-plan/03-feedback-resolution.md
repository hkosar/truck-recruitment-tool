# Feedback Resolution Log — the contract with the owner

Every piece of owner feedback is itemized here with (a) the **specific fix**, (b) the
**generalized tool-wide principle** extracted from it so the same note never has to be
given twice, and (c) **where it lands** in the specs and milestones. New feedback rounds
append below with fresh F-numbers **before** any implementation.

## Generalized principles (applied tool-wide)

| G# | Principle | Extracted from |
|----|-----------|----------------|
| G1 | Real interactive maps everywhere — Google-style basemap, zoom/pan/fullscreen, live-updating overlays; elevate map presentation even where rarely used | F6, F13 |
| G2 | Tables/lists over tile grids for enumerable data; an overview map sits above the list on dashboards | F4 |
| G3 | Scale-ready lists: server-side filter/sort/paginate + virtualization; assume hundreds–thousands of rows | F5 |
| G4 | Contactability is first-class: name/phone/email surfaced on every carrier view, filterable, driving exclusions | F9, F16, F17 |
| G5 | Warn, don't exclude, on subjective quality signals; pale-red highlighting propagates to EVERY rendering of the carrier (rows, profile, sheets, pins) | F15 |
| G6 | Multi-channel contact logging (call/text/email; mail reserved) in one unified per-carrier timeline | F8, F10 |
| G7 | Activity transparency: auto-logged events + manual comments on shared workspaces | F11 |
| G8 | Data-driven filter UX: show real value distributions with counts (facets), not abstract toggles | F14 |
| G9 | A batch is a business object: name, customer, job, N geographic lanes | F20, F21 |
| G10 | Show honest data coverage (match counts, fill rates, precision tiers) so users trust the list | F14, F16 |

## Round 1 — 2026-07-17 (`Recruiting_tool_feedback.docx` + brand assets + existing-tool screenshot)

| F# | Owner's feedback (condensed) | Resolution | Lands in |
|----|------------------------------|------------|----------|
| F1 | Users tab looks good | Kept as-is (auth + approval flow unchanged) | 02 §3f · M3.1–3.2 |
| F2 | Reserved tabs for the future tools, even if inert | Sidebar shows Email Blasts / Texting / Postcards / Enrichment as visible, disabled "coming soon" entries | 02 §3f · M3.3 |
| F3 | Rename Batches → Dashboard | Renamed across nav, routes, copy | 02 §1.2, §3a · M4.5 |
| F4 | Map of active batches on top, list below; kill the tile grid; row click → batch page | Dashboard = overview map (all batches' lanes + numbered batch pins + legend) above a batch **table**; tiles deleted | 01 `batch_dashboard` view · 02 §3a · M4.5 |
| F5 | Hundreds→thousands of carriers per search | Server-side pagination/sort/filter RPCs + virtualized rows + debounced counts; perf budgets | 01 §5.5 · 02 §4 · 05 §5 · M5.2 |
| F6 | Maps must be real: Google overlay, zoom, pan | Google Maps JS on every map surface (locked D1); interactive controls everywhere | 02 §2 · M4.1 |
| F7 | Profile deserves major effort; show 3 unique designs; General/Overview feed the title area; Insurance/Safety/Inspections as verification tiles | Shared content model (identity header absorbs General+Overview; verification-style tiles) + **three named variants** — Dossier / Command Console / Verification Ledger — built in mockup M0 for his pick, then implemented | 02 §3d · M0.3, M5.6 |
| F8 | Log call, text, AND email | `contact_logs.channel` enum + channel-specific dispositions + split Log button; one unified timeline | 01 §2.7 · 02 §3c/3d · M5.2, M5.6 |
| F9 | Sheet: add contact name + email; keep print/CSV; drop Copy-USDOT | `generate_contact_sheet` returns contact_name + email; USDOT-copy removed everywhere; print + CSV kept | 01 §5.5 · 02 §3e · M5.5 |
| F10 | Auto-email job offers; "rotating email" to protect the domain | Email module = fast-follow **M7** (owner decision D2). Legitimate deliverability architecture: dedicated `offers.` subdomain + Resend + SPF/DKIM/DMARC + warm-up + throttle + suppression synced to global DNC + CAN-SPAM. Deceptive rotation explicitly rejected — it would burn the brand and mailbox providers treat it as spam behavior | 00 D2/M7 · 04 §1 email |
| F11 | Activity log atop each batch: auto + manual comments | `batch_activity` table + SECURITY DEFINER auto-log triggers (status changes, refreshes, bulk ops, promotions, DNC) + comment composer; realtime feed | 01 §2.8 · 02 §3c-2 · M5.1 |
| F12 | Anchor order: Pin, Address, City, ZIP, County | `anchor_kind` enum + segmented control in exactly that order | 01 §2.2 · 02 §3b-Step2 · M4.2 |
| F13 | Corridor = custom pickup/dropoff every time; live map | Presets deleted; pickup/dropoff geocoded per entry; Google Routes polyline + buffer band re-render live; zones passed inline to count/map RPCs during editing | 01 §4/§5.0 · 02 §2, §3b · M4.2 |
| F14 | Reinvent freight: category checkboxes (no "wide net"), Other as first-class with per-value counts, search, include/exclude | 30 plain flag checkboxes with scoped counts + **FacetBrowser** over normalized other-descriptions (search, suggested keyword chips with counts, virtualized value list, tri-state include/exclude, summary bar). "Wide net" naming deleted | 01 §2.5, §5.3 · 02 §3b-Step3 · M2.4, M4.3 |
| F15 | Drop subjective "exclude concerning safety"; highlight issues pale-red wherever the carrier appears | Filter removed. Server-side warning function + 7-code closed vocabulary (`carrier_inactive, no_insurance, insurance_below_standard, authority_not_active, safety_rating, high_oos, recent_crashes`) returned by every list RPC; pale-red wash + reason chips on rows, profile header, sheets, map pins | 01 §3 · 02 §3c/3d/3e · M5.2+ |
| F16 | Filter by has-phone / has-email | `contactability` block in the search definition + working-list filter | 01 §4 · 02 §3b-Step4, §3c-5 · M4.4, M5.1 |
| F17 | List columns: contact name, phone, email | Columns added to members table (+sheet +profile), override-coalesced from census officer fields | 01 §5.5 · 02 §3c-6 · M5.2 |
| F18 | Auto-find websites/Google Business/social; hard matching acknowledged | MVP: research quick-links card (prefilled Google/Maps/Facebook/LinkedIn/SAFER searches). Full enrichment = **M8** (Places IDs-free + throttled Details), costed in 04 Table C | 02 §3d · M5.6, M8 |
| F19 | In-batch search belongs after batch definition | Confirmed; search input lives in the batch toolbar | 02 §3c-5 · M5.1 |
| F20 | Batch name first; add Customer and Job | Wizard Step 1 = Name (first field) + Customer + Job; fields on `batches`; shown on dashboard table + batch header | 01 §2.6 · 02 §3b-Step1 · M4.2 |
| F21 | Multiple corridors/radii per batch — the "asterisk/blob" | `batch_zones` rows (N per batch, radius or corridor), UNION membership semantics in the matcher, all lanes rendered simultaneously with index chips, per-lane contribution counts | 01 §2.6, §5.0 · 02 §2, §3b-Step2 · M4.2 |
| F22 | (From screenshot) mirror existing tool: numbered colored pins + legend + list⇄map | Numbered status pins (list row # = map pin #), right-side clickable legend, list⇄map segmented control | 02 §2 · M4.1, M5.3 |
| F23 | USDOT transfer happens per-carrier AFTER a carrier asks to register | "Send to Onboarding" → **Mark as Promoted** tracking action (`promoted_at/by` + activity + timeline; undoable); no pretend integration | 01 §5.4 · 02 §3d · M5.6 |
| F24 | (From screenshot) kinship with the existing TNBS tool | Stat-counter strips, pin legend, Google-map feel, monochrome + Montserrat brand chrome | 02 §1.5, §3a/3c · M0.2, M3.3 |

### Decisions taken on the owner's behalf this round (flagged for review)

1. **D5 reframe** — the profile action is now "Mark as Promoted" (records the promotion; sends nothing). If you want zero button instead, say so in M0 review.
2. **Autocomplete → geocode-on-enter** — the wizard's Address/pickup/dropoff inputs geocode when you press Enter rather than suggesting per keystroke. Reason: Google's Places Autocomplete is a separately-billed SKU with a much smaller free tier; plain Geocoding keeps the maps bill at $0 with huge headroom (04 §1). Internally the UX difference is minor. If per-keystroke suggestions matter to you, it's a swap-in later with a small cost line.
3. **Warning vocabulary** — the 7 warning codes and their thresholds (BIPD < $1MM, OOS > ~1.5× national averages, ≥4 crashes/24mo, Conditional/Unsatisfactory rating, inactive status/authority, no insurance) are our concretization of "safety or insurance or something needs to be looked at." Thresholds are config, tunable after you see real distributions in the M2.7 data review.
4. **Facet scope rule** — the value counts shown in the Other-cargo browser are computed with your current lanes+filters applied but cargo criteria removed (otherwise selecting a value would zero every other count). Documented in 01 §5.3.
5. **Owner-gate placement** — exactly three human gates: M0.4 design sign-off, M2.7 data-QA review, M6 UAT/launch. Everything else is automated gates.
6. **Material = per-lane label** — your "material" idea (Waco job: limestone from Austin, sand from Dallas) is captured as a **user-editable label on each lane** ("Material / lane label"), shown on lane chips, the dashboard Lanes column, and the map. If material should instead be a structured batch- or lane-level field (filterable, reportable), say so at the M0.4 walkthrough — it's a small schema addition at that stage. (01 reconciliation #18)
7. **CSV export kept** — your sheet feedback ("exporting to csv, copy usdot list I don't think is useful") reads two ways; we removed USDOT-copy (you explained why) and **kept CSV**. Confirm or kill it at M0.4.
8. **Contact-name research** — the research quick-links search the company AND the officer/contact name (when on file), plus a Texas SOS business-registry search — per your "search the company and contact name… business database" note. (Full automated enrichment stays M8.)
9. **Inspections tile is fed on-demand** — QCMobile lookups (server-side key, 24h cache) populate the Inspections verification tile when a profile is opened (M5.8); needs your free FMCSA WebKey (prereq list). Until then the tile shows an honest empty state.

### Adversarial completeness pass (post-assembly)

An independent review agent re-derived coverage from your verbatim feedback and hunted
cross-document contradictions: **21 findings (1 critical, 11 major, 9 minor) — all
resolved** via the binding amendments in `01-architecture.md` § "Adversarial-review
amendments" (#7–#20) plus targeted patches here, in `00-master-plan.md`, and in
`05-verification.md`. Notables: the schema/pipeline sub-specs were unified (#7), the
warning vocabulary is now one nine-code list including "insurance expiring ≤30d"
mirroring your existing tool's counter (#8), map pins now carry warning treatment (#10),
corridor routing is pinned to the modern Routes API (#12), and the ingest scope/sizing
was corrected to TX-active ~150–220k carriers with the real-data backfill running on the
production project (#13).

### Owner decisions recorded this round (asked & answered)

- **Maps: Google Maps Platform** (over open-source stack) — accepted with the billing-account prerequisite and hard quota caps.
- **Email module: fast-follow after launch** (over launch-blocking or unscheduled) — with subdomain/ESP warm-up starting during the main build.

## Round 2 — 2026-07-18 (`Starting_with_the_tabs.docx`, on mockup v2)

New generalized principles extracted this round:

| G# | Principle | From |
|----|-----------|------|
| G11 | **Internal-operator UX bias**: dense, single-surface control panels over multi-step wizards. Our users are employees who "pilot a complicated panel" for performance; wizards/simplified flows are reserved for external-facing experiences (owner-operators). | F26 |
| G12 | **No generic page subtext.** Descriptive filler under titles trains the eye to skip it and wastes real estate — remove everywhere; a screen explains itself through its controls. | F28 |
| G13 | **No unlabeled visualizations.** Every graphic needs an interpretive key, otherwise show plain numbers/columns instead. | F31 |
| G14 | **Uniform data typography & formats**: identical font sizing within a data cell class; standardized money format `$X.X MM` / `$NNN K`; icons sit inline-left of the text they qualify. | F34–F36 |

| F# | Owner's feedback (condensed) | Resolution | Lands in |
|----|------------------------------|------------|----------|
| F25 | Reserved tabs named "Email, Text, Mail, Enrichment" | Sidebar reserved entries renamed exactly so | Mockup v3 · 02 §3f · M3.3 |
| F26 | New Search: the wizard was a wrong turn — "I actually quite liked the control panel dashboard design"; revert to the v1 single-page baseline and fold the round-1 feedback into it | **Wizard superseded.** New Search = one dense control panel: left column = Details (name/customer/job first, F20) + Lanes (multi-lane add/edit, custom corridor endpoints, material labels) + Freight (category checkboxes + Other facet browser) + Filters (incl. contactability); right = live map + count, always visible. All round-1 features retained, zero steps | Mockup v3 · 02 Round-2 amendment · M4.2–M4.4 re-scoped |
| F27 | Dashboard header tiles + content centered | Stat tiles center their label+value; dashboard content sits in a centered container | Mockup v3 · 02 amendment |
| F28 | Kill the subtext under "Dashboard" (and by principle, everywhere) | All page-title subtext removed tool-wide (G12) | Mockup v3 · every screen spec |
| F29 | Map must be a real map — zoom, pan, click a job → zoom to it; "you may need me to link you to a google map tool" | Production is already locked on Google Maps JS (D1; M4.1) with exactly these behaviors — it renders the moment the deployed app + your GCP key exist. The self-contained mockup cannot load Google tiles (its published page blocks external requests by design), so mockup v3 adds real **zoom/pan on the built-in map + click-a-job-to-zoom** and richer map detail as the closest stand-in, clearly labeled as such | Mockup v3 (interactions) · M4.1/M4.5 (real tiles) |
| F30 | Job bubbles all orange is indistinguishable — OR start the map empty with a legend of jobs the user toggles on/off (then orange is fine) | **Toggle design adopted** (owner's preferred alternative): dashboard map starts empty; legend lists jobs with checkboxes; toggling shows that job's zones/pins; accent orange stays | Mockup v3 · 02 amendment · M4.5 |
| F31 | Pipeline stacked-bar graphic is uninterpretable — show stage counts as columns | Batch table: bar removed; per-stage numeric columns (New / Att / Cont / Int / NaF) with colored headers (G13) | Mockup v3 · 02 amendment |
| F32 | Batch page: activity feed collapsible (low priority, too much real estate), placed BELOW the data headers; headers centered | Activity feed collapsed by default, moved below the (centered) stat tiles; expandable in place | Mockup v3 · 02 amendment |
| F33 | No ad-hoc vertical stacking inside table rows. Approved 2-line cells: name+USDOT, contact, location. **Warnings move to their own column, stacked vertically** (screenshot annotation) | Warning chips leave the carrier cell; dedicated "Warnings" column renders them stacked; other cells audited against the approved patterns | Mockup v3 · 02 amendment · M5.2 |
| F34 | Contact cell font sizes must match (email renders larger than phone) | Single font size for all contact-cell lines (G14) | Mockup v3 |
| F35 | Last-contact cell: icon directly left of the outcome text on one line, time below; use the column space properly | Rebuilt: `[icon] Outcome` / `time (+ callback when set)` | Mockup v3 |
| F36 | Money format: "$2M" → "**$2.0 MM**", "**$750 K**" | `fmtMoney` standardized tool-wide (badges, tiles, sheets, profile) | Mockup v3 · 02 amendment |
| F37 | Batch map view: carrier bubbles "particularly ugly"; can't zoom close enough; no map features | Pin redesign (teardrop pins in status colors, legible numbering) + the F29 zoom/pan interactions + more basemap detail (major highways/rivers) in the mockup; real tiles in production | Mockup v3 · M4.1 |

**Decisions since this round's doc:**
1. **Carrier profile = COMMAND CONSOLE** (owner, in chat, 2026-07-18). The switcher is
   removed from the mockup; M5.6 implements Command Console. Dossier/Ledger renderers
   retained in mockup source as reference only.

**Still open:**
1. Material as a free-text per-lane label vs. a structured filterable field.
2. CSV export on the contact sheet — kept for now; say the word to cut it.

**Mockup v3 shipped** (same artifact URL): F25–F37 all applied — control-panel New
Search, empty-start dashboard map with per-job toggles + click-to-zoom, interactive
zoom/pan preview maps with teardrop status pins + highway context, stage-count columns,
collapsed activity bar below centered tiles, dedicated stacked Warnings column,
uniform contact typography, `$X.X MM / $NNN K` money format, renamed reserved tabs.
Verified headless: 15 flows, 0 errors, 0 external requests.
