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

> Status: M0 is implemented in this repo (core runtime, protocol, Boson adapter, server, browser client). Packages are not published to npm yet.

## Quickstart

Requires Node 22+. From a clone of this repo:

```bash
npm install
npm run build
BOSON_API_KEY=your-key npm start -w examples/minimal
```

Open http://localhost:8790 and press **Talk**, or type a message. Ask it to change the color: the `set_accent_color` tool runs in the page. Speak over the agent (or press Esc) to interrupt it; once interrupted, no further tool call from that turn is applied.

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
| `@vrealtime/boson` | Boson Higgs Realtime adapter |
| `@vrealtime/server` | Attach any WebSocket; Node `serve()` with a debug page |
| `@vrealtime/client` | Browser SDK: app-side tools with the epoch gate, mic and playback |
| `@vrealtime/testing` | Scripted fake model for tests |
| `@vrealtime/openai`, `@vrealtime/gemini` | Planned (M2) |
| `@vrealtime/cascade`, `@vrealtime/ai-sdk` | Planned (M2): STT + any LLM + TTS as one realtime model |
| `@vrealtime/react` | Planned (M2): React hooks |

## License

[Apache-2.0](LICENSE)
