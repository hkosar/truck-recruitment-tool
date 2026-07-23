# Socrata column verification — Task 2 (M2.0 runtime-verification research)

**Date:** 2026-07-17. **Method:** web search/fetch only (no pipeline code was run; no direct
Socrata API calls were made). **Scope:** FMCSA Company Census File (`az4n-8mr2`) and the L&I
family (`6eyk-hxee`, `qh9u-swkp`), per the task brief's explicit checklist — officer/contact
fields, mailing city/state columns, the 30 `crgo_*` flags (esp. `crgo_motoveh` vs
`crgo_motorveh`), `carrier_operation`/`classdef` value domains, and whether
`email_address`/`phone`/`cell_phone` exist as named.

## Access constraints hit this session (read this first)

Every direct-fetch attempt against the following hosts returned **HTTP 403** regardless of
path or query string: `data.transportation.gov` (including `/resource/*.json`,
`/api/views/*.json`), `dev.socrata.com` (including the Foundry per-dataset schema pages, e.g.
`/foundry/data.transportation.gov/az4n-8mr2/embed`), `catalog.data.gov`, `opennetzero.org`,
`li-public.fmcsa.dot.gov`, `www.fmcsa.dot.gov`, `web.archive.org` (tool-level block), and
`grep.app`. This matches — and is broader than — what `01-architecture.md` Part B already
documented ("this sandbox's egress proxy blocks data.transportation.gov"; "ai.fmcsa.dot.gov
... WAF blocks datacenter IPs"): apparently the WAF/proxy blocking extends to
`li-public.fmcsa.dot.gov` and `www.fmcsa.dot.gov` too, not just `ai.fmcsa.dot.gov`, and to
`dev.socrata.com`'s own docs/schema pages. **No live Socrata row was fetched this session.**
The ⚠️R1/R2/R3/R5/R6/R7 probes in Part B §7 are all still genuinely open and must be run from
an unproxied shell (e.g. the actual Render worker) before the pipeline goes live — this
document upgrades some of them from "guessed" to "corroborated by independent production
code," which is meaningfully better than nothing but is **not** the same as a live-row fetch.

What did work: **GitHub raw file fetches** (`raw.githubusercontent.com`) and web search. This
surfaced two production codebases not cited in Part B's original research —
**`kshivam4781/FMCSA-SOI-Data`** (a from-scratch Python SODA client for `az4n-8mr2`, including
its own `ALL_FIELDS` list pulled from the live schema) and **`axelm6/CarrierSearch`** /
**`lazizbekravshanov/fleetsight`** (both already cited in Part B, re-confirmed here) — plus
FMCSA's own public FAQ pages (reachable only via search-engine-cached snippets, not direct
fetch).

Legend: **CONFIRMED** = seen as a literal field name in ≥1 real, independent piece of
production code or an authoritative FMCSA page (via search-engine synthesis where direct fetch
was blocked). **CORROBORATED** = matches Part B's own prior citation, independently
re-observed this session. **CARRIED FORWARD** = matches Part B's citation, not independently
re-checked this session (no new evidence for or against). **UNVERIFIED** = no evidence found
either way; this pipeline's own guess.

---

## 1. Company Census File (`az4n-8mr2`) — the task's main checklist

### 1.1 Officer / contact-person fields — CONFIRMED, exactly as Part B assumed

`company_officer_1` and `company_officer_2` are the real field names — **not** `contact_name_1`/
`contact_name_2` (that was always just Part B's own internal alias name, per
`01-architecture.md` reconciliation amendment #1, which this confirms was the right call).

- `axelm6/CarrierSearch`'s `api/carriers.js` maps `company_officer_1` → `companyOfficer`
  directly off the live query response.
- `lazizbekravshanov/fleetsight`'s `pipeline/ingest.py` has both in its literal `$select`
  clause: `...cell_phone,company_officer_1,company_officer_2,status_code,...`
- `kshivam4781/FMCSA-SOI-Data`'s own `ALL_FIELDS` list (from its `fmcsa_api_client.py`) lists
  `company_officer_1`, `company_officer_2` under "Company Officer Fields."

**Action: none.** `pipeline/src/sources/census.ts` already maps these two fields to
`carriers.company_officer_1`/`company_officer_2` per reconciliation amendment #1.

### 1.2 Mailing city/state column names — CONFIRMED (resolves Part B's own ⚠️R5 on this point)

`carrier_mailing_street`, `carrier_mailing_city`, `carrier_mailing_state`, `carrier_mailing_zip`
are all real. Two bonus fields not in Part B's original list: `carrier_mailing_country`,
`carrier_mailing_cnty`, and `carrier_mailing_und_date` (undeliverable-mail date, presumably).

- `kshivam4781/FMCSA-SOI-Data`'s README lists the mailing-address field group explicitly
  (`carrier_mailing_street, carrier_mailing_city, carrier_mailing_state, etc.`), and its
  `get_ca_companies.py` script **actually SELECTs** `carrier_mailing_city` and
  `carrier_mailing_zip` in a real, runnable query.

**Action: none.** `census.ts` already maps `carrier_mailing_street/city/state/zip` →
`carriers.mail_street/city/state/zip`.

### 1.3 The 30 `crgo_*` flags, esp. `crgo_motoveh` vs `crgo_motorveh` — CONFIRMED: `crgo_motoveh`

This was the single most consequential open question (Part B §2.3 literally flagged it:
"⚠️R5: one repo spells `crgo_motorveh` — confirm"). Finding: **`crgo_motoveh` is correct.**
`crgo_motorveh` was not found anywhere.

- `kshivam4781/FMCSA-SOI-Data`'s actual client source code (`fmcsa_api_client.py`) contains a
  literal 31-item field list (30 boolean flags + `crgo_cargoothr_desc`) that lists
  `crgo_motoveh`, in the exact same order Part A's DDL (`01-architecture.md` §2.4) and Part B
  §2.3 already use: `crgo_genfreight, crgo_household, crgo_metalsheet, crgo_motoveh,
  crgo_drivetow, crgo_logpole, crgo_bldgmat, crgo_mobilehome, crgo_machlrg, crgo_produce,
  crgo_liqgas, crgo_intermodal, crgo_passengers, crgo_oilfield, crgo_livestock, crgo_grainfeed,
  crgo_coalcoke, crgo_meat, crgo_garbage, crgo_usmail, crgo_chem, crgo_drybulk, crgo_coldfood,
  crgo_beverages, crgo_paperprod, crgo_utility, crgo_farmsupp, crgo_construct, crgo_waterwell,
  crgo_cargoothr, crgo_cargoothr_desc`.
- A targeted web search for `"crgo_motorveh" site:github.com` returned **zero results** ("The
  search did not return any results for 'crgo_motorveh' specifically").

**Action: none needed** — `pipeline/src/sources/census.ts`'s `CRGO_FLAG_NAMES` constant
already uses `crgo_motoveh`. Flagged in-code as CONFIRMED with this citation.

**Still open:** the `'X'` = checked encoding (Part B's own citation: `val.strip().upper() ==
"X"` from `Wooohan/hussfix5ba`) was **not** independently re-verified this session — carried
forward as-is (CARRIED FORWARD, not CONFIRMED). No contradicting evidence found.

### 1.4 `carrier_operation` and `classdef` value domains — field names CONFIRMED, exact value strings still UNVERIFIED

Both field names are solid:

- `axelm6/CarrierSearch`'s real query code filters `classdef IS NULL OR classdef=''` and
  `classdef NOT LIKE '%BROKER%' AND classdef NOT LIKE '%FORWARDER%'` (carrier vs. broker
  disambiguation) and maps `carrier_operation` → `carrierOperation` directly.
- `lazizbekravshanov/fleetsight` and `kshivam4781/FMCSA-SOI-Data` both list `carrier_operation`
  as a literal field.

Value domain — **CONFIRMED that `classdef` holds multi-word descriptive strings**, not
single-letter codes (the `LIKE '%BROKER%'`/`'%FORWARDER%'` usage above only makes sense against
free-text-ish values). FMCSA's public "Operation Classification" page (reachable only via
search-engine synthesis, not a direct fetch — `li-public.fmcsa.dot.gov/mcmisfile/
operation_classification.htm` itself 403'd) corroborates three category definitions in
substance: **Authorized For Hire**, **Exempt For Hire**, **Private (Property)** — matching Part
A's DDL comment (`'Authorized For Hire' | 'Private (Property)' | ...`). The MCS-150 form is
generally understood to define a fuller set beyond these three (private passenger
business/non-business, migrant, U.S. mail, federal/state/local government, Indian tribe) but
**the exact string spellings/casing/spacing of the full domain were not independently
confirmed** — e.g. whether it's `"Private (Property)"` (with a space, as Part A's comment has
it) or `"Private(Property)"` (no space, as one search snippet rendered it) is still open.

For `carrier_operation`: FMCSA FAQ content (search-engine-synthesized, not directly fetched)
describes the underlying concept as Interstate vs. Intrastate, but **did not surface literal
enum strings or single-letter codes** — Part B's own guess of `A`/`B`/`C`-style codes (⚠️R5)
is **neither confirmed nor refuted**. `kshivam4781`'s field list separately shows
`interstate_beyond_100_miles`, `interstate_within_100_miles`, `intrastate_beyond_100_miles`,
`intrastate_within_100_miles` as their own distinct boolean-ish fields — worth checking on the
live probe whether `carrier_operation` itself is redundant with/derived from these four, or a
genuinely separate field.

**Recommendation:** treat `classdef`'s exact value strings and `carrier_operation`'s value
domain as still-open ⚠️R5 items requiring the Part B §7 R5 live-row probe
(`$limit=1` full-row sample) before writing any `classdef = 'Authorized For Hire'`-style exact
filters into RPC/matcher SQL. `census.ts` currently applies no value-domain-specific cast to
either field (plain `nullif(..., '')::text`), which is safe regardless of the answer.

### 1.5 `email_address` / `phone` / `cell_phone` — CONFIRMED, all three exist as named

All three are used as literal field names across every production codebase checked
(`axelm6/CarrierSearch`, `lazizbekravshanov/fleetsight`, `kshivam4781/FMCSA-SOI-Data`), plus
`fax`. No alternate spellings encountered anywhere.

**Action: none.** `census.ts` already maps `phone`, `cell_phone`, `fax`, `email_address`
1:1 (the last cast to `citext`, lowercased/trimmed).

### 1.6 Owned/leased equipment fields — CORRECTED (Part B's own ⚠️R5 hedge was off)

Part B §2.3 hedged: `owntruck, owntract, owntrail (+ termtruck…, triptruck… ⚠️R5)`. The real
prefixes for leased equipment are **`trm*`** (term-leased) and **`trp*`** (trip-leased), not
`term*`/`trip*` spelled out — plus a bus/coach ownership field, `owncoach`, that wasn't
mentioned at all before.

- `kshivam4781/FMCSA-SOI-Data`'s README, "Vehicle Ownership" section: "Owned: `owntruck`,
  `owntract`, `owntrail`, `owncoach`, etc. / Term leased: `trmtruck`, `trmtract`, `trmtrail`,
  etc. / Trip leased: `trptruck`, `trptract`, `trptrail`, etc."
- Independently, its `get_ca_companies.py` script's actual field list includes `owntruck,
  owntract, owntrail, owncoach`.

**Action taken:** `census.ts` promotes `owntruck`/`owntract`/`owntrail` to
`carriers.owned_trucks/tractors/trailers` (matches amendment #7's explicit column names) and
now fetches `owncoach`/`trmtruck`/`trmtract`/`trmtrail`/`trptruck`/`trptract`/`trptrail` into
`census_raw` (preserved, not lost) but does **not** invent dedicated column names for them —
amendment #7 only says "+leased" without specifying exact column names, whether term vs. trip
need separate columns, or whether coach ownership gets a column at all. That's a schema
decision for the schema-owning agent, not something to guess into a migration-adjacent file.

### 1.7 Other fields confirmed as literal `az4n-8mr2` names this session

`dot_number`, `legal_name`, `dba_name`, `status_code`, `add_date`, `mcs150_date`, `hm_ind`,
`prior_revoke_flag`, `prior_revoke_dot_number`, `dun_bradstreet_no`, `docket1prefix`, `docket1`,
`docket2`, `docket3`, `phy_street`, `phy_city`, `phy_state`, `phy_zip`, `phy_country`,
`phy_cnty`, `power_units`, `truck_units`, `bus_units`, `fleetsize`, `total_drivers`,
`total_cdl`, `total_intrastate_drivers`, `business_org_desc`, `business_org_id`,
`recordable_crash_rate`, `mcs150_mileage`\*, `mcs150_mileage_year`\*, `mcsipdate`, `mcsipstep`,
`review_id`, `review_type`, `review_date`.

\* `mcs150_mileage`/`mcs150_mileage_year` are carried forward from Part B's own citation, not
independently re-confirmed by name this session (not seen verbatim in the newly-found repos'
visible content) — CARRIED FORWARD, not CONFIRMED.

### 1.8 Noteworthy new finding: `safety_rating` may live on the census file itself

`kshivam4781`'s field list places `safety_rating`, `safety_rating_date`, `review_id`,
`review_type`, `review_date` under the **census** file's own field categories, not a
safety-specific dataset. If this holds up on a live probe, it raises the possibility that
`carrier_safety.safety_rating`/`safety_rating_date` could be sourced from the **daily**
census pull instead of (or in addition to) the monthly SMS dataset Part B §1.3 designates —
fresher data, one fewer dependency on the still-unresolved ⚠️R3 SMS dataset choice. Not acted
on in this scaffold (`sources/safety.ts` still sources these from the SMS pull, matching Part
B's original design) — flagged as a deliberate follow-up decision, not silently redesigned
around. See `pipeline/src/sources/safety.ts`'s header comment.

---

## 2. L&I family — live verified during the first production runs

### 2.1 `qh9u-swkp` (ActPendInsur) — VERIFIED LIVE 2026-07-21

The first production request returned HTTP 400. Live `/api/views/qh9u-swkp` metadata and sample
rows identified the cause and confirmed the actual contract:

- Display label `ins_type_desc` has query fieldName **`mod_col_1`**. Select it as
  `mod_col_1 as ins_type_desc`; filter `mod_col_1 like 'BIPD%'`.
- Verified fields: `docket_number`, `dot_number`, `ins_form_code`, `name_company`, `policy_no`,
  `trans_date`, `underl_lim_amount`, `max_cov_amount`, `effective_date`, and
  `cancl_effective_date`.
- Prior assumptions `ins_class_code` and `min_cov_amount` do **not** exist in this dataset.
- Live values confirm `max_cov_amount` is thousands of dollars (`1000` = $1,000,000) and BIPD
  types include `BIPD/Primary`, `BIPD/Excess`, `BIPD`, and rare `BIPD/Full` variants.

`sources/insurance.ts` now uses the live fieldName alias and removes nonexistent fields.

### 2.2 `6eyk-hxee` (Carrier — All With History) — VERIFIED LIVE 2026-07-21 (⚠️R2 resolved)

The first production request returned HTTP 400 because the guessed field names were wrong.
A live Socrata metadata request to `/api/views/6eyk-hxee` and token-authenticated sample request
then confirmed the runtime contract:

| Meaning | Verified SODA field | Observed format |
|---|---|---|
| DOT | `dot_number` | 8-character zero-padded text |
| Common authority | `common_stat` | compact code (`A`, `I`, `N`; `P` handled defensively) |
| Contract authority | `contract_stat` | compact code |
| Broker authority | `broker_stat` | compact code |
| Required BIPD minimum | `min_cov_amount` | zero-padded thousands of dollars (`00750` = $750,000); ingest ×1000 |

The prior guesses `common_authority_status`, `contract_authority_status`,
`broker_authority_status`, and `bipd_required_amount` do not exist in this dataset. Live value
frequencies (`00750`, `01000`, `00300`) confirm the DDL's thousands-of-dollars interpretation,
so the ×1000 conversion remains. `sources/authority.ts` now implements the live field names and
code-to-enum mapping.

### 2.3 SMS / safety datasets — LIVE VERIFIED 2026-07-22; crash source remains gated

Direct official DOT DataHub metadata and sample queries resolved the core R3 question:

- `4y6x-dmck` is **SMS AB PassProperty**, covering active interstate and intrastate Hazmat
  carriers. `h9zy-gjn8` is **SMS C PassProperty**, covering active intrastate non-Hazmat
  carriers. Both are public SODA-tabular datasets, have one carrier per row, use the same
  21-column contract, and are disjoint. Both are required for complete Texas coverage.
- Their exact 21-column schema includes `dot_number`, `insp_total`, `driver_insp_total`,
  `driver_oos_insp_total`, `vehicle_insp_total`, `vehicle_oos_insp_total`, and BASIC measure /
  Acute-Critical fields. They contain **no crash totals and no safety-rating columns**.
- `sjpe-nzai` is only an href/catalog entry pointing to the separate SMS raw-data download
  site, not a row-queryable SODA table. It is not a usable fallback for this pipeline.
- `az4n-8mr2` directly exposes `safety_rating` and `safety_rating_date`. Live values use compact
  `S`, `C`, and `U` codes, which map to Satisfactory, Conditional, and Unsatisfactory; dates
  are `YYYYMMDD` text.
- `4wxs-vbns` is the row-queryable **SMS Input - Crash** event dataset. It has crash events and
  `fatalities`, `injuries`, `tow_away`, and `not_preventable`, but sample analysis found that
  apparent report identifiers are not globally unique enough to aggregate safely without a
  separately reviewed event-key contract. Crash totals therefore remain unset rather than
  guessed; this prevents false `recent_crashes` warnings.

`sources/safety.ts` now selects only the verified inspection fields, sources ratings from the
Company Census dataset, validates impossible totals and unknown codes fail-closed, and supports
an isolated capped `--dry-run=true` path. Permanent crash aggregation remains a deliberate
follow-up after deduplication tests.

---

## 3. Recommended changes to Part B §2.3's mapping table

Concrete edits (not applied to `docs/` per this task's constraints — for whoever next touches
that file):

| Part B §2.3 says | Should say | Why |
|---|---|---|
| `company_officer_1` → `contact_name_1` | `company_officer_1` → `company_officer_1` | Reconciliation amendment #1 already overrides this; §2.3's own table text is stale relative to the reconciliation section above it |
| `crgo_cargoothr_desc` → `cargo_other_raw` | `crgo_cargoothr_desc` → `crgo_cargoothr_desc` | Reconciliation amendment #7 already overrides this; same staleness |
| `carrier_mailing_city*`,`carrier_mailing_state*` (⚠️R5 flagged) | same, flag removed | CONFIRMED this session, §1.2 above |
| `crgo_motoveh`(⚠️R5: "one repo spells `crgo_motorveh`") | `crgo_motoveh` (confirmed; no `crgo_motorveh` evidence found anywhere) | §1.3 above |
| `owntruck,owntract,owntrail (+ termtruck…,triptruck… ⚠️R5)` | `owntruck,owntract,owntrail,owncoach` (+ `trmtruck,trmtract,trmtrail` term-leased, `trptruck,trptract,trptrail` trip-leased) | §1.6 above — prefixes were wrong, and `owncoach` was missing entirely |

No other changes recommended to §2.3 from this session's research — everything else in that
table is either already confirmed (§1.5, §1.7 above) or remains genuinely open pending a live
probe (§1.4, §2 above), matching Part B's own existing ⚠️ flags.

---

## Sources

- [kshivam4781/FMCSA-SOI-Data](https://github.com/kshivam4781/FMCSA-SOI-Data) — README + `fmcsa_api_client.py` + `get_ca_companies.py` (new source this session; not cited in Part B's original research)
- [axelm6/CarrierSearch](https://github.com/axelm6/CarrierSearch) — `api/carriers.js` (re-confirmed; also cited in Part B)
- [lazizbekravshanov/fleetsight](https://github.com/lazizbekravshanov/fleetsight) — `pipeline/ingest.py` (re-confirmed; also cited in Part B)
- [awwsquared/carrier-compass](https://github.com/awwsquared/carrier-compass) — `pipeline/fetch/fetch_census.py`, `db/schema.sql` (new source this session; fetches with no `$select`, not independently useful for field-name confirmation but consulted)
- FMCSA "Operation Classification" definitions — content reached only via search-engine synthesis; direct fetch of `li-public.fmcsa.dot.gov/mcmisfile/operation_classification.htm` returned HTTP 403 this session
- FMCSA "What is the definition of an authorized for-hire carrier?" / "exempt for-hire" FAQ pages — same access caveat, `www.fmcsa.dot.gov` returned HTTP 403 to direct fetch
- Company Census File dataset page: https://data.transportation.gov/Trucking-and-Motorcoaches/Company-Census-File/az4n-8mr2 (referenced by search results; not directly fetchable this session — HTTP 403)
- ActPendInsur dataset page: https://data.transportation.gov/Trucking-and-Motorcoaches/ActPendInsur-All-With-History/qh9u-swkp (same caveat)

All URLs above that note "HTTP 403" or "not directly fetchable" were attempted via this
session's fetch tool and blocked; they are listed because they were still useful as *search
targets* whose indexed content could be synthesized, per the CONFIRMED/CORROBORATED items
above — re-attempt direct fetches from an unproxied environment (e.g. the Render worker itself,
per Part B §7's own instruction) before relying on anything in §2 of this document.
