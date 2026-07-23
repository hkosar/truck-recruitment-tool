import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { usePermissions } from '../../app/guards';
import { fmtInt, fmtRel } from '../../lib/format';
import { queryKeys } from '../../lib/queryKeys';
import { dashboardTotals } from '../../lib/rpc';
import { supabase } from '../../lib/supabase';
import type { BatchSummary, DashboardTotals } from '../../types/domain';

const EMPTY_TOTALS: DashboardTotals = {
  active_batches: 0,
  distinct_carriers: 0,
  with_phone: 0,
  interested: 0,
  promoted: 0,
};

function statusCount(row: BatchSummary, key: string): number {
  const counts = row.status_counts;
  if (!counts || Array.isArray(counts) || typeof counts !== 'object') return 0;
  const value = counts[key];
  return typeof value === 'number' ? value : Number(value ?? 0);
}

function laneSummary(zones: BatchSummary['zones']): string {
  if (!Array.isArray(zones) || zones.length === 0) return 'Statewide';
  const labels = zones
    .map((zone) => {
      if (!zone || typeof zone !== 'object' || Array.isArray(zone)) return null;
      const value = zone.label;
      return typeof value === 'string' && value.trim() ? value.trim() : null;
    })
    .filter((label): label is string => Boolean(label));
  const prefix = `${zones.length} lane${zones.length === 1 ? '' : 's'}`;
  return labels.length ? `${prefix} — ${labels.slice(0, 2).join(' · ')}` : prefix;
}

async function loadDashboard(): Promise<{ totals: DashboardTotals; batches: BatchSummary[] }> {
  const [totals, batchesResult] = await Promise.all([
    dashboardTotals(),
    supabase
      .from('batch_dashboard')
      .select('*')
      .is('archived_at', null)
      .order('last_activity_at', { ascending: false, nullsFirst: false }),
  ]);
  if (batchesResult.error) throw batchesResult.error;
  const batches = Array.isArray(batchesResult.data) ? batchesResult.data : [];
  return { totals: totals ?? EMPTY_TOTALS, batches };
}

function StatStrip({ totals }: { totals: DashboardTotals }) {
  const stats = [
    ['Active batches', totals.active_batches],
    ['Carriers in play', totals.distinct_carriers],
    ['With phone', totals.with_phone],
    ['Interested', totals.interested],
    ['Promoted', totals.promoted],
  ] as const;
  return (
    <section aria-label="Recruiting totals" className="grid overflow-hidden border border-border bg-surface sm:grid-cols-2 lg:grid-cols-5">
      {stats.map(([label, value], index) => (
        <div key={label} className={`px-5 py-4 text-center ${index ? 'border-l border-border' : ''}`}>
          <div className="text-[10px] font-extrabold uppercase tracking-[0.09em] text-text-subtle">{label}</div>
          <div className="mt-1 text-2xl font-extrabold tabular-nums text-text">{fmtInt(value)}</div>
        </div>
      ))}
    </section>
  );
}

function LoadingState() {
  return (
    <div className="space-y-5" aria-label="Loading dashboard">
      <div className="h-20 animate-pulse border border-border bg-surface" />
      <div className="h-72 animate-pulse border border-border bg-surface" />
      <div className="h-52 animate-pulse border border-border bg-surface" />
    </div>
  );
}

export default function Dashboard() {
  const { canEdit } = usePermissions();
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: queryKeys.dashboard(),
    queryFn: loadDashboard,
    staleTime: 30_000,
  });

  if (query.isPending) return <LoadingState />;

  if (query.isError) {
    return (
      <section className="border border-crit bg-crit-tint p-5">
        <h1 className="text-xl font-extrabold">Dashboard unavailable</h1>
        <p className="mt-2 text-sm text-text-muted">{query.error instanceof Error ? query.error.message : 'The dashboard could not be loaded.'}</p>
        <button type="button" onClick={() => void query.refetch()} className="mt-4 border border-crit px-4 py-2 text-xs font-bold text-crit">
          Retry
        </button>
      </section>
    );
  }

  const totals = query.data?.totals ?? EMPTY_TOTALS;
  const batches = Array.isArray(query.data?.batches) ? query.data.batches : [];

  return (
    <div className="mx-auto max-w-[1500px] space-y-5">
      <header className="flex items-center justify-between gap-4">
        <h1 className="text-xl font-extrabold tracking-[-0.02em]">Dashboard</h1>
        {canEdit ? (
          <Link to="/batches/new" className="bg-accent px-4 py-2.5 text-xs font-bold text-accent-ink hover:bg-accent-hover">
            New Batch
          </Link>
        ) : null}
      </header>

      <StatStrip totals={totals} />

      {batches.length === 0 ? (
        <section className="border border-border bg-surface px-6 py-16 text-center">
          <h2 className="text-lg font-bold">No batches yet</h2>
          {canEdit ? (
            <Link to="/batches/new" className="mt-5 inline-block bg-accent px-4 py-2.5 text-xs font-bold text-accent-ink">
              Create your first recruitment batch
            </Link>
          ) : null}
        </section>
      ) : (
        <>
          <section className="grid min-h-72 border border-border bg-surface lg:grid-cols-[1fr_320px]">
            <div className="flex min-h-72 items-center justify-center bg-surface-2 p-8">
              <div className="max-w-md text-center">
                <div className="text-[10px] font-extrabold uppercase tracking-[0.09em] text-text-subtle">Batch map</div>
                <div className="mt-3 text-lg font-bold">Select a job to focus its lanes</div>
                <p className="mt-2 text-sm text-text-muted">Map provider setup is isolated from recruiting data. The job legend is ready while the restricted Google Maps credentials are owner-gated.</p>
              </div>
            </div>
            <div className="border-l border-border p-4">
              <div className="mb-3 text-[10px] font-extrabold uppercase tracking-[0.09em] text-text-subtle">Jobs</div>
              <div className="space-y-1">
                {batches.map((batch, index) => (
                  <button
                    key={batch.id}
                    type="button"
                    onClick={() => batch.id && navigate(`/batches/${batch.id}`)}
                    className="flex w-full items-center gap-3 border border-transparent px-2 py-2 text-left hover:border-border hover:bg-row-hover"
                  >
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent text-[10px] font-extrabold text-accent-ink">{index + 1}</span>
                    <span className="min-w-0">
                      <span className="block truncate text-xs font-bold text-text">{batch.name}</span>
                      <span className="block truncate text-[11px] text-text-subtle">{batch.customer || 'No customer'}{batch.job ? ` · ${batch.job}` : ''}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section className="overflow-x-auto border border-border bg-surface">
            <table className="w-full min-w-[1050px] border-collapse text-[13px]">
              <thead className="bg-th-bg text-left text-[10px] font-extrabold uppercase tracking-[0.07em] text-text-muted">
                <tr>
                  <th className="px-3 py-2.5">#</th><th className="px-3 py-2.5">Batch</th><th className="px-3 py-2.5">Lanes</th>
                  <th className="px-3 py-2.5 text-right">Carriers</th><th className="px-3 py-2.5 text-right text-st-new">New</th>
                  <th className="px-3 py-2.5 text-right text-st-attempted">Attempted</th><th className="px-3 py-2.5 text-right text-st-contacted">Contacted</th>
                  <th className="px-3 py-2.5 text-right text-st-interested">Interested</th><th className="px-3 py-2.5 text-right text-crit">Warnings</th>
                  <th className="px-3 py-2.5">Last activity</th>
                </tr>
              </thead>
              <tbody>
                {batches.map((batch, index) => (
                  <tr key={batch.id} tabIndex={0} onClick={() => batch.id && navigate(`/batches/${batch.id}`)} onKeyDown={(event) => {
                    if ((event.key === 'Enter' || event.key === ' ') && batch.id) navigate(`/batches/${batch.id}`);
                  }} className="cursor-pointer border-t border-border odd:bg-surface even:bg-zebra hover:bg-row-hover">
                    <td className="px-3 py-2.5 font-mono tabular-nums text-text-subtle">{index + 1}</td>
                    <td className="px-3 py-2.5"><div className="font-bold">{batch.name}</div><div className="text-[11px] text-text-subtle">{batch.customer || 'No customer'}{batch.job ? ` · ${batch.job}` : ''}</div></td>
                    <td className="max-w-72 px-3 py-2.5 text-xs text-text-muted">{laneSummary(batch.zones)}</td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums">{fmtInt(batch.member_count)}</td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums">{fmtInt(statusCount(batch, 'new'))}</td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums">{fmtInt(statusCount(batch, 'attempted'))}</td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums">{fmtInt(statusCount(batch, 'contacted'))}</td>
                    <td className="px-3 py-2.5 text-right font-mono font-bold tabular-nums text-st-interested">{fmtInt(statusCount(batch, 'interested'))}</td>
                    <td className="px-3 py-2.5 text-right font-mono font-bold tabular-nums text-crit">{fmtInt(batch.warnings_count)}</td>
                    <td className="px-3 py-2.5 text-xs text-text-muted">{fmtRel(batch.last_activity_at || batch.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  );
}
