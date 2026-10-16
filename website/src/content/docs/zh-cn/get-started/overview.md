---
title: 概览
description: vRealTime 是什么、给谁用，以及各部分如何配合。
---

vRealTime（vRT）让人可以像跟人说话一样跟软件和设备说话。**agent** 负责听、说和调用**工具**，而工具在它该在的地方执行：在服务端、agent 旁边，或者在用户的网页、手机 App、桌面程序和设备里。

vRT 是**协议优先**的。vRT 协议（WebSocket + JSON 控制消息 + 二进制音频帧）才是契约本身。本仓库包含服务端运行时和第一个客户端 SDK 的 TypeScript 参考实现。客户端刻意做得很薄，所以可以用任何语言实现，一直到单片机。

## 两类开发者

| 角色 | 做什么 | 用什么 |
|---|---|---|
| **Agent 开发者**（服务端） | 选模型、写指令、加服务端工具、hooks、鉴权和审计 | TypeScript 运行时：`@vrealtime/core`、`@vrealtime/server` 和一个模型适配器 |
| **App 和设备开发者**（客户端） | 把 App 或设备暴露成工具，按需提供音频输入输出 | 客户端 SDK：目前是 `@vrealtime/client`；Python、Swift、Kotlin 和 C 在计划中 |

复杂度集中在服务端。客户端只负责连接、声明工具、执行工具、收发音频（如果有），并遵守 epoch 闸门。没有麦克风和喇叭的设备，比如一盏灯，只需要托管工具。

## 各部分如何配合

```
                 vRT 协议：协议规范 + 一致性测试套件
           ┌────────────────────────┴────────────────────────┐
  服务端（TypeScript 参考实现）                       客户端（薄、任何语言）
  agent 运行时 · 模型适配器 ·                         网页 · 手机 · 桌面 · 设备
  服务端工具 · hooks · 鉴权                           App 工具 · 音频收发 · epoch 闸门
```

服务端分三层，每一层都可以单独使用：

1. **模型层**（`@vrealtime/boson`、`openai`、`gemini`、`cascade`）：所有供应商统一成一个 `RealtimeModel` 接口，带标准化事件和能力声明。
2. **Agent 运行时**（`@vrealtime/core`）：会话、轮次和 epoch、工具路由、hooks，以及打断保证。
3. **边缘层**（`@vrealtime/server`、`@vrealtime/client`、`@vrealtime/protocol`）：线协议、服务端接入任意 WebSocket，以及浏览器 SDK。

详见[架构](/zh-cn/concepts/architecture/)。

## vRT 保证什么

当用户打断（说话盖过 agent，或按下停止）时：

1. **打断后不再有副作用。** 被打断那一轮里还没开始的工具调用，永远不会开始。
2. **每个工具调用恰好一个结果。** 被取消的调用也会得到回应，模型侧的对话记录保持完整。
3. **对话记录与用户实际听到的一致。** 对话会被截断到用户真正听到的音频为止。
4. **单个工具调用是原子的。** 要么完整生效，要么完全不生效；工具会收到一个取消信号，在提交前检查。

[打断](/zh-cn/concepts/interruption/)一页讲轮次、epoch 和客户端的 epoch 闸门如何兑现这些保证。

## 当前状态

核心运行时、协议、Boson / OpenAI / Gemini 适配器、cascade（语音识别 + 任意文本模型 + 语音合成）、语音活动检测、Node 和 Workers 服务端、浏览器客户端以及 React hooks 都已实现。[协议规范](/zh-cn/reference/protocol/)已经写完；一致性测试套件和 Python 客户端 SDK 正在进行中。

## 下一步

- [快速开始](/zh-cn/get-started/quickstart/)：两分钟跑起一个 agent 并跟它对话。
- [安装](/zh-cn/get-started/installation/)：把 vRT 加到你自己的项目里。
