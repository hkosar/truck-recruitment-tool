import { lazy, Suspense } from 'react';
import type { ReactNode } from 'react';
import { createBrowserRouter, Navigate } from 'react-router-dom';
import { AppShell } from './AppShell';
import { RequireManager, RequireRole, RequireStaff } from './guards';
import { activitySender, createActivityReporter, wireNavigationActivity } from '../lib/activity';
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

// Deliberate-use renewal: only navigations the person caused, taken from the router's own
// completed navigations (a <Link> click or keyboard activation just before, or browser
// back/forward). Never timers, prefetch, focus or background refetch (lib/activity.ts; doc 14
// §3.5; Gate 2 finding 6).
const activity = createActivityReporter({ send: activitySender(currentCsrfToken), now: () => Date.now() });
if (typeof window !== 'undefined') {
  wireNavigationActivity({ router, target: window, history: window.history, report: (t) => activity.reportUserNavigation(t), now: () => Date.now() });
}
