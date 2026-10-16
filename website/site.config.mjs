// Where the docs are published and where their sources live, derived from the
// packages' repository field so that nothing here repeats it. CI overrides the
// published location with the values GitHub Pages reports (custom domains included).
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../packages/core/package.json', import.meta.url), 'utf8'));

/** https://github.com/<owner>/<name> */
export const repository = manifest.repository.url.replace(/^git\+/, '').replace(/\.git$/, '');
export const branch = process.env.DOCS_BRANCH || 'main';

const { owner, name } = /github\.com\/(?<owner>[^/]+)\/(?<name>[^/]+)$/.exec(repository).groups;
/** CI passes unset values as empty strings. */
const env = (key) => process.env[key] || undefined;
export const site = env('DOCS_SITE') ?? `https://${owner}.github.io`;
// GitHub Pages reports an empty base path for a custom domain, which serves from the root.
export const base = env('DOCS_BASE') ?? (env('DOCS_SITE') ? '/' : `/${name}`);

/** A file in the repository, as a GitHub URL. */
export const sourceUrl = (path) => `${repository}/blob/${branch}/${path}`;
