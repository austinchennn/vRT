---
title: Installation
description: Install the vRT packages for your server and your app.
---

:::caution[Before the first npm release]
The `@vrealtime/*` packages are published to npm starting with version 0.1.0. Until that release is out, build installable tarballs from a clone of the repository with `npm run pack` and install the files from `release/` instead, together with the `@vrealtime` packages each one depends on.
:::

## Requirements

- **Server:** Node 22 or later, Bun, Deno, or Cloudflare Workers.
- **Client:** any modern browser, or Node 22 or later.
- **Packages** are ESM only. With TypeScript, use `moduleResolution` `bundler` or `nodenext`.

## Server

Install the runtime, the server edge and one model adapter:

```bash
npm install @vrealtime/core @vrealtime/server @vrealtime/boson
```

| Model | Package | Credentials |
|---|---|---|
| Boson Higgs Realtime | `@vrealtime/boson` | `BOSON_API_KEY` |
| OpenAI Realtime | `@vrealtime/openai` | `OPENAI_API_KEY` |
| Gemini Live | `@vrealtime/gemini` | `GEMINI_API_KEY` |
| Any text model + speech | `@vrealtime/cascade`, `@vrealtime/ai-sdk`, an AI SDK provider | Those of the providers you use |

On Node, `serve()` needs the `ws` package, an optional peer dependency:

```bash
npm install ws
```

## Client

```bash
npm install @vrealtime/client
```

For React, add the hook package:

```bash
npm install @vrealtime/react
```

## Optional packages

| Package | Use it for |
|---|---|
| `@vrealtime/vad` | Turn detection on the server for models without their own voice activity detection |
| `@vrealtime/testing` | A scripted fake model for tests, with virtual time |
| `@vrealtime/protocol` | The wire protocol types and codecs, for building your own client or tooling |

The [Packages](/reference/packages/) reference lists every package, its entry points and its dependencies.
