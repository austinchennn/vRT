---
title: Deploy
description: Serve an agent on Node, Bun, Deno, or Cloudflare Workers and Durable Objects.
sidebar:
  order: 5
---

The server needs nothing but a WebSocket: no media server and no worker pool.

## Node

```js
import { serve } from '@vrealtime/server/node';

const server = await serve(agent, { port: 8790 });
console.log(server.url);
// later: await server.close();
```

| Option | Default | Meaning |
|---|---|---|
| `port` | `8790` | `0` picks a free port |
| `host` | `localhost` | Bind address; use `0.0.0.0` in containers |
| `publicDir` | none | Serves static files; its `index.html` replaces the built-in debug page |
| `onListening(url)` | logs the URL | Called once listening |

`serve()` needs the `ws` package. It also accepts every [`attach()` option](#server-options).

## Any WebSocket: Bun, Deno and others

`attach(agent, socket)` connects any WebSocket that has `send()` and `close()` to a session. Event-style sockets are wired automatically; callback-style runtimes feed messages to the returned connection.

```js
// Deno
import { attach } from '@vrealtime/server';

Deno.serve((request) => {
  const { socket, response } = Deno.upgradeWebSocket(request);
  socket.binaryType = 'arraybuffer';
  attach(agent, socket, {}, { headers: request.headers });
  return response;
});
```

```js
// Bun
import { attach } from '@vrealtime/server';

const connections = new WeakMap();
Bun.serve({
  fetch: (request, server) => (server.upgrade(request) ? undefined : new Response('Expected a WebSocket', { status: 426 })),
  websocket: {
    open: (ws) => connections.set(ws, attach(agent, ws)),
    message: (ws, data) => connections.get(ws)?.receive(data),
    close: (ws) => connections.get(ws)?.closed(),
  },
});
```

Sockets attached for the same agent share one hub, so a reconnecting app can resume its session.

## Cloudflare Workers and Durable Objects

Sessions live in memory, so a reconnect must reach the memory that holds its session. Run the agent inside a Durable Object and route every connection for the same document (or user) to the same object:

```js
import { DurableObject } from 'cloudflare:workers';
import { defineAgent } from '@vrealtime/core';
import { boson, fetchSocket } from '@vrealtime/boson';
import { upgrade } from '@vrealtime/server/workers';

export class AgentObject extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Created once per object: connections share it, so reconnects resume their session.
    this.agent = defineAgent({ model: boson({ apiKey: env.BOSON_API_KEY, socket: fetchSocket() }), instructions: '…', clientTools: 'accept' });
  }

  fetch(request) {
    return upgrade(this.agent, request, { authenticate: verify });
  }
}

export default {
  fetch(request, env) {
    const doc = new URL(request.url).searchParams.get('doc') ?? 'default';
    return env.AGENT.get(env.AGENT.idFromName(doc)).fetch(request);
  },
};
```

- Define the agent once, not per request: sockets share a session hub per agent, and a new agent per request would make every reconnect start a new session.
- The Workers `WebSocket` cannot send authentication headers, so Boson and OpenAI connect through `fetchSocket()`.
- `upgrade()` uses the standard, non-hibernating WebSocket API.
- [`examples/workers`](https://github.com/austinchennn/vRT/tree/main/examples/workers) is the complete Worker, with token authentication; `npm run test:workers` runs it in workerd against a mock model server.

## Server options

`attach()`, `serve()` and `upgrade()` accept:

| Option | Default | Meaning |
|---|---|---|
| `authenticate(request)` | accept all | Decides who is connected; see [Authentication](/guides/authentication/) |
| `configure(principal, { context })` | none | Per-session config: instructions, voice, recognition vocabulary… |
| `onContext(context, session)` | none | Receives `hello.context` and every `context` message |
| `resumeWindowMs` | 30000 | How long a session without a connection waits for a resume |
| `heartbeatTimeoutMs` | 45000 | Closes a connection that sent nothing for this long |
| `highWaterMark` | 256 KiB | Queues outgoing frames while the socket buffers more than this |

## In production

- Serve over `wss://`, and authenticate every connection.
- Sessions are held in memory. Route a reconnecting client to the same process or Durable Object, or it cannot resume.
- Size the resume window and heartbeat timeout for your clients' networks; mobile networks drop more often.
