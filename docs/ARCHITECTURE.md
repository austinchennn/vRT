# vRealTime（vRT）架构设计（v1）

> **一句话**：一份协议，让任何实时语音模型接进任何 App 和设备。轻、快、可打断。

日期：2026-10-15。状态：M0、M2 已在本仓库实现（TypeScript 参考实现）；本版把定位调整为**协议优先、多语言、多设备**。

## 0. 定位

vRealTime 的目标是让 AI 和工具去适应人的习惯：人用说话来操作网页、手机、家里的设备，而不是人去学习每个 App 的界面。要覆盖这么多场景和开发者，核心就不能是某一种语言的框架，而是**一份与语言无关的协议**。

1. **协议优先**：真正的产品是 vRT 协议规范（`spec/`，Markdown + JSON Schema）和一致性测试套件。TypeScript 包是第一份参考实现，不是唯一的定义。任何语言写的 SDK，只要通过一致性测试，就是合格的 vRT 实现。
2. **多语言**：服务端运行时先只维护一份 TypeScript 参考实现；客户端 SDK 要薄、要多：TypeScript、Python、Swift、Kotlin、C。
3. **多设备**：网页、手机、桌面、家里的灯和门锁，都是"工具宿主"。每个设备通过同一份协议暴露自己的工具和音频输入输出，打断语义完全一样。
4. **不绑定基础设施**：只需要 WebSocket，不需要媒体服务器；服务端可以跑在 Node、Bun、Deno、Workers 上。
5. **原生支持 Boson Higgs Realtime**，同时覆盖 OpenAI Realtime、Gemini Live 等。
6. **工具在客户端执行是一等能力**：工具可以在用户的 App 或设备里执行，可打断、执行时实时可见、每轮可撤销。在物理世界里这更重要：用户喊"停"之后，门不能再被打开。
7. **任何文本 LLM 都能变成实时模型**：语音识别 + 任意 LLM + TTS 组合成一个 `RealtimeModel`，业务代码不需要改。

### 0.1 两类开发者

| 角色 | 做什么 | 用什么 |
|---|---|---|
| **Agent 开发者**（服务端） | 选模型、写指令、配 hooks、审计和权限 | TypeScript 运行时（参考实现）；Python 运行时视需求 |
| **工具与设备开发者**（客户端） | 把自己的 App 或设备暴露成工具和音频端 | 网页 TypeScript；手机 Swift、Kotlin；树莓派、Home Assistant、桌面 Python；ESP32 等单片机 C |

复杂度集中在服务端；客户端只负责"连上、声明工具、执行工具、收发音频、遵守打断闸门"。

## 1. 设计原则与量化预算

| 原则 | 做法 | 预算（CI 强制） |
|---|---|---|
| **轻** | 核心零运行时依赖；每个供应商一个独立包，只依赖 core；只出 ESM，可 tree-shake | `@vrealtime/core` ≤ 15 KB（min+gzip）；单个适配器 ≤ 10 KB；`@vrealtime/client` ≤ 20 KB |
| **快** | 音频热路径同步、不经 Promise；尽量零拷贝；能透传就不转码（例如 Opus 原样转发给 Boson） | 每个音频块的框架开销 < 50 µs；本地停播 < 1 个音频帧（≤ 20 ms） |
| **省** | 浏览器到服务端用二进制帧而不是 base64 JSON（体积小 33%，不用编解码）；可选 Opus（带宽约为 PCM 的 1/10） | 24 kHz PCM16 上行 ≤ 48 KB/s，Opus ≤ 4 KB/s |
| **到处能跑** | 只用 Web 标准 API：WebSocket、fetch、AbortSignal、TypedArray、TextEncoder | Node 22+、Bun、Deno、Cloudflare Workers、浏览器使用同一套代码 |
| **少概念** | 核心概念不超过 6 个；不引入链、图；状态机显式、小而可测 | `Session` 运行时 ≤ 1500 行 |
| **薄客户端** | 协议只用 WebSocket、JSON 文本帧和二进制音频帧；客户端不做编排、不做模型适配 | 任一语言的客户端协议核心（不含音频采集播放）≤ 800 行；ESP32-S3 级别的单片机可以实现 |
| **协议可演进** | 版本号加能力协商：`hello` 声明协议版本和可选能力；小版本只做增量，不破坏旧客户端 | 一致性测试覆盖每个协议版本 |

## 2. 分层

```
┌──────────────────── spec/：vRT 协议规范（与语言无关） ────────────────────┐
│ 消息定义（JSON Schema）· 二进制音频帧 · 打断与 epoch 语义 · 断线续传 · 一致性测试 │
└──────────────┬───────────────────────────────────────────┬─────────────┘
               │ 服务端实现                                │ 客户端实现（薄、多语言）
               ▼                                           ▼
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

上图下半部分是服务端的 TypeScript 参考实现。客户端除了 `@vrealtime/client`（TypeScript），还有 Python、Swift、Kotlin、C 等 SDK（见 §6），它们都只依赖 `spec/`，不依赖 TypeScript 代码。

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

### 5.1 线协议（v1）

**唯一定义在 [`spec/`](../spec/)**：[`spec/protocol.md`](../spec/protocol.md) 写语义（状态机、epoch、续传、错误码），[`spec/schema/`](../spec/schema/) 用 JSON Schema 写每一条消息，[`spec/examples/`](../spec/examples/) 是带预期结果的合法和非法样例。`@vrealtime/protocol` 是它的 TypeScript 实现：CI 先检查 `spec/` 自洽（`npm run check:spec`），再用全部样例和逐字段变异的消息对比 TS 校验函数与 Schema 的判定（`packages/protocol/test/spec.test.ts`）；其他语言的 SDK 也从同一份 Schema 生成类型或做校验。

版本规则：每条消息的 `v` 是大版本号（始终为 1）；`hello.capabilities` 声明可选能力，`ready.capabilities` 回复本会话生效的交集，缺省表示没有；标准能力统一登记在 [`spec/capabilities.json`](../spec/capabilities.json)，实现只能声明已登记的能力（或 `x-` 私有能力），服务端按"运行时已实现 × 模型支持"决定可协商的集合。小版本（v1.x）只能新增可选字段、新能力，以及只在协商成功后才发送的新消息类型和枚举值；接收方忽略不认识的字段和能力；破坏性变更只能出现在大版本。

- **二进制帧**放音频：1 字节类型 + 4 字节序号 + 负载，不做 base64。
- **JSON 帧**放控制：`hello`（协议版本、客户端工具、音频格式、`sessionId` + 恢复点；v1.1 起可带 `auth` 短期令牌，放在首条消息里而不是 URL，服务端每次握手和续传都校验，续传必须是同一主体）、`ready`、`audio.start`（之后的二进制输出帧属于哪个 item，客户端据此按 item 上报已播放 ms）、`turn.state`、`transcript`、`text`、`tool.call` / `tool.call.delta` / `tool.result`、`interrupt`、`playback`（已播放 ms）、`ack`、`ping` / `pong`、`error`。
- 每条消息带 `seq`，与轮次相关的消息带 `epoch`；断线重连时客户端在 `hello` 里带 `sessionId` 和 `resumeFrom`（已处理的最后一个服务端 `seq`），服务端在 `ready` 里回 `resumedFrom`，双方补发对方没收到的消息。`hello`、`ready`、`audio.start`、`ack`、`ping`、`pong` 只对当前连接有效，`seq` 为 0，不补发。会话建立之前发出的错误（如 `UNAUTHORIZED`、`RESUME_FAILED`）也用 `seq` 0；接收方对 `seq` 为 0 的消息一律处理、不去重。

TypeScript 实现见 [`packages/protocol/src`](../packages/protocol/src)。

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
- 工具宿主：按到达顺序串行执行，带 **epoch 闸门**：`interrupt()` 在本地立刻关闭当前 epoch，收到的旧 epoch 调用一律回 `INTERRUPTED`，不执行；工具真正开始执行的那一刻会再检查一次闸门，排队后才到的打断也拦得住；已关闭 epoch 的 `tool.call.delta` 预览直接丢弃。
- 打断通知不等服务端：`interrupt()` 当场发出 `interrupted`（`source: 'local'`），UI 立即清理预览和播放；服务端随后对同一 epoch 的确认不再重复通知，服务端自己发起的打断（如插话）发出 `source: 'server'`。`npm run bench:latency -- --rtt 100` 下打断通知从约 103 ms（一个往返）降到约 0.01 ms。
- 结构：`EpochGate`（epoch 状态）、`ToolHost`（排队、执行、恰好一个结果）、`ClientSession`（连接与编排）各管一件事。
- 工具调用生命周期（能力 `tool-stream-v1`，spec §7.5）：`tool.stream` 报告每个调用（服务端或客户端）的 `start` → 参数片段 → `arguments-complete` → 进度 → 恰好一个终态（`settled` / `cancelled` / `failed`），供 UI 在模型还在生成参数时渲染预览。core 由 `ToolStreams` 统一保证顺序，服务端按协商结果发 `tool.stream` 或 1.0 的 `tool.call.delta`（不会两者都发），客户端由 `ToolStreamTracker` 按 epoch 过滤、本地打断即刻取消、终态去重，并继续派生 `tool.preview` 兼容旧代码。服务端工具的输出不会出现在线上。
- 零依赖。React 绑定放在 `@vrealtime/react`。

### 5.4 一致性测试套件

`conformance/` 提供一个**测试服务端**和一个**测试客户端**，以命令行运行，可以对任何语言的实现做黑盒测试：

- 测服务端：测试客户端连上被测服务端，按脚本发送消息，检查回复。
- 测客户端：被测客户端连上测试服务端，测试服务端按脚本下发工具调用、打断、断线，检查客户端的行为。

必测场景：握手与版本协商；工具调用与结果；**打断后旧 epoch 的调用一律回 `INTERRUPTED`、绝不执行**；每个调用恰好一个结果；断线续传（`sessionId` + `resumeFrom` / `resumedFrom`，双方补发）；心跳超时；二进制音频帧的边界情况；非法消息不崩溃。

通过一致性测试是一个 SDK 被列为"官方兼容"的唯一标准。

## 6. 多语言客户端 SDK

每个客户端 SDK 必须实现的最小集合：

1. 协议会话：握手、`seq` / `ack`、断线续传、心跳、退避重连。
2. 工具宿主：声明工具（名称、描述、JSON Schema），按到达顺序串行执行，**epoch 闸门**，每个调用恰好回一个结果，可选的 `tool.call.delta` 预览。
3. `interrupt()`：本地立刻关闭当前 epoch，再通知服务端。
4. 音频（可选）：采集上行，播放下行，打断时立即清空播放缓冲并上报已播放毫秒数。没有麦克风和喇叭的设备（比如一盏灯）只实现 1–3。

| SDK | 平台 | 计划 |
|---|---|---|
| `@vrealtime/client`（TypeScript） | 浏览器、Node、Deno、Bun | 已实现（M0） |
| `vrealtime`（Python） | 树莓派、Home Assistant、桌面、服务端脚本 | M1 |
| Swift / Kotlin | iOS、Android | M3 |
| C（ESP-IDF） | ESP32 等单片机 | M4 |

## 7. 设备与 IoT

1. **设备即工具宿主**：灯暴露 `turn_on`、`set_brightness`，门锁暴露 `unlock`，带麦克风和喇叭的音箱同时是音频端。vdoc 暴露"修改文档"，用的是同一个模型。
2. **音频端与工具宿主分离**（v1.x 扩展，待设计）：家里通常是"一个音箱负责听和说，很多设备负责执行"。协议需要允许一个会话里有一个音频端连接、多个工具宿主连接，或者由一个网关（如 Home Assistant）代理多个设备。
3. **设备鉴权**：设备用单独签发的设备令牌，按设备限定可用的工具和权限，不复用浏览器的登录态；令牌可吊销。
4. **弱网**：音频用 Opus（带宽约为 PCM 的 1/10）；断线续传保证工具结果不丢、不重复；执行器类工具（开锁、开关）必须幂等，用 `callId` 去重。
5. **没有屏幕的确认**：`risk: 'high'` 的工具（开门、关闭报警、付款）由 `beforeToolCall` 转成语音确认，也可以要求设备上的物理按键确认；确认本身也受 epoch 约束，打断即作废。
6. **唤醒词**：放在设备端，可选。唤醒前不上传任何音频；唤醒后才建立或恢复会话。
7. **远场音频**：会话配置里开启降噪（例如 Boson 的 `far_field` 降噪）；回声消除由设备或浏览器负责。
8. **MCP 桥接**：vRT 服务端可以同时作为 MCP 客户端，把任何现有 MCP server 的工具当成服务端工具提供给模型，并按工具注解映射风险等级。Home Assistant 已有 MCP server 集成，接上后"用语音控制全屋设备"几乎不需要再写代码。

## 8. Cascade：任何文本 LLM 变成实时模型

```ts
const model = cascade({
  stt: deepgram(),                       // 或 boson.stt()
  llm: aiSdk(anthropic('claude-sonnet-5-5')), // 任意 Vercel AI SDK 模型
  tts: boson.tts({ voice: 'default' }),  // Higgs TTS 3
  vad: energyVad(),
});
```

`cascade()` 返回的仍是 `RealtimeModel`，L2、L3 完全不用改。`@vrealtime/ai-sdk` 把 Vercel AI SDK 的 `LanguageModel` 适配成 cascade 的文本模型，一次就覆盖它支持的所有 LLM 供应商，这是"像 LangChain 一样覆盖面广"最省力的做法。

## 9. Boson 适配器映射（OpenAI Realtime GA 兼容）

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

## 10. 包与依赖规则

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
| `@vrealtime/mcp` | core | MCP 桥接：MCP server 的工具变成服务端工具（M3） |
| `spec/` | 无 | 协议规范与 JSON Schema，所有实现的唯一来源 |
| `conformance/` | protocol | 一致性测试服务端和客户端（命令行） |
| `vrealtime`（PyPI） | 一个 WebSocket 库 | Python 客户端 SDK（M1） |

规则：core 和 protocol 永远零依赖；适配器不得互相依赖；任何 `node:` 导入只能出现在 `*/node` 子路径中。

## 11. 设计取舍

| | 常见做法 | vRealTime |
|---|---|---|
| 运行环境 | 只支持 Node，核心接口依赖特定 RTC SDK | Node、Bun、Deno、Workers、浏览器 |
| 基础设施 | 需要媒体服务器、Worker、进程池 | 任意 WebSocket；可选 WebRTC |
| 工具执行位置 | 服务端 | 服务端或客户端 App、设备，带 epoch 闸门 |
| 语言 | 框架绑定一种语言 | 协议优先：服务端一份参考实现，客户端多语言 SDK，一致性测试判定兼容 |
| 打断语义 | 隐含在大型状态机里 | 四条明确保证（4.2），状态机小而显式 |
| 供应商覆盖 | 为每家 LLM 单独写插件 | 实时模型逐家适配；文本 LLM 借 AI SDK 一次覆盖 |
| 体量 | 上百个依赖包 | core + boson + server 少于 5 个包，小于 1 MB |

## 12. 路线图

| 里程碑 | 内容 | 验收 |
|---|---|---|
| **M0 核心** ✅ | core（L1 接口、L2 Session、工具、hooks）、protocol、boson 适配器、server（Node）、client（文字和 PCM）、`@vrealtime/testing` 假模型 | 十行示例对着麦克风跑通；打断四条保证有自动化测试；体量预算进 CI |
| **M1 协议定稿与多语言起步** | `spec/` 协议规范与 JSON Schema（TS 实现以它为准）；一致性测试套件；Python 客户端 SDK；vdoc 用 `@vrealtime/client` 替换自研的会话和执行器（vdoc #30–#32） | TS 和 Python 两个客户端都通过一致性测试；vdoc 实测打断后 200 ms 内无改动上屏 |
| **M2 覆盖面** ✅ | openai、gemini、cascade、ai-sdk、vad；Workers / Durable Object 适配；react | 同一个 Agent 切换四种模型，业务代码零修改 |
| **M3 设备与生态** | MCP 桥接；Swift、Kotlin SDK；设备鉴权；音频端与工具宿主分离；树莓派 + Home Assistant 示例 | 用语音控制 Home Assistant 里的设备，打断后无动作 |
| **M4 嵌入式与发布** | C SDK（ESP32）；文档站；npm 与 PyPI 发布；基准测试（延迟与体量） | ESP32 设备通过一致性测试；0.x 公开发布 |

## 13. 待定

- **命名**（已定）：全名 vRealTime，简称 vRT（GitHub 仓库名 `vRT`）；npm 使用 `@vrealtime/*`：`@vrealtime` 组织已注册，0.1.0 已于 2026-10-16 由 CI 发布（附 provenance，流程见 `RELEASING.md`）；不带作用域的 npm 包名 `vrealtime` 和 PyPI 上的 `vrealtime`（Python SDK，#18）都还没注册。
- **许可证**（已定）：Apache-2.0。
- **Python**：客户端 SDK 提前到 M1；Python 服务端运行时视需求再定。
- **多连接会话**：音频端与工具宿主分离的协议设计（§7 第 2 条），在 M3 前定稿。
- **传输**：v1 只用 WebSocket；是否为低功耗设备增加 MQTT 绑定，等 M3 的设备实践后再定。
- **浏览器直连模型**：Boson 支持短期 client secret，可以作为可选的低延迟模式（`@vrealtime/client` 直接连模型）；默认仍经服务端中转。
