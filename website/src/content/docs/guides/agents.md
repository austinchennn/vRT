---
title: Build an agent
description: Define an agent with a model, instructions, server tools and hooks.
sidebar:
  order: 1
---

An agent is a plain object built with `defineAgent()`. The same definition runs on any model and any runtime.

```js
import { defineAgent, tool } from '@vrealtime/core';
import { openai } from '@vrealtime/openai';

export const agent = defineAgent({
  model: openai({ voice: 'marin' }),
  instructions: 'You help users plan trips. Keep answers short; they are spoken.',
  tools: { get_weather: getWeather },
  clientTools: 'accept',
});
```

## Options

| Option | Default | Meaning |
|---|---|---|
| `model` | required | A `RealtimeModel` from an adapter package |
| `instructions` | required | The system instructions |
| `tools` | none | Server tools, by name |
| `clientTools` | `'ignore'` | `'accept'` offers the tools a connecting app declares to the model |
| `hooks` | none | See [Hooks](#hooks) |
| `voice` | the model's | The voice to speak with |
| `turnDetection` | the model's | `'server'`, `'semantic'`, or `null` for manual turns |
| `clientToolTimeoutMs` | none | App tool calls without a result in this time settle as `TIMEOUT` |
| `vad` | none | Voice activity detection for models without their own, for example `energyVad()` from `@vrealtime/vad` |

## Server tools

```js
import { tool } from '@vrealtime/core';
import { z } from 'zod';

const getWeather = tool({
  description: 'Get the current weather for a city.',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  validate: z.object({ city: z.string().min(1) }), // optional: any Standard Schema
  run: async ({ city }, { signal }) => {
    const response = await fetch(`https://weather.example/api?city=${encodeURIComponent(city)}`, { signal });
    return response.json();
  },
});
```

The `run` context provides:

| Field | Meaning |
|---|---|
| `signal` | Aborts when the call's turn is interrupted; pass it to `fetch` and check it before committing |
| `callId`, `turnId`, `epoch` | The call's identity and its turn |
| `data` | What the server attached to the session, for example the authenticated principal |
| `emit(preview)` | Streams progress to the app as `tool.preview` while the tool runs |

Two more fields shape how a tool behaves:

- `risk: 'low' | 'medium' | 'high'` is passed to `beforeToolCall`, so you can require confirmation.
- `async: true` keeps the tool running after an interruption and delivers its result later. Use it only for work that is safe to finish, such as sending a requested email that was already confirmed.

## Hooks

```js
defineAgent({
  // ...
  hooks: {
    beforeToolCall: async (call) => {
      if (call.risk === 'high' && !(await confirmWithUser(call))) return { action: 'reject', message: 'The user declined.' };
    },
    afterToolCall: (call, result) => audit.log({ tool: call.name, where: call.where, ok: result.ok }),
    onTurnEnd: (turn, metrics) => metricsSink.record(turn.id, metrics),
    onError: (error, recoverable) => logger.error({ error, recoverable }),
  },
});
```

| Hook | Called | Can |
|---|---|---|
| `beforeToolCall(call)` | Before any tool call, server or app | Return nothing or `{ action: 'allow' }`, `{ action: 'reject', message }`, or `{ action: 'rewrite', arguments }` |
| `afterToolCall(call, result)` | After each call settles | Observe |
| `onTurnStart(turn)` | A turn starts | Observe |
| `onTurnEnd(turn, metrics)` | A turn ends | Observe metrics: time to first audio, time to first tool call, interrupt latency, tool calls |
| `onTranscript(text, final, turn)` | User speech is transcribed | Observe |
| `onError(error, recoverable)` | Something failed | Observe |

`call` carries `callId`, `name`, `arguments`, `where` (`'server'` or `'client'`), `risk`, `turn` and `data`.

## Serving it

Pass the agent to `serve()`, `attach()` or `upgrade()`; see [Deploy](/guides/deployment/). Per-user configuration, such as instructions that name the open document or a recognition vocabulary, comes from the server's `configure` option; see [Authentication](/guides/authentication/).
