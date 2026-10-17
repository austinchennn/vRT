import { setImmediate } from 'node:timers/promises';
import { defineAgent } from '@vrealtime/core';
import { serve } from '@vrealtime/server/node';
import { fakeModel } from '@vrealtime/testing';
import type { Wire } from '../../report.js';

/** Owns only public fake-model observations; never emits expected wire frames. */
export async function inputServer() {
  const texts: string[] = []; const audio: Wire[] = [];
  let overflow = false; let finished = false;
  const model = fakeModel({ onCommand(command) {
    if (command.type === 'sendText') {
      if (texts.length >= 64 || command.text.length > 1024) overflow = true;
      else texts.push(command.text);
    }
    if (command.type === 'sendAudio') {
      if (audio.length >= 64 || command.chunk.data.byteLength > 1024) overflow = true;
      else audio.push({ hex: Buffer.from(command.chunk.data).toString('hex'), format: { ...command.chunk.format } });
    }
  } });
  const running = await serve(defineAgent({ model, instructions: '' }), { host: '127.0.0.1', port: 0, onListening: () => {} });
  let closing: Promise<void> | undefined;
  const close = () => closing ??= running.close();
  async function handle(command: string): Promise<Wire> {
    if (command !== 'readInputs' && command !== 'finishInputs') throw new Error(`Unknown input command ${command}`);
    if (command === 'finishInputs') {
      if (finished) throw new Error('Repeated input finish');
      finished = true;
      // No scripted events/tools/background producers. Drain attached SDK continuations.
      await setImmediate();
      model.session.emit({ type: 'input.transcript', itemId: 'input-finish-marker', text: 'input-observation-marker', final: true });
    }
    if (overflow) throw new Error('Input observation bound exceeded');
    return { sessions: model.sessions.length, texts: [...texts], audio: audio.map(item => ({ ...item, format: { ...item.format } })) };
  }
  return { url: running.url.replace('http:', 'ws:'), handle, close };
}
