# vRealTime（vRT）架构设计（草案 v0）

> **一句话**：让任何实时语音模型，十行代码接进任何 App。轻、快、可打断。

日期：2026-10-15。状态：设计草案，尚未实现。

## 0. 定位

1. **TypeScript 优先、不绑定基础设施**：`npm i` 之后十行代码就能跑，不需要部署媒体服务器。相当于实时语音领域的 Vercel AI SDK。
2. **原生支持 Boson Higgs Realtime**，同时覆盖 OpenAI Realtime、Gemini Live 等。
3. **"App 执行工具"是一等能力**：工具可以在用户的 App（浏览器）里执行，可打断、执行时实时可见、每轮可撤销。
4. **任何文本 LLM 都能变成实时模型**：语音识别 + 任意 LLM + TTS 组合成一个 `RealtimeModel`，业务代码不需要改。

## 1. 设计原则与量化预算

| 原则 | 做法 | 预算（CI 强制） |
|---|---|---|
| **轻** | 核心零运行时依赖；每个供应商一个独立包，只依赖 core；只出 ESM，可 tree-shake | `@vrealtime/core` ≤ 15 KB（min+gzip）；单个适配器 ≤ 10 KB；`@vrealtime/client` ≤ 20 KB |
| **快** | 音频热路径同步、不经 Promise；尽量零拷贝；能透传就不转码（例如 Opus 原样转发给 Boson） | 每个音频块的框架开销 < 50 µs；本地停播 < 1 个音频帧（≤ 20 ms） |
| **省** | 浏览器到服务端用二进制帧而不是 base64 JSON（体积小 33%，不用编解码）；可选 Opus（带宽约为 PCM 的 1/10） | 24 kHz PCM16 上行 ≤ 48 KB/s，Opus ≤ 4 KB/s |
| **到处能跑** | 只用 Web 标准 API：WebSocket、fetch、AbortSignal、TypedArray、TextEncoder | Node 22+、Bun、Deno、Cloudflare Workers、浏览器使用同一套代码 |
| **少概念** | 核心概念不超过 6 个；不引入链、图；状态机显式、小而可测 | `Session` 运行时 ≤ 1500 行 |

## 2. 分层

```
┌────────────────────────────── L3 边缘（可选） ──────────────────────────────┐
│ @vrealtime/server  把任意 WebSocket 接到 Session    @vrealtime/client  浏览器 SDK      │
│ @vrealtime/protocol 线协议 v1（JSON 控制 + 二进制音频）  @vrealtime/react  hooks        │
├────────────────────────────── L2 Agent 运行时 ─────────────────────────────┤
│ defineAgent · Session 状态机 · Turn/epoch 打断 · 工具路由（服务端/客户端） · Hooks │
├────────────────────────────── L1 模型层 ───────────────────────────────────┤
│ RealtimeModel / RealtimeSession · 标准化事件 · 能力声明 · AudioChunk          │
│ @vrealtime/boson  @vrealtime/openai  @vrealtime/gemini  @vrealtime/cascade(+ @vrealtime/ai-sdk)  │
└────────────────────────────────────────────────────────────────────────────┘
```

每一层都可以单独使用。只想统一调用各家实时模型的开发者用 L1 就够了，这层相当于 AI SDK Core；要做完整语音 Agent 再加 L2、L3。

## 3. L1 模型层

类型定义见 [`packages/core/src`](../packages/core/src)。

```ts
interface RealtimeModel {
  readonly provider: string;            // 'boson'
  readonly id: string;                  // 'higgs-realtime'
  readonly capabilities: Capabilities;
  connect(config: SessionConfig, options?: { signal?: AbortSignal }): Promise<RealtimeSession>;
}

interface RealtimeSession {
  readonly capabilities: Capabilities;
  update(config: Partial<SessionConfig>): Promise<void>;
  sendAudio(chunk: AudioChunk): void;   // 热路径：同步，不返回 Promise
  commitAudio(): void;                  // 手动轮次
  clearAudio(): void;
  sendText(text: string): void;
  respond(options?: RespondOptions): void;
  cancel(): void;                       // 取消当前回复
  truncate(itemId: string, audioEndMs: number): void;
  submitToolResult(callId: string, output: unknown, options?: { respond?: boolean }): void;
  on<T extends RealtimeEvent['type']>(type: T, listener: (event: EventOf<T>) => void): () => void;
  close(): Promise<void>;
}
```

### 3.1 标准化事件

vRealTime 用**扁平事件 + `responseId`**，不按回复嵌套多层流：分配更少，序列化方便（可以直接走线协议），也更容易测试。

| 事件 | 含义 |
|---|---|
| `session.ready` | 会话就绪 |
| `input.speech.start` / `input.speech.end` | 用户开口和停止（来自模型 VAD 或框架 VAD） |
| `input.transcript` | 用户语音转写，`final` 标记是否最终结果 |
| `response.start` | 开始回复，带 `responseId` |
| `output.text` / `output.transcript` | 文字增量；语音回复对应的字幕增量 |
| `output.audio` | 音频块（`AudioChunk`） |
| `tool.call.delta` / `tool.call` | 工具参数流式增量；参数完整的工具调用 |
| `response.end` | 结束，`status` 为 `done`、`cancelled`、`interrupted` 或 `failed`，可带用量 |
| `error` | 错误，带 `recoverable` |

### 3.2 能力声明与框架补位

```ts
interface Capabilities {
  input: { audio: boolean; text: boolean; formats: AudioFormat[] };
  output: { audio: boolean; text: boolean; formats: AudioFormat[] };
  turnDetection: { server: boolean; semantic: boolean; manual: boolean };
  inputTranscription: boolean;
  tools: { calls: boolean; argumentStreaming: boolean; autoReplyAfterResult: boolean };
  truncate: boolean;
  midSessionUpdate: { instructions: boolean; tools: boolean };
}
```

缺什么能力由框架补，开发者面对的是同一套 API：没有服务端 VAD 就用 `@vrealtime/vad`；不支持 `truncate` 就由框架改写本地对话记录；结果提交后不会自动继续回复的模型，由框架补发 `respond()`。

### 3.3 音频

- `AudioChunk = { data: Uint8Array; format: AudioFormat; durationMs?: number }`，`AudioFormat` 为 `pcm16`（带采样率）、`opus`、`pcmu` 之一。
- **能透传就透传**：浏览器采集 Opus，服务端原样转给支持 Opus 的模型（Boson 支持），全程不解码。
- 只有格式不匹配时才转换。core 提供一个很小的线性重采样器；Opus 编解码放在可选包里，不进 core。

## 4. L2 Agent 运行时

```ts
const agent = defineAgent({
  model: boson({ voice: 'default', turnDetection: 'semantic' }),
  instructions: '你是文档编辑助手…',
  tools: { getWeather },                 // 服务端工具
  clientTools: 'accept',                 // 接收客户端连接时声明的工具
  hooks: { beforeToolCall, afterToolCall, onTurnEnd, onError },
});
```

### 4.1 Session 状态机（显式、小）

```
idle ──speech.start──▶ listening ──speech.end / commit──▶ responding ──response.end──▶ idle
                           ▲                                  │
                           └──── 打断：speech.start / 客户端 interrupt / cancel() ───┘
                                 epoch++ → cancel → truncate(已播放 ms) → 关闭旧 epoch 的工具调用
```

`responding` 有三个子状态：`thinking`、`speaking`、`acting`（工具执行中），通过 `turn.state` 推给客户端。

### 4.2 打断保证（vRealTime 的核心承诺）

每个 Turn 带一个递增的 `epoch`，所有工具调用都标记所属 epoch。框架保证：

1. **打断后不再有任何副作用**：属于已打断 epoch、尚未执行的工具调用永远不会执行。服务端工具通过 `AbortSignal` 取消；客户端工具由客户端闸门拒绝（见 5.3）。
2. **每个调用恰好一个结果**：被取消的调用也会给模型回一条 `cancelled` 结果，避免模型侧对话记录不完整。
3. **对话记录与用户实际听到的一致**：用客户端上报的已播放毫秒数调用 `truncate`。
4. **单个工具调用是原子的**：要么完整执行，要么不执行，由工具实现方保证；vdoc 的 `DocumentEngine` 就是这样的参考实现。

### 4.3 工具

```ts
const getWeather = tool({
  description: 'Get the weather for a city',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  validate: zodSchema,                    // 可选，任何 Standard Schema（zod/valibot/arktype）
  run: async ({ city }, ctx) => …,        // ctx: { signal, turn, session, emit }
  risk: 'low',                            // 交给 beforeToolCall 做确认策略
  async: false,                           // true 表示打断后仍然完成，稍后再送达结果
});
```

- **服务端工具**：在 Session 内执行。
- **客户端工具**：客户端连接时声明名称和 JSON Schema；调用经线协议转发，结果回传。模型看到的是同一种工具。
- core 不依赖 zod：`parameters` 用 JSON Schema，校验接受任意 [Standard Schema](https://standardschema.dev)。

### 4.4 Hooks

`beforeToolCall`（可以拒绝、改写、要求确认）、`afterToolCall`、`onTurnStart`、`onTurnEnd`（附带轮次指标）、`onTranscript`、`onError`。可观测性通过 hooks 实现，OpenTelemetry 放在可选包 `@vrealtime/otel`。

轮次指标内置且零依赖：`speechEnd → firstAudio`（TTFB）、`speechEnd → firstToolCall`、工具耗时、打断响应时间。

## 5. L3 边缘

### 5.1 线协议 `@vrealtime/protocol`（v1）

- **二进制帧**放音频：1 字节类型 + 4 字节序号 + 负载，不做 base64。
- **JSON 帧**放控制：`hello`（协议版本、客户端工具、音频格式、恢复点）、`ready`、`turn.state`、`transcript`、`text`、`tool.call` / `tool.call.delta` / `tool.result`、`interrupt`、`playback`（已播放 ms）、`ack`、`ping` / `pong`、`error`。
- 每条消息带 `seq` 和 `epoch`；断线重连时从 `lastSeq` 恢复。

类型定义见 [`packages/protocol/src`](../packages/protocol/src)。

### 5.2 服务端 `@vrealtime/server`

```ts
import { serve } from '@vrealtime/server/node';
serve(agent, { port: 8790 });            // Node：可选 peer 依赖 ws
// Bun / Deno / Cloudflare Workers：attach(agent, socket)
```

`attach(agent, socket: WebSocketLike)` 只要求 socket 有 `send`、`close` 和消息回调，任何运行时的 WebSocket 都能接。`serve()` 在 `/` 附带一个调试页，打开浏览器就能对着麦克风测试，不需要原生音频依赖。

### 5.3 客户端 `@vrealtime/client`

```ts
const session = await connect('wss://…', {
  tools: { apply_document_operations: { parameters, run } },
  audio: { input: 'mic', output: 'speaker' },
});
session.on('tool.preview', …);
session.interrupt();
```

- 麦克风：AudioWorklet 采集，按需重采样或用 WebCodecs 编码 Opus，以二进制帧发送。
- 播放：AudioWorklet 环形缓冲。收到 `input.speech.start` 或本地 VAD 触发时**立即清空缓冲**，并上报已播放的毫秒数。
- 工具宿主：按到达顺序串行执行，带 **epoch 闸门**：`interrupt()` 在本地立刻关闭当前 epoch，收到的旧 epoch 调用一律回 `INTERRUPTED`，不执行。
- 零依赖。React 绑定放在 `@vrealtime/react`。

## 6. Cascade：任何文本 LLM 变成实时模型

```ts
const model = cascade({
  stt: deepgram(),                       // 或 boson.stt()
  llm: aiSdk(anthropic('claude-sonnet-5-5')), // 任意 Vercel AI SDK 模型
  tts: boson.tts({ voice: 'default' }),  // Higgs TTS 3
  vad: energyVad(),
});
```

`cascade()` 返回的仍是 `RealtimeModel`，L2、L3 完全不用改。`@vrealtime/ai-sdk` 把 Vercel AI SDK 的 `LanguageModel` 适配成 cascade 的文本模型，一次就覆盖它支持的所有 LLM 供应商，这是"像 LangChain 一样覆盖面广"最省力的做法。

## 7. Boson 适配器映射（OpenAI Realtime GA 兼容）

| vRealTime | Boson Higgs Realtime |
|---|---|
| `connect(config)` | 服务端：`wss://api.boson.ai/v1/realtime` + `Authorization: Bearer`；首个 `session.update` 带 `model: 'higgs-realtime'` |
| `sendAudio` | `input_audio_buffer.append`（base64；PCM 8/16/24/48 kHz、PCMU、Opus；单条 ≤ 1 MiB） |
| `commitAudio` / `clearAudio` | `input_audio_buffer.commit` / `.clear` |
| `respond` / `cancel` | `response.create` / `response.cancel` |
| `truncate` | `conversation.item.truncate` |
| `submitToolResult` | `conversation.item.create`（`function_call_output`），再按需发 `response.create` |
| `input.speech.start/end` | `input_audio_buffer.speech_started/stopped`（服务端 VAD 会自动取消当前回复） |
| `input.transcript` | `conversation.item.input_audio_transcription.completed`（`higgs-stt-3.1`） |
| `response.start/end` | `response.created` / `response.done` |
| `output.audio` / `output.transcript` / `output.text` | `response.output_audio.delta` / `response.output_audio_transcript.delta` / `response.output_text.delta` |
| `tool.call.delta` / `tool.call` | `response.function_call_arguments.delta` / `.done` |

由于协议兼容，`@vrealtime/openai` 和 `@vrealtime/boson` 共享一个 `openai-compatible` 内部实现，各自只覆盖差异（端点、鉴权、扩展事件如 `conversation.context.summarized`）。

## 8. 包与依赖规则

| 包 | 依赖 | 说明 |
|---|---|---|
| `@vrealtime/core` | 无 | L1 接口、L2 运行时、工具、hooks、重采样 |
| `@vrealtime/protocol` | 无 | 线协议类型与编解码 |
| `@vrealtime/boson`、`@vrealtime/openai`、`@vrealtime/gemini` | core | 供应商适配器 |
| `@vrealtime/cascade` | core | STT + LLM + TTS 组合 |
| `@vrealtime/ai-sdk` | core，peer `ai` | Vercel AI SDK 适配 |
| `@vrealtime/server` | core、protocol；Node 可选 peer `ws` | 任意 WebSocket 接入 |
| `@vrealtime/client` | protocol | 浏览器 SDK |
| `@vrealtime/react` | client，peer `react` | hooks |
| `@vrealtime/vad`、`@vrealtime/otel`、`@vrealtime/testing` | core | 可选 |

规则：core 和 protocol 永远零依赖；适配器不得互相依赖；任何 `node:` 导入只能出现在 `*/node` 子路径中。

## 9. 设计取舍

| | 常见做法 | vRealTime |
|---|---|---|
| 运行环境 | 只支持 Node，核心接口依赖特定 RTC SDK | Node、Bun、Deno、Workers、浏览器 |
| 基础设施 | 需要媒体服务器、Worker、进程池 | 任意 WebSocket；可选 WebRTC |
| 工具执行位置 | 服务端 | 服务端或客户端 App，带 epoch 闸门 |
| 打断语义 | 隐含在大型状态机里 | 四条明确保证（4.2），状态机小而显式 |
| 供应商覆盖 | 为每家 LLM 单独写插件 | 实时模型逐家适配；文本 LLM 借 AI SDK 一次覆盖 |
| 体量 | 上百个依赖包 | core + boson + server 少于 5 个包，小于 1 MB |

## 10. 路线图

| 里程碑 | 内容 | 验收 |
|---|---|---|
| **M0 核心** | core（L1 接口、L2 Session、工具、hooks）、protocol、boson 适配器、server（Node）、client（文字和 PCM）、`@vrealtime/testing` 假模型 | 十行示例对着麦克风跑通；打断四条保证有自动化测试；体量预算进 CI |
| **M1 vdoc 接入** | vdoc 用 `@vrealtime/client` 替换自研的会话、执行器（vdoc #30–#32）；Opus 透传；`truncate` 对齐 | vdoc 实测：打断后 200 ms 内无改动上屏 |
| **M2 覆盖面** | openai、gemini、cascade、ai-sdk、vad；Workers / Durable Object 适配；react | 同一个 Agent 切换四种模型，业务代码零修改 |
| **M3 开源** | 文档站、示例、changesets 发版、基准测试（延迟与体量） | npm 0.x 公开发布 |

## 11. 待定

- **命名**（已定）：全名 vRealTime，简称 vRT（GitHub 仓库名 `vRT`）；npm 使用 `@vrealtime/*`。`vrealtime` 包名、`@vrealtime` 组织名目前都还空着，需尽快用本人账号注册。
- **许可证**：建议 Apache-2.0。
- **Python SDK**：M3 之后视需求而定。
- **浏览器直连模型**：Boson 支持短期 client secret，可以作为可选的低延迟模式（`@vrealtime/client` 直接连模型）；默认仍经服务端中转。
