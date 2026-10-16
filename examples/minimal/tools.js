/** The app-side tool: runs in the browser, changes the page's accent color. */
export function accentColorTool(apply) {
  return {
    description: 'Change the accent color of the page. Accepts any CSS color.',
    parameters: {
      type: 'object',
      properties: { color: { type: 'string', description: 'A CSS color, e.g. "teal" or "#ff6600"' } },
      required: ['color'],
    },
    run: ({ color }) => {
      apply(color);
      return { applied: color };
    },
  };
}
