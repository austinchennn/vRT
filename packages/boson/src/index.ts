import { RealtimeError, type AudioFormat, type Capabilities, type RealtimeModel, type SessionConfig } from '@vrealtime/core';
import { createCompatibleModel, type BuiltinTool, type ErrorTables, type SocketFactory } from '@vrealtime/openai-compatible';

export { SERVER_TOOL_CALL, SERVER_TOOL_RESULT, fetchSocket } from '@vrealtime/openai-compatible';
export { bosonTts, type BosonTtsOptions } from './speech.js';
export type { ProviderSocket, SocketFactory } from '@vrealtime/openai-compatible';

export const BOSON_REALTIME_URL = 'wss://api.boson.ai/v1/realtime';

/** Boson's built-in web search tool; its name is reserved for it. */
export const BOSON_WEB_SEARCH = 'web_search';

/**
 * Options of Boson's built-in web search
 * (https://docs.boson.ai/models/higgs-realtime/guides/tool-calling.md).
 */
export interface BosonWebSearch {
  /** Only results from these bare hostnames (and their subdomains); at most 5. Exclusive with `excludedDomains`. */
  allowedDomains?: readonly string[];
  /** Never results from these bare hostnames; at most 5. */
  excludedDomains?: readonly string[];
  /** ISO 3166-1 alpha-2 country to bias results toward, e.g. `CN` or `US`. */
  country?: string;
}

export interface BosonOptions {
  /** Defaults to `process.env.BOSON_API_KEY` where `process` exists. */
  apiKey?: string;
  model?: string;
  voice?: string;
  /** `null` for manual turns via `commitAudio()`. */
  turnDetection?: 'server' | 'semantic' | null;
  /** Transcribe user speech (`higgs-stt-3.1`); on by default. */
  transcription?: boolean | { language?: string };
  inputFormat?: AudioFormat;
  outputFormat?: AudioFormat;
  url?: string;
  /** Custom socket for runtimes whose `WebSocket` cannot set headers (e.g. Cloudflare Workers). */
  socket?: SocketFactory;
  /**
   * Boson's built-in web search, run on Boson's servers whenever the model decides
   * it needs current or uncertain facts. Its calls never reach the app as tool calls
   * (they surface as `server_tool.call` / `server_tool.result` extension events), and
   * no app tool may be named `web_search`. Off by default.
   */
  webSearch?: boolean | BosonWebSearch;
}

const PCM = (sampleRate: 8000 | 16000 | 24000 | 48000): AudioFormat => ({ encoding: 'pcm16', sampleRate, channels: 1 });

export const BOSON_CAPABILITIES: Capabilities = {
  input: { audio: true, text: true, formats: [PCM(8000), PCM(16000), PCM(24000), PCM(48000), { encoding: 'pcmu' }, { encoding: 'opus', frameMs: 20 }] },
  output: { audio: true, text: true, formats: [PCM(24000)] },
  turnDetection: { server: true, semantic: true, manual: true },
  inputTranscription: true,
  tools: { calls: true, argumentStreaming: true, autoReplyAfterResult: false },
  truncate: true,
  midSessionUpdate: { instructions: true, tools: true },
};

const EXTENSIONS = ['conversation.context.summarized', 'session.idle_timeout', 'session.max_duration_reached'];

/**
 * Boson's error vocabulary on top of the OpenAI error types it shares.
 * See https://docs.boson.ai/api-reference/realtime/overview.md and /api-reference/errors.md.
 */
export const BOSON_ERRORS: ErrorTables = {
  errorTypes: {
    voice_output_task_ongoing: 'invalid_request',
    invalid_previous_item_id: 'invalid_request',
    conversation_item_duplicate_id: 'invalid_request',
    conversation_item_not_found: 'invalid_request',
  },
  // 4429 always follows an `insufficient_quota` error event, whose message the close error repeats.
  closeCodes: { 1013: 'overloaded', 3000: 'auth', 4429: 'quota' },
  sessionLimitEvents: ['session.idle_timeout', 'session.max_duration_reached'],
};

function envKey(): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.['BOSON_API_KEY'];
}

const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const MAX_DOMAINS = 5;

/** The wire form of the web search tool; refuses what Boson would reject, before any session starts. */
export function bosonWebSearchTool(options: true | BosonWebSearch): BuiltinTool {
  const settings = options === true ? {} : options;
  const invalid = (message: string): never => { throw new RealtimeError('invalid_request', `boson: webSearch ${message}`, { provider: 'boson' }); };
  const domains = (list: readonly string[] | undefined, field: string): string[] | undefined => {
    if (list === undefined || list.length === 0) return undefined;
    if (list.length > MAX_DOMAINS) invalid(`${field} takes at most ${MAX_DOMAINS} domains`);
    for (const domain of list) if (!HOSTNAME.test(domain)) invalid(`${field} needs bare hostnames without scheme or path, got "${domain}"`);
    return [...list];
  };
  const allowed = domains(settings.allowedDomains, 'allowedDomains');
  const excluded = domains(settings.excludedDomains, 'excludedDomains');
  if (allowed && excluded) invalid('allowedDomains and excludedDomains are mutually exclusive');
  if (settings.country !== undefined && !/^[A-Za-z]{2}$/.test(settings.country)) invalid(`country must be an ISO 3166-1 alpha-2 code, got "${settings.country}"`);
  return {
    type: BOSON_WEB_SEARCH,
    ...(allowed ? { allowed_domains: allowed } : {}),
    ...(excluded ? { excluded_domains: excluded } : {}),
    ...(settings.country !== undefined ? { location: { country: settings.country.toUpperCase() } } : {}),
  };
}

/** Boson Higgs Realtime (OpenAI Realtime GA compatible). */
export function boson(options: BosonOptions = {}): RealtimeModel {
  const apiKey = options.apiKey ?? envKey();
  if (!apiKey) throw new RealtimeError('auth', 'boson: missing apiKey (or BOSON_API_KEY)', { provider: 'boson' });
  const model = options.model ?? 'higgs-realtime';
  const builtinTools = options.webSearch ? [bosonWebSearchTool(options.webSearch)] : [];
  const defaults: SessionConfig = {
    turnDetection: options.turnDetection === undefined ? 'semantic' : options.turnDetection,
    inputTranscription: options.transcription ?? true,
    inputFormat: options.inputFormat ?? PCM(24000),
    outputFormat: options.outputFormat ?? PCM(24000),
    ...(options.voice !== undefined ? { voice: options.voice } : {}),
  };
  return createCompatibleModel({
    provider: 'boson',
    id: model,
    model,
    url: options.url ?? BOSON_REALTIME_URL,
    headers: { Authorization: `Bearer ${apiKey}` },
    capabilities: BOSON_CAPABILITIES,
    defaults,
    transcriptionModel: 'higgs-stt-3.1',
    extensions: EXTENSIONS,
    // Boson sends nothing on connect and acks the first `session.update` with `session.created`.
    readyOn: 'session.created',
    errors: BOSON_ERRORS,
    ...(builtinTools.length > 0 ? { builtinTools } : {}),
    ...(options.socket ? { socket: options.socket } : {}),
  });
}
