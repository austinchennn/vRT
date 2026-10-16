// Generates the pages whose source of truth lives elsewhere in the repository, so the
// docs never hold a second copy that can drift: the protocol specification
// (spec/protocol.md) and the package list (packages/*/package.json). Runs before dev and build.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { sourceUrl } from '../site.config.mjs';

const root = new URL('../../', import.meta.url);
const out = new URL('../src/content/docs/reference/', import.meta.url);
mkdirSync(out, { recursive: true });

const frontmatter = (fields) => `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n\n`;
const generatedNote = (path) => `:::note\nThis page is generated from [\`${path}\`](${sourceUrl(path)}). Edit that file, not this page.\n:::\n\n`;

// ── Protocol specification ───────────────────────────────────────────────

const SPEC = 'spec/protocol.md';
const spec = /^# (?<title>.+)\n(?<body>[\s\S]*)$/.exec(readFileSync(new URL(SPEC, root), 'utf8')).groups;
const specBody = spec.body
  // Starlight renders its own table of contents.
  .replace(/^## Contents\n[\s\S]*?(?=^## )/m, '')
  // Links to other files in spec/ point at the repository.
  .replace(/\]\((?![a-z]+:|#)([^)\s]+)\)/g, (_, target) => `](${sourceUrl(`spec/${target}`)})`);
writeFileSync(
  new URL('protocol.md', out),
  frontmatter({
    title: spec.title,
    description: 'The normative definition of the vRT wire protocol: messages, reliability, sessions, epochs, tools, audio and errors.',
    editUrl: sourceUrl(SPEC),
    sidebar: { label: 'Protocol specification', translations: { 'zh-CN': '协议规范' } },
  }) +
    generatedNote(SPEC) +
    specBody.trimStart(),
);

// ── Packages ─────────────────────────────────────────────────────────────

const packagesDir = new URL('packages/', root);
const packages = readdirSync(packagesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => JSON.parse(readFileSync(new URL(`${entry.name}/package.json`, packagesDir), 'utf8')))
  .sort((a, b) => a.name.localeCompare(b.name));

const code = (text) => `\`${text}\``;
const rows = packages.map((manifest) => {
  const entries = Object.keys(manifest.exports ?? { '.': null }).map((subpath) => code(subpath === '.' ? manifest.name : `${manifest.name}${subpath.slice(1)}`));
  const internal = Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies }).filter((name) => name.startsWith('@vrealtime/'));
  const external = Object.keys(manifest.peerDependencies ?? {}).filter((name) => !name.startsWith('@vrealtime/'));
  const needs = [...internal.map(code), ...external.map((name) => `${code(name)} (peer)`)].join(', ') || 'none';
  return `| ${entries.join('<br/>')} | ${manifest.description} | ${needs} |`;
});
writeFileSync(
  new URL('packages.md', out),
  frontmatter({ title: 'Packages', description: 'Every @vrealtime package, its entry points and what it depends on.', editUrl: false }) +
    `:::note\nThis page is generated from each package's \`package.json\`.\n:::\n\n` +
    `All packages share one version (${packages[0].version}) and are released together. Install only the ones you use; each lists its \`@vrealtime\` dependencies below.\n\n` +
    `| Entry point | What it is | Depends on |\n|---|---|---|\n${rows.join('\n')}\n`,
);

console.log(`synced ${SPEC} and ${packages.length} packages into src/content/docs/reference/`);
