---
title: Client API
description: The @vrealtime/client session, its options, members and events.
---

## connect(url, options)

```ts
function connect(url: string, options?: ConnectOptions): Promise<ClientSession>;
```

Opens a connection and resolves once the session is ready. Rejects if the connection closes first or the server refuses it with a non-recoverable error. [Browser client](/guides/browser-client/#options) describes the options.

## ClientSession

| Member | Type | Meaning |
|---|---|---|
| `on(type, listener)` | `() => void` | Subscribes to an event; returns an unsubscribe function |
| `interrupt(reason?)` | `void` | `reason`: `'user'` (default), `'keyboard'` or `'speech'` |
| `sendText(text)` | `void` | User text input |
| `setContext(context)` | `void` | Replaces the application context; `undefined` clears it |
| `sendAudio(pcm16)` | `void` | One PCM16 frame in the negotiated input format |
| `close()` | `Promise<void>` | Closes the session without reconnecting |
| `sessionId` | `string \| undefined` | Set once ready |
| `state` | `'idle' \| 'listening' \| 'thinking' \| 'speaking' \| 'acting'` | The agent's turn state |
| `epoch` | `number` | The newest epoch seen from the server |
| `connected` | `boolean` | A connection is open and ready |
| `capabilities` | `ReadonlySet<string>` | Optional protocol features in effect |

## Events

| Event | Fields | When |
|---|---|---|
| `ready` | `sessionId`, `resumed` | The session opened, or resumed after a reconnect |
| `state` | `state`, `turnId`, `epoch` | The agent's turn changed state |
| `transcript` | `role` (`user` or `agent`), `itemId`, `text`, `final` | Speech was transcribed; interim updates have `final: false` |
| `text` | `responseId`, `delta` | A chunk of the agent's text response |
| `tool.call` | `callId`, `name`, `arguments`, `turnId`, `epoch` | A tool call arrived (whether or not it will run) |
| `tool.preview` | `callId`, `name`, `epoch`, `preview` | Display-only progress of a call; never for a closed epoch |
| `tool.result` | `callId`, `name`, `turnId`, `epoch`, `result` | A call's one result |
| `interrupted` | `epoch`, `source` (`local` or `server`) | `epoch` and every earlier epoch closed; once per closure |
| `error` | `code`, `message`, `recoverable` | From the server, or local (`AUTH_FAILED`, `AUDIO_FAILED`, `RESUME_FAILED`) |
| `reconnecting` | `attempt`, `delayMs` | The connection dropped; retrying after `delayMs` |
| `closed` | `code?`, `reason?` | The session ended and will not reconnect |

## Tools

```ts
interface ClientTool {
  description?: string;
  parameters: JsonSchemaObject;   // the arguments, as the model sees them
  run(args: any, context: ClientToolContext): unknown;
}

interface ClientToolContext {
  signal: AbortSignal;   // aborts when the call's turn is interrupted
  callId: string;
  turnId: string;        // the turn that issued the call
  epoch: number;
}

type ToolOutcome =
  | { ok: true; output: unknown }
  | { ok: false; code: 'INTERRUPTED' | 'REJECTED' | 'INVALID' | 'TIMEOUT' | 'FAILED'; message: string };
```
