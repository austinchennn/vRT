---
title: Interruption
description: Turns, epochs, the client's epoch gate, and the guarantees they give.
sidebar:
  order: 2
---

Interruption is the core promise of vRT: once the user interrupts, nothing from the interrupted turn takes effect, whether it edits a document or unlocks a door.

## Turns and epochs

A **turn** is one exchange: the user speaks, the agent thinks, speaks and runs tools. The server reports each turn's state to the app with `turn.state`: `listening`, `thinking`, `speaking`, `acting` (tools running) and finally `idle`.

Every turn has an **epoch**, a number that only grows: it advances when a turn starts and when a turn is interrupted. Everything the server sends about a turn carries its epoch, including tool calls and the audio it announces. When a turn is interrupted, its epoch, and every earlier one, is **closed**.

## The four guarantees

1. **No side effects after an interruption.** A tool call of a closed epoch that has not started never starts. Server tools are cancelled through their `AbortSignal`; app tools are stopped by the client's epoch gate.
2. **Exactly one result per call.** A cancelled call is still answered, with `INTERRUPTED`, so the model never waits on a call that will not finish.
3. **The transcript matches what was heard.** The client reports how many milliseconds of each audio item were actually played, and the conversation is truncated there.
4. **Each tool call is atomic.** A call takes full effect or none. This one is the tool's job: check the cancellation signal right before committing (see [Tools](/concepts/tools/)).

## What happens when the user interrupts

The user speaks over the agent, presses a stop button, or presses a key. The client calls `session.interrupt()`, which, **without waiting for the server**:

1. closes the current epoch locally;
2. answers every queued tool call of that epoch with `INTERRUPTED`, without running it;
3. aborts the `signal` of the tool that is running;
4. ends every open `tool.stream` call of that epoch as `cancelled`;
5. stops playback and discards buffered audio;
6. emits `interrupted` (with `source: 'local'`), so the UI can clear previews right away;
7. then tells the server.

The server stops the model, settles the turn's pending calls, truncates the conversation to what was heard, and confirms with `interrupted`. The client does not report that confirmation a second time. When the server interrupts on its own, for example because its voice activity detection heard the user, the client reports it with `source: 'server'`.

## The epoch gate

The gate is what makes guarantee 1 hold even for messages already on their way:

- a tool call that arrives for a closed epoch is answered `INTERRUPTED` and never runs;
- the gate is checked again at the instant a tool starts, so an interruption that lands between queueing and starting still stops it;
- output audio of a closed epoch is never played;
- previews (`tool.preview`) of a closed epoch are dropped.

```js
session.on('interrupted', ({ epoch }) => clearPreviews((preview) => preview.epoch <= epoch));
```

## What interruption cannot do

Cancellation is **cooperative**. Aborting the signal cannot undo something a tool already did. Tools with effects in the world should be atomic, check `context.signal.aborted` before committing, and be idempotent by `callId`. For irreversible actions, require confirmation with `risk: 'high'` and a `beforeToolCall` hook ([Build an agent](/guides/agents/)).

The exact rules are in the [protocol specification](/reference/protocol/#62-interruption-and-the-epoch-gate).
