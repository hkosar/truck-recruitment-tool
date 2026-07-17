# Twisted Nail Carrier Recruiter — Verified Cost & Services Analysis

**Prepared 2026-07-17. Every price below was verified this week via live web sources (July 2026, post-March-2025 Google pricing model). Citation per line. Dev labor excluded (internal). Stack per locked decision: Supabase + Render + React/Vite, Google Maps primary.**

---

## 1. Verified price sheet (raw facts, then the tables)

### Google Maps Platform (post-March-2025 model)
The $200/mo universal credit is **gone**, replaced by per-SKU free monthly calls: **Essentials SKUs = 10,000 free calls/mo each, Pro = 5,000, Enterprise = 1,000**, resetting on the 1st ([developers.google.com/maps/billing-and-pricing/march-2025](https://developers.google.com/maps/billing-and-pricing/march-2025), [mapsplatform.google.com blog](https://mapsplatform.google.com/resources/blog/start-building-today-with-up-to-10-000-monthly-free-calls-per-product/)). Overage rates at the 10K–100K volume tier:

| SKU | Tier | Free/mo | After free |
|---|---|---|---|
| Dynamic Maps (JS map load) | Essentials | 10,000 | $7.00/1,000 |
| Geocoding | Essentials | 10,000 | $5.00/1,000 |
| Routes: Compute Routes (basic, traffic-unaware) | Essentials | 10,000 | $5.00/1,000 |
| Places Text Search (IDs only) | — | unlimited | $0 |
| Place Details — Essentials fields | Essentials | 10,000 | $5.00/1,000 |
| Place Details — Pro fields | Pro | 5,000 | $17.00/1,000 |
| Text Search / Place Details — Enterprise fields (phone, website, rating, hours) | Enterprise | 1,000 | $35.00 / $20.00 per 1,000 |

Sources: [developers.google.com/maps/billing-and-pricing/pricing](https://developers.google.com/maps/billing-and-pricing/pricing), [woosmap.com/blog/google-places-api-pricing](https://www.woosmap.com/blog/google-places-api-pricing), [mapatlas.eu/blog/google-maps-api-pricing-2026](https://mapatlas.eu/blog/google-maps-api-pricing-2026). Directions API / Distance Matrix are **Legacy** — build on **Routes API** only ([developers.google.com/maps/billing-and-pricing/faq](https://developers.google.com/maps/billing-and-pricing/faq)).

**Prerequisite:** a Google Cloud **billing account with a card on file is mandatory even at $0 usage** ([developers.google.com/maps/billing-and-pricing/overview](https://developers.google.com/maps/billing-and-pricing/overview)). **Budget alerts notify but do NOT stop billing; only per-API quota caps hard-stop spend** ([developers.google.com/maps/billing-and-pricing/manage-costs](https://developers.google.com/maps/billing-and-pricing/manage-costs)). Both are configured in §6.

**Our consumption math (5 users, 22 workdays):**
- **Map loads:** 10,000 free ÷ 110 user-days = **~90 map opens per user per day** before the first dollar. Realistic heavy use (dashboard map + batch maps + search maps, SPA reusing one map instance) = 20–40 loads/user/day → **2,200–4,400/mo → $0.**
- **Geocoding:** interactive only (anchor lookups for Address/City/ZIP searches — Pin and County need none; bulk carrier geocoding goes to the free Census pipeline, §4). Even 50 searches/day team-wide → ~1,100/mo → **$0.** Skip Places Autocomplete entirely (separate SKU, unneeded internally).
- **Routes:** 1 Compute Routes call per corridor-lane edit, debounced to drag-end (F13 live editing). 10,000 free = ~450 recomputes per workday. Realistic 20–60/day → **$0.** Use `TRAFFIC_UNAWARE` routing (Essentials, 10k free) — a corridor buffer needs geometry, not traffic (traffic-aware is a Pro SKU at only 5k free).

**Verdict: $0/mo with ~10–20× headroom on every SKU.**

### Supabase
Free: $0 — 500MB database, 2 projects, **auto-pauses after 1 week of no API activity, no backups**. Pro: **$25/mo** — 8GB disk, **daily backups (7-day retention), never pauses**, $10/mo compute credit that fully covers the Micro instance (adequate for PostGIS `ST_DWithin` over a ~60–80k-row TX table), spend-cap toggle available. Sources: [supabase.com/pricing](https://supabase.com/pricing), [makerkit.dev/blog/saas/supabase-pricing](https://makerkit.dev/blog/saas/supabase-pricing), [uibakery.io/blog/supabase-pricing](https://uibakery.io/blog/supabase-pricing). **What forces Pro at launch:** (a) a shared CRM writing call logs cannot run without backups; (b) TX dataset 50–300MB + L&I + safety + logs + PostGIS indexes crowds the 500MB free cap; (c) pause-on-idle is unacceptable for a production tool over a holiday week. **Dev/staging stays on a second free project ($0) where pausing is harmless.**

### Render
- **Static site (React SPA):** **$0**, 100GB/mo bandwidth + 500 build-min included ([render.com/pricing](https://render.com/pricing), [srvrlss.io/provider/render](https://www.srvrlss.io/provider/render/)).
- **Cron job (nightly FMCSA sync + geocode delta + L&I/safety refresh, one combined script):** billed **per second of runtime at the instance rate, $1/mo minimum per cron service** ([render.com/docs/cronjobs](https://render.com/docs/cronjobs), [saaspricepulse.com/tools/render](https://www.saaspricepulse.com/tools/render)). A ~15-min nightly job ≈ 7.5 compute-hrs/mo ≈ $0.07–0.26 → bills the **$1 minimum**. Use ONE cron service (multiple crons each pay their own $1 floor).
- **Background worker:** Starter $7/mo (512MB) / Standard $25/mo (2GB) — **not needed at MVP**; batch Refresh and exports execute in-query at 250–5,000-row scale. Optional later for an email send queue.
- **Workspace plan:** Hobby **$0** suffices for this team size; paid workspace only if collaborative deploy features are wanted later.

### Bulk geocoding at $0 (verified available)
- **Census Bureau batch geocoder:** free, no API key, **10,000 records per batch / 5MB file**, unlimited successive batches — the ~60–80k TX carrier universe = 6–8 batches on ingest night ([geocoding.geo.census.gov/geocoder/Geocoding_Services_API.html](https://geocoding.geo.census.gov/geocoder/Geocoding_Services_API.html), [Census Geocoder FAQ PDF](https://www2.census.gov/geo/pdfs/maps-data/data/Census_Geocoder_FAQ.pdf)). Expect 60–85% street-level match on carrier-typed addresses (PO boxes/rural routes fail) — per the brief, ZIP-centroid precision is acceptable for radius search, so:
- **ZCTA centroid fallback:** Census **2025 Gazetteer file** (free download, lat/lng centroid per ZCTA) + free ZIP→ZCTA crosswalk ([census.gov gazetteer files](https://www.census.gov/geographies/reference-files/time-series/geo/gazetteer-files.html), [censusreporter crosswalk](https://github.com/censusreporter/acs-aggregate/blob/master/crosswalks/zip_to_zcta/ZIP_ZCTA_README.md)). Store a `geocode_precision` column (street/zip) per G10 honesty.

### Email module (M-email, timing TBD) — ESP shortlist at 1–5k emails/mo
| ESP | Entry price | Fit |
|---|---|---|
| **Resend (recommended)** | Free 3k/mo but **100/day cap kills blast bursts**; **Pro $20/mo** = 50k/mo, no daily cap, 10 custom domains | Modern API, React Email templates, managed pre-warmed shared IPs, subdomain sending supported ([resend.com/pricing](https://resend.com/pricing), [nuntly.com/resend-pricing](https://nuntly.com/resend-pricing)) |
| Amazon SES | ~$0.10/1,000 ≈ **$0.50/mo** | Cheapest by far but ops-heavy: sandbox-exit application, DIY reputation/suppression tooling, no UI ([emailsendx.com comparison](https://emailsendx.com/blog/amazon-ses-vs-sendgrid-vs-mailgun-vs-postmark-2026)) |
| Postmark | **$15/mo** / 10k | Best deliverability reputation; fine runner-up ([buildmvpfast.com email API costs](https://www.buildmvpfast.com/api-costs/email)) |
| SendGrid | Free 100/day; Essentials **$19.95/mo** / 50k | No advantage at this scale ([vibecoder pricing comparison](https://blog.vibecoder.me/email-service-pricing-resend-sendgrid-postmark)) |

**Recommendation: Resend Pro $20/mo**, sending from a dedicated subdomain of the domain the owner already controls (e.g. `offers.twistednail.com`) — this IS the legitimate implementation of F10's "rotating email": separate subdomain reputation, SPF+DKIM+DMARC records ($0), gradual volume warm-up over 2–4 weeks (process, $0), suppression synced to the global `do_not_contact` flag, CAN-SPAM physical-address + unsubscribe footer ($0). Send via the transactional API with list/suppression managed in our own Supabase tables — avoids Resend's per-contact marketing billing entirely. Dedicated IP is unnecessary and counterproductive below ~100k/mo. **Compliance cash cost: $0; it is process.**

### Enrichment (future milestone)
- **MVP enrichment (F18): $0** — prefilled Google/Facebook/LinkedIn search links per carrier; no API.
- **API tier:** pattern = Places **Text Search IDs-only (free, unlimited)** → **Place Details requesting website/phone/rating = Enterprise fields: 1,000 free/mo, then $20/1,000** ([woosmap.com/blog/google-places-api-pricing](https://www.woosmap.com/blog/google-places-api-pricing), [developers.google.com/maps/documentation/places/web-service/usage-and-billing](https://developers.google.com/maps/documentation/places/web-service/usage-and-billing)). At a throttled ≤1,000 enrichments/mo cadence → **$0**; each additional 1,000/mo → **+$20**. 5k/mo ceiling → ~$80/mo.

### Misc
- **Sentry Developer plan: $0** — 5k errors/mo, 1 seat (errors from all users are still ingested; one shared dev login views them). Multi-seat Team is $26/mo if ever wanted ([sentry.io/pricing](https://sentry.io/pricing/), [last9.io/blog/sentry-pricing](https://last9.io/blog/sentry-pricing/)).
- **Domain: $0** — twistednail.com is already owned; `recruit.` + `offers.` subdomains are free DNS records. A separate new .com would be $10.44/yr at-cost via Cloudflare ([cloudflare registrar](https://www.cloudflare.com/products/registrar/), [cfdomainpricing.com](https://cfdomainpricing.com/)) — **not recommended**: a subdomain of the established domain warms faster and isn't deceptive.
- **FMCSA QCMobile API: $0** — free WebKey via Login.gov developer account ([mobile.fmcsa.dot.gov/QCDevsite/docs/apiAccess](https://mobile.fmcsa.dot.gov/QCDevsite/docs/apiAccess)).
- **FMCSA Socrata (az4n-8mr2 census + jeyh-5nsj L&I): $0** — free app token lifts anonymous throttling ([dev.socrata.com/docs/app-tokens.html](https://dev.socrata.com/docs/app-tokens.html), [data.transportation.gov](https://data.transportation.gov)).

---

## 2. Table A — MVP launch (Phase 0 + 1): **$26/mo**

| # | Line item | $/mo | Justification (one line) | Citation |
|---|---|---|---|---|
| A1 | Supabase Pro (prod project) | **$25.00** | Daily backups + no idle-pausing + 8GB headroom are non-negotiable for a shared CRM; $10 credit covers the Micro compute we need | [supabase.com/pricing](https://supabase.com/pricing) |
| A2 | Supabase Free (dev/staging project) | $0.00 | Second free project; pausing is harmless in dev | [supabase.com/pricing](https://supabase.com/pricing) |
| A3 | Render static site (React SPA) | $0.00 | Free tier includes 100GB bandwidth — 5 users can't dent it | [render.com/pricing](https://render.com/pricing) |
| A4 | Render cron (one combined nightly sync: census + L&I + safety + geocode delta) | **$1.00** | ~15 min/night ≈ $0.07–0.26 actual compute → bills the $1/mo service minimum | [render.com/docs/cronjobs](https://render.com/docs/cronjobs) |
| A5 | Google Maps: Dynamic Maps (~2.2–4.4k loads) | $0.00 | 10k free/SKU/mo ≈ 90 map opens/user/workday of headroom | [developers.google.com march-2025](https://developers.google.com/maps/billing-and-pricing/march-2025) |
| A6 | Google Maps: Geocoding (~0.5–1.5k interactive) | $0.00 | Only search-anchor lookups hit Google; bulk geocoding is A8 | [developers.google.com pricing](https://developers.google.com/maps/billing-and-pricing/pricing) |
| A7 | Google Maps: Routes Compute Routes (~0.5–1.5k, traffic-unaware, drag-end debounced) | $0.00 | 10k free basic routes ≈ 450 corridor recomputes/workday | [developers.google.com pricing](https://developers.google.com/maps/billing-and-pricing/pricing) |
| A8 | Bulk geocoding: Census batch (10k/batch) + 2025 ZCTA Gazetteer centroid fallback | $0.00 | Free federal services cover the full one-time TX backfill + nightly deltas | [geocoding.geo.census.gov](https://geocoding.geo.census.gov/geocoder/Geocoding_Services_API.html), [census.gov gazetteer](https://www.census.gov/geographies/reference-files/time-series/geo/gazetteer-files.html) |
| A9 | FMCSA data: Socrata app token + QCMobile WebKey | $0.00 | Both free by policy; token only lifts throttling | [dev.socrata.com](https://dev.socrata.com/docs/app-tokens.html), [FMCSA QCDevsite](https://mobile.fmcsa.dot.gov/QCDevsite/docs/apiAccess) |
| A10 | Sentry Developer (error tracking) | $0.00 | 5k errors/mo free; a 5-user tool should never approach it | [sentry.io/pricing](https://sentry.io/pricing/) |
| A11 | Domain/subdomains on twistednail.com | $0.00 | Already owned; subdomains are free DNS records | [cloudflare.com/products/registrar](https://www.cloudflare.com/products/registrar/) |
| | **Total A** | **$26.00/mo** | ($312/yr) | |

## 3. Table B — MVP + email module: **$46/mo**

| # | Line item | $/mo | Justification | Citation |
|---|---|---|---|---|
| B1–B11 | Everything in Table A | $26.00 | unchanged | — |
| B12 | Resend Pro | **$20.00** | Free tier's 100/day cap blocks blast bursts; Pro = 50k/mo, no daily cap, custom subdomain sending, pre-warmed shared IPs | [resend.com/pricing](https://resend.com/pricing) |
| B13 | Sending subdomain `offers.twistednail.com` + SPF/DKIM/DMARC | $0.00 | DNS records on the owned domain; the legitimate form of F10's "rotating email" | [nuntly.com/resend-pricing](https://nuntly.com/resend-pricing) |
| B14 | Warm-up, suppression sync to global DNC, CAN-SPAM footer | $0.00 | Process, not spend: 2–4 week volume ramp, unsubscribe honored, physical address in footer | — |
| B15 | (Optional) Render Starter worker for send queue | $0.00 default | Not required at 1–5k/mo — a cron tick drains the queue; add $7/mo only if sends must be near-real-time | [render.com/pricing](https://render.com/pricing) |
| | **Total B** | **$46.00/mo** | ($552/yr) | |

## 4. Table C — full stack + enrichment: **$46/mo at recommended throttle** (metered upside)

| # | Line item | $/mo | Justification | Citation |
|---|---|---|---|---|
| C1–C15 | Everything in Table B | $46.00 | unchanged | — |
| C16 | Enrichment MVP: manual research quick-links (prefilled Google/FB/LinkedIn URLs) | $0.00 | F18 MVP; zero API surface | — |
| C17 | Places API: Text Search IDs-only → Place Details (website/phone/rating = Enterprise fields), **throttled to ≤1,000 carriers/mo** | **$0.00** | IDs-only search is free-unlimited; Enterprise Details has 1,000 free/mo — throttle inside it | [woosmap.com places pricing](https://www.woosmap.com/blog/google-places-api-pricing) |
| C18 | Metered enrichment expansion (owner's dial) | +$20.00 per extra 1,000/mo (max ~+$80 at 5k/mo) | $20/1k Enterprise Place Details past the free 1k; a line-item decision, never a surprise | [developers.google.com places billing](https://developers.google.com/maps/documentation/places/web-service/usage-and-billing) |
| | **Total C** | **$46.00/mo** (up to $126 only if the owner deliberately turns the enrichment dial to 5k/mo) | | |

## 5. One-time setup costs

| Item | Cost | Note |
|---|---|---|
| Google Cloud billing account (card on file — mandatory even at $0) | $0 | Prerequisite for any Maps key; do this first | 
| GCP quota caps + budget alerts configuration | $0 | 30-min task; see §6 R1–R3 |
| Login.gov account + FMCSA WebKey; Socrata app token | $0 | Two registrations |
| Full-TX bulk geocode backfill (6–8 Census batches + ZCTA fallback) | $0 | One ingest night on the $1 cron |
| Resend account + subdomain DNS (SPF/DKIM/DMARC) + 2–4 wk warm-up ramp | $0 | At email-module start, not before |
| Optional separate sending domain (NOT recommended) | $10.44/yr | Only if owner insists on full domain separation | 
| Optional one-time enrichment backfill of ~10k TX carriers | ~$180 one-time | 9k billable × $20/1k; decision-gated, never automatic |

**Total mandatory one-time cash: $0.**

## 6. When the MapLibre + OSM fallback becomes worth it (verified break-even)

The fallback is **more expensive than Google at our scale**, so Google stays primary:
- Tiles: OSM's public tile servers prohibit production apps; commercial tile plans are Stadia ~$20/mo or MapTiler ~$25/mo (their free tiers are non-commercial-only) — or self-hosted Protomaps PMTiles on Supabase Storage at ~$0 but with build effort ([stadiamaps.com/pricing](https://stadiamaps.com/pricing/), [maptiler.com/cloud/pricing](https://www.maptiler.com/cloud/pricing/), [protomaps.com blog](https://protomaps.com/blog/free-tier-maps/), [supabase protomaps guide](https://supabase.com/blog/self-host-maps-storage-protomaps)).
- Routing: self-hosted OSRM on the 666MB Texas extract needs ~4GB RAM → Render Pro instance **$85/mo** ([geofabrik.de Texas](https://download.geofabrik.de/north-america/us/texas.html), [OSRM disk/memory wiki](https://github.com/Project-OSRM/osrm-backend/wiki/Disk-and-Memory-Requirements)).
- **Trigger points to revisit:** (a) Dynamic Maps consistently >10k loads/mo (≈ multi-tenant SaaS scale, not 5 users); (b) Google retires/reprices a SKU we use; (c) owner refuses card-on-file with Google. Until then the fallback is an architecture note (map component behind an interface), not a purchase.

## 7. Cost-control rules (set during setup, all $0)

1. **GCP hard quota caps per API** — budget alerts do NOT stop billing; quotas do. Cap Dynamic Maps at 500 loads/day, Geocoding 200/day, Routes 200/day, Place Details 50/day ([manage-costs doc](https://developers.google.com/maps/billing-and-pricing/manage-costs)).
2. **GCP budget alerts at $5 / $25** to the owner's email — early smoke detector under the hard caps.
3. **API key restrictions:** browser key locked to the app's HTTPS referrer + only the 3 needed APIs; server key (if any) IP-locked.
4. **Frontend discipline:** one persistent map instance per SPA session (loads bill per initialization); corridor route recompute on drag-end only, debounced.
5. **Supabase spend cap ON** (Pro toggle): overages error instead of billing; disk-usage alert at 6GB of the 8GB.
6. **One Render cron service, not several** (each carries its own $1 floor); alert if nightly runtime exceeds 60 min (runaway job = per-second billing; normal chain is 25–45 min — 01 reconciliation #20).
7. **Email:** stay on flat-rate Resend Pro; app-level daily send ceiling (e.g. 500/day) + mandatory suppression/DNC check before every send; monitor bounce/complaint rates weekly during warm-up.
8. **Enrichment dial:** hard monthly job cap of 1,000 Place Details lookups (inside the free tier); raising it is an explicit owner decision worth exactly $20 per extra 1,000.
9. **Sentry:** client `sampleRate` tuned + spike protection on, to live inside the free 5k errors/mo.
10. **Monthly 15-minute cost ritual:** GCP, Supabase, Render, Resend usage dashboards reviewed on the 1st; every dashboard has a number that should read near-zero variance from this document.

## 8. Decision summary for the owner

- **MVP: $26/mo ($312/yr). The only real bill is Supabase Pro ($25) — it buys backups, always-on, and headroom; everything else rides free tiers with enforced caps.**
- **Email module adds exactly $20/mo (Resend Pro).** SES could do it for ~$0.50/mo but trades ~$19/mo of savings for meaningfully more ops burden and DIY compliance tooling — poor trade at this team size.
- **Enrichment adds $0/mo at the recommended 1,000-lookups/mo throttle**; it is a metered dial at $20 per extra 1,000, plus an optional ~$180 one-time full backfill.
- **Google Maps stays $0** for a 5-user internal tool with ~10–20× headroom per SKU; the MapLibre/OSRM fallback would cost $20–105/mo and is deferred behind an interface, not bought.
- **No mandatory one-time cash. Total worst-case steady state with every module on and the enrichment dial at maximum: ~$126/mo; expected: $46/mo.**

### Post-review amendment (sizing correction — 01 reconciliation #13)

This document's "~60–80k TX carriers" figure under-counted; the canonical ingest scope is
**TX active carriers, ~150–220k rows**. Consequences, re-verified: Supabase **Pro (8GB)
absorbs it comfortably** (~0.5–1GB with `census_raw` + indexes) — the $25 line and Micro
compute stand; the one-time Census-geocoder backfill is **~15–22 batches** (still one to
two free ingest nights on the $1 cron); and the **M2.7 real-data backfill runs on the
production Pro project**, not the free 500MB dev project (which keeps synthetic seed
only). **No dollar amounts change.**
