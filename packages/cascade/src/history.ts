import type { ChatMessage } from './index.js';

/** How much of the conversation the cascade sends and keeps. */
export interface HistoryLimits {
  /** Most messages sent to the llm per request. Default 200. */
  maxMessages?: number;
  /** Rough token budget for the messages sent (about 4 characters per token). Default 32 000. */
  maxTokens?: number;
  /** Most messages kept in `session.history`, so memory does not grow with the session. Default twice `maxMessages`. */
  maxStoredMessages?: number;
  /**
   * Replaces the default trim of what is sent: gets the stored history (already capped
   * at `maxStoredMessages`) and returns the messages for the next request.
   * `trimHistory` is exported to build on.
   */
  process?: (messages: readonly ChatMessage[]) => readonly ChatMessage[];
}

export const MAX_MESSAGES = 200;
export const MAX_TOKENS = 32_000;

/** About 4 characters per token, plus a little per message. */
export function estimateTokens(message: ChatMessage): number {
  let chars = 0;
  if (message.role === 'tool') chars += message.name.length + (JSON.stringify(message.output) ?? '').length;
  else chars += message.content.length;
  if (message.role === 'assistant' && message.toolCalls) chars += JSON.stringify(message.toolCalls).length;
  return Math.ceil(chars / 4) + 4;
}

/**
 * The longest recent window of `messages` within the budget that is still a valid
 * conversation: it never starts with a tool result, never keeps a tool result without
 * the assistant message that called it, and starts with a user message when one fits.
 * When nothing fits, the window starts at the last place it can.
 */
export function trimHistory(messages: readonly ChatMessage[], limits: { maxMessages?: number; maxTokens?: number }): ChatMessage[] {
  const maxMessages = limits.maxMessages ?? Infinity;
  const maxTokens = limits.maxTokens ?? Infinity;
  const n = messages.length;
  // A window starting inside (caller, result] would orphan that tool result.
  const callers = new Map<string, number>();
  const blocked = new Int32Array(n + 1);
  messages.forEach((message, i) => {
    if (message.role === 'assistant') for (const call of message.toolCalls ?? []) callers.set(call.callId, i);
    else if (message.role === 'tool') {
      const caller = callers.get(message.callId) ?? -1;
      blocked[caller + 1]!++;
      blocked[i + 1]!--;
    }
  });
  const valid = new Array<boolean>(n);
  for (let i = 0, depth = 0; i < n; i++) {
    depth += blocked[i]!;
    valid[i] = depth === 0 && messages[i]!.role !== 'tool';
  }
  let user = -1;
  let other = -1;
  let lastUser = -1;
  let lastOther = -1;
  let tokens = 0;
  for (let i = n - 1; i >= 0; i--) {
    const fits = n - i <= maxMessages && (tokens += estimateTokens(messages[i]!)) <= maxTokens;
    if (!valid[i]) continue;
    const isUser = messages[i]!.role === 'user';
    if (isUser && lastUser < 0) lastUser = i;
    if (!isUser && lastOther < 0) lastOther = i;
    if (!fits) continue;
    if (isUser) user = i;
    else other = i;
  }
  const start = user >= 0 ? user : other >= 0 ? other : lastUser >= 0 ? lastUser : lastOther >= 0 ? lastOther : n;
  return messages.slice(start);
}
