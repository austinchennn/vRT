import type { Capabilities } from '@vrealtime/core';
import { TOOL_STREAM_V1 } from '@vrealtime/protocol';

/**
 * A protocol capability (spec/capabilities.json) this server implements. It is
 * offered only when the runtime and model support its contract. A lifecycle
 * capability need not require argument fragments from the model.
 */
export interface CapabilityRule {
  token: string;
  available(model: Capabilities): boolean;
}

/** Every capability this server implements. */
export const CAPABILITY_RULES: readonly CapabilityRule[] = [
  // Any model: without argument streaming a call goes straight from start to arguments-complete.
  { token: TOOL_STREAM_V1, available: () => true },
];

/** The tokens sessions of an agent with this model may negotiate. */
export function supportedCapabilities(model: Capabilities, rules: readonly CapabilityRule[] = CAPABILITY_RULES): ReadonlySet<string> {
  return new Set(rules.filter((rule) => rule.available(model)).map((rule) => rule.token));
}
