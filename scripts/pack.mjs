// Builds every package and writes one installable tarball per package to release/.
// Until the public npm release (M4), apps install these: npm i ./release/vrealtime-core-0.1.0.tgz ...
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, workspacePackages } from './packages.mjs';

const release = join(root, 'release');
rmSync(release, { recursive: true, force: true });
mkdirSync(release);
execFileSync(process.execPath, [join(root, 'scripts/build.mjs')], { stdio: 'inherit' });

for (const pkg of workspacePackages()) {
  // npm only ships LICENSE and README from the package folder; add them for the pack.
  const generated = [];
  const license = join(pkg.path, 'LICENSE');
  if (!existsSync(license)) {
    copyFileSync(join(root, 'LICENSE'), license);
    generated.push(license);
  }
  const readme = join(pkg.path, 'README.md');
  if (!existsSync(readme)) {
    writeFileSync(readme, `# ${pkg.name}\n\n${pkg.manifest.description}\n\nPart of [vRealTime](https://github.com/austinchennn/vRT). Licensed under Apache-2.0.\n`);
    generated.push(readme);
  }
  try {
    execFileSync('npm', ['pack', '--silent', '--pack-destination', release], { cwd: pkg.path, stdio: ['ignore', 'ignore', 'inherit'] });
  } finally {
    for (const file of generated) rmSync(file);
  }
}

const tarballs = readdirSync(release).filter((f) => f.endsWith('.tgz')).sort();
console.log(`packed ${tarballs.length} packages into release/:\n  ${tarballs.join('\n  ')}`);
