import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';

/**
 * AppShell = Sidebar + Topbar + content — docs/build-plan/
 * 02-frontend-spec.md §3 "Shared shell". Mounted as a react-router layout
 * route (see app/router.tsx); screens render into <Outlet/>.
 */
export function AppShell() {
  return (
    <div className="flex h-dvh w-full overflow-hidden bg-bg text-text">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <main className="flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
