// Enforces docs/ARCHITECTURE.md §1 size budgets and §8 dependency rules.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';
import { workspacePackages } from './packages.mjs';

const KB = 1024;
const ADAPTERS = new Set(['@vrealtime/boson', '@vrealtime/openai', '@vrealtime/gemini']);
const SIZE_BUDGETS = {
  '@vrealtime/core': 15 * KB,
  '@vrealtime/protocol': 5 * KB,
  '@vrealtime/client': 20 * KB,
};
const ZERO_DEPENDENCY = new Set(['@vrealtime/core', '@vrealtime/protocol']);
const NODE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]node:/m;

const failures = [];
const fail = (message) => failures.push(message);

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.[cm]?[jt]sx?$/.test(name) ? [path] : [];
  });
}

/** `node:` imports are allowed only under a `node` subpath: `src/node/**` or `src/node.ts`. */
function isNodeSubpath(srcRelative) {
  return srcRelative === 'node.ts' || srcRelative.split(/[\\/]/)[0] === 'node';
}

/**
 * Adapters are measured together with the internal base they share
 * (`@vrealtime/openai-compatible`); everything else they import stays external.
 */
const INLINED = ['@vrealtime/openai-compatible'];

async function minGzipBytes(entry, inlineInternal) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    minify: true,
    format: 'esm',
    platform: 'neutral',
    ...(inlineInternal
      ? { plugins: [externalExcept(INLINED)], mainFields: ['module', 'main'], conditions: ['import'] }
      : { packages: 'external' }),
    write: false,
    logLevel: 'silent',
  });
  return gzipSync(result.outputFiles[0].contents, { level: 9 }).length;
}

function externalExcept(inlined) {
  return {
    name: 'external-except',
    setup(build) {
      build.onResolve({ filter: /^[^./]/ }, (args) => (inlined.includes(args.path) ? undefined : { path: args.path, external: true }));
    },
  };
}

for (const pkg of workspacePackages()) {
  const { name, manifest, path } = pkg;
  const runtimeDeps = Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies, ...manifest.optionalDependencies });

  if (ZERO_DEPENDENCY.has(name) && runtimeDeps.length > 0) {
    fail(`${name} must have zero runtime dependencies, found: ${runtimeDeps.join(', ')}`);
  }
  if (ADAPTERS.has(name)) {
    const crossAdapter = runtimeDeps.filter((dep) => ADAPTERS.has(dep));
    if (crossAdapter.length > 0) fail(`${name} must not depend on other adapters: ${crossAdapter.join(', ')}`);
  }

  const src = join(path, 'src');
  for (const file of sourceFiles(src)) {
    const rel = relative(src, file);
    if (!isNodeSubpath(rel) && NODE_IMPORT.test(readFileSync(file, 'utf8'))) {
      fail(`${name}: node: import outside a */node subpath in src/${rel}`);
    }
  }

  const budget = SIZE_BUDGETS[name] ?? (ADAPTERS.has(name) ? 10 * KB : undefined);
  const entry = join(path, 'dist/index.js');
  let size;
  try {
    statSync(entry);
    size = await minGzipBytes(entry, ADAPTERS.has(name));
  } catch {
    fail(`${name}: dist/index.js missing, run npm run build first`);
    continue;
  }
  const label = `${name}: ${(size / KB).toFixed(2)} KB min+gzip`;
  if (budget !== undefined && size > budget) fail(`${label} exceeds ${(budget / KB).toFixed(0)} KB budget`);
  else console.log(budget === undefined ? label : `${label} / ${(budget / KB).toFixed(0)} KB`);
}

if (failures.length > 0) {
  for (const message of failures) console.error(`✗ ${message}`);
  process.exit(1);
}
console.log('✓ budgets ok');
