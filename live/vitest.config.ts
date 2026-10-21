import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const packages = fileURLToPath(new URL('../packages/', import.meta.url));

// Tests against real providers: never part of `npm test` or CI. They cost money and need keys;
// run them with `npm run test:live`. A test whose key is missing is reported as skipped.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@vrealtime\/([^/]+)$/, replacement: `${packages}$1/src/index.ts` },
      { find: /^@vrealtime\/([^/]+)\/([^/]+)$/, replacement: `${packages}$1/src/$2/index.ts` },
    ],
  },
  test: { include: ['live/**/*.live.test.ts'], testTimeout: 60_000, fileParallelism: false },
});
