import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Shared Vite config. Used for:
 *  - `npm run dev:web` / `build:web` (React client)
 *  - `npm run build:api` (SSR build of the Express server, so `@/` aliases resolve)
 *  - `vitest.config.ts`, which merges this config for path-alias parity in tests
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  root: '.',
  publicDir: 'public',
  server: {
    port: 5173,
    proxy: {
      // Keep the browser on one origin so HttpOnly auth cookies are sent to the API.
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    sourcemap: true,
    target: 'es2022',
  },
});
