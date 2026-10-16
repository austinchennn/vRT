---
title: 打断
description: 轮次、epoch、客户端的 epoch 闸门，以及它们提供的保证。
sidebar:
  order: 2
---

打断是 vRT 的核心承诺：用户一打断，被打断那一轮里的东西就都不再生效，不管它是在改文档还是在开门。

## 轮次和 epoch

一个**轮次**是一次交互：用户说话，agent 思考、说话、执行工具。服务端通过 `turn.state` 把每一轮的状态告诉 App：`listening`、`thinking`、`speaking`、`acting`（工具执行中），最后回到 `idle`。

每一轮都有一个 **epoch**，它只增不减：新一轮开始时加一，一轮被打断时也加一。服务端发出的关于某一轮的所有内容都带着它的 epoch，包括工具调用和它宣告的音频。一轮被打断时，它的 epoch 以及更早的所有 epoch 都会被**关闭**。

## 四条保证

1. **打断后不再有副作用。** 已关闭 epoch 里还没开始的工具调用，永远不会开始。服务端工具通过 `AbortSignal` 取消；App 工具由客户端的 epoch 闸门拦下。
2. **每个调用恰好一个结果。** 被取消的调用也会得到 `INTERRUPTED` 的回应，模型永远不会一直等一个不会结束的调用。
3. **对话记录与用户实际听到的一致。** 客户端上报每段音频实际播放了多少毫秒，对话就截断在那里。
4. **单个工具调用是原子的。** 一次调用要么完整生效，要么完全不生效。这一条由工具负责：在提交前检查取消信号（见[工具](/zh-cn/concepts/tools/)）。

## 用户打断时发生了什么

用户说话盖过 agent、按下停止按钮或按下某个键，客户端调用 `session.interrupt()`，它会**不等服务端**，依次：

1. 在本地关闭当前 epoch；
2. 这个 epoch 里排队的工具调用全部回 `INTERRUPTED`，不执行；
3. 中止正在执行的工具的 `signal`；
4. 停止播放并丢弃缓冲的音频；
5. 发出 `interrupted`（`source: 'local'`），UI 可以立刻清掉预览；
6. 然后再通知服务端。

服务端停下模型，结算这一轮还在等待的调用，把对话截断到用户听到的位置，然后回一个 `interrupted` 确认。客户端不会再重复通知这次确认。如果是服务端自己发起的打断（比如它的语音活动检测听到用户开口），客户端会以 `source: 'server'` 通知。

## epoch 闸门

闸门让第 1 条保证对已经在路上的消息也成立：

- 已关闭 epoch 的工具调用到达时，回 `INTERRUPTED`，绝不执行；
- 工具真正开始执行的那一刻会再检查一次闸门，所以就算打断恰好落在排队之后、开始之前，也拦得住；
- 已关闭 epoch 的音频永远不会播放；
- 已关闭 epoch 的预览（`tool.preview`）直接丢弃。

```js
session.on('interrupted', ({ epoch }) => clearPreviews((preview) => preview.epoch <= epoch));
```

## 打断做不到什么

取消是**协作式**的。中止信号撤销不了工具已经做完的事。对外部世界有影响的工具应当是原子的，在提交前检查 `context.signal.aborted`，并且以 `callId` 做幂等。不可逆的操作，请用 `risk: 'high'` 加 `beforeToolCall` hook 要求确认（见[构建 agent](/zh-cn/guides/agents/)）。

精确的规则见[协议规范](/zh-cn/reference/protocol/#62-interruption-and-the-epoch-gate)。
