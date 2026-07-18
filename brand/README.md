# Twisted Nail brand assets (build subset)

Subset of `Twisted Nail_Brand Assets_Oct 2022.zip` (owner-provided; keep the zip as the
source of truth — it also contains EPS/AI/PDF masters, white icon variants, italics, and
the full Montserrat family).

- `logos/` — primary wordmark (black / white / black-box), badge (black / white /
  white-on-black), icon (black / white) (PNG). Spec usage (docs/tnbs-design-system.md):
  white badge on the navy top bar; black badge on white/light surfaces; never recolor.
- `fonts/` — Montserrat TTFs, weights 400/500/600/700/800/900. M1 converts these to
  subset woff2 for `app/public/fonts/` (fonttools); the mockup embeds a small subset as
  data URIs. Montserrat is licensed under the SIL Open Font License.

Identity: monochrome black/white, dressed in exactly one app accent — TNBS navy
(#1e3a6e). Status + category colors are closed token sets, not brand colors
(see docs/tnbs-design-system.md, which supersedes build-plan 02 §1.5 on this).
