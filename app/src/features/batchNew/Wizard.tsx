/**
 * Stub — docs/build-plan/02-frontend-spec.md §3b. Real screen: 4-step
 * stepper (Details / Lanes / Freight / Filters & Review) with a persistent
 * right-hand live map and a fixed footer (live count via countCarriers(),
 * Back/Next, "Grab Batch"). Route already gated to manager|edit.
 */
export default function Wizard() {
  return (
    <div className="rounded-lg border border-border bg-surface p-8">
      <h1 className="font-ui text-2xl font-extrabold text-text">New Batch</h1>
      <p className="mt-2 max-w-2xl text-sm text-text-muted">
        Stub screen. Steps 1-4 (Details, Lanes, Freight, Filters & Review), the live map, and
        the live-count footer land here.
      </p>
    </div>
  );
}
