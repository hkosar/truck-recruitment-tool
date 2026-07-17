/**
 * App-facing domain types. docs/build-plan/02-frontend-spec.md §1.1 lists
 * this file as "Lane, SearchDefinition, WarningCode, Channel, Status, etc."
 *
 * Two families of type live here:
 *  1. Aliases DERIVED from types/database.ts via indexed access (Status,
 *     Channel, the *Row RPC-result shapes, ...) — single source of truth,
 *     zero duplication, and they keep resolving correctly once database.ts
 *     is replaced by real `supabase gen types` output.
 *  2. HAND-WRITTEN shapes with no Postgres-enum or stubbed-Table backing
 *     yet (SearchDefinition, LaneDraft, Pin, WarningCode, the 30 cargo
 *     flags, ...) — these model jsonb contracts and pure UI concepts, not
 *     generated-typeable columns. WarningCode in particular is a closed
 *     vocabulary enforced by a SQL *function* (internal.warning_reasons),
 *     not a Postgres enum, so there is nothing to derive it from; RPC rows
 *     type `warning_reasons` as the raw `string[]` the SQL function
 *     actually returns (see database.ts) — narrow to `WarningCode[]` at the
 *     UI boundary if a component wants the stronger guarantee.
 */
import type { Database, Json } from './database';

// ---------------------------------------------------------------------------
// Enum aliases (derived — 01 §2.2)
// ---------------------------------------------------------------------------
export type UserRole = Database['public']['Enums']['user_role'];
export type UserStatus = Database['public']['Enums']['user_status']; // amendment #14: 'disabled', not "suspended"
export type Status = Database['public']['Enums']['batch_carrier_status'];
export type Channel = Database['public']['Enums']['contact_channel'];
export type ContactDisposition = Database['public']['Enums']['contact_disposition']; // amendment #9: + 'no_response'
export type ZoneType = Database['public']['Enums']['zone_type'];
export type AnchorKind = Database['public']['Enums']['anchor_kind']; // F12 order: pin|address|city|zip|county
export type GeocodePrecision = Database['public']['Enums']['geocode_precision'];
export type AuthorityStatus = Database['public']['Enums']['authority_status'];
export type ActivityType = Database['public']['Enums']['activity_type'];
export type SuppressionChannel = Database['public']['Enums']['suppression_channel'];
export type SuppressionSource = Database['public']['Enums']['suppression_source'];
export type SyncSource = Database['public']['Enums']['sync_source'];

/** StatusBadge's UI-only pseudo-status (02 §5: `status={Status|"dnc"}`). */
export type DisplayStatus = Status | 'dnc';

export const STATUS_VALUES: Status[] = ['new', 'attempted', 'contacted', 'interested', 'not_a_fit'];

/** Per-channel disposition subsets shown by LogContactModal (02 §3d). The
 * `contact_disposition` enum itself stays permissive DB-side — channel <->
 * disposition compatibility is a UI concern (01 §2.2 comment). */
export const DISPOSITIONS_BY_CHANNEL: Record<Extract<Channel, 'call' | 'text' | 'email'>, ContactDisposition[]> = {
  call: ['connected', 'no_answer', 'voicemail', 'callback', 'interested', 'not_interested', 'wrong_number'],
  text: ['sent', 'replied', 'no_response', 'wrong_number'],
  email: ['sent', 'replied', 'bounced', 'no_response'],
};

// ---------------------------------------------------------------------------
// Warnings — amendment #8, CLOSED NINE-code vocabulary (supersedes 02's
// original 5-code list and 01 §3's original 7-code function body).
// lib/warnings.ts maps each code to {label, tone}.
// ---------------------------------------------------------------------------
export type WarningCode =
  | 'carrier_inactive'
  | 'no_insurance'
  | 'insurance_below_standard'
  | 'insurance_expiring_30d'
  | 'authority_not_active'
  | 'safety_rating'
  | 'high_oos'
  | 'recent_crashes'
  | 'missing_from_source';

// ---------------------------------------------------------------------------
// Cargo — the 30 crgo_* booleans (01 §2.4 / §2.3 field mapping, MCS-150 set)
// ---------------------------------------------------------------------------
export type CargoFlagName =
  | 'crgo_genfreight'
  | 'crgo_household'
  | 'crgo_metalsheet'
  | 'crgo_motoveh'
  | 'crgo_drivetow'
  | 'crgo_logpole'
  | 'crgo_bldgmat'
  | 'crgo_mobilehome'
  | 'crgo_machlrg'
  | 'crgo_produce'
  | 'crgo_liqgas'
  | 'crgo_intermodal'
  | 'crgo_passengers'
  | 'crgo_oilfield'
  | 'crgo_livestock'
  | 'crgo_grainfeed'
  | 'crgo_coalcoke'
  | 'crgo_meat'
  | 'crgo_garbage'
  | 'crgo_usmail'
  | 'crgo_chem'
  | 'crgo_drybulk'
  | 'crgo_coldfood'
  | 'crgo_beverages'
  | 'crgo_paperprod'
  | 'crgo_utility'
  | 'crgo_farmsupp'
  | 'crgo_construct'
  | 'crgo_waterwell'
  | 'crgo_cargoothr';

/** Tier-2 sand/gravel backstop flags (discovery §4 / 01 §2.3 mapping note). */
export const TIER2_BACKSTOP_FLAGS: CargoFlagName[] = ['crgo_drybulk', 'crgo_construct', 'crgo_bldgmat'];

// ---------------------------------------------------------------------------
// Lanes — UI "lane" = DB "zone" (01 reconciliation item #5, one concept).
//
// Two distinct shapes on purpose:
//  - LaneDraft: the wizard's editing-time convenience shape (02 §3b "Lane
//    draft shape" prose, field names `anchor`/`radius_mi`/`origin`/`dest`/
//    `buffer_mi`). Lives in the (not-yet-built) zustand wizardDraft slice /
//    features/batchNew/laneDraft.ts.
//  - SearchDefinitionZone (+ Radius/CorridorLaneParams): the wire shape
//    serialized into search_definition.zones[] for every RPC call and into
//    batch_zones.params once persisted (01 §4 jsonb contract, verbatim
//    field names `anchor_kind`/`anchor_label`/`radius_miles`/`origin_label`/
//    `dest_label`/`route`/`buffer_miles`). A transform function between the
//    two belongs in features/batchNew/laneDraft.ts (out of scope here).
// ---------------------------------------------------------------------------
export interface LaneAnchorDraft {
  kind: AnchorKind;
  label: string;
  lng: number;
  lat: number;
}

export interface LaneEndpointDraft {
  label: string;
  lng: number;
  lat: number;
}

export type LaneDraft =
  | {
      id: string;
      type: 'radius';
      /** amendment #18: owner's "material" label, user-editable, defaults to
       * a generated geographic string (e.g. "Austin · 55 mi"). */
      label?: string;
      anchor: LaneAnchorDraft;
      radius_mi: number;
    }
  | {
      id: string;
      type: 'corridor';
      label?: string;
      origin: LaneEndpointDraft;
      dest: LaneEndpointDraft;
      /** Google Routes API `computeRoutes` polyline (amendment #12), decoded
       * client-side before this point. */
      encoded_polyline?: string;
      buffer_mi: number;
    };

export interface RadiusLaneParams {
  anchor_kind: AnchorKind;
  anchor_label: string;
  lng: number;
  lat: number;
  radius_miles: number;
}

export interface CorridorLaneParams {
  origin_label: string;
  dest_label: string;
  route_provider: 'google' | 'osrm';
  /** decoded + simplified polyline, [lng, lat] pairs (01 §4). */
  route: [number, number][];
  buffer_miles: number;
}

export interface SearchDefinitionZone {
  zone_type: ZoneType;
  params: RadiusLaneParams | CorridorLaneParams;
}

/** A persisted `batch_zones` row (01 §2.6). Not yet backed by a
 * types/database.ts Table entry — add one and re-derive this once typegen
 * exists; hand-written for now, kept structurally aligned with the DDL. */
export interface Lane {
  id: string;
  batch_id: string;
  zone_type: ZoneType;
  label: string;
  params: RadiusLaneParams | CorridorLaneParams;
  distance_miles: number;
  sort_order: number;
  created_at: string;
}

// ---------------------------------------------------------------------------
// search_definition jsonb contract — SINGLE SOURCE OF TRUTH (01 §4).
//
// Field-name reconciliation: 01 §4's worked example uses `cargo.other.
// include`/`exclude` (no separate `keywords` array); 02 §3b's prose says
// `includes`/`excludes`/`keywords`. 01 is the authoritative contract (build-
// plan reconciliation rule) — the "Suggested keywords" chips add their term
// straight into `include`, they don't get their own serialized field.
// ---------------------------------------------------------------------------
export interface CargoOtherRules {
  enabled: boolean;
  include: string[];
  exclude: string[];
}

export interface CargoBlock {
  flags: CargoFlagName[];
  other: CargoOtherRules;
}

export interface ContactabilityBlock {
  has_phone: boolean;
  has_email: boolean;
}

export interface InsuranceBlock {
  /** dollars, not thousands (ingest already ×1000s the L&I figures). */
  min_bipd: number | null;
  /** false (default) = threshold is a highlight, never a silent exclusion
   * (locked rule; insurance_below_standard warning covers it instead). */
  enforce: boolean;
  require_insured: boolean;
}

export interface PowerUnitsBlock {
  min: number | null;
  max: number | null;
}

export interface StatusBlock {
  active_only: boolean;
  authorized_only: boolean;
  for_hire_only: boolean;
  interstate_only: boolean;
}

export interface SearchDefinition {
  /** 1..N, UNION semantics (F21). Absent/empty = statewide (geo optional). */
  zones?: SearchDefinitionZone[];
  cargo?: CargoBlock;
  contactability?: ContactabilityBlock;
  insurance?: InsuranceBlock;
  power_units?: PowerUnitsBlock;
  status?: StatusBlock;
  /** default true — DNC never enters new work. */
  exclude_dnc?: boolean;
}

/** jsonb args boundary cast (SearchDefinition -> Json is not a free
 * structural assignment — see lib/rpc.ts `toJson()`). Re-exported so
 * feature code doesn't need to reach into types/database.ts directly. */
export type { Json };

// ---------------------------------------------------------------------------
// Sort whitelists (01 §5.1 / §5.5 — never interpolated server-side; typed
// here so callers can't pass a column that isn't in the whitelist).
// ---------------------------------------------------------------------------
export type SearchCarriersSort = 'legal_name' | 'power_units' | 'phy_city' | 'dot_number' | 'bipd_on_file';
export type BatchMembersSort = 'status' | 'legal_name' | 'phy_city' | 'power_units' | 'last_contact_at' | 'added_at';
export type SortDir = 'asc' | 'desc';

// ---------------------------------------------------------------------------
// RPC result row aliases (derived — 01 §5 + amendments). `[number]` unwraps
// the array element type off a `returns table(...)` Function's Returns.
// ---------------------------------------------------------------------------
export type SearchCarrierRow = Database['public']['Functions']['search_carriers']['Returns'][number];
export type CountCarriersResult = Database['public']['Functions']['count_carriers']['Returns'][number];
export type FacetOtherValueRow = Database['public']['Functions']['facet_other_values']['Returns'][number];
export type FacetSuggestedKeywordRow = Database['public']['Functions']['facet_suggested_keywords']['Returns'][number];
export type CargoFlagCountRow = Database['public']['Functions']['facet_cargo_flags']['Returns'][number];
export type CreateBatchResult = Database['public']['Functions']['create_batch']['Returns'][number];
export type RefreshBatchResult = Database['public']['Functions']['refresh_batch']['Returns'][number];
export type BatchMemberRow = Database['public']['Functions']['batch_members']['Returns'][number];
export type BatchMembersMapRow = Database['public']['Functions']['batch_members_map']['Returns'][number];
export type SearchCarriersMapRow = Database['public']['Functions']['search_carriers_map']['Returns'][number];
export type ContactSheetRow = Database['public']['Functions']['generate_contact_sheet']['Returns'][number];
export type BatchStatusCounts = Database['public']['Functions']['batch_status_counts']['Returns'][number];
export type DashboardTotals = Database['public']['Functions']['dashboard_totals']['Returns'][number];

// ---------------------------------------------------------------------------
// Views (derived — 01 §5.5 batch_dashboard, 01 §3 carrier_warnings)
// ---------------------------------------------------------------------------
export type BatchSummary = Database['public']['Views']['batch_dashboard']['Row'];
export type CarrierWarningsRow = Database['public']['Views']['carrier_warnings']['Row'];

// ---------------------------------------------------------------------------
// Profile (derived — 01 §2.3)
// ---------------------------------------------------------------------------
export type Profile = Database['public']['Tables']['profiles']['Row'];

// ---------------------------------------------------------------------------
// Map pins (02 §2 Pin type + amendment #10's `warning` ring/legend row)
// ---------------------------------------------------------------------------
export interface Pin {
  /** dot_number as a string (marker element ids want strings). */
  id: string;
  lng: number;
  lat: number;
  /** row # in the current filtered+sorted list — list and map cross-
   * reference exactly (F22). */
  number?: number;
  /** resolved var(--st-*) hex, DNC pins resolve to var(--st-dnc). */
  color: string;
  label?: string;
  dnc?: boolean;
  /** amendment #10: crit-colored ring around the status fill + a "Needs
   * review" legend row, independent of dnc/status color. */
  warning?: boolean;
}
