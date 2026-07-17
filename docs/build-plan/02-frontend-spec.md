# Frontend Spec v2 (+ brand system)

The production React app spec, screen by screen, with every Round-1 feedback item (F#)
and principle (G#) applied. RPC names herein are working aliases — canonical names and
two approved additions live in `01-architecture.md` § Contract reconciliation, which
governs. Brand: monochrome Twisted Nail chrome + Montserrat (assets in `brand/`), one
hi-vis orange interaction accent, semantic status colors (§1.5).

# Frontend Spec v2 — Twisted Nail Carrier Recruiter (production React app)

Source of truth read: `docs/discovery-brief.md`, `mockup/README.md`, `mockup/src/screens.js`, `mockup/src/styles.css`, `mockup/src/ui.js`, `mockup/src/data.js`. v1 screens (login/register/forgot/guest, dashboard cards, builder, working list, profile, users) and the v1 token set are the baseline; every delta below is tagged with the feedback item (F#) or principle (G#) that drives it.

---

## 1. App architecture

### 1.1 Stack and project layout

Vite 7 + React 19 + TypeScript 5 + Tailwind v4 (CSS-first `@theme`) + TanStack Query v5 + Zustand v5 + React Router v7 + supabase-js v2 + `@googlemaps/js-api-loader` + `@googlemaps/markerclusterer` + `@turf/buffer` + `@turf/simplify` + `@tanstack/react-virtual`. Deployed as a Render static site. New top-level `app/` directory, sibling of `mockup/` and `docs/`:

```
app/
  index.html                      # <html data-theme> bootstrap, font preloads
  package.json  vite.config.ts  tsconfig.json
  .env.example                    # VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY,
                                  # VITE_GOOGLE_MAPS_API_KEY, VITE_GOOGLE_MAPS_MAP_ID,
                                  # VITE_MAPS_PROVIDER=google|maplibre
  public/
    fonts/montserrat/*.woff2      # converted from provided TTFs (fonttools), wt 400–900
    brand/wordmark.svg  badge.svg  icon.svg   # provided monochrome assets
  src/
    main.tsx                      # providers: QueryClientProvider, Router, ThemeProvider
    app/
      router.tsx                  # route table (below)
      guards.tsx                  # RequireAuth, RequireApproved, RequireManager
      AppShell.tsx  Sidebar.tsx  Topbar.tsx
    theme/
      tokens.css                  # §1.5 — the design tokens (light+dark)
      fonts.css                   # @font-face Montserrat
      app.css                     # Tailwind entry: @import "tailwindcss"; @theme inline {...}
    lib/
      supabase.ts                 # typed createClient<Database>
      queryKeys.ts                # key catalog (§1.3)
      rpc.ts                      # typed wrappers for every RPC (§1.4)
      realtime.ts                 # channel helpers + coalesced invalidation
      format.ts                   # fmtMoney, fmtRel, fmtPhone, tabular helpers
      permissions.ts              # can() from profile.role
      warnings.ts                 # WarningCode -> label/tone map (F15)
    map/
      MapCanvas.tsx               # provider-agnostic component (§2)
      adapter.ts                  # MapAdapter interface
      google/  maplibre/          # adapter implementations
      overlays.ts                 # lane -> circle/polyline/buffer polygon builders
      markers.ts                  # numbered status pin factory (F22)
      MapLegend.tsx  MapToolbar.tsx
    components/                   # shared inventory (§5)
    features/
      auth/        Login.tsx Register.tsx Forgot.tsx Reset.tsx Pending.tsx
      users/       UsersAdmin.tsx
      dashboard/   Dashboard.tsx BatchTable.tsx OverviewMap.tsx
      batchNew/    Wizard.tsx StepDetails.tsx StepLanes.tsx StepFreight.tsx
                   StepFiltersReview.tsx LaneEditor.tsx laneDraft.ts
      batch/       BatchPage.tsx MembersTable.tsx MembersMap.tsx ActivityFeed.tsx
                   BulkBar.tsx BatchStats.tsx sheet/ContactSheet.tsx
      carrier/     CarrierProfile.tsx VerificationTiles.tsx Timeline.tsx
                   LogContactModal.tsx ResearchLinks.tsx variants/   # M0 design round (§3d)
    types/
      database.ts                 # supabase gen types output
      domain.ts                   # Lane, SearchDefinition, WarningCode, Channel, Status
```

### 1.2 Routing map (React Router v7, code-split per route via `React.lazy`)

| Path | Screen | Guard |
|---|---|---|
| `/login` `/register` `/forgot` `/reset` | Auth screens (v1 shapes kept, F1) | anon only |
| `/pending` | Guest gate landing | authed, status=pending |
| `/` | redirect → `/dashboard` | approved |
| `/dashboard` | Dashboard (F3/F4) | approved |
| `/batches/new` | New Batch wizard (F20/F21/F14) | role manager\|edit |
| `/batches/:batchId` | Batch page; `?view=list\|map&status=&q=` URL-synced (shareable) | approved |
| `/batches/:batchId/sheet` | Printable contact sheet (F9), selection via `sessionStorage["sheet:"+batchId]`, auto `window.print()` on load | approved |
| `/carriers/:dot` | Carrier profile; `?batch=<id>` carries working context | approved |
| `/users` | Users admin (F1) | manager |
| `*` | 404 → link to Dashboard | — |

`RequireApproved` reads the `profiles` row: `status='pending'` (or role `guest`) → hard redirect to `/pending` from every app route — the v1 guest gate, kept. `status='suspended'` → sign out + message on `/login`.

### 1.3 State strategy

- **Server state = TanStack Query only.** No server data in Zustand ever. `staleTime` 30s default; counts/facets 15s. Key catalog (in `lib/queryKeys.ts`):
  `['dashboard']`, `['batch',id]`, `['batch',id,'counts']`, `['batch',id,'members',filtersHash]` (infinite), `['batch',id,'activity']` (infinite), `['batch',id,'geojson']`, `['carrier',dot]`, `['carrier',dot,'timeline']`, `['carrier',dot,'memberships']`, `['search','count',defHash]`, `['search','preview',defHash]`, `['facet','other',scopeHash,q]`, `['facet','cargo',scopeHash]`, `['users']`, `['me']`.
- **Client store = one Zustand store**, slices: `wizardDraft` (persisted to sessionStorage so a refresh keeps the batch being built), `selection: Record<batchId, Set<dot>>`, `listPrefs` (last view/sort per batch), `theme` (`light|dark|system`, persisted to localStorage, stamps `data-theme` on `<html>` — same mechanism as mockup).
- **Mutations** are optimistic where cheap (status change, DNC, comment) with rollback on error + toast; heavy ones (create/refresh batch) are pessimistic with button spinners.

### 1.4 supabase-js integration points

`lib/supabase.ts` exports a typed client. All heavy reads go through **Postgres RPCs** (SECURITY DEFINER with role checks; frontend contract listed here, backend spec'd elsewhere):

| RPC | Args → returns | Used by |
|---|---|---|
| `search_count(definition jsonb)` | `{total, with_phone, with_email, tier1}` | wizard live count (G3/G10) |
| `search_preview(definition, lim int)` | first N matching carriers | wizard review |
| `cargo_flag_counts(scope jsonb)` | `[{flag, count}]` for the 30 crgo_* flags | Freight step (F14/G8) |
| `facet_other_values(scope jsonb, q text, lim int)` | `[{value, count}]` distinct `crgo_cargoothr_desc` values scoped to lanes+filters | FacetBrowser (F14/G8) |
| `create_batch(name, customer, job, definition)` | `batch_id` | Grab Batch (F20) |
| `refresh_batch(batch_id)` | `{added int}` (adds only, never removes) | Refresh |
| `batch_members(batch_id, status, q, warnings_only, min_insurance, size, has_phone, has_email, sort, page, page_size)` | `{rows[], total}` | Batch table (F5/G3) |
| `batch_status_counts(batch_id)` | counts per status + dnc + warnings | chips/stat strip |
| `set_batch_status(batch_id, dots int[], status)` | — (also writes activity row) | row + bulk status |
| `log_contact(dot, batch_id, channel, disposition, notes, next_steps)` | log row | F8/G6 |
| `set_dnc(dot, on bool)` / `mark_promoted(dot)` | — | profile actions (F23) |
| `dashboard_batches()` | per-batch summary rows (counts, breakdown, last_activity) | Dashboard (F4) |
| `batch_geojson(batch_id?)` | simplified lane geometries (all batches when null) | maps (G1) |
| `add_comment(batch_id, body)` | activity row | ActivityFeed (F11/G7) |

Row-shaped reads (carrier profile, timeline, memberships, users, activity pages) use plain `.from().select()` under RLS. Every RPC wrapper passes TanStack's `signal` to `.abortSignal()` so superseded live-count/facet requests cancel (§4).

**Realtime subscriptions** (in `lib/realtime.ts`, invalidations coalesced at 500ms):
- Batch page: channel `batch:{id}` → `postgres_changes` on `batch_carriers` and `batch_activity` filtered `batch_id=eq.{id}` → invalidate `['batch',id,*]`. This is the v1 "Live" shared-list promise made real (G7).
- Carrier profile: `contact_logs` filtered `dot_number=eq.{dot}` → invalidate timeline.
- Dashboard: `batches` table changes → invalidate `['dashboard']`.
- Topbar "Live" badge reflects actual channel state (`SUBSCRIBED` green / reconnecting amber), replacing v1's decorative badge.

**Auth**: email+password via Supabase Auth; register inserts a `profiles` row (`role='guest'`, `status='pending'`) via trigger. "Remember me" checked → localStorage session storage; unchecked → sessionStorage adapter passed at client creation. Forgot → `resetPasswordForEmail` → `/reset`. `usePermissions()` derives `{canEdit: role in ('manager','edit'), isManager}`; view role renders read-only (StatusBadge instead of StatusSelect, no log/bulk/create controls) while RLS enforces server-side.

### 1.5 Brand system implementation

- **Fonts** (`theme/fonts.css`): self-hosted Montserrat `@font-face`, weights 400/500/600/700/800/900 (+italics 400/600), `font-display: swap`, woff2 converted from the provided TTFs; preload 600 and 700 in `index.html`. `--font-ui: "Montserrat", system-ui, ...`; data/mono keeps the mockup stack (`ui-monospace, "SF Mono", ... monospace`); all numeric table cells get `font-variant-numeric: tabular-nums`. Wordmark/badge SVGs used in sidebar brand block and auth card (replacing v1's truck-icon placeholder); headings weight 800, UI weight 500/600.
- **Color** (`theme/tokens.css`): **neutrals go true monochrome** (v1's warm "concrete" bias is dropped per the brand direction); **accent + status + semantic hexes are carried over verbatim from the mockup** so v1 feedback stays valid. Both themes via `:root` + `:root[data-theme="dark"]` + `prefers-color-scheme` fallback, exactly the mockup mechanism.

```css
:root { /* light */
  --bg:#f4f4f4; --surface:#ffffff; --surface-2:#fafafa; --surface-sunk:#ececec;
  --border:#e2e2e2; --border-strong:#c7c7c7;
  --text:#141414; --text-muted:#595959; --text-subtle:#8c8c8c;
  /* accent — hi-vis orange, from mockup */
  --accent:#e8611d; --accent-hover:#cf5314; --accent-press:#b8480f; --accent-ink:#ffffff;
  --accent-tint:#fbe7d8; --accent-tint-2:#f6d3ba; --accent-ring:rgba(232,97,29,.38);
  /* pipeline status — from mockup */
  --st-new:#64748b;       --st-new-tint:#e7eaef;
  --st-attempted:#b07d10; --st-attempted-tint:#f6eccf;
  --st-contacted:#2f6fed; --st-contacted-tint:#dfe8fd;
  --st-interested:#157f43;--st-interested-tint:#d6efdf;
  --st-notfit:#8a8f98;    --st-notfit-tint:#e8e8e6;
  --st-dnc:#d0342c;       --st-dnc-tint:#f8dcd9;
  /* semantic + warning surface (F15) */
  --good:#157f43; --warn:#b07d10; --crit:#d0342c; --info:#2f6fed;
  --good-tint:#d6efdf; --warn-tint:#f6eccf; --crit-tint:#f8dcd9; --info-tint:#dfe8fd;
  --row-warning:#fdf3f2;         /* pale-red row wash, light */
}
:root[data-theme="dark"] {
  --bg:#0f0f10; --surface:#17181a; --surface-2:#1e2022; --surface-sunk:#0a0a0b;
  --border:#2a2c2f; --border-strong:#3d4045;
  --text:#ececec; --text-muted:#a6a6a9; --text-subtle:#737377;
  --accent:#f26f2b; --accent-hover:#f9813f; --accent-press:#d95e1c; --accent-ink:#1a0f07;
  --accent-tint:#2c1a0f; --accent-tint-2:#3d2413; --accent-ring:rgba(242,111,43,.45);
  --st-new:#93a0b2; --st-new-tint:#232b34; --st-attempted:#d6a53a; --st-attempted-tint:#33290f;
  --st-contacted:#6fa1ff; --st-contacted-tint:#152439; --st-interested:#48bd77; --st-interested-tint:#122a1c;
  --st-notfit:#828a94; --st-notfit-tint:#242a30; --st-dnc:#f2685f; --st-dnc-tint:#361715;
  --good:#48bd77; --warn:#d6a53a; --crit:#f2685f; --info:#6fa1ff;
  --good-tint:#122a1c; --warn-tint:#33290f; --crit-tint:#361715; --info-tint:#152439;
  --row-warning:#2a1614;
}
```

- **Tailwind wiring** (`theme/app.css`): `@theme inline { --color-accent: var(--accent); --color-st-new: var(--st-new); ... --color-row-warning: var(--row-warning); --font-ui: ...; --radius-*: 4px/6px/10px; }` — one line per token, yielding utilities `bg-accent`, `text-st-interested`, `bg-row-warning`, `ring-accent-ring`, etc. Rule: **orange is interaction only** (primary buttons, active nav, focus rings, selection, sliders, S&G tier chip); state meaning always comes from `--st-*`/semantic tokens; chrome is neutral-only.

---

## 2. Map integration spec (G1, F6, F13, F21, F22)

**Primary: Google Maps JS API** (pending-decision primary), loaded lazily per-screen via `@googlemaps/js-api-loader` with `libraries: ["marker","geometry","places","routes"]` and a `VITE_GOOGLE_MAPS_MAP_ID` (vector map required for `AdvancedMarkerElement`). Basemap = **default roadmap skin** to match the owner's existing tool (F24); the cloud style for the Map ID only reduces POI density. Every map gets zoom/pan/fullscreen controls enabled, scroll-zoom on, `gestureHandling:"greedy"` inside the app (F6).

`MapCanvas` is provider-agnostic over a `MapAdapter` interface:

```ts
interface MapAdapter {
  mount(el: HTMLElement, opts: {center, zoom}): void;
  setMarkers(pins: Pin[]): void;                 // diffed, not recreated
  setLanes(lanes: LaneGeometry[]): void;         // circles / route lines / buffer polygons
  fitTo(bounds | "lanes" | "markers"): void;
  onPinClick(cb), onMapClick(cb), destroy();
}
type Pin = { id: string; lng: number; lat: number; number?: number;   // row index (F22)
             color: string;  /* var(--st-*) resolved hex */ label?: string; dnc?: boolean };
```

- **Numbered status pins (F22)**: `AdvancedMarkerElement` with a custom DOM element — 26px circle, fill = pipeline-status color (DNC = `--st-dnc`), white 700-weight Montserrat number = the carrier's **row number in the current filtered+sorted list** (table shows the same # column, so list and map cross-reference exactly like the owner's tool). Dashboard maps use per-batch pins: accent-dark circle with batch index + a name label chip.
- **Right-side legend (F22)**: `MapLegend` overlay, top-right; batch maps list the 5 statuses + DNC with counts; wizard maps list "Matches filters" (accent) / "Other carriers" (grey); dashboard lists batches with their pin numbers. Clickable rows toggle that status's markers.
- **Radius lanes**: `google.maps.Circle` (accent stroke 2px, accent fill at 10% opacity) + anchor dot marker. Radius/center mutate in place on edit — no overlay re-creation (F13).
- **Corridor lanes**: route from `DirectionsService` (origin/dest LatLng) → render the polyline (accent, 3px) **plus the buffered band**: decode the route polyline, `@turf/buffer(line, bufferMi, {units:"miles"})` → polygon overlay (accent fill 8%, no stroke jitter). Buffer slider mutates only the polygon. Displayed buffer is turf-approximate; authoritative membership is PostGIS server-side — a one-line footnote in the wizard says counts come from the server.
- **Multi-lane rendering (F21)**: all lanes of a batch render simultaneously — the "asterisk / amorphous blob" is the natural visual union of overlapping accent overlays (no client-side geometric union). Each lane carries a small index chip (A, B, C…) at its anchor/origin matching the lane list. `fitTo("lanes")` on load and after add/remove.
- **Live editing (F13)**: wizard edits write the lane draft to the store; a 250ms-debounced effect diffs into the adapter (`setLanes`) and fires the debounced `search_count`. Dragging the radius slider updates the circle every frame (local), the count on debounce.
- **Clustering**: `@googlemaps/markerclusterer` engages only when visible markers > 250; cluster glyph = neutral dark circle with count; clusters explode by zoom 11 (§4).
- **List⇄Map toggles**: segmented control (v1 pattern kept); both panes stay mounted — map hidden with `visibility:hidden` (not unmount) so tiles/markers persist; `fitTo` re-runs on reveal.
- **Failure states**: loader failure or missing key → `MapUnavailable` card (neutral, retry button, "list view still works"); all list functionality is independent of Maps availability.

**MapLibre fallback (one paragraph, per pending decision):** `map/maplibre/` implements the same `MapAdapter` with MapLibre GL + a free vector style (OpenFreeMap/Protomaps) or OSM raster tiles; pins become MapLibre DOM markers reusing the identical pin elements; circles/buffers render as GeoJSON fill layers (same turf output); geocoding falls back to server-proxied Nominatim and routing to OSRM/Valhalla via a Render endpoint; Places autocomplete degrades to a plain geocode-on-enter input. `VITE_MAPS_PROVIDER` selects the adapter at build/run time — no screen code changes.

---

## 3. Screen specs v2

Shared shell: `AppShell` = Sidebar + Topbar (breadcrumbs, Live badge, theme toggle, user menu) + content. All screens: loading = skeleton blocks matching final layout; error = inline `ErrorState` card with retry (never blank); role gating per §1.4.

### 3a. Dashboard — `/dashboard` (F3, F4, G1, G2, F24)

v1's card grid is **deleted**. Layout top-to-bottom:
1. **PageHeader**: title "Dashboard" (F3), description, primary button "New Batch" → `/batches/new` (hidden for view role).
2. **StatStrip** (F24 kinship): Active batches / Carriers in play (distinct dots) / With phone / Interested / Promoted. From `dashboard_batches()` aggregates.
3. **Overview map** (~44vh `MapCanvas`): all active batches' lane geometries from `batch_geojson(null)` (server-simplified) + one numbered batch pin per batch at its primary anchor; right legend lists batches; pin/legend click → navigate to batch. Zones tinted accent at low opacity; hover a table row → that batch's lanes highlight (opacity raise).
4. **Batch table** (G2, `DataTable`, client-side — tens of rows): columns **#** (map pin number) · **Batch** (name bold + `customer · job` subline, F20) · **Lanes** (e.g. "2 lanes — 50 mi radius · Austin; corridor · Austin→Waco") · **Carriers** (mono) · **Pipeline** (StackedBar of status colors, tooltip per segment) · **Interested** (mono, `--st-interested`) · **Warnings** (count chip, crit tone, F15) · **Last activity** (rel time + actor initial) · row menu (Rename, Edit details, Refresh, Delete — edit-gated). **Row click → `/batches/:id`** (F4). Sorted by last activity desc.
- Empty: EmptyState "No batches yet — create your first recruitment batch" + New Batch button (map hidden). Loading: stat skeletons + map shimmer + 4 skeleton rows. Data: `['dashboard']` + `['batch geojson all']`; realtime on `batches`.

### 3b. New Batch flow — `/batches/new` (F20, F21, F12, F13, F14, F15, F16, G1, G8, G10)

Replaces v1's single-page builder. **Stepper wizard, 4 steps**; steps 2–4 share a persistent right-hand live map (sticky, ~60% width) and a **fixed footer**: live match count (`search_count`, debounced 350ms, with with-phone/with-email/tier-1 sub-counts, G10) + Back/Next + final "Grab Batch". Draft persists in `wizardDraft` (sessionStorage). Cancel → confirm modal if dirty.

- **Step 1 — Details (F20, full-width, no map)**: **Batch name is the first field on screen**, large input, required. Then **Customer** (combobox seeded with distinct existing values, free-entry allowed) and **Job** (text — "a batch is a recruitment session for a customer's job"). Next disabled until name is non-empty.
- **Step 2 — Lanes (F21, F12, F13)**: left panel = **lane list** (each row: index chip A/B/C, type icon, label, params summary, per-lane contribution count, Edit, Remove) + two add buttons: **Add radius lane** and **Add corridor lane**. Coverage = **union of all lanes**; at least 1 lane to proceed.
  - *Radius editor*: anchor-type segmented control ordered **Pin · Address · City · ZIP · County** (F12). Pin = "click the map" mode (crosshair cursor, map click sets anchor); Address = Google Places Autocomplete (TX-biased); City = TX city combobox; ZIP = 5-digit input → geocode centroid; County = 254-county combobox → county-seat centroid (polygon-county deferred, noted in UI). Radius slider 5–150 mi with mono echo. Circle updates live while dragging (F13).
  - *Corridor editor*: **custom Pickup and Dropoff inputs every time — no preset routes** (F13; v1's `PRESET_ROUTES` deleted). Each input = Places Autocomplete or "drop pin" mode; when both set → `DirectionsService` computes the route, polyline + buffer band render immediately and re-render on any change; buffer slider 5–80 mi ("distance from any point along the run" helper kept from v1). Route error (no drivable path) → inline crit message, lane not saveable.
  - Lane draft shape: `{id, type:'radius', anchor:{kind:'pin'|'address'|'city'|'zip'|'county', label, lng, lat}, radius_mi}` | `{id, type:'corridor', origin:{label,lng,lat}, dest:{label,lng,lat}, encoded_polyline, buffer_mi}`.
- **Step 3 — Freight (F14, G8)**: the "wide net" concept and name are **gone**. Two blocks:
  1. **Cargo categories** — all **30 `crgo_*` flags as plain checkboxes**, 2-col scrollable group, each with a live count scoped to current lanes+filters (`cargo_flag_counts`); pre-checked default: Dry Bulk, Construction, Building Materials unchecked — nothing pre-checked except "Other cargo" ON.
  2. **"Other cargo" first-class facet browser** (`FacetBrowser`): enabled by its own checkbox (default ON). Contains: keyword search input (300ms debounce) across distinct `crgo_cargoothr_desc` values; a **Suggested keywords** chip row (sand, gravel, aggregate, rock, dirt, stone, base, fill, crushed, caliche, topsoil, "S&G") each with its scoped match count — clicking adds it as an include rule; a **virtualized value list** (`facet_other_values`, can be long by design) showing `value — carrier count` with a per-value tri-state **Include / Exclude / neutral** control; and a sticky summary bar ("Including 14 values · Excluding 3 · ≈ 412 carriers"). Include rules OR together; excludes subtract. Selected rules serialize into `definition.cargo.other = {includes:[], excludes:[], keywords:[]}`.
- **Step 4 — Filters & Review (F15, F16, G10)**: carrier filters card: **Minimum insurance (BIPD)** select (Any/$500K+/$750K+/$1MM+/$2MM+) + **"Keep below-threshold carriers visible"** switch (kept from v1 — threshold, never silent exclusion); Fleet size (Any/1–5/6–20/21+); toggles For-hire only, Active registration only, Authorized & insured only, Interstate only; **Contactability** (F16): checkboxes "Has phone on file" / "Has email on file". **The v1 "Exclude concerning safety" toggle is removed** (F15); in its place a neutral note: "Safety and authority issues are never filtered out — carriers with issues are highlighted in red everywhere." Review panel: definition summary (details, lanes, freight rules, filters), coverage stats (total, % with phone, % with email, tier-1 share — G10), `search_preview` first-10 table. Footer button becomes **"Grab Batch — N carriers"** → `create_batch` → toast → navigate `/batches/:id`.
- Errors: count RPC failure → footer shows "count unavailable — retry" (never blocks editing); create failure → toast + stay. View role never reaches this route.

### 3c. Batch page — `/batches/:batchId` (F5, F11, F15, F16 filter parity, F17, F19, F22, F24, G3–G7)

Top-to-bottom:
1. **Header**: batch name (h1) + `Customer · Job` subline (F20) + lane chips (A/B/C with type+label, click → highlights lane on map) + Refresh button (runs `refresh_batch`, toast "+N added", writes activity) + batch menu (Rename, Edit details, Delete — edit/manager gated).
2. **ActivityFeed (F11, G7)** — collapsible card, default showing last 3 with "Show all": chronological feed mixing **auto events** (created, refreshed +N, status changes "Maria set 12 carriers to Contacted", bulk actions, promotions, DNC sets — written server-side by the RPCs) and **manual comments** (composer at top, edit roles). Infinite scroll pages of 30; realtime.
3. **StatStrip (F24)**: Carriers / With phone / With email (F16 visibility) / Interested / Warnings (crit tone) / Promoted.
4. **Status filter chips** (v1 pattern kept): All + New/Attempted/Contacted/Interested/Not a Fit + Do Not Call, each with live counts (`batch_status_counts`), URL-synced.
5. **Toolbar**: search input (name/USDOT/city — F19 placement confirmed in-batch), insurance min select, size select, **Contactability** select (Any / Has phone / Has email / Missing both), **"Warnings only"** toggle (F15 companion), sort select (Name/Distance/Fleet/Recent contact/Warnings first), **List⇄Map** segmented control (F22).
6. **Members table** — **server-paginated + virtualized** (F5/G3, §4). Columns: checkbox · **#** (map pin number) · Carrier (name + USDOT mono + S&G tier chip) · **Contact name** · **Phone** · **Email** (F17/G4; `ContactCell`, copyable, `tel:`/`mailto:` links, "—" subtle when missing) · Location (city + distance-to-nearest-lane, server-computed) · Trucks (mono) · Insurance (badge: good ≥$1MM / warn ≥$500K / crit none) · **Status** (StatusSelect, colored, includes "Do Not Call…" escape → confirm modal; view role sees StatusBadge) · Last contact (channel icon + dispo + rel time) · quick **Log** split-button (Call default; caret → Text / Email, F8). **Warning rows (F15/G5): `bg-row-warning` pale-red wash + `WarningChips`** (reason chips: "Authority inactive", "No insurance", "Insurance below required", "High OOS", "Conditional rating") rendered identically here, on profile, and on sheets. DNC rows: muted, lock icon, no checkbox/log.
7. **Map view**: same data page? No — map fetches up to 5,000 lightweight pins (`dot,lng,lat,status,dnc,row#`) for the current filter via a slim RPC variant; numbered status pins + lane overlays + right legend with per-status counts (F22); pin click → carrier profile with `?batch=`.
8. **BulkBar** (fixed bottom, appears when selection > 0): "N selected" · Mark status… (menu of 5) · **Generate Contact Options** (→ §3e) · clear. Select-all checkbox selects the current filtered set (server returns matching dots, capped 5,000; DNC always excluded).
- Empty (no members): EmptyState "This batch grabbed 0 carriers — edit lanes or filters." Empty (filters): "No carriers match these filters" + clear-filters button. Loading: chip skeletons + 10 skeleton rows. Error: ErrorState + retry. Realtime per §1.4 — another user's status change updates rows/chips within ~1s.

### 3d. Carrier profile — `/carriers/:dot?batch=` (F7, F8, F15, F18, F23, G4, G5, G6)

**v2 restructure (all variants share this content model):**
- **Identity header** — v1's General tab + Overview migrate here (F7): name (h1) + DBA, big mono USDOT, chips (Active, S&G tier, DNC red when set), and a general-facts line: entity · classification · operation · power units/drivers · MCS-150 date · full physical address. Warning carriers: header carries the pale-red wash + WarningChips (F15). Header actions: **Mark as Promoted** (F23 — replaces v1 "Send to Onboarding" modal/copy entirely: lightweight tracking action, confirm modal says "Records that this carrier asked to register and was promoted into the TNBS tools — nothing is sent anywhere"; after: neutral "Promoted ✓" badge + activity/timeline entry, undoable via menu) and the **global DNC toggle** (v1 confirm-modal behavior kept verbatim: "global — suppresses this carrier in every batch and channel").
- **Verification tiles (F7)**: Insurance, Safety, Inspections as **verification-style tiles** — each a card with a verdict icon (good check / warn / crit alert), headline stat, 2–3 key figures, and expand-for-detail (Insurance: authority status/type, BIPD on file vs required, cargo ins, effective date; Safety: crashes 24mo, inspections, vehicle/driver OOS %, rating + date, "public signals only" footnote kept; Inspections: table of date/state/level/result/violations, empty state "No inspection detail on file").
- **Contact panel (G4)**: contact name, phone, cell, email as copyable rows with `tel:`/`mailto:`; missing email → subtle "no email on file". **Three log buttons: Log Call / Log Text / Log Email (F8)** → `LogContactModal` with channel-specific dispositions (call: connected/no answer/voicemail/callback/interested/not interested/wrong number; text: sent/replied/no response/wrong number; email: sent/replied/bounced/no response), notes, next steps, and — when `?batch=` present — "Update status in this batch to…" (v1 behavior kept).
- **Unified timeline (G6)**: all channels, all batches, newest first; each entry: channel icon, dispo badge, notes, next steps, user avatar + batch name, rel time; channel filter chips; realtime.
- **Batch memberships**: v1 card kept — per-batch StatusSelect inline (not just badges), "status is per-batch" footnote kept.
- **Research quick-links (F18 MVP)**: card of prefilled external searches opening in new tabs: Google `"<legal_name>" <city> TX trucking`, Google Maps business search, Facebook and LinkedIn company searches, FMCSA SAFER snapshot by USDOT. Marked "Research — enrichment coming later" (future reserved module, F2).

**Three M0 design-variant directions (owner picks one, then iterate — build all three as `features/carrier/variants/` behind a dev-only switcher):**
1. **"Dossier"** — a full-bleed masthead: oversized carrier name (Montserrat 800) over a monochrome header band with USDOT as a giant watermark-style mono numeral; verification tiles as a horizontal row of three passport-stamp cards directly under the masthead; below, a single centered column: contact panel → timeline → memberships. Structurally: one-column, header-dominant, maximum identity presence; reads like a printed carrier file.
2. **"Command Console"** — split layout: fixed left rail (~340px) holding identity summary, contact panel, DNC, Promote, research links — everything actionable; right work area with the verification tiles as a 3-up grid on top and a tabbed lower region (Timeline | Memberships | Inspections detail). Structurally: two-pane with persistent actions; optimized for working a call while reading data; closest evolution of v1's layout.
3. **"Verification Ledger"** — vertical checklist metaphor: a slim identity header, then a single ledger column where Insurance, Safety, Inspections, Contactability, and Authority each render as a full-width ledger row with a left verdict rail (good/warn/crit color edge), expandable in place; timeline lives in a right-side drawer toggled by a persistent "History" button. Structurally: audit-style single scroll, strongest expression of the warn-don't-exclude system (G5); most different from v1.

### 3e. Contact Options sheet (F9, G4, G5)

Triggered from BulkBar. **Modal**: summary chips (N carriers · with phone · with email · "X Do-Not-Call excluded automatically"); preview table columns: **# · Carrier · Contact name · Phone · Cell · Email · City · Status** (contact name + email added per F9); warning carriers keep their pale-red row + chips (G5). Actions: **Print call sheet** → opens `/batches/:id/sheet` in a new tab (clean print layout: batch name/customer/job header, date, generated-by; monochrome; row per carrier with a blank notes line; auto `window.print()`); **Export CSV** → client-generated file `batch-<name>-contacts.csv` with columns `usdot, carrier, dba, contact_name, phone, cell, email, city, state, status, insurance_bipd, warnings`. **"Copy USDOT list" is removed** (F9 — USDOT promotion happens per-carrier via Mark as Promoted only). Empty selection can't occur (BulkBar gates); selection that is 100% DNC → modal shows "all selected carriers are suppressed".

### 3f. Auth screens, Users admin, Sidebar (F1, F2, F3)

- **Auth**: v1 shapes kept 1:1 minus demo-role buttons — Login (email, password, Remember me, Forgot link), Register (name/email/password → creates pending guest → `/pending`), Forgot (reset email), Reset (new password from email link), Pending guest gate (v1 copy kept: "A manager needs to review and provision your account"; sign-out button). Brand block uses the real wordmark assets.
- **Users admin `/users`** (F1 — keep): pending-approval card (approve modal with Editor/Viewer radio, reject) + active-users table (role select, suspend/restore, "you" lock on self). Mutations update `profiles` under manager-only RLS; realtime on `profiles` refreshes the pending count badge.
- **Sidebar (F2, F3)**: section "Recruiting": **Dashboard** (renamed from Batches, F3; count badge = active batches) · **New Batch**. Section "Outreach — coming soon" (F2): **Email Blasts, Texting, Postcards, Enrichment** rendered as visible but disabled items (subtle text, small "Soon" chip, `aria-disabled`, tooltip "Planned module — not yet available"; no routes). Section "Admin" (manager only): **Users** with pending-count badge. Footer: user cell menu (theme toggle, sign out).

---

## 4. Performance plan (F5, G3)

- **Server-side everything for members**: `batch_members` RPC does filter/sort/paginate in Postgres (sort keys whitelisted: name, distance, power_units, last_contact_at, warnings_first, status). **Offset pagination, `page_size=200`, returns `total`** — batches cap at low thousands, so offset math is safe and enables the scrollbar.
- **Virtualized rows**: `useInfiniteQuery` feeding `@tanstack/react-virtual`; fixed row height 48px, overscan 10; next page prefetched when the virtualizer crosses 75% of loaded rows. Memoized `MemberRow` (`React.memo`, stable handlers via row-id-keyed callbacks); static column defs.
- **Debounce + cancellation**: wizard live count 350ms, facet search 300ms, table search 250ms; every fetch passes TanStack's `signal` → `abortSignal()` so stale requests die server-side; `keepPreviousData` on members/facets so the table never flashes empty while refetching.
- **Counts decoupled from rows**: status-chip counts and stat strip come from `batch_status_counts` (one grouped query), never from scanning loaded pages.
- **Map budgets**: pin payload is a slim projection (≤ 5,000 pts, ~100KB); clustering activates > 250 visible markers, declusters at zoom ≥ 11; lane geometries server-simplified (`ST_Simplify` tolerance ≈ 0.005°) before shipping GeoJSON; markers diffed in the adapter (update position/color/number in place, never teardown); map instances persist across list⇄map toggles (§2).
- **Realtime discipline**: invalidations coalesced in a 500ms window per batch; only affected key families invalidated (a `batch_carriers` UPDATE invalidates members+counts, not activity).
- **App-level**: route-level code splitting (maps SDK + turf only load on map screens); Montserrat 600/700 preloaded, rest swap; Query `staleTime` 30s to kill refetch storms on tab focus; dashboard row hover prefetches `['batch',id]` + first members page.

---

## 5. Shared component inventory (props sketches)

```ts
// status + warnings
<StatusBadge status={Status|"dnc"} size?="sm|md" />                       // v1 badge, tokens §1.5
<StatusSelect value onChange(next) disabled? includeDnc?=true />          // colored select; "Do Not Call…" -> confirm modal
<WarningChips warnings={WarningCode[]} compact? max?=3 />                 // F15/G5; overflow "+2"
   // WarningCode = 'authority_inactive'|'insurance_none'|'insurance_below_required'|'oos_high'|'conditional_rating'
<StackedBar segments={{status: count}[]} total height?=6 />               // dashboard pipeline bar
<StatStrip items={{label, value: ReactNode, sub?, tone?: 'default'|'crit'|'interested'}[]} />  // F24

// map (§2)
<MapCanvas lanes={LaneGeometry[]} pins={Pin[]} legend={LegendEntry[]}
           fit?="lanes"|"pins" onPinClick?(id) onMapClick?(lngLat) pickMode?  cluster?=auto />
<MapLegend entries={{swatch, label, count?, onToggle?}[]} />              // right side, F22

// batch building
<LaneList lanes onEdit(id) onRemove(id) counts={Record<laneId, number>} />
<LaneEditor lane={LaneDraft} onChange onCancel onSave />                  // radius|corridor forms, F12/F13
<FacetBrowser scope={SearchDefinitionScope} value={{includes, excludes, keywords}}
              onChange suggested={{term, count}[]} />                     // F14/G8; virtualized value list
<LiveCount definition loading? />                                         // footer count + sub-counts (G10)
<Stepper steps={{id, label, done}[]} current onStepClick />

// tables + contact
<DataTable<T> columns={ColumnDef<T>[]} query={InfiniteQueryResult} virtual?  rowNumberOffset?
              selection?={{selected:Set<string>, onToggle, onToggleAllMatching}}
              rowTone?(row)=> "default"|"warning"|"dnc"  onRowClick?(row) />   // G2/G3/F15
<ContactCell name? phone? email? compact? />                              // G4; copy + tel:/mailto:
<BulkBar count actions={{label, icon?, onClick, primary?}[]} onClear />
<LogContactModal dot batchId? defaultChannel="call"|"text"|"email" onSaved />  // F8/G6
<Timeline dot filterChannel? />                                           // unified, realtime
<ActivityFeed batchId collapsed? />  <CommentComposer batchId />          // F11/G7
<VerificationTile kind="insurance"|"safety"|"inspections" verdict="good"|"warn"|"crit"
                  headline stats={{k,v}[]} expandContent />               // F7
<ResearchLinks carrier />                                                 // F18 MVP
<PromoteButton dot promoted? />  <DncToggle dot dnc />                    // F23 / global DNC
<EmptyState icon title body action? />  <ErrorState message onRetry />
<PageHeader title description? actions? />  <Toast />  <ConfirmModal />
```

Every component consumes tokens only (no raw hexes outside `tokens.css`); `WarningChips` + `rowTone="warning"` are the single implementation of F15 reused across batch table, profile header, contact-sheet modal, and print sheet, so the pale-red system stays identical everywhere (G5).
