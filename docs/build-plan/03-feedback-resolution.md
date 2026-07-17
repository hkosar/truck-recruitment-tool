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

### Owner decisions recorded this round (asked & answered)

- **Maps: Google Maps Platform** (over open-source stack) — accepted with the billing-account prerequisite and hard quota caps.
- **Email module: fast-follow after launch** (over launch-blocking or unscheduled) — with subdomain/ESP warm-up starting during the main build.

## Round 2 — (reserved)

M0.4 outcomes land here: chosen profile variant, mockup-v2 amendments, M2.7 data-QA
verdict, and any new F-items (F25+).
