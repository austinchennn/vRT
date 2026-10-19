/** Lifecycle events for every tool call: `tool.stream` (spec/protocol.md §7.5). */
export const TOOL_STREAM_V1 = 'tool-stream-v1';
/** Cross-session uniqueness for opaque turn and tool-call identifiers (spec/protocol.md §6.3). */
export const GLOBAL_TOOL_IDS_V1 = 'global-tool-ids-v1';

/**
 * The capabilities in effect for a session: those the client offered that the
 * server supports, deduplicated, in the client's order. Absent means none.
 */
export function negotiateCapabilities(offered: readonly string[] | undefined, supported: ReadonlySet<string>): string[] {
  return offered === undefined ? [] : [...new Set(offered)].filter((capability) => supported.has(capability));
}
