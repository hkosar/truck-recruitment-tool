import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';

/**
 * AppShell = Sidebar + Topbar + content — docs/build-plan/
 * 02-frontend-spec.md §3 "Shared shell". Mounted as a react-router layout
 * route (see app/router.tsx); screens render into <Outlet/>.
 */
import { connectedSupabaseRef, isStaging } from '../lib/supabase';

export function AppShell() {
  return (
    <div className="flex h-dvh w-full flex-col overflow-hidden bg-bg text-text">
      {isStaging ? (
        <div className="flex h-7 shrink-0 items-center justify-center bg-warn px-4 text-[10px] font-extrabold uppercase tracking-[0.12em] text-white">
          Staging · fictional data · not production · {connectedSupabaseRef}
        </div>
      ) : null}
      <Topbar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="min-w-0 flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
