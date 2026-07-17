import { lazy, Suspense } from 'react';
import type { ReactNode } from 'react';
import { createBrowserRouter, Navigate } from 'react-router-dom';
import { AppShell } from './AppShell';
import { RequireAnon, RequireApproved, RequireAuth, RequireManager, RequireRole } from './guards';

/**
 * Route table — docs/build-plan/02-frontend-spec.md §1.2, code-split per
 * screen via React.lazy. One deliberate deviation from the literal table:
 * `/reset` is NOT gated by RequireAnon. A Supabase password-recovery link
 * signs the user into a real (if transient) session before they land on
 * `/reset` — gating it "anon only" would bounce them away before they could
 * ever set a new password. Reset.tsx checks for a recovery session itself
 * and shows "invalid or expired link" when there isn't one.
 */

const Login = lazy(() => import('../features/auth/Login'));
const Register = lazy(() => import('../features/auth/Register'));
const Forgot = lazy(() => import('../features/auth/Forgot'));
const Reset = lazy(() => import('../features/auth/Reset'));
const Pending = lazy(() => import('../features/auth/Pending'));

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
    element: <RequireAnon />,
    children: [
      { path: '/login', element: withSuspense(<Login />) },
      { path: '/register', element: withSuspense(<Register />) },
      { path: '/forgot', element: withSuspense(<Forgot />) },
    ],
  },
  // Public: see the deviation note above.
  { path: '/reset', element: withSuspense(<Reset />) },
  {
    element: <RequireAuth />,
    children: [
      { path: '/pending', element: withSuspense(<Pending />) },
      {
        element: <RequireApproved />,
        children: [
          // Print-only, no AppShell chrome (02 §3e: opens in a new tab,
          // auto window.print() on load).
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
    ],
  },
]);
