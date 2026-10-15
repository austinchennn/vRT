import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const packages = fileURLToPath(new URL('./packages/', import.meta.url));

// Tests run against source, never against a stale dist.
const alias = readdirSync(packages).map((name) => ({
  find: new RegExp(`^@vrealtime/${name}$`),
  replacement: `${packages}${name}/src/index.ts`,
}));

export default defineConfig({
  resolve: { alias },
  test: { passWithNoTests: true, include: ['packages/*/test/**/*.test.ts'] },
});
