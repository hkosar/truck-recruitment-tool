/**
 * Stub — docs/build-plan/02-frontend-spec.md §3a. Real screen: PageHeader
 * ("New Batch" hidden for view role) + StatStrip (dashboard_totals()) +
 * ~44vh overview MapCanvas (batch_dashboard.zones, one pin per batch) +
 * client-side DataTable of batch_dashboard rows (F3/F4/G2).
 */
export default function Dashboard() {
  return (
    <div className="rounded-lg border border-border bg-surface p-8">
      <h1 className="font-ui text-2xl font-extrabold text-text">Dashboard</h1>
      <p className="mt-2 max-w-2xl text-sm text-text-muted">
        Stub screen. StatStrip, the all-active-batches overview map, and the batch table land
        here once dashboardTotals()/batch_dashboard and MapCanvas exist.
      </p>
    </div>
  );
}
