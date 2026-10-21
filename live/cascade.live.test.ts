import { createOpenAI } from '@ai-sdk/openai';
import { aiSdk } from '@vrealtime/ai-sdk';
import { bosonTts } from '@vrealtime/boson';
import { cascade } from '@vrealtime/cascade';
import { defineAgent, startSession, type AgentEvent } from '@vrealtime/core';
import { voskStt } from '@vrealtime/vosk';
import { describe, expect, it } from 'vitest';

/**
 * One cascade end to end on real parts: a Vosk server hears the user and revises its
 * guess while they speak, a local Ollama model answers, Boson Higgs TTS speaks.
 * The user's voice is Boson TTS too, fed in real time.
 *
 *   VOSK_URL=ws://127.0.0.1:2700 OLLAMA_URL=http://127.0.0.1:11434/v1 OLLAMA_MODEL=qwen2.5:1.5b \
 *   BOSON_API_KEY=… npm run test:live
 */
const { BOSON_API_KEY, VOSK_URL, OLLAMA_URL, OLLAMA_MODEL } = process.env;
const ready = !!(BOSON_API_KEY && VOSK_URL && OLLAMA_URL && OLLAMA_MODEL);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function speech(text: string): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of bosonTts().synthesize(text, { signal: AbortSignal.timeout(30_000) })) chunks.push(chunk);
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

describe.skipIf(!ready)('cascade (live): vosk + ollama + boson tts', () => {
  it('shows revised guesses while the user speaks, answers the final transcript and speaks the answer', async () => {
    const llm = aiSdk(createOpenAI({ baseURL: OLLAMA_URL!, apiKey: 'ollama' }).chat(OLLAMA_MODEL!));
    const model = cascade({ stt: voskStt({ url: VOSK_URL! }), llm, tts: bosonTts() });
    const session = await startSession(defineAgent({ model, instructions: 'You are a voice assistant. Answer in one short sentence.' }));
    const events: AgentEvent[] = [];
    for (const type of ['transcript', 'audio', 'error', 'turn.state'] as const) session.on(type, (e) => events.push(e));

    // 20 ms frames at 24 kHz, in real time, so the recognizer hears it as it is said.
    const voice = await speech('Please turn on the lights in the kitchen.');
    const format = { encoding: 'pcm16', sampleRate: 24000, channels: 1 } as const;
    for (let at = 0; at < voice.byteLength; at += 960) {
      session.sendAudio({ data: voice.subarray(at, at + 960), format });
      await sleep(20);
    }
    session.commitAudio();
    await expect.poll(() => session.state, { timeout: 60_000, interval: 200 }).toBe('idle');
    await expect.poll(() => events.some((e) => e.type === 'turn.state' && e.state === 'speaking'), { timeout: 1 }).toBe(true);

    const user = events.filter((e): e is Extract<AgentEvent, { type: 'transcript' }> => e.type === 'transcript' && e.role === 'user');
    const final = user.find((e) => e.final);
    expect(events.filter((e) => e.type === 'error')).toEqual([]);
    // Guesses came before the final transcript, numbered in order.
    expect(user.filter((e) => !e.final).length).toBeGreaterThan(0);
    expect(user.map((e) => e.revision)).toEqual(user.map((_, i) => i + 1));
    expect(final?.text).toMatch(/kitchen/i);
    expect(session.transcript.find((t) => t.role === 'user')?.text).toBe(final?.text);
    // The model answered, and the answer was spoken.
    expect(session.transcript.find((t) => t.role === 'agent')?.text.length).toBeGreaterThan(0);
    expect(events.filter((e) => e.type === 'audio').length).toBeGreaterThan(0);
    await session.close();
  });
});
