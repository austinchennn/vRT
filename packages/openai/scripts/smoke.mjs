// Manual smoke test against the real OpenAI API (not run in CI).
// npm run build && OPENAI_API_KEY=... node packages/openai/scripts/smoke.mjs
import { openai } from '../dist/index.js';

const model = openai({ turnDetection: null });
const session = await model.connect({
  instructions: 'Answer in one short sentence. When asked about colors, call set_color.',
  modalities: 'audio',
  tools: [{ name: 'set_color', description: 'Set the accent color', parameters: { type: 'object', properties: { color: { type: 'string' } }, required: ['color'] } }],
});

let audioMs = 0;
const done = new Promise((resolve) => {
  session.on('session.ready', (e) => console.log('ready', e.sessionId));
  session.on('response.start', (e) => console.log('response.start', e.responseId));
  session.on('output.transcript', (e) => process.stdout.write(e.delta));
  session.on('output.audio', (e) => { audioMs += e.chunk.durationMs ?? 0; });
  session.on('tool.call', (e) => {
    console.log('\ntool.call', e.name, e.arguments);
    session.submitToolResult(e.callId, { ok: true });
  });
  session.on('extension', (e) => console.log('extension', e.name));
  session.on('error', (e) => console.error('\nerror', e.recoverable, e.error.message));
  let responses = 0;
  session.on('response.end', (e) => {
    console.log(`\nresponse.end ${e.status}, audio ${audioMs.toFixed(0)} ms`, e.usage ?? '');
    if (++responses === 2) resolve();
  });
});

session.sendText('Please make the accent color teal.');
session.respond();
await Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout after 30 s')), 30_000))]);
await session.close();
