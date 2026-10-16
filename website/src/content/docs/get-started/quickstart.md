---
title: Quickstart
description: Run a voice agent whose tool runs in the browser, then build your own in a few lines.
---

## Run the example

Requires Node 22 or later.

```bash
git clone https://github.com/austinchennn/vRT.git
cd vRT
npm install
npm run build
```

No API key? Start the example with a scripted fake model:

```bash
npm run start:fake -w examples/minimal
```

With a Boson key, start it with a real realtime model:

```bash
BOSON_API_KEY=your-key npm start -w examples/minimal
```

Open `http://localhost:8790` and press **Talk**, or type a message. Ask it to change the color: the `set_accent_color` tool runs in the page. Speak over the agent, or press Esc, to interrupt it. Once interrupted, no further tool call from that turn is applied.

The same agent runs on other models; only the model changes:

```bash
MODEL=openai OPENAI_API_KEY=your-key npm start -w examples/minimal
```

```bash
MODEL=gemini GEMINI_API_KEY=your-key npm start -w examples/minimal
```

```bash
MODEL=cascade OPENAI_API_KEY=your-key npm start -w examples/minimal
```

## Build your own

### 1. The server

An agent is a model, instructions and, optionally, tools. `serve()` exposes it over WebSocket on Node:

```js
// server.js
import { defineAgent } from '@vrealtime/core';
import { boson } from '@vrealtime/boson';
import { serve } from '@vrealtime/server/node';

serve(defineAgent({
  model: boson({ voice: 'default', turnDetection: 'semantic' }),
  instructions: 'You are a friendly voice assistant. When asked to change colors, call set_accent_color.',
  clientTools: 'accept', // offer the tools the app declares to the model
}), { port: 8790 });
```

`serve()` also answers plain HTTP with a debug page: open `http://localhost:8790` to talk to the agent before you write any client code.

### 2. The app

In the browser, connect, declare the tools the page hosts, and turn on audio:

```js
import { connect } from '@vrealtime/client';

const session = await connect('ws://localhost:8790', {
  tools: {
    set_accent_color: {
      description: 'Change the accent color of the page. Accepts any CSS color.',
      parameters: { type: 'object', properties: { color: { type: 'string' } }, required: ['color'] },
      run: ({ color }) => {
        document.documentElement.style.setProperty('--accent', color);
        return { applied: color };
      },
    },
  },
  audio: { input: 'mic', output: 'speaker' },
});

session.on('transcript', (e) => console.log(e.role, e.text));
document.querySelector('#stop').onclick = () => session.interrupt();
```

Call `connect()` from a click: browsers only allow audio playback after a user gesture.

### 3. Talk to it

Say "make it teal". The model calls `set_accent_color`, the tool runs in the page, and the result goes back to the model, which answers. Press stop while it talks: playback stops at once, and any tool call from that turn that has not started never runs.

## Next steps

- [Installation](/get-started/installation/): packages, runtimes and TypeScript setup.
- [Build an agent](/guides/agents/): server tools, hooks and confirmation for risky actions.
- [Browser client](/guides/browser-client/): tool context, cancellation, previews and events.
- [Choose a model](/guides/models/): Boson, OpenAI, Gemini or any text model through cascade.
