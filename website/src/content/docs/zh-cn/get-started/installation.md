---
title: 安装
description: 为服务端和 App 安装 vRT 的包。
---

所有包都以 [`@vrealtime`](https://www.npmjs.com/org/vrealtime) 作用域发布在 npm 上，由 CI 发布并附带 provenance（来源证明），所有包版本一致。只装你用到的即可。

## 环境要求

- **服务端：** Node 22 或更高、Bun、Deno，或 Cloudflare Workers。
- **客户端：** 任何现代浏览器，或 Node 22 及以上。
- **包**只提供 ESM。使用 TypeScript 时，`moduleResolution` 设为 `bundler` 或 `nodenext`。

## 服务端

安装运行时、服务端边缘层和一个模型适配器：

```bash
npm install @vrealtime/core @vrealtime/server @vrealtime/boson
```

| 模型 | 包 | 凭据 |
|---|---|---|
| Boson Higgs Realtime | `@vrealtime/boson` | `BOSON_API_KEY` |
| OpenAI Realtime | `@vrealtime/openai` | `OPENAI_API_KEY` |
| Gemini Live | `@vrealtime/gemini` | `GEMINI_API_KEY` |
| 任意文本模型 + 语音 | `@vrealtime/cascade`、`@vrealtime/ai-sdk`，以及一个 AI SDK provider | 你所用供应商的凭据 |

在 Node 上，`serve()` 需要 `ws` 包（可选的 peer 依赖）：

```bash
npm install ws
```

## 客户端

```bash
npm install @vrealtime/client
```

使用 React 时，再加上 hook 包：

```bash
npm install @vrealtime/react
```

## 可选的包

| 包 | 用途 |
|---|---|
| `@vrealtime/vad` | 为没有自带语音活动检测的模型，在服务端做轮次检测 |
| `@vrealtime/testing` | 用于测试的脚本化假模型，带虚拟时钟 |
| `@vrealtime/protocol` | 线协议的类型和编解码，用来写你自己的客户端或工具 |

[包](/zh-cn/reference/packages/)参考页列出了每个包、它的入口和依赖。
