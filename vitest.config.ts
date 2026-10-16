import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const packages = fileURLToPath(new URL('./packages/', import.meta.url));

// Tests run against source, never against a stale dist.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@vrealtime\/([^/]+)$/, replacement: `${packages}$1/src/index.ts` },
      { find: /^@vrealtime\/([^/]+)\/([^/]+)$/, replacement: `${packages}$1/src/$2/index.ts` },
    ],
  },
  test: { passWithNoTests: true, include: ['packages/*/test/**/*.test.ts', 'examples/*/test/**/*.test.ts'] },
});
