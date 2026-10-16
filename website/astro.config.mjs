import { unified } from '@astrojs/markdown-remark';
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import starlightLinksValidator from 'starlight-links-validator';
import { remarkBaseLinks } from './plugins/remark-base-links.mjs';
import { base, branch, repository, site } from './site.config.mjs';

export default defineConfig({
  site,
  base,
  trailingSlash: 'always',
  markdown: { processor: unified({ remarkPlugins: [remarkBaseLinks(base)] }) },
  integrations: [
    starlight({
      title: 'vRealTime',
      description: 'One protocol for voice agents that act on any app or device. Light, fast, interruptible.',
      logo: { src: './src/assets/logo.svg', alt: 'vRealTime' },
      favicon: '/favicon.svg',
      social: [{ icon: 'github', label: 'GitHub', href: repository }],
      editLink: { baseUrl: `${repository}/edit/${branch}/website/` },
      lastUpdated: true,
      customCss: ['./src/styles/custom.css'],
      defaultLocale: 'root',
      locales: {
        root: { label: 'English', lang: 'en' },
        'zh-cn': { label: '简体中文', lang: 'zh-CN' },
      },
      sidebar: [
        {
          label: 'Get started',
          translations: { 'zh-CN': '开始' },
          items: ['get-started/overview', 'get-started/quickstart', 'get-started/installation'],
        },
        { label: 'Concepts', translations: { 'zh-CN': '核心概念' }, items: [{ autogenerate: { directory: 'concepts' } }] },
        { label: 'Guides', translations: { 'zh-CN': '指南' }, items: [{ autogenerate: { directory: 'guides' } }] },
        {
          label: 'Reference',
          translations: { 'zh-CN': '参考' },
          items: ['reference/client-api', 'reference/protocol', 'reference/packages'],
        },
      ],
      // Untranslated pages fall back to English; linking to them is intended.
      plugins: [starlightLinksValidator({ errorOnFallbackPages: false })],
    }),
  ],
});
