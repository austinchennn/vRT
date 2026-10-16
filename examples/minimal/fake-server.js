// The example page without an API key: a scripted fake model that echoes what
// you type, speaks a short tone, and calls set_accent_color when you name a color.
import { defineAgent } from '@vrealtime/core';
import { serve } from '@vrealtime/server/node';
import { fakeModel } from '@vrealtime/testing';

const COLORS = ['red', 'orange', 'gold', 'green', 'teal', 'blue', 'purple', 'pink'];
const pcm = { encoding: 'pcm16', sampleRate: 24000, channels: 1 };

function tone(ms, hz) {
  const data = new Uint8Array(48 * ms);
  const view = new DataView(data.buffer);
  for (let i = 0; i < 24 * ms; i++) view.setInt16(i * 2, Math.round(6000 * Math.sin((2 * Math.PI * hz * i) / 24000)), true);
  return { data, format: pcm, durationMs: ms };
}

let turn = 0;
let lastText = '';
const model = fakeModel({
  capabilities: { tools: { autoReplyAfterResult: false } },
  onCommand(command, session) {
    if (command.type === 'sendText') lastText = command.text;
    if (command.type !== 'respond') return;
    const id = `r${++turn}`;
    const color = COLORS.find((c) => lastText.toLowerCase().includes(c));
    const reply = color ? `Changing the color to ${color}.` : lastText ? `You said: ${lastText}` : 'Done.';
    lastText = '';
    session.schedule({ type: 'response.start', responseId: id }, 150);
    reply.split(' ').forEach((word, i) => {
      session.schedule({ type: 'output.transcript', responseId: id, itemId: `${id}-a`, delta: (i ? ' ' : '') + word }, 200 + i * 120);
    });
    for (let i = 0; i < 40; i++) session.schedule({ type: 'output.audio', responseId: id, itemId: `${id}-a`, chunk: tone(20, 440 + 40 * (turn % 5)) }, 200 + i * 20);
    if (color) session.schedule({ type: 'tool.call', responseId: id, callId: `${id}-c`, name: 'set_accent_color', arguments: { color } }, 1200);
    session.schedule({ type: 'response.end', responseId: id, status: 'done' }, 1300);
  },
});
setInterval(() => model.clock.advance(10), 10);

serve(defineAgent({ model, instructions: 'fake', clientTools: 'accept' }), {
  port: Number(process.env.PORT ?? 8790),
  // DEBUG_PAGE=1 serves the server's built-in microphone debug page instead.
  ...(process.env.DEBUG_PAGE ? {} : { publicDir: new URL('./public', import.meta.url) }),
});
