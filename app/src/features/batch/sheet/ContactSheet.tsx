import { useParams } from 'react-router-dom';

/**
 * Stub — docs/build-plan/02-frontend-spec.md §3e. Real screen: printable
 * call sheet (batch name/customer/job header, date, generated-by, one row
 * per selected carrier with a blank notes line, auto window.print() on
 * load). Selection reads from sessionStorage["sheet:"+batchId]. No
 * AppShell chrome (see app/router.tsx) — this route opens in a new tab.
 * Uses the normal theme tokens for now; the real implementation should add
 * `@media print` rules to force a plain white/black page regardless of the
 * viewer's light/dark preference.
 */
export default function ContactSheet() {
  const { batchId } = useParams<{ batchId: string }>();

  return (
    <div className="min-h-dvh bg-bg p-10 text-text">
      <h1 className="font-ui text-xl font-extrabold">Contact Sheet — stub</h1>
      <p className="mt-2 max-w-2xl text-sm text-text-muted">
        Stub screen. The printable call sheet (via generateContactSheet()) lands here, with
        window.print() firing automatically on load.
      </p>
      <p className="mt-4 font-mono text-xs text-text-subtle">batchId: {batchId}</p>
    </div>
  );
}
