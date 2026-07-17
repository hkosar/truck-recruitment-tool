import { useLocation } from 'react-router-dom';

/**
 * Topbar — breadcrumbs + Live badge (docs/build-plan/02-frontend-spec.md
 * §3 shared shell). Theme toggle + user menu live in Sidebar's footer
 * instead (see the note there) to avoid duplicating sign-out controls.
 */

const SEGMENT_LABELS: Record<string, string> = {
  dashboard: 'Dashboard',
  batches: 'Batches',
  new: 'New Batch',
  carriers: 'Carriers',
  users: 'Users',
  sheet: 'Contact Sheet',
};

function labelFor(segment: string): string {
  return SEGMENT_LABELS[segment] ?? segment;
}

export function Topbar() {
  const location = useLocation();
  const segments = location.pathname.split('/').filter(Boolean);

  return (
    <header
      className="flex shrink-0 items-center justify-between border-b border-border bg-surface px-6"
      style={{ height: 'var(--topbar-h)' }}
    >
      <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-text-muted">
        <span className="font-medium text-text">Home</span>
        {segments.map((segment, index) => (
          <span key={`${segment}-${index}`} className="flex items-center gap-1.5">
            <span className="text-text-subtle">/</span>
            <span className={index === segments.length - 1 ? 'font-medium text-text' : ''}>{labelFor(segment)}</span>
          </span>
        ))}
      </nav>

      <LiveBadge />
    </header>
  );
}

function LiveBadge() {
  // TODO: wire to lib/realtime.ts channel state (SUBSCRIBED -> green,
  // reconnecting -> amber) once that module exists (02 §1.4/§3). Neutral
  // "Idle" here rather than faking a connected state.
  return (
    <div className="flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs text-text-subtle">
      <span className="h-1.5 w-1.5 rounded-full bg-text-subtle" />
      Idle
    </div>
  );
}
