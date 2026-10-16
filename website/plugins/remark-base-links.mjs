// Astro does not apply `base` to links written in Markdown. This prefixes root-relative
// links ("/guides/models/") with it, so content stays independent of where the site is
// deployed, and the links validator (a rehype plugin, so it runs after this) checks the
// final URLs.
const LINK_NODES = new Set(['link', 'definition']);
const JSX_NODES = new Set(['mdxJsxFlowElement', 'mdxJsxTextElement']);

function walk(node, visit) {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

export function remarkBaseLinks(base) {
  const prefix = base.replace(/\/$/, '');
  const rebase = (url) => (prefix && url.startsWith('/') && !url.startsWith('//') && url !== prefix && !url.startsWith(`${prefix}/`) ? prefix + url : url);
  return () => (tree) =>
    walk(tree, (node) => {
      if (LINK_NODES.has(node.type)) node.url = rebase(node.url);
      if (JSX_NODES.has(node.type)) {
        for (const attribute of node.attributes ?? []) if (attribute.name === 'href' && typeof attribute.value === 'string') attribute.value = rebase(attribute.value);
      }
    });
}
