---
title: Browser client
description: Connect an app, host tools behind the epoch gate, stream audio and react to events.
sidebar:
  order: 2
---

`@vrealtime/client` connects a web page (or a Node process) to a vRT server. It has no dependencies besides the protocol package.

```js
import { connect } from '@vrealtime/client';

const session = await connect('wss://agent.example.com', {
  tools: { apply_edit: applyEdit },
  audio: { input: 'mic', output: 'speaker' },
  context: { docId: 'q3-plan' },
  auth: () => fetch('/voice-token').then((r) => r.text()),
});
```

`connect()` resolves once the session is ready and rejects if the server refuses it. With audio, call it from a click or key press so the browser allows playback.

## Options

| Option | Default | Meaning |
|---|---|---|
| `tools` | none | App tools, by name: `{ description?, parameters, run(args, context) }` |
| `audio` | `false` | `{ input: 'mic' \| factory \| false, output: 'speaker' \| sink \| false }`; text-only when `false` |
| `context` | none | Application data sent with `hello`; update it with `setContext()` |
| `auth` | none | A token, or a function called on every connect and reconnect so short-lived tokens can rotate |
| `reconnect` | on | `{ maxAttempts: 8, baseDelayMs: 250, maxDelayMs: 5000 }`, or `false` |
| `heartbeatMs` | 15000 | Ping interval; a connection silent for 2.5 intervals is replaced |
| `WebSocket` | global | A custom `WebSocket` constructor |

## Hosting tools

```js
const applyEdit = {
  description: 'Replace the text of one block in the open document.',
  parameters: {
    type: 'object',
    properties: { blockId: { type: 'string' }, text: { type: 'string' } },
    required: ['blockId', 'text'],
  },
  run: async ({ blockId, text }, { signal, callId, turnId }) => {
    await editor.whenIdle();          // may wait, for example for IME composition to end
    if (signal.aborted) return;       // interrupted meanwhile: change nothing
    return editor.replace(blockId, text, { operationId: callId, undoGroup: turnId });
  },
};
```

- Calls run **one at a time, in arrival order**.
- A call whose turn was already interrupted is answered `INTERRUPTED` and never runs, even if the interruption happens just before it starts.
- If the turn is interrupted while `run` is pending, the call is answered `INTERRUPTED` at once and its `signal` aborts; whatever `run` returns later is ignored.
- A thrown error becomes `FAILED`; returning nothing answers with `output: null`.

## Methods and properties

| Member | Meaning |
|---|---|
| `interrupt(reason?)` | Stops the agent now; see [Interruption](/concepts/interruption/) |
| `sendText(text)` | Sends user text, interrupting the response in flight |
| `setContext(context)` | Replaces the application context on the server; `undefined` clears it |
| `sendAudio(pcm16)` | Sends one frame of your own capture, in the negotiated input format |
| `close()` | Closes the session; it does not reconnect |
| `state` | The agent's turn state: `idle`, `listening`, `thinking`, `speaking` or `acting` |
| `epoch` | The newest epoch seen from the server |
| `sessionId`, `connected` | The session and whether a connection is open |
| `capabilities` | Optional protocol features in effect for the session |

## Events

Subscribe with `session.on(type, listener)`, which returns an unsubscribe function. The [client API reference](/reference/client-api/) lists every event and its fields. The ones most apps use:

```js
session.on('state', ({ state }) => (statusLine.textContent = state));
session.on('transcript', ({ role, itemId, text, final }) => transcript.upsert(itemId, role, text, final));
session.on('tool.preview', (preview) => previews.show(preview));
session.on('tool.result', ({ callId }) => previews.clear((p) => p.callId === callId));
session.on('interrupted', ({ epoch }) => previews.clear((p) => p.epoch <= epoch));
session.on('reconnecting', ({ attempt }) => banner.show(`Reconnecting (${attempt})…`));
session.on('closed', () => previews.clear(() => true));
```
