# Verification & Quality Gates

How "done" is judged at every level. The executing manager treats this file as the
acceptance authority; `00-master-plan.md` task cards reference these sections.

## 1. Global Definition of Done (every task)

- Typecheck + lint + unit tests green in CI (both `app/` and `pipeline/`).
- No console errors or unhandled rejections in exercised flows.
- New behavior covered by at least one automated check (unit, E2E step, or SQL probe) that fails if the behavior regresses.
- Loading / empty / error states exist for any new screen surface (02's per-screen states are the checklist).
- Role gating verified for any new mutation path (view-role must not see the control AND the server must reject it).
- Spec docs updated when reality diverged (reconciliation section in 01 if cross-doc).
- No secrets in the repo; env vars documented in `.env.example`.

## 2. Milestone gate summary

| Gate | Type | Pass condition |
|---|---|---|
| M0.4 | **Owner** | Hunter's explicit sign-off on mockup v2 + chosen profile variant |
| M1 | Auto | CI green · `supabase db reset` clean · deployed shell reachable |
| M2.7 | **Owner** | Hunter confirms staging data matches market reality (coverage brief reviewed) |
| M3 | Auto | Role-matrix E2E green |
| M4 | Auto | Multi-lane batch E2E + SQL cross-check equality |
| M5 | Auto | Full CRM E2E green on staging |
| M6 | **Owner** | UAT on production → launch approval |
| M7 | Owner+process | Deliverability checklist §7 + first-campaign approval |

## 3. Database verification

### 3.1 Post-migration probes (M1.2)

```sql
-- seed invariants
select count(*) from carriers;                                   -- ~800 synthetic
select count(*) from batches;                                    -- 2 (one multi-lane)
select count(*) from batch_zones where batch_id = (select id from batches order by created_at limit 1); -- >= 2
select dot_number from batch_carriers group by dot_number having count(distinct batch_id) > 1 limit 1;  -- cross-batch carrier exists
select count(*) from carriers where do_not_contact;              -- >= 1
select * from carrier_warnings where warning_reasons <> '{}' limit 5;  -- warnings render
-- refresh-candidate invariant: per seed batch, >= 1 matching carrier that is NOT a member
-- matcher sanity: zone union returns more than either zone alone
-- facet scope rule: facet_other_values with cargo removed ≠ zeroed
```

### 3.2 RLS negative matrix (M6.2 — scripted role fixtures)

| Actor | Attempt | Expected |
|---|---|---|
| anon | select carriers | 0 rows / denied |
| pending guest | select batches / carriers / profiles(others) | empty; own profile only |
| view | update batch_carriers.status · insert contact_logs · insert batch_activity comment · update carriers.do_not_contact | ALL denied |
| edit | delete batches · delete batch_carriers · update profiles(role) · update carriers.legal_name (sync-owned) | ALL denied |
| edit | insert contact_logs with user_id != self | denied |
| edit | insert batch_activity with activity_type != 'comment' | denied |
| manager | update cargo_other_values.match_group | allowed (curation) |
| any authed | update carriers sync-owned columns | denied (column grants) |
| **disabled** user (canonical status value — 01 reconciliation #14) | any select beyond own profile; any write | denied; app signs out with message |

Each case is a Playwright-or-script assertion using real JWTs from seeded fixture users. All 4 roles exercised. Any "allowed" that should be denied is a launch blocker.

### 3.3 Pipeline probes (M2.0 — from 01 pipeline §7, R1–R7)

Resolve every ⚠️R item with live evidence before dependent tasks: column spellings (officer, mailing, `crgo_motoveh`), value domains (`carrier_operation`, `classdef`), TX volume, L&I `$select`, Census batch geocoder behavior, OOS national averages. Findings recorded as an addendum in 01.

### 3.4 Sync correctness (M2)

- Idempotency: second consecutive run writes only changed rows (~1–3% churn).
- Add-only refresh: upstream attribute change never removes a batch member.
- 5 hand-verified carriers vs SAFER/L&I web values (insurance $, authority, name, address).
- Geocode precision histogram reported; ≥95% of active TX carriers have geometry at some tier.
- Facet curation survives re-sync (`match_group`/`is_sand_gravel` untouched by upsert).

## 4. E2E catalog (Playwright, successor to `mockup/verify.js`)

Runs headless in CI against a seeded dev project; ~0 external requests except Supabase + (mocked) Maps. Google Maps is loaded with the key only in the manual staging run; CI uses the MapUnavailable path plus adapter unit tests, so CI never spends map quota.

1. **Auth:** register → pending gate (sees ONLY pending page) → manager approves as Editor → user gains app.
2. **Role matrix:** view-role sees read-only list (badges not selects, no bulk/log/create); manager sees Users; edit cannot reach Users.
3. **Wizard:** name-first step enforces required name; add radius lane (City anchor) + radius slider changes live count; add corridor lane (custom pickup/dropoff) → count changes; anchor segmented order is Pin/Address/City/ZIP/County; per-lane counts shown; remove lane restores count.
4. **Freight:** enable a flag → count changes; facet search finds a seeded value; include 2 values + exclude 1 → count math consistent (exclude dominant); suggested chip click adds an include.
5. **Filters/review:** insurance threshold with keep-below-visible ON leaves count unchanged but flags warnings; contactability has-email drops count per seed's ~22% fill; review stats match; Grab Batch → lands on batch page with exact member count.
6. **Dashboard:** rename visible ("Dashboard"); table row click navigates; batch appears with customer · job; no tile grid present.
7. **Batch page:** status chips filter; in-batch search filters; warnings-only shows only pale-red rows with chips; contact name/phone/email columns render; URL-sync restores state on reload.
8. **Status + logging:** row status change persists + appears in activity feed; log a Call, a Text, an Email (channel dispositions differ) → unified timeline shows all three with channel icons; batch-context status update from log modal works.
9. **Bulk + sheet:** select-all-matching → bulk status writes one activity row; Generate Contact Options excludes the DNC carrier with an explicit note; sheet shows contact name + email columns; **no "Copy USDOT list" control exists anywhere** (assert absence); CSV downloads with specified columns; print route renders; **print and CSV each write an `export` activity-feed row** (`log_export` — 01 reconciliation #19).
10. **Profile:** identity header carries General/Overview facts; verification tiles show verdict tones; warning carrier's header is pale-red with chips; research quick-links open expected URLs (href assertions); Mark as Promoted → badge + activity + undoable; DNC toggle → confirm modal → carrier locked in EVERY batch (assert in a second batch).
11. **Cross-batch invariant:** seeded shared carrier shows different per-batch statuses + one merged timeline.
12. **Refresh:** seeded "newly matching" carrier is added with `added_via_refresh`, count bumps, feed logs "+N".
13. **Realtime:** two browser contexts — status change in A appears in B ≤ ~2s; comment posted in A streams into B's feed.
14. **Reserved tabs:** sidebar shows the four disabled future-tool entries; clicking does nothing/navigates nowhere.
15. **Map subset (stubbed `MapAdapter` in CI — no real tiles/quota):** adapter receives numbered pins whose numbers equal the current filtered+sorted list rows under two different sorts; **warning carriers' pins carry `warning: true`** (crit-ring treatment); legend entries + per-status counts match chip counts; legend click toggles that status's pins; pin click navigates to the carrier with `?batch=`; lane overlays (circle + corridor band per lane, with material/label chips) passed for every lane. **Plus one manual staging map pass** (real Google key) before the M5→M6 gate: visual check of pins/legend/lanes/zoom/pan/fullscreen, recorded with screenshots.

## 5. Performance budgets (M6.3, measured on staging real data)

| Surface | Budget |
|---|---|
| Batch page first interactive, 5,000-member batch | < 2.5s (broadband) |
| `batch_members` page fetch P95 | < 700ms |
| `count_carriers` live count P95 (3 lanes + facets) | < 1.5s |
| `facet_other_values` P95 | < 1.2s |
| Map: 5,000 slim pins render | < 1.5s, no dropped-frame scroll jank in list |
| Bulk status 1,000 rows | < 3s end-to-end |
| Nightly pipeline chain on Render cron | < 60 min (alert beyond — 01 reconciliation #20) |
| Wizard debounce discipline (cost + UX) | ≤1 `count_carriers` call per 350ms while dragging; corridor Routes call on drag-end only (≤1 per edit gesture) — asserted by counting stubbed calls in the wizard E2E |

## 6. Launch checklist (M6.6)

- Prod backfill run verified (row counts vs staging ±daily churn).
- Backups: Supabase Pro daily backup visible; restore procedure rehearsed once into a scratch project (runbook step).
- Cost guardrails evidence filed (GCP caps + alerts, Supabase spend cap, Render alert, key referrer lock) per 04 §7.
- Sentry receiving events from prod build.
- 5 real users created with correct roles; forgot-password verified on a real mailbox.
- Runbook + 1-page user guide committed.
- Rollback plan: static-site rollback via Render previous deploy; DB is additive-only at launch.

## 7. Email deliverability checklist (M7 gate)

- SPF, DKIM, DMARC verified on `offers.twistednail.com` (Resend domain status green).
- Warm-up ramp schedule configured (e.g. 20/day → 50 → 100 → 250 over 2–4 weeks) and enforced by the queue's daily ceiling.
- Suppression enforcement proven: seeded DNC/suppressed/no-email carriers cannot enter an audience (server-side assertion).
- CAN-SPAM: physical address + working unsubscribe in every template; unsubscribe writes a suppression + timeline entry.
- Bounce/complaint webhooks ingest correctly (test events) and suppress future sends.
- First real campaign: audience + copy explicitly approved by Hunter; sent volume within warm-up ceiling; results reported (delivered/bounced/replied) after 72h.
