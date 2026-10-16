import type { Capabilities } from '@vrealtime/core';

/**
 * A protocol capability (spec/capabilities.json) this server implements. It is
 * offered only when the agent's model can support it, e.g. argument streaming.
 */
export interface CapabilityRule {
  token: string;
  available(model: Capabilities): boolean;
}

/** Every capability this server implements. None yet. */
export const CAPABILITY_RULES: readonly CapabilityRule[] = [];

/** The tokens sessions of an agent with this model may negotiate. */
export function supportedCapabilities(model: Capabilities, rules: readonly CapabilityRule[] = CAPABILITY_RULES): ReadonlySet<string> {
  return new Set(rules.filter((rule) => rule.available(model)).map((rule) => rule.token));
}
