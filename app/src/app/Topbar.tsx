import { Link, useLocation } from 'react-router-dom';

/**
 * TNBS navy app bar: approved badge/wordmark, breadcrumbs, global-search
 * affordance, and truthful connection state. The system is light-only.
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
      className="flex shrink-0 items-center gap-5 border-b border-bar-line bg-bar px-4 text-bar-ink"
      style={{ height: 'var(--topbar-h)' }}
    >
      <Link to="/dashboard" className="flex shrink-0 items-center gap-2.5" aria-label="Twisted Nail Carrier Recruiter dashboard">
        <img src="/brand/badge-white.png" alt="" className="h-8 w-8 object-contain" />
        <img src="/brand/primary-white.png" alt="Twisted Nail" className="h-7 w-auto object-contain" />
      </Link>

      <nav aria-label="Breadcrumb" className="hidden min-w-0 items-center gap-1.5 text-xs text-white/70 lg:flex">
        <span className="font-semibold text-white">Carrier Recruiter</span>
        {segments.map((segment, index) => (
          <span key={`${segment}-${index}`} className="flex min-w-0 items-center gap-1.5">
            <span className="text-white/35">/</span>
            <span className={index === segments.length - 1 ? 'truncate font-semibold text-white' : 'truncate'}>{labelFor(segment)}</span>
          </span>
        ))}
      </nav>

      <div className="ml-auto flex items-center gap-3">
        <span
          aria-label="Global search is deferred for this staging handoff"
          title="Global search is not included in this staging handoff"
          className="hidden w-64 cursor-not-allowed border border-white/15 bg-white/5 px-3 py-2 text-xs text-white/45 xl:block"
        >
          Global search · coming later
        </span>
        <LiveBadge />
      </div>
    </header>
  );
}

function LiveBadge() {
  // TODO: wire to lib/realtime.ts channel state (SUBSCRIBED -> green,
  // reconnecting -> amber) once that module exists (02 §1.4/§3). Neutral
  // "Idle" here rather than faking a connected state.
  return (
    <div className="flex items-center gap-1.5 rounded-full border border-white/25 bg-white/10 px-2.5 py-1 text-xs font-semibold text-white/75">
      <span className="h-1.5 w-1.5 rounded-full bg-white/55" />
      Idle
    </div>
  );
}
