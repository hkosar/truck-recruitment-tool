# Twisted Nail brand assets (build subset)

Subset of `Twisted Nail_Brand Assets_Oct 2022.zip` (owner-provided; keep the zip as the
source of truth — it also contains EPS/AI/PDF masters, white icon variants, italics, and
the full Montserrat family).

- `logos/` — primary wordmark (black / white / black-box), badge, icon (PNG).
- `fonts/` — Montserrat TTFs, weights 400/500/600/700/800/900. M1 converts these to
  subset woff2 for `app/public/fonts/` (fonttools); the mockup embeds a small subset as
  data URIs. Montserrat is licensed under the SIL Open Font License.

Identity: monochrome black/white. App chrome follows it; the orange interaction accent
and status colors are APP tokens, not brand colors (see build-plan 02 §1.5).
