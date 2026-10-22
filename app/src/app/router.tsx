import { lazy, Suspense } from 'react';
import type { ReactNode } from 'react';
import { createBrowserRouter, Navigate } from 'react-router-dom';
import { AppShell } from './AppShell';
import { RequireManager, RequireRole, RequireStaff } from './guards';
import { activitySender, createActivityReporter } from '../lib/activity';
import { currentCsrfToken } from '../lib/api';

/**
 * Route table — docs/build-plan/02-frontend-spec.md §1.2, code-split per screen via React.lazy.
 * Sign-in is served by the server (/signin, /auth/*); the old in-app Login, Register, Forgot,
 * Reset and Pending screens are retired (Hunter decision 3: manager-added staff only). The
 * server redirects their old URLs to /signin.
 */

const Dashboard = lazy(() => import('../features/dashboard/Dashboard'));
const Wizard = lazy(() => import('../features/batchNew/Wizard'));
const BatchPage = lazy(() => import('../features/batch/BatchPage'));
const ContactSheet = lazy(() => import('../features/batch/sheet/ContactSheet'));
const CarrierProfile = lazy(() => import('../features/carrier/CarrierProfile'));
const UsersAdmin = lazy(() => import('../features/users/UsersAdmin'));
const NotFound = lazy(() => import('../features/NotFound'));

function RouteFallback() {
  return (
    <div className="flex min-h-40 w-full items-center justify-center text-text-subtle">
      <span className="font-ui text-sm">Loading…</span>
    </div>
  );
}

function withSuspense(node: ReactNode) {
  return <Suspense fallback={<RouteFallback />}>{node}</Suspense>;
}

export const router = createBrowserRouter([
  {
    element: <RequireStaff />,
    children: [
      // Print-only, no AppShell chrome (02 §3e: opens in a new tab, auto window.print() on load).
      { path: '/batches/:batchId/sheet', element: withSuspense(<ContactSheet />) },
      {
        element: <AppShell />,
        children: [
          { index: true, element: <Navigate to="/dashboard" replace /> },
          { path: '/dashboard', element: withSuspense(<Dashboard />) },
          {
            path: '/batches/new',
            element: <RequireRole roles={['manager', 'edit']}>{withSuspense(<Wizard />)}</RequireRole>,
          },
          { path: '/batches/:batchId', element: withSuspense(<BatchPage />) },
          { path: '/carriers/:dot', element: withSuspense(<CarrierProfile />) },
          {
            path: '/users',
            element: <RequireManager>{withSuspense(<UsersAdmin />)}</RequireManager>,
          },
          { path: '*', element: withSuspense(<NotFound />) },
        ],
      },
    ],
  },
]);

// Deliberate-use renewal: only navigations the person caused (a same-origin link click, which
// also covers Enter on a focused link, or browser back/forward). Never timers, prefetch, focus
// or background refetch (lib/activity.ts; doc 14 §3.5).
const activity = createActivityReporter({ send: activitySender(currentCsrfToken), now: () => Date.now() });
if (typeof window !== 'undefined') {
  window.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (link && link.origin === window.location.origin && !link.target) activity.reportUserNavigation('click');
  });
  window.addEventListener('popstate', () => activity.reportUserNavigation('history'));
}
