import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('..', import.meta.url));

/** Workspace packages in dependency order (dependencies first). */
export function workspacePackages() {
  const dir = join(root, 'packages');
  const all = readdirSync(dir).map((name) => {
    const path = join(dir, name);
    const manifest = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
    return { name: manifest.name, dir: name, path, manifest };
  });
  const byName = new Map(all.map((p) => [p.name, p]));
  const ordered = [];
  const seen = new Set();
  const visit = (pkg) => {
    if (seen.has(pkg.name)) return;
    seen.add(pkg.name);
    const deps = { ...pkg.manifest.dependencies, ...pkg.manifest.peerDependencies };
    for (const dep of Object.keys(deps)) if (byName.has(dep)) visit(byName.get(dep));
    ordered.push(pkg);
  };
  all.forEach(visit);
  return ordered;
}
