/**
 * Stub — docs/build-plan/02-frontend-spec.md §3f. Real screen:
 * pending-approval card (approve modal with Editor/Viewer radio, reject) +
 * active-users table (role select, suspend/restore, "you" lock on self).
 * Route already gated to manager.
 */
export default function UsersAdmin() {
  return (
    <div className="rounded-lg border border-border bg-surface p-8">
      <h1 className="font-ui text-2xl font-extrabold text-text">Users</h1>
      <p className="mt-2 max-w-2xl text-sm text-text-muted">
        Stub screen. The pending-approval card and the active-users table land here.
      </p>
    </div>
  );
}
