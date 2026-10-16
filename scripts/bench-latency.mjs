// Framework latency on the paths #22 changes, over a real localhost WebSocket with a
// scripted model, so the numbers are vRT's own overhead (no model, no network):
//   preview    model emits a tool-argument delta  → client emits `tool.preview`
//   call       model emits a tool call            → the client tool's run() starts
//   interrupt  app calls session.interrupt()      → client emits `interrupted` (what the UI waits for)
//   confirmed  app calls session.interrupt()      → the server's turn ends (`turn.state` idle)
// `--rtt <ms>` delays every frame by half of it each way, to show which paths wait for the server.
// Baseline only: it reports p50/p95 and enforces no budget.
// Runs against the built packages: npm run build && npm run bench:latency [-- --rtt 100 --iterations 500 --json]
import { parseArgs } from 'node:util';
import { connect } from '../packages/client/dist/index.js';
import { defineAgent } from '../packages/core/dist/index.js';
import { serve } from '../packages/server/dist/node/index.js';
import { fakeModel } from '../packages/testing/dist/index.js';

const { values: args } = parseArgs({
  options: {
    iterations: { type: 'string', default: '300' },
    warmup: { type: 'string', default: '30' },
    rtt: { type: 'string', default: '0' },
    json: { type: 'boolean', default: false },
  },
});
const ITERATIONS = Number(args.iterations);
const WARMUP = Number(args.warmup);
const RTT_MS = Number(args.rtt);
const METRICS = ['preview', 'call', 'interrupt', 'confirmed'];

const model = fakeModel();
const server = await serve(defineAgent({ model, instructions: '', clientTools: 'accept' }), { port: 0, onListening: () => {} });

/** Resolves with the next event (or tool run) the predicate accepts. */
const waiters = new Set();
const next = (accept) => new Promise((resolve) => waiters.add({ accept, resolve }));
const notify = (event) => {
  for (const waiter of waiters) {
    if (!waiter.accept(event)) continue;
    waiters.delete(waiter);
    waiter.resolve(performance.now());
  }
};

/** The global WebSocket with `oneWayMs` added to every frame in both directions, order preserved. */
function delayedWebSocket(oneWayMs) {
  return class DelayedWebSocket {
    #inner;
    constructor(url) {
      this.#inner = new WebSocket(url);
    }
    get readyState() {
      return this.#inner.readyState;
    }
    get binaryType() {
      return this.#inner.binaryType;
    }
    set binaryType(value) {
      this.#inner.binaryType = value;
    }
    send(data) {
      setTimeout(() => this.#inner.readyState === WebSocket.OPEN && this.#inner.send(data), oneWayMs);
    }
    close(code, reason) {
      this.#inner.close(code, reason);
    }
    addEventListener(type, listener) {
      this.#inner.addEventListener(type, type === 'message' ? (event) => setTimeout(() => listener(event), oneWayMs) : listener);
    }
  };
}

const session = await connect(server.url.replace('http', 'ws'), {
  ...(RTT_MS > 0 ? { WebSocket: delayedWebSocket(RTT_MS / 2) } : {}),
  tools: { probe: { parameters: { type: 'object' }, run: (_args, { callId }) => notify({ type: 'run', callId }) } },
});
for (const type of ['tool.preview', 'tool.result', 'interrupted', 'state']) session.on(type, notify);

async function iteration(i) {
  const fake = model.session;
  const responseId = `r${i}`;
  const callId = `c${i}`;
  const responding = next((e) => e.type === 'state' && e.state === 'thinking');
  fake.emit({ type: 'response.start', responseId });
  await responding;

  let start = performance.now();
  const previewed = next((e) => e.type === 'tool.preview' && e.callId === callId);
  fake.emit({ type: 'tool.call.delta', responseId, callId, name: 'probe', argumentsDelta: '{"n":' });
  const preview = (await previewed) - start;

  start = performance.now();
  const ran = next((e) => e.type === 'run' && e.callId === callId);
  const answered = next((e) => e.type === 'tool.result' && e.callId === callId);
  fake.emit({ type: 'tool.call', responseId, callId, name: 'probe', arguments: { n: i } });
  const call = (await ran) - start;
  await answered;

  start = performance.now();
  const interrupted = next((e) => e.type === 'interrupted');
  const idle = next((e) => e.type === 'state' && e.state === 'idle');
  session.interrupt();
  const interrupt = (await interrupted) - start;
  const confirmed = (await idle) - start;
  model.clock.advance(0); // delivers the scripted model's own end of the cancelled response
  return { preview, call, interrupt, confirmed };
}

const samples = Object.fromEntries(METRICS.map((metric) => [metric, []]));
for (let i = 0; i < WARMUP + ITERATIONS; i++) {
  const result = await iteration(i);
  if (i >= WARMUP) for (const metric of METRICS) samples[metric].push(result[metric]);
}
await session.close();
await server.close();

/** Nearest-rank percentile. */
const percentile = (sorted, q) => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
const report = Object.fromEntries(METRICS.map((metric) => {
  const sorted = [...samples[metric]].sort((a, b) => a - b);
  return [metric, { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), max: sorted.at(-1), n: sorted.length }];
}));

if (args.json) console.log(JSON.stringify({ node: process.version, iterations: ITERATIONS, rttMs: RTT_MS, unit: 'ms', metrics: report }, null, 2));
else {
  console.log(`latency over localhost WebSocket, simulated RTT ${RTT_MS} ms, ${ITERATIONS} iterations (ms)`);
  for (const [metric, { p50, p95, max }] of Object.entries(report)) {
    console.log(`  ${metric.padEnd(10)} p50 ${p50.toFixed(3).padStart(8)}   p95 ${p95.toFixed(3).padStart(8)}   max ${max.toFixed(3).padStart(8)}`);
  }
}
