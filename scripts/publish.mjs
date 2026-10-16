// Publishes the release/ tarballs (the exact artifacts npm run pack built and
// npm run test:consumer installed) to npm, dependencies first. Re-runnable: versions
// already on the registry are skipped, so a release that failed halfway can be resumed.
//
//   node scripts/publish.mjs [--dry-run] [--provenance] [--expect-version 0.1.0] [--tag next]
//
// Run by .github/workflows/release.yml on a version tag; see RELEASING.md.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { root, workspacePackages } from './packages.mjs';

const { values: args } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    provenance: { type: 'boolean', default: false },
    'expect-version': { type: 'string' },
    tag: { type: 'string' },
  },
});

const SCOPE = '@vrealtime/';
const packages = workspacePackages();
const version = packages[0].manifest.version;
const problems = [];

// Lockstep: one version for every package, matching the release tag, with internal dependencies pinned to it.
if (args['expect-version'] !== undefined && args['expect-version'] !== version) problems.push(`the tag says ${args['expect-version']}, the packages say ${version}`);
for (const { name, manifest } of packages) {
  if (manifest.version !== version) problems.push(`${name} is ${manifest.version}, expected ${version}`);
  if (manifest.private) problems.push(`${name} is private`);
  if (manifest.publishConfig?.access !== 'public') problems.push(`${name} lacks publishConfig.access "public"`);
  const internal = Object.entries({ ...manifest.dependencies, ...manifest.peerDependencies, ...manifest.optionalDependencies }).filter(([dep]) => dep.startsWith(SCOPE));
  for (const [dep, range] of internal) if (range !== version) problems.push(`${name} depends on ${dep}@${range}, expected ${version}`);
}

/** npm pack's file name for a scoped package: @scope/name -> scope-name-version.tgz */
const tarballOf = (name) => join(root, 'release', `${name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`);
for (const { name } of packages) if (!existsSync(tarballOf(name))) problems.push(`release/ has no tarball for ${name}; run npm run pack`);

if (problems.length > 0) {
  for (const problem of problems) console.error(`✗ ${problem}`);
  process.exit(1);
}

/** True when name@version is already on the registry. */
function published(name) {
  try {
    execFileSync('npm', ['view', `${name}@${version}`, 'version', '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch (error) {
    if (/E404|404 Not Found/.test(String(error.stderr))) return false;
    throw new Error(`Cannot check ${name}@${version} on the registry:\n${error.stderr}`);
  }
}

// A prerelease (1.0.0-rc.1) must never become what `npm install` picks by default.
const distTag = args.tag ?? (version.includes('-') ? 'next' : 'latest');
const flags = ['--access', 'public', '--tag', distTag, ...(args.provenance ? ['--provenance'] : []), ...(args['dry-run'] ? ['--dry-run'] : [])];
console.log(`${args['dry-run'] ? 'dry run: ' : ''}publishing ${packages.length} packages at ${version} with dist-tag ${distTag}`);

for (const { name } of packages) {
  if (published(name)) {
    console.log(`  - ${name}@${version} is already published, skipped`);
    continue;
  }
  execFileSync('npm', ['publish', tarballOf(name), ...flags], { stdio: ['ignore', 'ignore', 'inherit'] });
  console.log(`  ✓ ${name}@${version}`);
}
