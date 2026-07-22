import { supabase } from './supabase';
import type { Json } from '../types/database';
import type {
  BatchMemberRow,
  BatchMembersMapRow,
  BatchMembersSort,
  BatchStatusCounts,
  CargoFlagCountRow,
  Channel,
  ContactSheetRow,
  CountCarriersResult,
  CreateBatchResult,
  DashboardTotals,
  FacetOtherValueRow,
  FacetSuggestedKeywordRow,
  RefreshBatchResult,
  SearchCarrierRow,
  SearchCarriersMapRow,
  SearchCarriersSort,
  SearchDefinition,
  SortDir,
  Status,
} from '../types/domain';

/**
 * Typed wrapper functions for every CANONICAL RPC — docs/build-plan/
 * 01-architecture.md §5 + the Contract reconciliation section + amendments
 * #3/#8/#9/#10/#11. These are the RPC NAMES the database actually exposes;
 * 02-frontend-spec.md's table used working aliases while drafting (mapping
 * below, from 01's reconciliation section) — call sites should import from
 * here, never call `supabase.rpc(...)` directly.
 *
 *   search_count        -> count_carriers          batch_status_counts()   is a NEW RPC (amendment #11)
 *   search_preview       -> search_carriers          dashboard_totals()      is a NEW RPC (amendment #11)
 *   batch_geojson        -> batch_dashboard.zones / batch_members_map / search_carriers_map (views/RPCs, not here)
 *   dashboard_batches     -> batch_dashboard view (plain select, not an RPC — not here)
 *   set_batch_status(1)   -> plain PATCH batch_carriers (not here); (bulk) -> bulk_set_status
 *   log_contact           -> plain INSERT contact_logs (not here)
 *   add_comment           -> plain INSERT batch_activity (not here)
 *   set_dnc               -> set_do_not_contact
 *   mark_promoted         -> plain PATCH batch_carriers.promoted_at (not here)
 *
 * Plain PostgREST reads/writes (01 §5.4's "no RPC" list, plus row-shaped
 * reads like the carrier profile embed and the batch_dashboard/
 * carrier_warnings views) are deliberately NOT wrapped here — this file's
 * job is exactly "every CANONICAL RPC". Those calls belong next to the
 * feature code that issues them (or a future `lib/queries.ts`).
 *
 * Every wrapper accepts an optional AbortSignal, threaded through
 * `.abortSignal()` so TanStack Query can cancel a superseded live-count/
 * facet/search request (§4 performance plan). Calls stay POST throughout —
 * the supabase-js `{ get: true }` RPC option would enable HTTP caching, but
 * risks URL-length limits on large search_definition payloads (corridor
 * lanes carry a polyline), so it's deliberately not used here.
 */

/**
 * jsonb args boundary: a concrete SearchDefinition interface isn't
 * structurally assignable to the recursive `Json` union (index-signature
 * assignability is one of TS's genuinely awkward corners — plain interfaces
 * don't implicitly satisfy `{ [key: string]: Json }` the way object
 * literals sometimes do), so every RPC that takes `p_definition` casts
 * through this single, obvious point instead of fighting the type checker.
 */
function toJson<T>(value: T): Json {
  return value as unknown as Json;
}

/** `returns table(...)` functions that are conceptually single-row
 * aggregates (count_carriers, create_batch, ...) still come back as an
 * array (Postgres set-returning semantics) — unwrap with a clear error if
 * the RPC ever returns nothing, instead of silently handing back
 * `undefined`. */
function firstRow<T>(rows: T[] | null, fnName: string): T {
  const row = rows?.[0];
  if (!row) throw new Error(`${fnName}: expected one row, got none`);
  return row;
}

/** Generated Supabase RPC types represent optional Postgres arguments as
 * `value | undefined`; sending `undefined` omits the argument so the database
 * default (including explicit SQL NULL defaults) is applied. */
function optional<T>(value: T | null | undefined): T | undefined {
  return value ?? undefined;
}

// ---------------------------------------------------------------------------
// 01 §5.1 — paged results (search builder + pre-batch review)
// ---------------------------------------------------------------------------
export interface SearchCarriersOptions {
  page?: number;
  pageSize?: number;
  sort?: SearchCarriersSort;
  dir?: SortDir;
  signal?: AbortSignal;
}

export async function searchCarriers(
  definition: SearchDefinition,
  options: SearchCarriersOptions = {},
): Promise<{ rows: SearchCarrierRow[]; total: number }> {
  const query = supabase.rpc('search_carriers', {
    p_definition: toJson(definition),
    p_page: options.page ?? 1,
    p_page_size: options.pageSize ?? 50,
    p_sort: options.sort ?? 'legal_name',
    p_dir: options.dir ?? 'asc',
  });
  const { data, error } = options.signal ? await query.abortSignal(options.signal) : await query;
  if (error) throw error;
  const rows = data ?? [];
  return { rows, total: rows[0]?.total_count ?? 0 };
}

// ---------------------------------------------------------------------------
// 01 §5.2 — live match counter (F13 live editing, G10 honest coverage;
// amendment #11 adds tier1_count). Also the primitive behind per-lane
// contribution counts: call this N times with a single-zone definition,
// client-side, debounced (amendment #11) — that orchestration belongs in
// the wizard, not here.
// ---------------------------------------------------------------------------
export async function countCarriers(definition: SearchDefinition, signal?: AbortSignal): Promise<CountCarriersResult> {
  const query = supabase.rpc('count_carriers', { p_definition: toJson(definition) });
  const { data, error } = signal ? await query.abortSignal(signal) : await query;
  if (error) throw error;
  return firstRow(data, 'count_carriers');
}

// ---------------------------------------------------------------------------
// 01 §5.3 / F14 — the "Other cargo" facet browser
// ---------------------------------------------------------------------------
export async function facetOtherValues(
  definition: SearchDefinition,
  options: { keyword?: string | null; limit?: number; offset?: number; signal?: AbortSignal } = {},
): Promise<FacetOtherValueRow[]> {
  const query = supabase.rpc('facet_other_values', {
    p_definition: toJson(definition),
    p_keyword: optional(options.keyword),
    p_limit: options.limit ?? 100,
    p_offset: options.offset ?? 0,
  });
  const { data, error } = options.signal ? await query.abortSignal(options.signal) : await query;
  if (error) throw error;
  return data ?? [];
}

export async function facetSuggestedKeywords(
  definition: SearchDefinition,
  signal?: AbortSignal,
): Promise<FacetSuggestedKeywordRow[]> {
  const query = supabase.rpc('facet_suggested_keywords', { p_definition: toJson(definition) });
  const { data, error } = signal ? await query.abortSignal(signal) : await query;
  if (error) throw error;
  return data ?? [];
}

/** Contract reconciliation item #3 — approved ADDITION to Part A §5: the 30
 * cargo-checkbox live counts (F14/G8). Same SCOPE RULE as
 * facetOtherValues() (counts computed with `cargo` removed from the
 * definition) — callers pass the already-scoped definition; this wrapper
 * doesn't strip it itself. */
export async function facetCargoFlags(definition: SearchDefinition, signal?: AbortSignal): Promise<CargoFlagCountRow[]> {
  const query = supabase.rpc('facet_cargo_flags', { p_definition: toJson(definition) });
  const { data, error } = signal ? await query.abortSignal(signal) : await query;
  if (error) throw error;
  return data ?? [];
}

// ---------------------------------------------------------------------------
// 01 §5.4 — batch operations (VOLATILE)
// ---------------------------------------------------------------------------
export async function createBatch(args: {
  name: string;
  customer?: string | null;
  job?: string | null;
  description?: string | null;
  definition: SearchDefinition;
}): Promise<CreateBatchResult> {
  const { data, error } = await supabase.rpc('create_batch', {
    p_name: args.name,
    p_customer: args.customer ?? '',
    p_job: args.job ?? '',
    p_description: args.description ?? '',
    p_definition: toJson(args.definition),
  });
  if (error) throw error;
  return firstRow(data, 'create_batch');
}

export async function refreshBatch(batchId: string): Promise<RefreshBatchResult> {
  const { data, error } = await supabase.rpc('refresh_batch', { p_batch_id: batchId });
  if (error) throw error;
  return firstRow(data, 'refresh_batch');
}

/** Bulk status change (BulkBar "Mark status…", F5/F11). A single-row status
 * change is a plain `PATCH batch_carriers` instead (01 §5.4) — see this
 * file's header. */
export async function bulkSetStatus(batchId: string, dots: number[], status: Status): Promise<number> {
  const { data, error } = await supabase.rpc('bulk_set_status', {
    p_batch_id: batchId,
    p_dots: dots,
    p_status: status,
  });
  if (error) throw error;
  return data ?? 0;
}

/** Global DNC toggle (F23 sibling / profile header). Logs into every batch
 * currently containing the carrier (01 §5.4 locked rule). */
export async function setDoNotContact(dot: number, on: boolean, reason?: string | null): Promise<void> {
  const { error } = await supabase.rpc('set_do_not_contact', {
    p_dot: dot,
    p_on: on,
    p_reason: optional(reason),
  });
  if (error) throw error;
}

/** Sheet/CSV exports write activity (01 amendment #19) so F11's feed
 * records them — call after a successful Print/Export action. */
export async function logExport(batchId: string, kind: 'call_sheet' | 'csv', rowCount: number): Promise<void> {
  const { error } = await supabase.rpc('log_export', {
    p_batch_id: batchId,
    p_kind: kind,
    p_row_count: rowCount,
  });
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// 01 §5.5, extended by reconciliation item #3 — batch working page
// ---------------------------------------------------------------------------
export interface BatchMembersFilters {
  status?: Status[] | null;
  q?: string | null;
  warningsOnly?: boolean;
  minInsurance?: number | null;
  sizeMin?: number | null;
  sizeMax?: number | null;
  hasPhone?: boolean | null;
  hasEmail?: boolean | null;
}

export interface BatchMembersOptions extends BatchMembersFilters {
  page?: number;
  pageSize?: number;
  sort?: BatchMembersSort;
  dir?: SortDir;
  signal?: AbortSignal;
}

export async function batchMembers(
  batchId: string,
  options: BatchMembersOptions = {},
): Promise<{ rows: BatchMemberRow[]; total: number }> {
  const query = supabase.rpc('batch_members', {
    p_batch_id: batchId,
    p_status: optional(options.status),
    p_q: optional(options.q),
    p_warnings_only: options.warningsOnly ?? false,
    p_min_insurance: optional(options.minInsurance),
    p_size_min: optional(options.sizeMin),
    p_size_max: optional(options.sizeMax),
    p_has_phone: optional(options.hasPhone),
    p_has_email: optional(options.hasEmail),
    p_page: options.page ?? 1,
    p_page_size: options.pageSize ?? 50,
    p_sort: options.sort ?? 'status',
    p_dir: options.dir ?? 'asc',
  });
  const { data, error } = options.signal ? await query.abortSignal(options.signal) : await query;
  if (error) throw error;
  const rows = data ?? [];
  return { rows, total: rows[0]?.total_count ?? 0 };
}

/** amendment #10: same filters as batchMembers() + p_sort/p_dir, returning
 * `row_num` so "list # = pin #" holds under every sort/filter (M5.3 AC). Up
 * to ~5,000 lightweight pins for the batch map view (F22). */
export async function batchMembersMap(
  batchId: string,
  options: BatchMembersFilters & { sort?: BatchMembersSort; dir?: SortDir; signal?: AbortSignal } = {},
): Promise<BatchMembersMapRow[]> {
  const query = supabase.rpc('batch_members_map', {
    p_batch_id: batchId,
    p_status: optional(options.status),
    p_q: optional(options.q),
    p_warnings_only: options.warningsOnly ?? false,
    p_min_insurance: optional(options.minInsurance),
    p_size_min: optional(options.sizeMin),
    p_size_max: optional(options.sizeMax),
    p_has_phone: optional(options.hasPhone),
    p_has_email: optional(options.hasEmail),
    p_sort: options.sort ?? 'status',
    p_dir: options.dir ?? 'asc',
  });
  const { data, error } = options.signal ? await query.abortSignal(options.signal) : await query;
  if (error) throw error;
  return data ?? [];
}

/** Live builder map overlay (F13) — up to `limit` (default 5,000) pins for
 * the in-progress SearchDefinition. */
export async function searchCarriersMap(
  definition: SearchDefinition,
  options: { limit?: number; signal?: AbortSignal } = {},
): Promise<SearchCarriersMapRow[]> {
  const query = supabase.rpc('search_carriers_map', {
    p_definition: toJson(definition),
    p_limit: options.limit ?? 5000,
  });
  const { data, error } = options.signal ? await query.abortSignal(options.signal) : await query;
  if (error) throw error;
  return data ?? [];
}

/** Backs both the Contact Options sheet preview and the printable
 * /batches/:id/sheet (F9) — hard-excludes do_not_contact carriers
 * server-side. `dots: null` (default) = whole batch. */
export async function generateContactSheet(
  batchId: string,
  dots: number[] | null = null,
): Promise<ContactSheetRow[]> {
  const { data, error } = await supabase.rpc('generate_contact_sheet', {
    p_batch_id: batchId,
    p_dots: optional(dots),
  });
  if (error) throw error;
  return data ?? [];
}

// ---------------------------------------------------------------------------
// amendment #11 — new RPCs
// ---------------------------------------------------------------------------
/** Status filter chips + StatStrip counts (F5/F24). Supersedes the earlier
 * "read status_counts off batch_dashboard" plan in 01's reconciliation
 * section item #2 — this is the richer, purpose-built replacement. Column
 * naming (`<status>_count`) is a reasonable reconstruction: the amendment's
 * prose specifies the fields returned ("per-status counts + dnc_count +
 * warnings_count + with_phone + with_email"), not literal SQL — confirm
 * against the real migration once M1.2 cuts it. */
export async function batchStatusCounts(batchId: string, signal?: AbortSignal): Promise<BatchStatusCounts> {
  const query = supabase.rpc('batch_status_counts', { p_batch_id: batchId });
  const { data, error } = signal ? await query.abortSignal(signal) : await query;
  if (error) throw error;
  return firstRow(data, 'batch_status_counts');
}

/** Dashboard StatStrip (F24): active batches / distinct carriers in play /
 * with phone / interested / promoted. */
export async function dashboardTotals(signal?: AbortSignal): Promise<DashboardTotals> {
  const query = supabase.rpc('dashboard_totals');
  const { data, error } = signal ? await query.abortSignal(signal) : await query;
  if (error) throw error;
  return firstRow(data, 'dashboard_totals');
}

// ---------------------------------------------------------------------------
// 01 §5.6 — compliance helper (call-sheet today; email/SMS modules later)
// ---------------------------------------------------------------------------
export async function isContactable(dot: number, channel: Channel, signal?: AbortSignal): Promise<boolean> {
  const query = supabase.rpc('is_contactable', { p_dot: dot, p_channel: channel });
  const { data, error } = signal ? await query.abortSignal(signal) : await query;
  if (error) throw error;
  return data ?? false;
}
