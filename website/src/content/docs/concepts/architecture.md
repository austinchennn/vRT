---
title: Architecture
description: The layers of vRT, its packages, and the rules that keep them small.
sidebar:
  order: 1
---

vRT has a language-neutral **protocol** at the top and three **layers** on the server below it. Every layer can be used on its own.

```
┌──────────────────── spec/: the vRT protocol (language-neutral) ────────────────────┐
│ messages (JSON Schema) · binary audio frames · epochs and interruption · resume   │
└──────────────┬────────────────────────────────────────────────┬───────────────────┘
               │ server implementation                          │ client implementations
┌────────────────────────────── L3 edge ─────────────────────────────────────────────┐
│ @vrealtime/server: attach any WebSocket        @vrealtime/client: browser SDK       │
│ @vrealtime/protocol: wire protocol v1          @vrealtime/react: hooks              │
├────────────────────────────── L2 agent runtime ────────────────────────────────────┤
│ defineAgent · sessions · turns and epochs · tool routing (server / client) · hooks │
├────────────────────────────── L1 models ───────────────────────────────────────────┤
│ RealtimeModel · normalized events · declared capabilities · audio chunks           │
│ @vrealtime/boson · openai · gemini · cascade (+ ai-sdk)                            │
└────────────────────────────────────────────────────────────────────────────────────┘
```

## L1: models

Every provider is a `RealtimeModel`: `connect(config)` returns a session that accepts audio and text, emits normalized events (`response.start`, `output.audio`, `tool.call`, `input.speech.start` and so on) and declares its **capabilities**: audio formats, server-side turn detection, argument streaming, truncation, and whether instructions and tools can change mid-session.

The runtime fills the gaps a model leaves. A model without server-side turn detection gets voice activity detection from `@vrealtime/vad`; a model that cannot truncate gets its transcript rewritten locally. **Cascade** turns any speech-to-text model, any text LLM and any text-to-speech model into one realtime model, so a text model such as Claude behaves like a native voice model.

## L2: the agent runtime

`@vrealtime/core` runs one **session** per conversation. A small, explicit state machine moves each **turn** through `listening`, `thinking`, `speaking` and `acting` (tools running) and back to `idle`. Every turn and every interruption advances the **epoch**, which is how interruption is enforced (see [Interruption](/concepts/interruption/)). The runtime routes tool calls to server tools or to the connected app, runs hooks, and measures each turn.

## L3: the edge

- `@vrealtime/server` attaches any WebSocket to a session (`attach()`), serves on Node (`serve()`), and upgrades requests on Cloudflare Workers and Durable Objects (`upgrade()`). It keeps sessions alive across reconnects.
- `@vrealtime/client` is the browser SDK: it connects, declares app tools, runs them behind the epoch gate, and captures and plays audio.
- `@vrealtime/protocol` is the TypeScript implementation of the [protocol specification](/reference/protocol/).

## Rules that keep it light

| Rule | Enforced by |
|---|---|
| `@vrealtime/core` and `@vrealtime/protocol` have zero runtime dependencies | CI budget check |
| Model adapters never depend on each other | CI budget check |
| `node:` imports only in `*/node` subpaths, so everything else runs in browsers and Workers | CI budget check |
| Size budgets (min+gzip): core ≤ 15 KB, client ≤ 20 KB, protocol ≤ 5 KB, each adapter ≤ 10 KB | CI budget check |
| The protocol is defined by `spec/`, and the TypeScript codec is tested against its schemas and vectors | `npm run check:spec` and `npm test` |
