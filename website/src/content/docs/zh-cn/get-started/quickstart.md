---
title: 快速开始
description: 跑起一个工具在浏览器里执行的语音 agent，再用几行代码写一个自己的。
---

## 跑示例

需要 Node 22 或更高版本。

```bash
git clone https://github.com/austinchennn/vRT.git
cd vRT
npm install
npm run build
```

没有 API key？用脚本化的假模型启动示例：

```bash
npm run start:fake -w examples/minimal
```

有 Boson key 的话，用真实的实时模型启动：

```bash
BOSON_API_KEY=your-key npm start -w examples/minimal
```

打开 `http://localhost:8790`，按 **Talk** 说话，或者直接输入文字。让它换个颜色：`set_accent_color` 这个工具就在页面里执行。在 agent 说话时开口，或按 Esc，就能打断它；打断之后，这一轮里的工具调用都不会再生效。

同一个 agent 也能跑在其他模型上，只需要换模型：

```bash
MODEL=openai OPENAI_API_KEY=your-key npm start -w examples/minimal
```

```bash
MODEL=gemini GEMINI_API_KEY=your-key npm start -w examples/minimal
```

```bash
MODEL=cascade OPENAI_API_KEY=your-key npm start -w examples/minimal
```

## 写一个自己的

### 1. 服务端

一个 agent 就是一个模型、一段指令，以及可选的工具。`serve()` 在 Node 上通过 WebSocket 把它暴露出来：

```js
// server.js
import { defineAgent } from '@vrealtime/core';
import { boson } from '@vrealtime/boson';
import { serve } from '@vrealtime/server/node';

serve(defineAgent({
  model: boson({ voice: 'default', turnDetection: 'semantic' }),
  instructions: 'You are a friendly voice assistant. When asked to change colors, call set_accent_color.',
  clientTools: 'accept', // 把 App 声明的工具提供给模型
}), { port: 8790 });
```

`serve()` 还会对普通 HTTP 请求返回一个调试页：写客户端代码之前，打开 `http://localhost:8790` 就能直接跟 agent 对话。

### 2. App

在浏览器里连接，声明页面托管的工具，并打开音频：

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

在点击事件里调用 `connect()`：浏览器只允许在用户操作之后播放音频。

### 3. 跟它对话

说"make it teal"。模型调用 `set_accent_color`，工具在页面里执行，结果回传给模型，模型再回答你。在它说话时按停止：播放立刻停下，这一轮里还没开始的工具调用都不会执行。

## 下一步

- [安装](/zh-cn/get-started/installation/)：包、运行环境和 TypeScript 配置。
- [构建 agent](/zh-cn/guides/agents/)：服务端工具、hooks，以及高风险操作的确认。
- [浏览器客户端](/zh-cn/guides/browser-client/)：工具上下文、取消、预览和事件。
- [选择模型](/zh-cn/guides/models/)：Boson、OpenAI、Gemini，或者通过 cascade 接任意文本模型。
