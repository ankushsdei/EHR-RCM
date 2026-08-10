/**
 * Global Vitest setup.
 *
 * Registers @testing-library/jest-dom matchers (toBeInTheDocument, etc.) for
 * React component tests. The import is side-effect only and safe under the
 * Node environment used by backend tests.
 */
import '@testing-library/jest-dom/vitest';
