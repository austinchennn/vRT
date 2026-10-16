---
title: Overview
description: What vRealTime is, who it is for, and how the pieces fit together.
---

vRealTime (vRT) lets people talk to software and devices the way they talk to each other. An **agent** listens, speaks and calls **tools**, and the tools run where they belong: on the server next to the agent, or in the user's web page, phone app, desktop program or device.

vRT is **protocol-first**. The vRT protocol, which is WebSocket with JSON control messages and binary audio frames, is the contract. This repository holds the TypeScript reference implementation of the server runtime and the first client SDK. Clients are deliberately thin, so they can be written in any language, down to microcontrollers.

## Two kinds of developers

| Role | What they do | What they use |
|---|---|---|
| **Agent developer** (server) | Picks a model, writes instructions, adds server tools, hooks, auth and audit | The TypeScript runtime: `@vrealtime/core`, `@vrealtime/server` and a model adapter |
| **App and device developer** (client) | Exposes an app or device as tools and, optionally, audio input and output | A client SDK: `@vrealtime/client` today; Python, Swift, Kotlin and C planned |

Complexity lives on the server. A client only connects, declares its tools, runs them, streams audio if it has any, and obeys the epoch gate. A device without a microphone or speaker, such as a light, only hosts tools.

## How it fits together

```
                 vRT protocol: specification + conformance suite
           ┌────────────────────────┴────────────────────────┐
  Server (TypeScript reference)                     Clients (thin, any language)
  agent runtime · model adapters ·                  web · mobile · desktop · devices
  server tools · hooks · auth                       app tools · audio in/out · epoch gate
```

The server side has three layers, each usable on its own:

1. **Models** (`@vrealtime/boson`, `openai`, `gemini`, `cascade`): one `RealtimeModel` interface with normalized events and declared capabilities over every provider.
2. **Agent runtime** (`@vrealtime/core`): sessions, turns and epochs, tool routing, hooks and the interrupt guarantees.
3. **Edge** (`@vrealtime/server`, `@vrealtime/client`, `@vrealtime/protocol`): the wire protocol, attaching any WebSocket on the server, and the browser SDK.

See [Architecture](/concepts/architecture/) for the details.

## What vRT guarantees

When the user interrupts, by speaking over the agent or pressing stop:

1. **No side effects after an interruption.** Tool calls from the interrupted turn that have not started never start.
2. **Exactly one result per tool call.** Cancelled calls are answered too, so the model's conversation stays consistent.
3. **The transcript matches what was heard.** The conversation is truncated to the audio the user actually heard.
4. **Each tool call is atomic.** It takes full effect or none; tools receive a cancellation signal to check before committing.

[Interruption](/concepts/interruption/) explains how turns, epochs and the client's epoch gate deliver these.

## Status

The core runtime, protocol, Boson, OpenAI and Gemini adapters, cascade (speech-to-text + any text model + text-to-speech), voice activity detection, the Node and Workers server, the browser client and React hooks are implemented. The [protocol specification](/reference/protocol/) is written; the conformance suite and the Python client SDK are in progress.

## Next steps

- [Quickstart](/get-started/quickstart/): run an agent and talk to it in two minutes.
- [Installation](/get-started/installation/): add vRT to your own project.
