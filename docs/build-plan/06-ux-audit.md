# 06 — Independent expert UI/UX audit (round 5) + honest status sweep

**Produced 2026-07-20** by a multi-agent audit workflow: six expert lenses (visual/brand
conformance, interaction, accessibility/WCAG, information architecture & domain fit, responsive/
mobile, data-density at scale) each audited the committed mockup (v6.1) and its rendered
screenshots, then **every finding was adversarially re-verified against the actual source** before
it counted. **49 findings survived verification.** This is the first independent design review —
prior rounds were owner feedback + my own headless functional checks (which prove it *works*, not
that it's *well-designed*).

Findings cite `file:line` or a screenshot. Severity: **high** = hurts the core calling job or
violates a locked guideline on a key surface · **medium** = real friction · **low** = polish.

---

## 1. Honest project status (what's real vs. what's a shell)

| Milestone | Status | Reality |
|---|---|---|
| **M0** Design | 🟡 partial | Mockup iterated v1→v6 through 4 feedback rounds, headless-verified each time. Big picks made (Command Console profile, Columns New Search, TNBS navy/light system). **Not formally closed:** no explicit final sign-off; 2 decisions still open. |
| **M1** Foundations | 🟡 partial | Monorepo scaffold is real and typechecks clean (app + pipeline + 14 migrations + seed + CI + render.yaml). **But:** `types/database.ts` is a hand-written placeholder, and **nothing has run against a live database.** Blocked on Supabase + Render. |
| **M2** Data pipeline | 🟡 partial | ~3,000 lines of real pipeline code, typechecking. **But nothing has touched live data** — the sandbox proxy 403s the FMCSA/Socrata hosts, so column names for L&I/safety are still unverified. Blocked on Socrata token + prod Supabase. |
| **M3** Shell & auth | 🟡 partial | Auth flow code is real (login/register/reset/pending + shell + guards). **But** unrun (no live Supabase Auth), Users-admin is a 16-line stub, and the app's tokens still carry the **old orange + dark-mode** palette (see §8). |
| **M4** Search & batches | 🔴 not started | Every screen is a "Stub screen" placeholder. RPC wrappers + matcher SQL exist; no map, no builder, no facet browser wired. Also needs Google Maps key. |
| **M5** Working list & CRM | 🔴 not started | All stubs. No members table, bulk bar, contact sheet, Command Console, or logging UI wired. |
| **M6** Hardening & launch | 🔴 not started | No E2E suite, no Sentry, no cutover. |
| **M7** Email · **M8** Enrich · **M9** SMS/Postcards | 🔴 not started | By design — later phases. |

**The single biggest unblock is Supabase + Render + a Socrata token** (the setup guide covers
these) — almost everything downstream is gated on them.

---

## 2. The six themes

1. **The warning/status signal is applied inconsistently — flooded where it shouldn't be, absent
   where it must be.** KPI numbers painted permanent green/red (even at 0); the pale-red warning
   wash covers 26 of 29 rows (hiding the navy selection fill, flattening real DNC rows against
   routine "Conditional rating" ones); the profile hero fully floods red so a routine warning
   reads as "this carrier is bad." Yet the warning signal is **missing from the printed Contact
   sheet** (the one thing the team calls from) and from the batch-map legend.
2. **Accessibility falls below the tool's own WCAG-AA and 44px targets.** The core status pills and
   the grey USDOT/label text fail contrast; modals/menus/search aren't keyboard- or
   screen-reader-operable; row controls have no accessible names. Most fixes are cheap (token/
   attribute level).
3. **Nothing is built for real data scale.** The working table renders every row and rebuilds on
   each keystroke; maps plot one pin each with no clustering; lists render unbounded; there's no
   "showing N of M" count. Real blockers once you have thousands of carriers.
4. **The calling surface loses cross-record context.** The working row — where calls actually
   happen — is the thinnest view: it shows only per-batch status, so a recruiter can't see a
   carrier was already contacted in another batch and re-cold-calls them. Promoted status is
   computed then thrown away; DNC captures no reason; there's no persistent per-carrier note.
5. **The New Search builder has dead / self-contradicting controls.** With zero lanes it shows a
   meaningless statewide count and an enabled "Grab" that only errors; while editing a lane the
   map count and footer count disagree; Cancel wipes a whole multi-lane search with no confirm.
6. **The tool breaks on a phone.** Below 760px the only navigation (sidebar) simply disappears with
   no drawer; the Command Console never reflows (vet column crushed to ~4px); triage controls stay
   17–28px.

---

## 3. High-severity findings (must-fix)

1. **Warnings dropped from the Generate Contact Options sheet** — the printed/CSV sheet shows only
   Carrier/Contact/Phone/Email/Status; a recruiter cold-calls a carrier with no idea it has "No
   insurance + Conditional rating." Violates locked G5/F15 which name "sheets" verbatim.
   *Fix: add a Warnings column + pale-red wash to the modal, print view, and CSV.* (`screens2.js:298`)
2. **Quick-log (call/text/email) is in the off-screen rightmost column** — the most-repeated
   action requires horizontal scroll on a laptop. *Fix: pin the actions + status columns sticky.*
   (`screens2.js:114`, `styles.css:286`)
3. **New Search shows a statewide count + an enabled "Grab Batch — N" that just errors** before any
   lane exists. *Fix: disable Grab and show "Add a lane to see matches" until lanes ≥ 1.*
   (`main.js:97`, `screens.js:329`)
4. **Working list has no pagination/virtualization** and rebuilds every row on each keystroke.
   *Fix: window to 50–100 rows + "Showing 1–50 of N", patch only tbody, debounce input.*
   (`screens2.js:104`, `main.js:27`)
5. **Core status pills + grey meta text fail AA contrast** — warn/attempted (4.06:1), Not-a-Fit
   (2.75:1), Interested (4.33:1), and `--text-subtle #86909e` (3.2:1) all below 4.5:1. *Fix:
   darken those inks + the token to ≈#68717d.* (`styles.css:18,42-50`)
6. **No cross-batch awareness or dedupe** — the row and contact sheet hide a carrier's status/
   history in other batches → guaranteed duplicate cold calls. *Fix: surface a carrier-global
   signal on the row ("also in 2 batches / contacted 6d ago") and dedupe on the sheet.*
7. **The 760px breakpoint strips function instead of adapting** — sidebar becomes `display:none`
   with no drawer; Command Console never reflows; controls stay sub-44px. *Fix: off-canvas nav
   drawer + `.console-grid{grid-template-columns:1fr}` + 44px targets under the phone query.*

*(Two more high-severity items — the a11y contrast pair and the mobile trio — are folded into the
above; the raw list carries them separately.)*

---

## 4. Medium findings (real friction)

- Closed status color leaks into decoration (KPI green/red rainbow; row wash floods; hero floods).
- Modals/popup-menus/global-search combobox are not keyboard/screen-reader operable (no focus
  trap, roles, focus move; Escape doesn't close the search popover).
- Row controls (checkboxes, status selects, cargo switch) have **no accessible names**.
- Focus indicator on checkboxes/switches composites to ~1.8:1 (below the 3:1 for focus).
- Builder live-count contradicts itself while a lane is being edited; Grab ignores an in-progress lane.
- "Cancel" beside "Grab" discards a multi-lane search with no confirm/draft.
- No callback-time input (log modal hardcodes `callback_at:null`) — *note: a "callbacks-due queue"
  would contradict the locked §16 "list, not a queue" decision; capturing the time is fine, a
  reminder queue is a separate owner call.*
- DNC set with no reason captured, though `dnc_reason/by/at` exist in the schema + seed.
- No persistent per-carrier note / best-time-to-reach (context trapped inside individual logs).
- Batch-map warning rings unlabeled (legend omits the "warning flag" key the New Search map has).
- Bulk bar overflows off-screen on a phone; map heights hard-coded (a 560px map swallows the phone);
  global search hidden on mobile with no fallback.

## 5. Low findings (polish)

Profile hero flooded red; phone numbers wrap mid-number on the contact sheet; reject-user is
one unconfirmed click (Approve gets a modal); no dashboard empty state; bulk bar overlays the last
rows and is missing Attempted/Not-a-Fit/DNC; New Search keeps banned title subtext; Grab/Refresh
give no in-progress feedback; batch name optional + silently auto-generated; maps have no touch
handlers (mitigated — production uses Google Maps); tap targets below spec's 44px.

---

## 6. Low-hanging fruit — safe S-effort wins (mockup, spec-aligned)

These are small, unambiguous, and align with the locked design system — good to apply now while
provisioning is underway:

- [ ] Warnings column + wash on the contact sheet / print / CSV (**highest value single fix**).
- [ ] Darken the 3 failing status inks + `--text-subtle`→≈#68717d to clear AA 4.5:1.
- [ ] Disable "Grab Batch" + "Add a lane to see matches" until lanes ≥ 1.
- [ ] Make the builder footer count + Grab use the same zone set as the map (fix the contradiction).
- [ ] Drop the `good`/`crit` args from KPI `stat()` calls → KPI numbers render in `--text`.
- [ ] Confirm before Cancel discards a wizard with lanes; add friction to Reject-user.
- [ ] `white-space:nowrap` on `.mono` phone/USDOT cells.
- [ ] `aria-label`s on row checkboxes/select-all, status selects, cargo switch.
- [ ] Opaque 2px navy focus ring on checkboxes/switches (clears 3:1).
- [ ] "Has a warning flag" swatch in the batch-map legend; fix the New Search swatch to a ringed dot.
- [ ] "Promoted" badge on rows where `effPromoted` is set (already computed).
- [ ] Capture a DNC reason in the DNC modal → store/show `dnc_reason/by/at`.
- [ ] Require a batch name before Grab; delete the New Search page subtext.
- [ ] Dashboard empty state; bulk bar `flex-wrap` + body padding + Attempted/Not-a-Fit/DNC actions.
- [ ] Surface the builder-map 400-pin truncation ("showing 400 of N"); clamp map heights under 760px.
- [ ] `.console-grid{grid-template-columns:1fr}` below 760px (stops the vet screen crushing).
- [ ] App tokens: swap the pre-lock **orange → navy #1e3a6e**; drop the weight-900 @font-face;
      remove dead `state.overrides.newBatches`; delete/re-run stale dark-mode screenshots.
- [ ] Ellipsis-truncate the working-table carrier/contact cells; cap the activity feed with "load older".

## 7. Structural — bake into the real build (M4/M5), not the mockup

- List virtualization + "showing N of M" + server-side pagination (the whole point of F5/G3).
- Off-canvas mobile nav drawer + a real 44px-target phone pass.
- Cross-batch awareness on the row + dedupe on the contact sheet (uses the M:N model already in schema).
- Full keyboard/screen-reader semantics for modals, menus, and the global-search combobox.
- Persistent per-carrier note field; callback-time capture.
- Map clustering (Google Maps provides it — a config, not a build).

## 8. Design-system drift (found by the status sweep — worth fixing before M3 chrome)

The design system locked **navy-only, light-only** on 2026-07-18 — one day *after* the app scaffold
and `02-frontend-spec.md` were written in the **old "hi-vis orange + dark mode"** direction. Only
the *mockup* was brought forward. So today:
- `app/src/theme/tokens.css` still ships orange `#e8611d` + a full dark-mode implementation +
  ThemeProvider dark toggle.
- `02-frontend-spec.md` §1.5 still says "orange interaction accent" and documents dark mode.

Both silently contradict the canonical `tnbs-design-system.md`. **This needs a deliberate
reconciliation pass before M3 builds chrome on top of it** — not just a hex swap (there's live
dark-mode plumbing to remove).

## 9. Owner decisions this surfaced (still open)

1. **Final M0 sign-off** on mockup v6 (the loop is still live).
2. **Material field**: free-text per-lane label vs. a structured, filterable field. (Open since round 1.)
3. **Contact-sheet CSV export**: keep or cut.
4. **The warning row-wash**: your F15 intent was "warn, don't hide" everywhere — but at 26/29 rows
   the pale-red floods and hides the selection highlight. Keep the full wash, or reserve it for
   DNC/critical and let ordinary warnings ride the ⚠ chips? (Design judgment call — yours.)

---

*Full raw findings (all 49, with per-finding verification notes) preserved in the workflow
transcript. This doc is the curated, build-facing version.*
