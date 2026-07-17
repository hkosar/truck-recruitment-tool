import { Link } from 'react-router-dom';

/** docs/build-plan/02-frontend-spec.md §1.2: `*` -> 404 -> link to
 * Dashboard. */
export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-border bg-surface p-12 text-center">
      <h1 className="font-ui text-2xl font-extrabold text-text">Page not found</h1>
      <p className="max-w-md text-sm text-text-muted">
        That route doesn't exist. If you followed a link here, it may be out of date.
      </p>
      <Link
        to="/dashboard"
        className="mt-2 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:bg-accent-hover"
      >
        Back to Dashboard
      </Link>
    </div>
  );
}
