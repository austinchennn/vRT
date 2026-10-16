import { defineAgent, startSession, type AudioChunk } from '@vrealtime/core';
import { fakeModel } from '@vrealtime/testing';
import { describe, expect, it } from 'vitest';
import { energyVad } from '../src/index.js';

const format = { encoding: 'pcm16', sampleRate: 16000, channels: 1 } as const;

function chunk(amplitude: number, ms = 20, seed = 1): AudioChunk {
  const n = (16000 * ms) / 1000;
  const data = new Uint8Array(n * 2);
  const view = new DataView(data.buffer);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    const noise = ((x / 0x7fffffff) * 2 - 1) * 30;
    view.setInt16(i * 2, Math.round(amplitude * Math.sin((2 * Math.PI * 220 * i) / 16000) + noise), true);
  }
  return { data, format };
}

function run(vad: ReturnType<ReturnType<typeof energyVad>>, chunks: AudioChunk[]) {
  return chunks.map((c, i) => [i, vad.process(c)] as const).filter(([, e]) => e !== undefined);
}

const repeat = (n: number, make: (i: number) => AudioChunk) => Array.from({ length: n }, (_, i) => make(i));

describe('energyVad', () => {
  it('detects speech after minSpeechMs and its end after minSilenceMs', () => {
    const vad = energyVad({ minSpeechMs: 100, minSilenceMs: 300 })();
    const audio = [...repeat(20, (i) => chunk(0, 20, i)), ...repeat(30, (i) => chunk(8000, 20, i)), ...repeat(20, (i) => chunk(0, 20, i))];
    expect(run(vad, audio)).toEqual([[24, 'start'], [64, 'end']]);
    expect(vad.speaking).toBe(false);
  });

  it('ignores short blips and short pauses', () => {
    const vad = energyVad({ minSpeechMs: 100, minSilenceMs: 300 })();
    const blip = [...repeat(10, () => chunk(0)), ...repeat(3, () => chunk(8000)), ...repeat(10, () => chunk(0))];
    expect(run(vad, blip)).toEqual([]);
    const pause = [...repeat(10, () => chunk(8000)), ...repeat(10, () => chunk(0)), ...repeat(10, () => chunk(8000))];
    expect(run(vad, pause).map(([, e]) => e)).toEqual(['start']);
  });

  it('adapts to steady background noise', () => {
    const vad = energyVad({ minSpeechMs: 100, minSilenceMs: 300 })();
    const noisy = repeat(100, (i) => chunk(600, 20, i));
    expect(run(vad, noisy).filter(([i]) => i > 10)).toEqual([]);
    expect(run(vad, repeat(10, () => chunk(9000))).map(([, e]) => e)).toEqual(['start']);
  });

  it('ignores non-PCM audio and resets', () => {
    const vad = energyVad()();
    expect(vad.process({ data: new Uint8Array(160), format: { encoding: 'pcmu' } })).toBeUndefined();
    run(vad, repeat(20, () => chunk(8000)));
    expect(vad.speaking).toBe(true);
    vad.reset();
    expect(vad.speaking).toBe(false);
  });

  it('costs well under 10 µs per 20 ms chunk', () => {
    const vad = energyVad()();
    const c = chunk(4000);
    for (let i = 0; i < 2000; i++) vad.process(c);
    const start = performance.now();
    for (let i = 0; i < 20000; i++) vad.process(c);
    expect(((performance.now() - start) * 1000) / 20000).toBeLessThan(10);
  });
});

describe('runtime turn detection with a VAD', () => {
  it('commits and asks for a reply on speech end, and interrupts on speech start', async () => {
    const model = fakeModel({ capabilities: { turnDetection: { server: false } } });
    const session = await startSession(defineAgent({ model, instructions: '', vad: energyVad({ minSpeechMs: 60, minSilenceMs: 200 }) }));
    const states: string[] = [];
    session.on('turn.state', (e) => states.push(e.state));
    for (const c of [...repeat(5, () => chunk(0)), ...repeat(10, () => chunk(8000)), ...repeat(12, () => chunk(0))]) session.sendAudio(c);
    expect(model.session.commands.filter((c) => c.type === 'commitAudio' || c.type === 'respond').map((c) => c.type)).toEqual(['commitAudio', 'respond']);
    expect(states).toEqual(['listening', 'thinking']);

    model.session.emit({ type: 'response.start', responseId: 'r1' });
    model.session.emit({ type: 'output.audio', responseId: 'r1', itemId: 'a', chunk: { data: new Uint8Array(480), format } });
    for (const c of repeat(5, () => chunk(8000))) session.sendAudio(c);
    expect(model.session.commandsOf('cancel')).toHaveLength(1);
    expect(session.state).toBe('listening');
  });

  it('stays off when the model detects turns itself or turns are manual', async () => {
    const serverVad = fakeModel();
    const a = await startSession(defineAgent({ model: serverVad, instructions: '', vad: energyVad({ minSpeechMs: 20 }) }));
    for (const c of repeat(10, () => chunk(8000))) a.sendAudio(c);
    expect(a.state).toBe('idle');
    const manual = fakeModel({ capabilities: { turnDetection: { server: false } } });
    const b = await startSession(defineAgent({ model: manual, instructions: '', turnDetection: null, vad: energyVad({ minSpeechMs: 20 }) }));
    for (const c of repeat(10, () => chunk(8000))) b.sendAudio(c);
    expect(b.state).toBe('idle');
  });
});
