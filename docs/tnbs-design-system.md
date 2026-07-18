# TNBS Design System — portable spec v1.0

**Locked 2026-07-18 by Hunter Kosar** through three approved design rounds.
This document is self-contained: paste it into any TNBS app's repo (or hand it to any developer
or coding agent) to reproduce the house look exactly. The canonical copy lives with the sales
platform; if this copy and that one ever disagree, the platform's copy wins.

---

## 1. Brand foundation

- **Typeface: Montserrat** — the only brand font. Weights used: 400 (body), 500, 600 (emphasis /
  buttons), 700 (headings), 800 (page titles, KPI numbers). Self-host the TTF/WOFF2 files; never
  load from a font CDN. Fallback stack: `"Montserrat", "Segoe UI", system-ui, sans-serif`.
- **Logo: the Twisted Nail badge** (circular "twisted-nail T" mark). Use the **white badge on the
  navy top bar**; the black badge on white/light surfaces. Never recolor, outline, or add effects
  to the mark.
- **The brand is black-and-white at heart** — the app dresses it in exactly **one accent: navy**
  (the company hat color). Resist adding more accent colors; restraint is the identity.
- Theme: **light only**. No dark mode (deliberate decision; revisit only as a formal project).

## 2. Color tokens (copy-paste)

```css
:root {
  /* Brand accent — the ONLY accent. Buttons, active nav, selected rows, links, focus rings. */
  --tnbs-navy:        #1e3a6e;
  --tnbs-navy-ink:    #ffffff;   /* text/icons on navy */
  --tnbs-bar:         #1a3560;   /* the top bar (app chrome) */
  --tnbs-bar-line:    #14294c;   /* border under the bar */

  /* Surfaces — cool slate, light */
  --tnbs-page:        #eef1f5;   /* app background */
  --tnbs-surface:     #ffffff;   /* cards, tables, panels */
  --tnbs-border:      #dde3ea;
  --tnbs-border-strong:#c4ccd6;  /* buttons, inputs */
  --tnbs-zebra:       #f6f9fc;   /* even table rows */
  --tnbs-row-line:    #e8edf3;   /* row separators */
  --tnbs-row-hover:   #eef3f9;
  --tnbs-selected:    #e6eefb;   /* selected row fill (+ 3px inset navy bar on first cell) */
  --tnbs-th-bg:       #eef2f7;   /* table header background */

  /* Text */
  --tnbs-text:        #1c2530;   /* primary */
  --tnbs-text-2:      #52606e;   /* secondary */
  --tnbs-text-3:      #86909e;   /* muted / labels */

  /* Status — reserved for state ONLY; never decoration, never a series/module color.
     Always pill = tinted fill + dark ink of the same hue, always with a text label. */
  --tnbs-ok:    #15803d;  --tnbs-ok-bg:    #e6f1ea;
  --tnbs-warn:  #b45c0c;  --tnbs-warn-bg:  #f7eeda;
  --tnbs-bad:   #a4262c;  --tnbs-bad-bg:   #f6e7e8;
  --tnbs-info:  #1e3a6e;  --tnbs-info-bg:  #e6ecf7;

  /* Module/category identity colors (e.g. product verticals). Validated colorblind-safe
     as a set (2026-07-18). Assign in fixed order; NEVER color-alone — always beside a label. */
  --tnbs-cat-1: #6a5ca8;   /* e.g. Permits */
  --tnbs-cat-2: #08949e;   /* e.g. Bids */
  --tnbs-cat-3: #b5701c;   /* e.g. Energy */

  /* Geometry — tight, technical ("Blueprint") */
  --tnbs-r-card: 5px;      /* cards, tables, panels */
  --tnbs-r-el:   3px;      /* buttons, inputs, small elements */
  /* Shadows: none or nearly none (0 1px 2px rgba(28,37,48,.06) max). Borders do the work. */
}
```

## 3. Typography & density rules

| Role | Spec |
|------|------|
| Page title | 20px / 800 / letter-spacing −0.02em |
| Section/panel label | 11px / 800 / UPPERCASE / letter-spacing +0.07–0.09em / `--tnbs-text-3` |
| Table header | 10.5px / 800 / UPPERCASE / +0.07em / `--tnbs-th-bg` background |
| Table body | 13px; row vertical padding ≈ 9px (compact — this density is a signature) |
| Body copy | 13–14px / 400–600 |
| KPI numbers | 25–32px / 800 / −0.02em |
| All numeric columns & KPIs | `font-variant-numeric: tabular-nums` |

- Buttons: 12.5px/700, radius `--tnbs-r-el`; primary = navy fill + white text; secondary = white
  fill + `--tnbs-border-strong` border. No gradients, no shadows on buttons.
- Zebra-stripe all data tables (`--tnbs-zebra` on even rows); hover `--tnbs-row-hover`; selection
  `--tnbs-selected` **plus** a 3px inset navy bar on the row's first cell.
- Links and row actions: navy, 700 weight, no underline at rest.

## 4. Component conventions

- **Status pill:** rounded-full, 11px/700, tinted background + same-hue dark ink, always with a
  text label and (where established) a glyph: ✓ ok · ⚑ needs attention · ⚠ warning. Sanctioned
  glyphs only (✓ ⚠ ⚑ ★ and icon glyphs paired with labels); **no decorative emoji anywhere**.
- **Score badge:** 0–100 in a small rounded square, 800 weight, tier-tinted: high = ok colors,
  mid = warn colors, low = neutral gray. A score is **never shown without an available
  plain-language "why"** (reasons list or tooltip).
- **Category tag:** 8px color square + UPPERCASE 10.5px label in `--tnbs-text-2` (identity is
  carried by square + word together, never color alone).
- **Stat tile:** surface card, uppercase label (`--tnbs-text-3`), big tabular number, small
  delta/context line; optional 3px navy accent bar or left edge for "attention" tiles.
- **App chrome:** navy top bar (56px): white badge + wordmark left, primary nav as text tabs
  (active = 14% white overlay), global search, avatar right. Workspace/secondary nav: light
  sidebar (~216px), active item = 11% navy tint + 800 weight.
- **Money/estimates:** always labeled *directional, not a forecast* where derived.

## 5. Do / don't

**Do:** let borders and zebra do the structure (not shadows) · keep one accent (navy) ·
uppercase micro-labels with letter-spacing · compact rows · tabular numerals · visible keyboard
focus (2px navy outline, 2px offset) · 44px minimum tap targets on phone layouts · one
responsive breakpoint at 760px (sidebar collapses, tables scroll inside their own container).

**Don't:** introduce new accent hues (status ≠ accent ≠ category — three separate, closed
systems) · use color as the only signal for anything · use purple/pastel SaaS styling, gradients,
or `rounded-lg`-everywhere softness · use decorative emoji · show a score without a "why" ·
load fonts from CDNs.

---

*Provenance: distilled from the approved platform mockups (2026-07-18), the Twisted Nail brand
kit (Oct 2022 — badge + Montserrat), and the strongest conventions of the three predecessor tools
(`UI_STANDARDS.md` discipline from the bid pipeline; phone-first triage rules from the permits
tool). Category triple + status set validated for color-vision deficiency as documented in the
consolidation plan.*

---

## Appendix — how the Carrier Recruiter applies this spec (2026-07-18)

Recorded when the recruiter mockup adopted the system (v6). App-specific mappings, all
owner-approved unless noted:

- **Chrome mapping (owner pick):** navy bar carries badge + wordmark, global search
  (carriers/batches/USDOT), Live pill, avatar. Primary nav stays in the light sidebar
  (Dashboard, New Search, Outreach "soon" modules, Users) — the bar's text-tab slot is
  reserved for cross-tool navigation when more TNBS tools ship.
- **Category colors → lane identity** (agent judgment call, flagged for veto): cat-1/2/3
  color lane A/B/C zones on maps, lane chips, and legends — always beside the lane letter
  and material label. Cycles at >3 lanes.
- **Status mapping:** New = neutral slate · Attempted = warn · Contacted = info ·
  Interested = ok · Not a fit = neutral gray · DNC / warning rows = bad (pale `--tnbs-bad-bg`
  row fill — carriers are warned, never hidden).
- **Mono exception:** USDOT numbers and phone numbers keep a monospace face as data
  identifiers (predecessor-tool convention); all counts/KPIs are Montserrat tabular.
- Dark mode fully removed; insurance money values are real FMCSA filings, so no
  "directional" label is required.
