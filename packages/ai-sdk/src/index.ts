import type { ChatMessage, TextModel, TextPart, TextRequest } from '@vrealtime/cascade';
import { jsonSchema, streamText, tool, type JSONSchema7, type JSONValue, type LanguageModel, type ModelMessage, type ToolChoice, type ToolSet } from 'ai';

export interface AiSdkOptions {
  maxOutputTokens?: number;
  /** Passed through to `streamText` (provider-specific settings). */
  providerOptions?: Parameters<typeof streamText>[0]['providerOptions'];
}

/** Maps cascade history to AI SDK `ModelMessage`s. */
export function toModelMessages(messages: readonly ChatMessage[]): ModelMessage[] {
  return messages.map((message): ModelMessage => {
    switch (message.role) {
      case 'user':
        return { role: 'user', content: message.content };
      case 'assistant':
        return {
          role: 'assistant',
          content: [
            ...(message.content ? [{ type: 'text' as const, text: message.content }] : []),
            ...(message.toolCalls ?? []).map((call) => ({ type: 'tool-call' as const, toolCallId: call.callId, toolName: call.name, input: call.arguments })),
          ],
        };
      case 'tool':
        return {
          role: 'tool',
          content: [{ type: 'tool-result', toolCallId: message.callId, toolName: message.name, output: { type: 'json', value: (message.output ?? null) as JSONValue } }],
        };
    }
  });
}

function toToolChoice(choice: TextRequest['toolChoice']): ToolChoice<ToolSet> | undefined {
  if (choice === undefined || typeof choice === 'string') return choice;
  return { type: 'tool', toolName: choice.name };
}

/**
 * Any Vercel AI SDK `LanguageModel` as a cascade text model. Tools are declared
 * from JSON Schema without `execute`: vRealTime runs them, with its interrupt
 * guarantees, and feeds results back through the history.
 */
export function aiSdk(model: LanguageModel, options: AiSdkOptions = {}): TextModel {
  return {
    id: typeof model === 'string' ? model : model.modelId,
    async *stream(request, { signal }): AsyncGenerator<TextPart> {
      const tools: ToolSet = {};
      for (const spec of request.tools) {
        tools[spec.name] = tool({ description: spec.description, inputSchema: jsonSchema(spec.parameters as JSONSchema7) });
      }
      const toolChoice = toToolChoice(request.toolChoice);
      const result = streamText({
        model,
        messages: toModelMessages(request.messages),
        abortSignal: signal,
        // Errors are rethrown below for cascade to report; skip the SDK's console logging.
        onError: () => {},
        ...(request.instructions !== undefined ? { instructions: request.instructions } : {}),
        ...(request.tools.length > 0 ? { tools } : {}),
        ...(toolChoice !== undefined ? { toolChoice } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(options.maxOutputTokens !== undefined ? { maxOutputTokens: options.maxOutputTokens } : {}),
        ...(options.providerOptions !== undefined ? { providerOptions: options.providerOptions } : {}),
      });
      const names = new Map<string, string>();
      for await (const part of result.stream) {
        switch (part.type) {
          case 'text-delta':
            if (part.text) yield { type: 'text', delta: part.text };
            break;
          case 'tool-input-start':
            names.set(part.id, part.toolName);
            break;
          case 'tool-input-delta':
            yield { type: 'tool-call-delta', callId: part.id, name: names.get(part.id) ?? '', argumentsDelta: part.delta };
            break;
          case 'tool-call':
            yield { type: 'tool-call', callId: part.toolCallId, name: part.toolName, arguments: part.input };
            break;
          case 'finish':
            yield {
              type: 'finish',
              usage: {
                ...(part.totalUsage.inputTokens !== undefined ? { inputTokens: part.totalUsage.inputTokens } : {}),
                ...(part.totalUsage.outputTokens !== undefined ? { outputTokens: part.totalUsage.outputTokens } : {}),
                ...(part.totalUsage.inputTokenDetails?.cacheReadTokens !== undefined ? { cachedInputTokens: part.totalUsage.inputTokenDetails.cacheReadTokens } : {}),
              },
            };
            break;
          case 'error':
            throw part.error instanceof Error ? part.error : new Error(String(part.error));
          case 'abort':
            return;
        }
      }
    },
  };
}
