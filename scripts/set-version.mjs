// Sets one version on every package and pins every internal dependency (packages
// and examples) to it, then refreshes the lockfile. vRT packages version in lockstep.
//
//   node scripts/set-version.mjs 0.2.0
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, workspacePackages } from './packages.mjs';

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SCOPE = '@vrealtime/';
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

const version = process.argv[2];
if (version === undefined || !SEMVER.test(version)) {
  console.error('usage: node scripts/set-version.mjs <version>   (for example 0.2.0 or 1.0.0-rc.1)');
  process.exit(1);
}

const examples = readdirSync(join(root, 'examples'), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join(root, 'examples', entry.name));
const manifests = [...workspacePackages().map((pkg) => ({ dir: pkg.path, published: true })), ...examples.map((dir) => ({ dir, published: false }))];

for (const { dir, published } of manifests) {
  const file = join(dir, 'package.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  if (published) manifest.version = version;
  for (const field of DEPENDENCY_FIELDS) {
    for (const name of Object.keys(manifest[field] ?? {})) if (name.startsWith(SCOPE)) manifest[field][name] = version;
  }
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: root, stdio: 'inherit' });
console.log(`set ${manifests.length} manifests to ${version}; review with git diff, then commit`);
