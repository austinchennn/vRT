---
title: Tools
description: Server tools and app tools, results and failures, risk, previews and cancellation.
sidebar:
  order: 3
---

A tool is a function the model can call. To the model, every tool looks the same: a name, a description and a JSON Schema for its arguments. vRT runs it in one of two places.

| | Server tools | App tools (client tools) |
|---|---|---|
| Runs | In the agent's session, on the server | In the user's page, app or device |
| Declared | In `defineAgent({ tools })` | By the client when it connects |
| Use for | Databases, APIs, anything with secrets | The UI, the document, the device itself |
| Cancelled by | Its `AbortSignal` | The client's epoch gate and `AbortSignal` |

App tools are offered to the model only when the agent sets `clientTools: 'accept'`.

## Results

Every call gets exactly one result: either `{ ok: true, output }` or a failure with a code:

| Code | Meaning |
|---|---|
| `INTERRUPTED` | The call's turn was interrupted before or while it ran |
| `REJECTED` | Declined, for example by the user or by a `beforeToolCall` hook |
| `INVALID` | The arguments are not valid for the tool |
| `TIMEOUT` | No result arrived in time (`clientToolTimeoutMs` for app tools) |
| `FAILED` | The tool threw, or the app does not host a tool of that name |

A tool that returns nothing answers with `output: null`.

## Running one at a time

App tools run **one at a time, in arrival order**: a call starts only after the previous one has its result. Tools can rely on that ordering, for example when the model applies several edits in sequence.

## Cancellation and atomicity

Every tool receives a context with a `signal` that aborts when its turn is interrupted, plus `callId`, `turnId` and `epoch`. Check the signal after every `await` and right before committing:

```js
run: async ({ blockId, text }, { signal, callId, turnId }) => {
  const block = await loadBlock(blockId);
  if (signal.aborted) return;               // interrupted while loading: change nothing
  return editor.apply({ blockId, text, operationId: callId, group: turnId });
}
```

Group effects by `turnId` to undo a whole turn, and use `callId` as an idempotency key.

## Risk and confirmation

Server tools declare a `risk` (`'low'`, `'medium'` or `'high'`), and every call, server or app, passes through the `beforeToolCall` hook first. The hook can allow it, reject it, or rewrite its arguments, so a high-risk action can wait for a spoken or on-screen confirmation. See [Build an agent](/guides/agents/).

## Watching a call: tool streams

The app can follow every call, server or app, through its lifecycle with `tool.stream` events, so it can render a preview while the model is still writing the arguments:

| Phase | Carries | Meaning |
|---|---|---|
| `start` | | The model began a call |
| `arguments-delta` | `delta` | The next fragment of the arguments' JSON text |
| `arguments-complete` | `arguments` | The arguments are complete; the call is issued |
| `progress` | `progress` | A running server tool reported progress with `context.emit()` |
| `settled` | `ok`, `code` | The call has its result |
| `cancelled` | | Its turn was interrupted |
| `failed` | `message` | The model stopped before completing the arguments |

Every call starts with `start` and ends with exactly one of `settled`, `cancelled` or `failed`. A model that does not stream arguments goes straight from `start` to `arguments-complete`, so show a waiting state there.

Streams are for display only. `arguments-complete` runs nothing: an app tool still runs only through its `run`, behind the epoch gate. When the user interrupts, the client cancels every open call of that turn at once, without waiting for the server. The output of a server tool never reaches the app; `settled` only says whether it succeeded.

Tool streams need the `tool-stream-v1` capability, which the browser client and the TypeScript server both support. With a server that lacks it, the app receives the older `tool.preview` events instead, and it keeps receiving them alongside `tool.stream` for compatibility.

## Validation

`parameters` is plain JSON Schema, as the model sees it. Server tools can also pass any [Standard Schema](https://standardschema.dev) validator (Zod, Valibot, ArkType) as `validate`; invalid arguments become an `INVALID` result without running the tool. App tools validate inside `run`.
