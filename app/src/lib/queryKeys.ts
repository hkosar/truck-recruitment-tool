/**
 * TanStack Query key catalog — docs/build-plan/02-frontend-spec.md §1.3.
 * Server state lives ONLY in TanStack Query (never Zustand); every query in
 * the app should get its key from here so invalidation (incl. the
 * realtime-driven invalidation in the future lib/realtime.ts) has one place
 * to target. Keys are plain readonly tuples — `as const` keeps literal
 * segments (e.g. 'counts') narrowed instead of widening to `string`.
 */

export const queryKeys = {
  dashboard: () => ['dashboard'] as const,
  dashboardTotals: () => ['dashboard', 'totals'] as const,

  batch: (batchId: string) => ['batch', batchId] as const,
  batchCounts: (batchId: string) => ['batch', batchId, 'counts'] as const,
  /** filtersHash = a stable serialization of the toolbar's current filters
   * (status[], q, warningsOnly, minInsurance, size range, contactability,
   * sort/dir) — infinite query, paged via batch_members (F5/G3). */
  batchMembers: (batchId: string, filtersHash: string) => ['batch', batchId, 'members', filtersHash] as const,
  batchActivity: (batchId: string) => ['batch', batchId, 'activity'] as const,
  batchGeojson: (batchId: string) => ['batch', batchId, 'geojson'] as const,

  carrier: (dot: number) => ['carrier', dot] as const,
  carrierTimeline: (dot: number) => ['carrier', dot, 'timeline'] as const,
  carrierMemberships: (dot: number) => ['carrier', dot, 'memberships'] as const,

  /** defHash = a stable serialization of the in-progress SearchDefinition
   * (wizard live count/preview, G3/G10). */
  searchCount: (defHash: string) => ['search', 'count', defHash] as const,
  searchPreview: (defHash: string) => ['search', 'preview', defHash] as const,

  /** scopeHash = SearchDefinition with the `cargo` key removed (facet SCOPE
   * RULE, 01 §5.3) so facet counts aren't biased by the selection being
   * built. */
  facetOther: (scopeHash: string, q: string) => ['facet', 'other', scopeHash, q] as const,
  facetCargo: (scopeHash: string) => ['facet', 'cargo', scopeHash] as const,

  users: () => ['users'] as const,
  pendingUsersCount: () => ['users', 'pending-count'] as const,
  /** current signed-in profile (app/guards.tsx useSession()). */
  me: () => ['me'] as const,
};
