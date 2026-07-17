import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Vite 7 + React 19 + Tailwind v4 (CSS-first `@theme`, no tailwind.config.js needed).
// See docs/build-plan/02-frontend-spec.md §1.1 for the stack rationale.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
  },
  preview: {
    port: 4173,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
