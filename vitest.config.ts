import { fileURLToPath, URL } from 'node:url';
import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

/**
 * Vitest configuration.
 *
 * Merges the shared Vite config (`vite.config.ts`) so the `@/` path alias
 * resolves identically in tests and in the app build.
 *
 * The suite spans two runtimes:
 *  - Node.js for backend services, routers, Prisma, and config modules.
 *  - jsdom for React UI components (`*.test.tsx`).
 *
 * `environmentMatchGlobs` selects jsdom for component tests and Node for the
 * rest, so a single `vitest run` covers the whole matrix.
 */
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      globals: true,
      // Default runtime for backend/service/config tests.
      environment: 'node',
      // React component tests opt into jsdom by file pattern.
      environmentMatchGlobs: [
        ['**/*.test.tsx', 'jsdom'],
        ['**/client/**', 'jsdom'],
      ],
      setupFiles: ['./tests/setup.ts'],
      include: [
        'tests/**/*.test.{ts,tsx}',
        'src/**/*.test.{ts,tsx}',
        'src/**/__tests__/**/*.{ts,tsx}',
      ],
      exclude: ['node_modules', 'dist', 'coverage', '.git'],
      coverage: {
        provider: 'v8',
        reporter: ['text', 'html'],
        reportsDirectory: './coverage',
        exclude: [
          'node_modules/',
          'dist/',
          'coverage/',
          '**/*.config.ts',
          '**/__tests__/**',
          'tests/**',
          'prisma/**',
        ],
      },
    },
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
  }),
);
