---
title: React
description: Use the useRealtime hook to connect a React app.
sidebar:
  order: 3
---

`@vrealtime/react` wraps the browser client in one hook. The session closes when the component unmounts.

```tsx
import { useRealtime } from '@vrealtime/react';

export function Assistant() {
  const { status, state, transcript, error, connect, interrupt } = useRealtime('wss://agent.example.com', {
    tools: {
      set_accent_color: {
        parameters: { type: 'object', properties: { color: { type: 'string' } }, required: ['color'] },
        run: ({ color }) => document.documentElement.style.setProperty('--accent', color),
      },
    },
    audio: { input: 'mic', output: 'speaker' },
  });

  return (
    <div>
      <button onClick={status === 'connected' ? () => interrupt() : connect}>{status === 'connected' ? `${state} · stop` : 'Talk'}</button>
      {error && <p role="alert">{error.message}</p>}
      <ul>{transcript.map((line) => <li key={line.itemId} className={line.role}>{line.text}</li>)}</ul>
    </div>
  );
}
```

## Options

Everything [`connect()`](/guides/browser-client/#options) accepts, plus:

| Option | Meaning |
|---|---|
| `tools` | App tools. They are read through a ref, so new closures on re-render are used without reconnecting |
| `autoConnect` | Connect on mount, for text-only apps. With audio, call `connect()` from a click instead |

## Returned values

| Value | Meaning |
|---|---|
| `status` | `idle`, `connecting`, `connected`, `reconnecting`, `closed` or `error` |
| `state` | The agent's turn state |
| `transcript` | Lines of `{ itemId, role, text, final }`, updated as the agent and user speak |
| `error` | The last `{ code, message }`, if any |
| `connect()` | Idempotent and never rejects; failures land in `status` and `error` |
| `disconnect()`, `interrupt(reason?)`, `sendText(text)` | As on the client session |
| `session` | The underlying client session, for events the hook does not track |
