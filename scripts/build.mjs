import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { root, workspacePackages } from './packages.mjs';

const tsc = join(root, 'node_modules/.bin/tsc');
for (const pkg of workspacePackages()) {
  rmSync(join(pkg.path, 'dist'), { recursive: true, force: true });
  execFileSync(tsc, ['-p', join(pkg.path, 'tsconfig.build.json')], { stdio: 'inherit' });
  console.log(`built ${pkg.name}`);
}
