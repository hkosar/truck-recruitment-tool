import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router-dom';
import { ThemeProvider } from './theme/ThemeProvider';
import { router } from './app/router';
import './theme/app.css';

// docs/build-plan/02-frontend-spec.md §1.1: providers are
// QueryClientProvider + Router + ThemeProvider.
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
      <ThemeProvider>
        <RouterProvider router={router} />
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
