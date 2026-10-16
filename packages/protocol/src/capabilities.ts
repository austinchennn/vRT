/**
 * The capabilities in effect for a session: those the client offered that the
 * server supports, deduplicated, in the client's order. Absent means none.
 */
export function negotiateCapabilities(offered: readonly string[] | undefined, supported: ReadonlySet<string>): string[] {
  return offered === undefined ? [] : [...new Set(offered)].filter((capability) => supported.has(capability));
}
