# vRealTime (vRT)

**Realtime voice agents for any app. Light, fast, interruptible.**

vRealTime is a TypeScript framework that gives every realtime speech model one API and lets agents act inside your app as they speak.

- **Light**: zero-dependency core, one small package per provider, ESM only. No media server, no workers, no native binaries.
- **Fast**: synchronous audio hot path, binary frames instead of base64 JSON, Opus passthrough where the model accepts it.
- **Runs anywhere**: Node, Bun, Deno, Cloudflare Workers and the browser. Web-standard APIs only.
- **App-side tools**: tools can run in the user's app with strict interrupt guarantees. Once the user interrupts, no further side effects land.
- **Any model**: Boson Higgs Realtime, OpenAI Realtime, Gemini Live, or any text LLM plus STT and TTS through `cascade()`.

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

> Status: M0 and M2 are implemented in this repo: core runtime, protocol, Boson / OpenAI / Gemini adapters, cascade (STT + any AI SDK model + TTS), VAD, Node / Workers server, browser client and React hooks. Packages are not published to npm yet.

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

## Installing before the npm release

Packages are not on npm yet (public release is M4). Build installable tarballs and add the ones you need to your app:

```bash
npm run pack
```

```bash
npm i /path/to/vRT/release/vrealtime-core-0.1.0.tgz /path/to/vRT/release/vrealtime-protocol-0.1.0.tgz /path/to/vRT/release/vrealtime-openai-compatible-0.1.0.tgz /path/to/vRT/release/vrealtime-boson-0.1.0.tgz /path/to/vRT/release/vrealtime-server-0.1.0.tgz /path/to/vRT/release/vrealtime-client-0.1.0.tgz
```

Install each package together with the `@vrealtime/*` packages it depends on, as above. `npm run test:consumer` checks that the tarballs install into an empty project, import in Node and type-check with `moduleResolution` `bundler` and `nodenext`.

## Development

```bash
npm run typecheck && npm test && npm run test:e2e
npm run build && npm run check:budgets && npm run bench
```

## Design

- [Architecture](docs/ARCHITECTURE.md) (Chinese)

## Packages

| Package | Purpose |
|---|---|
| `@vrealtime/core` | Model interface, normalized events, agent runtime, tools, hooks |
| `@vrealtime/protocol` | Wire protocol v1 between apps and a vRealTime server |
| `@vrealtime/boson`, `@vrealtime/openai`, `@vrealtime/gemini` | Provider adapters (Boson Higgs Realtime, OpenAI Realtime, Gemini Live) |
| `@vrealtime/server` | Attach any WebSocket; Node `serve()` with a debug page; Workers / Durable Objects `upgrade()` |
| `@vrealtime/client` | Browser SDK: app-side tools with the epoch gate, mic and playback |
| `@vrealtime/testing` | Scripted fake model for tests |
| `@vrealtime/cascade`, `@vrealtime/ai-sdk` | STT + any text LLM + TTS as one realtime model; AI SDK models as the LLM |
| `@vrealtime/vad` | Energy VAD for turn detection where the model has none |
| `@vrealtime/react` | `useRealtime()` hook |

## License

[Apache-2.0](LICENSE)
