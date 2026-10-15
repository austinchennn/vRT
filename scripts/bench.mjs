// Per-chunk framework cost on the audio hot path (docs/ARCHITECTURE.md §1: < 50 µs).
// Runs against the built package: npm run build && npm run bench
import { Emitter, Pcm16Resampler, toBase64 } from '../packages/core/dist/index.js';

const BUDGET_US = 50;
const ITERATIONS = 20_000;
const chunk = new Uint8Array(960); // 20 ms of 24 kHz mono PCM16
const view = new DataView(chunk.buffer);
for (let i = 0; i < 480; i++) view.setInt16(i * 2, Math.round(8000 * Math.sin(i / 7)), true);

const emitter = new Emitter();
let sink = 0;
emitter.on('output.audio', (event) => { sink += event.chunk.data.byteLength; });
const resampler = new Pcm16Resampler(24000, 16000);
const format = { encoding: 'pcm16', sampleRate: 24000, channels: 1 };

function step() {
  emitter.emit({ type: 'output.audio', responseId: 'r', itemId: 'i', chunk: { data: chunk, format } });
  sink += toBase64(resampler.process(chunk)).length;
}

for (let i = 0; i < 2_000; i++) step();
const start = performance.now();
for (let i = 0; i < ITERATIONS; i++) step();
const perChunkUs = ((performance.now() - start) * 1000) / ITERATIONS;

console.log(`emit + resample 24→16 kHz + base64, 20 ms chunk: ${perChunkUs.toFixed(2)} µs (budget ${BUDGET_US} µs)`);
if (sink === 0) throw new Error('unreachable');
if (perChunkUs > BUDGET_US) process.exit(1);
