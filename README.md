# vRealTime (vRT)

**Realtime voice agents for any app. Light, fast, interruptible.**

vRealTime is a TypeScript framework that gives every realtime speech model one API and lets agents act inside your app as they speak.

- **Light**: zero-dependency core, one small package per provider, ESM only. No media server, no workers, no native binaries.
- **Fast**: synchronous audio hot path, binary frames instead of base64 JSON, Opus passthrough where the model accepts it.
- **Runs anywhere**: Node, Bun, Deno, Cloudflare Workers and the browser. Web-standard APIs only.
- **App-side tools**: tools can run in the user's app with strict interrupt guarantees. Once the user interrupts, no further side effects land.
- **Any model**: Boson Higgs Realtime, OpenAI Realtime, Gemini Live, or any text LLM plus STT and TTS through `cascade()`.

```ts
import { defineAgent } from '@vrealtime/core';
import { boson } from '@vrealtime/boson';
import { serve } from '@vrealtime/server/node';

serve(defineAgent({
  model: boson({ voice: 'default', turnDetection: 'semantic' }),
  instructions: 'You are a helpful document editor.',
  clientTools: 'accept',
}), { port: 8790 });
```

> Status: design stage. The API above is the target and is not implemented yet.

## Design

- [Architecture](docs/ARCHITECTURE.md) (Chinese)

## Packages (planned)

| Package | Purpose |
|---|---|
| `@vrealtime/core` | Model interface, normalized events, agent runtime, tools, hooks |
| `@vrealtime/protocol` | Wire protocol v1 between apps and a vRealTime server |
| `@vrealtime/boson`, `@vrealtime/openai`, `@vrealtime/gemini` | Provider adapters |
| `@vrealtime/cascade`, `@vrealtime/ai-sdk` | STT + any LLM + TTS as one realtime model |
| `@vrealtime/server`, `@vrealtime/client`, `@vrealtime/react` | Server attachment, browser SDK, React hooks |

## License

[Apache-2.0](LICENSE)
