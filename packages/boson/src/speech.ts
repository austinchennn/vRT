import { pcm16Chunks } from '@vrealtime/openai-compatible';

/**
 * Boson Higgs TTS as a cascade part: `cascade({ stt, llm, tts: bosonTts() })`. The shape
 * matches `@vrealtime/cascade`'s `TtsModel` without depending on it.
 */
type Pcm16Format = { encoding: 'pcm16'; sampleRate: 24000; channels: 1 };

export interface BosonTtsOptions {
  /** Defaults to `process.env.BOSON_API_KEY` where `process` exists. */
  apiKey?: string;
  /** Default `https://api.boson.ai/v1`. */
  baseURL?: string;
  /** Default `higgs-tts-3`. */
  model?: string;
  /** A preset voice or a custom voice id; default `default`. A session `voice` overrides it. */
  voice?: string;
  fetch?: typeof fetch;
}

function envKey(): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.['BOSON_API_KEY'];
}

/** Text to speech through `/audio/speech`, streamed as raw 24 kHz PCM16 as it is decoded. */
export function bosonTts(options: BosonTtsOptions = {}) {
  const apiKey = options.apiKey ?? envKey();
  if (!apiKey) throw new Error('boson tts: missing apiKey (or BOSON_API_KEY)');
  const baseURL = (options.baseURL ?? 'https://api.boson.ai/v1').replace(/\/$/, '');
  const fetchImpl = options.fetch ?? fetch;
  const model = options.model ?? 'higgs-tts-3';
  const format: Pcm16Format = { encoding: 'pcm16', sampleRate: 24000, channels: 1 };
  return {
    format,
    async *synthesize(text: string, call: { voice?: string; signal: AbortSignal }): AsyncGenerator<Uint8Array> {
      const response = await fetchImpl(`${baseURL}/audio/speech`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: text, voice: call.voice ?? options.voice ?? 'default', response_format: 'pcm', stream: true }),
        signal: call.signal,
      });
      if (!response.ok || !response.body) {
        const body = await response.text().catch(() => '');
        throw new Error(`boson tts failed (HTTP ${response.status})${body ? `: ${body.slice(0, 200)}` : ''}`);
      }
      yield* pcm16Chunks(response.body);
    },
  };
}
