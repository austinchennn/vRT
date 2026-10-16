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

## Previews

While a model is still generating a call's arguments, and while a server tool reports progress with `context.emit()`, the app receives `tool.preview` events. Previews are for display only: never act on one, and clear it when the call's `tool.result` arrives or its turn is interrupted.

## Validation

`parameters` is plain JSON Schema, as the model sees it. Server tools can also pass any [Standard Schema](https://standardschema.dev) validator (Zod, Valibot, ArkType) as `validate`; invalid arguments become an `INVALID` result without running the tool. App tools validate inside `run`.
