import { useParams, useSearchParams } from 'react-router-dom';

/**
 * Stub — docs/build-plan/02-frontend-spec.md §3c. Real screen: header +
 * ActivityFeed + StatStrip + status filter chips + toolbar + virtualized
 * members table + map view + BulkBar. URL-synced via
 * ?view=list|map&status=&q= (shareable).
 */
export default function BatchPage() {
  const { batchId } = useParams<{ batchId: string }>();
  const [searchParams] = useSearchParams();

  return (
    <div className="rounded-lg border border-border bg-surface p-8">
      <h1 className="font-ui text-2xl font-extrabold text-text">Batch</h1>
      <p className="mt-2 max-w-2xl text-sm text-text-muted">
        Stub screen. Header, ActivityFeed, StatStrip, status chips, toolbar, the virtualized
        members table, map view, and BulkBar land here.
      </p>
      <dl className="mt-4 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
        <dt className="text-text-subtle">batchId</dt>
        <dd className="font-mono text-text">{batchId}</dd>
        <dt className="text-text-subtle">view</dt>
        <dd className="font-mono text-text">{searchParams.get('view') ?? '(default)'}</dd>
      </dl>
    </div>
  );
}
