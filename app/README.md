# Twisted Nail — Carrier Recruiter (production app)

Production React app for Phase 1 of the carrier recruitment tool. Spec:
`../docs/build-plan/02-frontend-spec.md` (screens, map, brand system) and
`../docs/build-plan/01-architecture.md` (schema, RPC contract, RLS —
**authoritative** wherever the two disagree; see its "Contract
reconciliation" section).

Stack: Vite 7 + React 19 + TypeScript 5 + Tailwind v4 (CSS-first `@theme`) +
TanStack Query v5 + Zustand v5 + React Router v7 + `@supabase/supabase-js`
v2 + `@googlemaps/js-api-loader` + `@turf/buffer`.

## Status

This is a **scaffold**: project config, theme, routing, the typed
Supabase/RPC layer, and titled stub screens. Screens are not built out yet
— see each stub component's file comment for what belongs there and which
spec section to build it from.

`types/database.ts` is a **hand-written placeholder** for the real
`supabase gen types typescript` output (the Supabase schema itself hasn't
been migrated yet — see `../docs/build-plan/01-architecture.md` Part A).
Read that file's header before touching it.

## Prerequisites

- Node.js >= 22.12 (matches Vite 7 and `@supabase/supabase-js`'s engines)
- A Supabase project (once `supabase/migrations/` exists and is applied)
- A Google Maps API key + Map ID (once map screens are built)

## Getting started

```bash
npm install
cp .env.example .env.local   # fill in VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY / ...
npm run dev                  # http://localhost:5173
```

## Scripts

| Command | What |
|---|---|
| `npm run dev` | Vite dev server with HMR |
| `npm run build` | Typecheck (`tsc --noEmit`), then production build to `dist/` |
| `npm run preview` | Serve the production build locally |
| `npm run typecheck` | `tsc --noEmit` only (no emit, no bundling) |
| `npm run lint` | ESLint (flat config, `eslint.config.js`) |

## Project layout

```
src/
  main.tsx            # QueryClientProvider + Router + ThemeProvider
  theme/               # tokens.css (light/dark + brand), fonts.css, app.css (Tailwind entry), ThemeProvider.tsx
  app/                 # router.tsx, guards.tsx, AppShell/Sidebar/Topbar
  lib/                 # supabase client, RPC wrappers, query keys, permissions, warnings, formatting
  types/               # domain.ts (app-facing types) + database.ts (Supabase placeholder types)
  features/            # one folder per screen area (auth, dashboard, batchNew, batch, carrier, users)
public/
  fonts/               # Montserrat .woff2 (fonttools conversion of brand/fonts/*.ttf — not yet generated)
  brand/               # wordmark/badge/icon SVGs (not yet placed — see brand/logos/ at the repo root)
```

## Fonts and brand assets

`theme/fonts.css` declares `@font-face` rules pointing at
`public/fonts/montserrat/*.woff2`. Those files don't exist yet in this
scaffold (only `public/fonts/.gitkeep` does) — converting
`../brand/fonts/*.ttf` to woff2 (fonttools) is a separate build step. Until
then the app falls back to the system font stack; nothing breaks.

Sidebar/Login currently render a text-based "TN" wordmark placeholder.
Swap it for `public/brand/wordmark.svg` (from `../brand/logos/`) once that
asset is placed under `public/brand/`.

## Environment variables

See `.env.example`. All client-side config is `VITE_`-prefixed and typed in
`src/vite-env.d.ts`.

## Conventions

- Server state lives only in TanStack Query (`lib/queryKeys.ts` is the key
  catalog); Zustand is for client-only state (not yet scaffolded — see
  `docs/build-plan/02-frontend-spec.md` §1.3 for the planned slices).
- Every canonical RPC has a typed wrapper in `lib/rpc.ts` — call those, not
  `supabase.rpc(...)` directly, so the RPC contract has one call site per
  operation.
- Design tokens only: no raw hex colors outside `theme/tokens.css`. Orange
  (`--accent`) is interaction-only; pipeline/semantic state always uses the
  `--st-*` / `--good`/`--warn`/`--crit`/`--info` tokens.
