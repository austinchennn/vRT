# vRealTime documentation site

The documentation at <https://austinchennn.github.io/vRT/>, built with [Astro Starlight](https://starlight.astro.build). It is a separate npm project with its own lockfile, so the library's installs and CI never pull in the site's dependencies.

```bash
cd website
npm ci
npm run dev       # http://localhost:4321/vRT/
npm run build     # also validates every internal link
```

## Layout

| Path | What it is |
|---|---|
| `src/content/docs/` | English pages (the default locale) |
| `src/content/docs/zh-cn/` | Chinese pages. A page that is not translated yet falls back to English, with a notice |
| `src/content/docs/reference/protocol.md`, `packages.md` | **Generated**, not committed: `scripts/sync-content.mjs` builds them from `spec/protocol.md` and each `packages/*/package.json` before every `dev` and `build` |
| `astro.config.mjs` | Site configuration: sidebar, locales, plugins |
| `site.config.mjs` | Where the site is published and where its sources live, derived from the packages' `repository` field; CI overrides the location with what GitHub Pages reports |
| `plugins/remark-base-links.mjs` | Prefixes root-relative links with the site's base path, so pages never hard-code where the site is deployed |

## Writing pages

- Link to other pages with root-relative paths (`/guides/models/`), never relative ones; the build adds the base path and fails on broken links or anchors.
- Never copy the protocol or the package list into a page: link to the generated reference pages, and change `spec/` or the package manifests instead.
- To translate a page, add the same path under `src/content/docs/zh-cn/`; the sidebar picks it up. Group labels are translated in `astro.config.mjs`.

Pushes to `main` that touch `website/`, `spec/` or a package manifest deploy the site through [`.github/workflows/docs.yml`](../.github/workflows/docs.yml); pull requests build it without deploying.
