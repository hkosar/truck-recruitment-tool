import { useParams, useSearchParams } from 'react-router-dom';

/**
 * Stub — docs/build-plan/02-frontend-spec.md §3d. Real screen: identity
 * header, verification tiles (insurance/safety/inspections), contact
 * panel, unified timeline, batch memberships, research links. Three "M0"
 * design variants (Dossier / Command Console / Verification Ledger) get
 * built behind a dev-only switcher under features/carrier/variants/.
 */
export default function CarrierProfile() {
  const { dot } = useParams<{ dot: string }>();
  const [searchParams] = useSearchParams();
  const batchId = searchParams.get('batch');

  return (
    <div className="rounded-lg border border-border bg-surface p-8">
      <h1 className="font-ui text-2xl font-extrabold text-text">Carrier Profile</h1>
      <p className="mt-2 max-w-2xl text-sm text-text-muted">
        Stub screen. Identity header, verification tiles, contact panel, unified timeline, batch
        memberships, and research links land here.
      </p>
      <dl className="mt-4 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
        <dt className="text-text-subtle">USDOT</dt>
        <dd className="font-mono text-text">{dot}</dd>
        <dt className="text-text-subtle">batch context</dt>
        <dd className="font-mono text-text">{batchId ?? '(none)'}</dd>
      </dl>
    </div>
  );
}
