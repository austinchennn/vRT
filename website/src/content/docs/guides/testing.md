---
title: Testing
description: Test agents and apps deterministically with the scripted fake model and virtual time.
sidebar:
  order: 7
---

`@vrealtime/testing` provides `fakeModel()`, a `RealtimeModel` that replays scripted events on a virtual clock and records every command it receives. Tests run fast, offline and deterministically.

```js
import { defineAgent } from '@vrealtime/core';
import { serve } from '@vrealtime/server/node';
import { connect } from '@vrealtime/client';
import { fakeModel } from '@vrealtime/testing';

const pcm = { encoding: 'pcm16', sampleRate: 24000, channels: 1 };

// A model that answers every request by calling set_color 10 ms (virtual time) later.
const model = fakeModel({
  onCommand(command, session) {
    if (command.type !== 'respond') return;
    session.schedule({ type: 'response.start', responseId: 'r1' });
    session.schedule({ type: 'tool.call', responseId: 'r1', callId: 'c1', name: 'set_color', arguments: { color: 'teal' } }, 10);
    session.schedule({ type: 'response.end', responseId: 'r1', status: 'done' }, 11);
  },
});

const server = await serve(defineAgent({ model, instructions: 'test', clientTools: 'accept' }), { port: 0, clock: model.clock, onListening: () => {} });
let color;
const session = await connect(server.url.replace('http', 'ws'), {
  tools: { set_color: { parameters: { type: 'object' }, run: ({ color: c }) => (color = c) } },
});

session.sendText('make it teal');
// ...wait until the model has received the request, then move virtual time forward:
model.clock.advance(20);
// ...wait until color === 'teal'
```

## What the fake model gives you

| Member | Meaning |
|---|---|
| `fakeModel({ capabilities, script, onCommand, clock, connectError })` | Override capabilities (for example no argument streaming), replay a fixed script, react to commands, share a clock, or fail to connect |
| `model.clock` | A `VirtualClock`: nothing scheduled runs until `advance(ms)` |
| `model.session` | The most recent session; `model.sessions` lists all of them |
| `session.schedule(event, delayMs)` / `session.emit(event)` | Emit a model event later, or now |
| `session.commandsOf(type)` | What the runtime sent the model: `respond`, `cancel`, `truncate`, `submitToolResult`… |

Pass the same clock to the server (`serve(agent, { clock: model.clock })`) so heartbeats and resume windows run on virtual time too.

## Test interruption

The most valuable test of a voice app: interrupt while a tool call is still on its way, and check that it never takes effect.

```js
session.sendText('make it blue');            // the model calls set_color 500 ms later
// ...wait until session.state === 'speaking'
session.interrupt();
model.clock.advance(1000);                   // the late call is due now
// color is unchanged, and no tool.result reports success for it
```
