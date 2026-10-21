# vRealTime (vRT)

**For decades, we learned the machine’s language. Now machines learn ours.**

One protocol for voice agents that act on any app or device. Light, fast, interruptible.

vRealTime lets people talk to software and devices the way they talk to each other. An agent listens, speaks and calls tools that run where they belong: in a web page, a phone app, a desktop program or a light switch.

vRealTime is protocol-first. The vRT protocol (WebSocket, JSON control messages, binary audio frames) is the contract. This repository holds the TypeScript reference implementation of the server runtime and the first client SDK. Clients are deliberately thin, so they can be written in any language, down to microcontrollers.

- **Protocol-first**: a language-neutral [spec](spec/) (prose, JSON Schemas and test vectors) and a conformance suite define what "compatible" means, whatever language an implementation is written in (conformance suite in progress: #17).
- **Any language, any device**: TypeScript client today; Python next (#18); Swift, Kotlin and C for ESP32-class devices planned.
- **Tools run in your app or device**: with strict interrupt guarantees. Once the user interrupts, nothing from that turn takes effect, whether it edits a document or unlocks a door.
- **Any model**: Boson Higgs Realtime, OpenAI Realtime, Gemini Live, or any text LLM plus STT and TTS through `cascade()`.
- **Light**: zero-dependency core, one small package per provider, ESM only. No media server, no workers, no native binaries.
- **Fast**: synchronous audio hot path, binary frames instead of base64 JSON, Opus passthrough where the model accepts it.
- **Runs anywhere**: the server runtime runs on Node, Bun, Deno and Cloudflare Workers; the TypeScript client runs in the browser too. Web-standard APIs only.

```js
import { defineAgent } from '@vrealtime/core';
import { boson } from '@vrealtime/boson';
import { serve } from '@vrealtime/server/node';

serve(defineAgent({
  model: boson({ voice: 'default', turnDetection: 'semantic' }),
  instructions: 'You are a friendly voice assistant. When asked to change colors, call set_accent_color.',
  clientTools: 'accept',
}), { port: 8790, publicDir: new URL('./public', import.meta.url) });
```

> Status: M0 and M2 are implemented in this repo: core runtime, protocol, Boson / OpenAI / Gemini adapters, cascade (STT + any AI SDK model + TTS), VAD, Node / Workers server, browser client and React hooks. The language-neutral [protocol spec](spec/) is written; the conformance suite and Python client SDK are in progress (M1). Packages are published on npm as `@vrealtime/*`.

## How it fits together

```
                 vRT protocol: spec + conformance suite
           ┌────────────────────┴─────────────────────┐
  Server (TypeScript reference)              Clients (thin, any language)
  agent runtime · model adapters ·           web · mobile · desktop · devices
  server tools · hooks · audit               app tools · audio in/out · epoch gate
```

- **Agent developers** pick a model, write instructions and hooks, and run the server runtime.
- **App and device developers** connect with a client SDK, declare their tools and, optionally, stream audio. A device without a microphone or speaker, such as a light, only hosts tools.

## Quickstart

Requires Node 22+. From a clone of this repo:

```bash
npm install
npm run build
BOSON_API_KEY=your-key npm start -w examples/minimal
```

Open http://localhost:8790 and press **Talk**, or type a message. Ask it to change the color: the `set_accent_color` tool runs in the page. Speak over the agent (or press Esc) to interrupt it; once interrupted, no further tool call from that turn is applied.

The same agent runs on any of the four models; only the model changes ([examples/minimal/models.js](examples/minimal/models.js)):

```bash
MODEL=openai OPENAI_API_KEY=your-key npm start -w examples/minimal
```

```bash
MODEL=gemini GEMINI_API_KEY=your-key npm start -w examples/minimal
```

```bash
MODEL=cascade OPENAI_API_KEY=your-key npm start -w examples/minimal
```

```bash
MODEL=cascade-claude ANTHROPIC_API_KEY=your-key OPENAI_API_KEY=your-key npm start -w examples/minimal
```

Cascade works with any text model the AI SDK supports (Claude, OpenAI, self-hosted OpenAI-compatible servers...) and any OpenAI-compatible speech endpoint (`openaiStt({ baseURL })`, `openaiTts({ baseURL })`). Session config `inputTranscription: { language, vocabulary }` biases recognition toward names and terms (for example words from the open document) on every model that supports it.

No API key? `npm run start:fake -w examples/minimal` serves the same page with a scripted fake model.

The browser side is a few lines with `@vrealtime/client` (see [examples/minimal/app.js](examples/minimal/app.js)):

```js
import { connect } from '@vrealtime/client';

const session = await connect('ws://localhost:8790', {
  tools: { set_accent_color: { parameters: { type: 'object', properties: { color: { type: 'string' } } }, run: ({ color }) => setAccent(color) } },
  audio: { input: 'mic', output: 'speaker' },
});
session.on('transcript', (e) => console.log(e.role, e.text));
```

### React

```tsx
import { useRealtime } from '@vrealtime/react';

function Assistant() {
  const { status, state, transcript, connect, interrupt } = useRealtime('wss://your-server', {
    tools: { set_accent_color: { parameters: { type: 'object' }, run: ({ color }) => setAccent(color) } },
    audio: { input: 'mic', output: 'speaker' },
  });
  return <button onClick={status === 'connected' ? () => interrupt() : connect}>{status === 'connected' ? state : 'Talk'}</button>;
}
```

### Cloudflare Workers and Durable Objects

```ts
import { upgrade } from '@vrealtime/server/workers';
import { boson, fetchSocket } from '@vrealtime/boson';

const agent = defineAgent({ model: boson({ apiKey: env.BOSON_API_KEY, socket: fetchSocket() }), instructions: '…', clientTools: 'accept' });
export default { fetch: (request) => upgrade(agent, request) };
```

Workers' `WebSocket` cannot send auth headers, so Boson and OpenAI connect through `fetchSocket()`. Inside a Durable Object, call `upgrade()` from its `fetch()`; sessions live in the object's memory, so route reconnects to the same object to resume. [examples/workers](examples/workers) is a complete Worker with one Durable Object per document and token auth; `npm run test:workers` runs it in `wrangler dev` (workerd) against a mock Boson server.

### Authentication

Tokens go in the first message, never in the URL. The client takes a string or a function (called on every reconnect, so short-lived tokens can rotate); the server decides who is connected and configures the session for them:

```ts
connect(url, { auth: () => fetchShortLivedToken(), context: { docId } });

serve(agent, {
  authenticate: async ({ token, context, headers }) => verify(token, context),   // → { id, ... } or undefined to refuse
  configure: (principal) => ({ instructions: `You edit ${principal?.docId}.` }),
});
```

Tools and hooks see the principal as `context.data` / `info.data`; a session can only be resumed by the same principal.

## Install

Packages are on npm as [`@vrealtime/*`](https://www.npmjs.com/org/vrealtime), each published from CI with [provenance](https://docs.npmjs.com/generating-provenance-statements). A server needs the runtime, the server edge and a model adapter (`ws` for Node's `serve()`); an app needs the client:

```bash
npm install @vrealtime/core @vrealtime/server @vrealtime/boson ws
```

```bash
npm install @vrealtime/client
```

The [installation guide](https://austinchennn.github.io/vRT/get-started/installation/) lists every model and optional package. To try unreleased changes from `main`, run `npm run pack` and install the tarballs it writes to `release/`; releases publish those same files ([RELEASING.md](RELEASING.md)).

The [Python protocol foundation](python/) provides standard-library-only message and audio
codecs with shared spec-vector tests. It is not yet a connection/session SDK.

## Development

```bash
npm run check:spec && npm run typecheck && npm test && npm run test:e2e
npm run build && npm run check:budgets && npm run bench
```

`BOSON_API_KEY=… npm run test:live` checks behaviour that only a real provider can show, such as Boson actually cutting its stored copy of a reply that was truncated. It is never part of `npm test` or CI, costs a little usage, and reports each test as skipped when its key is missing.

`npm run bench:latency -- --rtt 100` measures how long a tool-argument preview, a tool call and an interruption take to reach the app over a WebSocket with a simulated round-trip time (after `npm run build`).

The partial [black-box conformance profiles](conformance/) check baseline handshakes
and the client's local interrupt gate across real WebSockets and independent driver
processes. Run `npm run test:conformance`; select `server-tool-stream-v1` for server capability/lifecycle checks or `server-heartbeat-v1` for server heartbeat/activity-timeout checks (see the linked guide). Select `server-input-validation-v1` for server invalid-control and binary-input boundaries. Select `client-control-validation-v1` for client invalid-control handling. Select `server-resume-replay-v1` for normal server recovery/replay checks. Select `server-resume-principal-v1` for recovery authentication and owner isolation. Select `server-resume-rejection-v1` for recovery rejection and ACK-deletion cursor boundaries. Passing selected profiles is not full protocol certification.

## Documentation

- [Documentation site](https://austinchennn.github.io/vRT/) (English and 中文): quickstart, concepts, guides and API reference. Source in [website/](website/).
- [Protocol specification](spec/): the wire protocol every implementation follows, with JSON Schemas and test vectors
- [Architecture](docs/ARCHITECTURE.md) (Chinese)

## Roadmap

| Milestone | Scope |
|---|---|
| M0 ✅ | Core runtime with interrupt guarantees, protocol, Boson adapter, Node server, browser client, ten-line demo |
| M2 ✅ | OpenAI and Gemini adapters, cascade, AI SDK models, VAD, Workers and Durable Objects, React hooks |
| M1 | Language-neutral spec and JSON Schemas (#16), conformance suite (#17), Python client SDK (#18) |
| M3 | MCP bridge (#19), Swift and Kotlin SDKs, device auth, Home Assistant example |
| M4 | C SDK for ESP32-class devices, docs site, npm and PyPI releases, benchmarks |

## Packages (TypeScript)

| Package | Purpose |
|---|---|
| `@vrealtime/core` | Model interface, normalized events, agent runtime, tools, hooks |
| `@vrealtime/protocol` | Wire protocol v1 between apps and a vRealTime server (implements [spec/](spec/)) |
| `@vrealtime/boson`, `@vrealtime/openai`, `@vrealtime/gemini` | Provider adapters (Boson Higgs Realtime, OpenAI Realtime, Gemini Live) |
| `@vrealtime/server` | Attach any WebSocket; Node `serve()` with a debug page; Workers / Durable Objects `upgrade()` |
| `@vrealtime/client` | Browser SDK: app-side tools with the epoch gate, mic and playback |
| `@vrealtime/testing` | Scripted fake model for tests |
| `@vrealtime/cascade`, `@vrealtime/ai-sdk` | STT + any text LLM + TTS as one realtime model; AI SDK models as the LLM |
| `@vrealtime/vad` | Energy VAD for turn detection where the model has none |
| `@vrealtime/react` | `useRealtime()` hook |

## License

[Apache-2.0](LICENSE)
