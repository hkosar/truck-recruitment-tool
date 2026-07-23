import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router-dom';
import { router } from './app/router';
import './theme/app.css';

// TNBS Design System v1.0 is deliberately light-only, so the runtime provider
// stack is QueryClientProvider + Router with no theme state or toggle.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // §1.3: 30s default staleness; screens that need tighter freshness
      // (counts/facets, 15s) override per-query.
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root not found in index.html.');
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
