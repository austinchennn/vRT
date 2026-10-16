/**
 * OpenAI (or OpenAI-compatible) HTTP speech endpoints as cascade parts:
 * `cascade({ stt: openaiStt(), llm, tts: openaiTts() })`. The shapes match
 * `@vrealtime/cascade`'s `SttModel` / `TtsModel` without depending on it.
 */
type Pcm16Format = { encoding: 'pcm16'; sampleRate: 8000 | 16000 | 24000 | 48000; channels: 1 };

export interface SpeechOptions {
  /** Defaults to `process.env.OPENAI_API_KEY`. */
  apiKey?: string;
  /** Default `https://api.openai.com/v1`; any OpenAI-compatible base URL works. */
  baseURL?: string;
  model?: string;
  fetch?: typeof fetch;
}

export interface SttOptions extends SpeechOptions {
  /** Hint for the spoken language (ISO-639-1), when not set per session. */
  language?: string;
}

export interface TtsOptions extends SpeechOptions {
  /** Default `alloy`; a session `voice` overrides it. */
  voice?: string;
  /** Speaking style for models that support it (e.g. `gpt-4o-mini-tts`). */
  instructions?: string;
}

function envKey(): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.['OPENAI_API_KEY'];
}

function resolve(options: SpeechOptions) {
  const apiKey = options.apiKey ?? envKey();
  if (!apiKey) throw new Error('openai speech: missing apiKey (or OPENAI_API_KEY)');
  return { apiKey, baseURL: (options.baseURL ?? 'https://api.openai.com/v1').replace(/\/$/, ''), fetchImpl: options.fetch ?? fetch };
}

/** Wraps mono PCM16 in a WAV container for upload. */
export function pcm16ToWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const wav = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(wav.buffer);
  const ascii = (offset: number, text: string) => { for (let i = 0; i < text.length; i++) wav[offset + i] = text.charCodeAt(i); };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + pcm.byteLength, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, pcm.byteLength, true);
  wav.set(pcm, 44);
  return wav;
}

async function failure(response: Response, what: string): Promise<Error> {
  const body = await response.text().catch(() => '');
  return new Error(`${what} failed (HTTP ${response.status})${body ? `: ${body.slice(0, 200)}` : ''}`);
}

/** Speech to text through `/audio/transcriptions` (default model `gpt-4o-transcribe`). */
export function openaiStt(options: SttOptions = {}) {
  const { apiKey, baseURL, fetchImpl } = resolve(options);
  const model = options.model ?? 'gpt-4o-transcribe';
  return {
    sampleRate: 16000 as const,
    async transcribe(audio: Uint8Array, format: Pcm16Format, call: { signal: AbortSignal; language?: string }): Promise<string> {
      const form = new FormData();
      form.append('file', new Blob([pcm16ToWav(audio, format.sampleRate) as Uint8Array<ArrayBuffer>], { type: 'audio/wav' }), 'audio.wav');
      form.append('model', model);
      const language = call.language ?? options.language;
      if (language) form.append('language', language);
      const response = await fetchImpl(`${baseURL}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal: call.signal });
      if (!response.ok) throw await failure(response, 'transcription');
      const json = (await response.json()) as { text?: string };
      return json.text ?? '';
    },
  };
}

/** Text to speech through `/audio/speech` as raw 24 kHz PCM16, streamed (default model `gpt-4o-mini-tts`). */
export function openaiTts(options: TtsOptions = {}) {
  const { apiKey, baseURL, fetchImpl } = resolve(options);
  const model = options.model ?? 'gpt-4o-mini-tts';
  const format: Pcm16Format = { encoding: 'pcm16', sampleRate: 24000, channels: 1 };
  return {
    format,
    async *synthesize(text: string, call: { voice?: string; signal: AbortSignal }): AsyncGenerator<Uint8Array> {
      const response = await fetchImpl(`${baseURL}/audio/speech`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          input: text,
          voice: call.voice ?? options.voice ?? 'alloy',
          response_format: 'pcm',
          ...(options.instructions ? { instructions: options.instructions } : {}),
        }),
        signal: call.signal,
      });
      if (!response.ok || !response.body) throw await failure(response, 'speech');
      // Network chunks can split a sample; carry the odd byte to the next chunk.
      let carry: number | undefined;
      const reader = response.body.getReader();
      try {
        for (let read = await reader.read(); !read.done; read = await reader.read()) {
          let bytes = read.value;
          if (carry !== undefined) {
            const joined = new Uint8Array(bytes.byteLength + 1);
            joined[0] = carry;
            joined.set(bytes, 1);
            bytes = joined;
            carry = undefined;
          }
          if (bytes.byteLength % 2 === 1) {
            carry = bytes[bytes.byteLength - 1];
            bytes = bytes.subarray(0, bytes.byteLength - 1);
          }
          if (bytes.byteLength > 0) yield bytes;
        }
      } finally {
        reader.releaseLock();
      }
    },
  };
}
