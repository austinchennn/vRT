import { defineAgent, startSession, tool, type AgentEvent, type AudioChunk, type Tool } from '@vrealtime/core';
import { describe, expect, it, vi } from 'vitest';
import { cascade, type SttResult, type SttStream, type StreamingSttModel, type TextModel, type TextRequest } from '../src/index.js';

// ── The reference composition (docs/ARCHITECTURE.md §8.2) ────────────────────
// It lives in the app, not in vRT: what to speculate on and what to show is the
// app's call. All it needs from vRT is the transcript identity: itemId, revision, final.

type UserTranscript = Extract<AgentEvent, { type: 'transcript' }>;

interface Speculation<T> {
  itemId: string;
  revision: number;
  final: boolean;
  status: 'pending' | 'result' | 'cancelled' | 'error';
  value?: T;
  error?: unknown;
}

/**
 * Runs `task` on the latest revision of each utterance. A newer revision aborts the
 * older task, and the generation check drops its result even when it ignores the
 * signal. Results are opaque previews: nothing here runs a tool or commits anything.
 */
function speculate<T>(
  task: (text: string, signal: AbortSignal) => Promise<T>,
  publish: (speculation: Speculation<T>) => void,
  options: { maxUtterances?: number } = {},
) {
  const current = new Map<string, { revision: number; final: boolean; controller: AbortController }>();
  const maxUtterances = options.maxUtterances ?? 2;
  let closed = false;
  const cancel = (itemId: string) => {
    const entry = current.get(itemId);
    if (!entry) return;
    current.delete(itemId);
    entry.controller.abort();
    publish({ itemId, revision: entry.revision, final: entry.final, status: 'cancelled' });
  };
  return {
    update(event: UserTranscript): void {
      if (closed || event.role !== 'user' || event.revision === undefined) return;
      const previous = current.get(event.itemId);
      // A repeated or older revision changes nothing.
      if (previous && event.revision <= previous.revision) return;
      cancel(event.itemId);
      // An empty text retracts the utterance: nothing to speculate on.
      if (!event.text) return;
      const entry = { revision: event.revision, final: event.final, controller: new AbortController() };
      current.set(event.itemId, entry);
      while (current.size > maxUtterances) cancel(current.keys().next().value!);
      const identity = { itemId: event.itemId, revision: event.revision, final: event.final };
      const isCurrent = () => !closed && current.get(event.itemId) === entry;
      publish({ ...identity, status: 'pending' });
      task(event.text, entry.controller.signal).then(
        (value) => { if (isCurrent()) publish({ ...identity, status: 'result', value }); },
        (error) => { if (isCurrent()) publish({ ...identity, status: 'error', error }); },
      );
    },
    /** In flight, for bounds checks. */
    get size() {
      return current.size;
    },
    close(): void {
      if (closed) return;
      for (const itemId of [...current.keys()]) cancel(itemId);
      closed = true;
    },
  };
}

// ── Harness ───────────────────────────────────────────────────────────────────

const pcm16k = { encoding: 'pcm16', sampleRate: 16000, channels: 1 } as const;
const chunk: AudioChunk = { data: new Uint8Array(640), format: pcm16k };
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Streaming stt whose results the test pushes. */
function streamingStt() {
  const pushers: ((result: SttResult) => void)[] = [];
  const model: StreamingSttModel = {
    mode: 'stream',
    open() {
      const queue: SttResult[] = [];
      let wake: (() => void) | undefined;
      pushers.push((result) => { queue.push(result); wake?.(); });
      const stream: SttStream = {
        write() {},
        end() {},
        results: {
          async *[Symbol.asyncIterator]() {
            for (;;) {
              while (queue.length === 0) await new Promise<void>((resolve) => { wake = resolve; });
              yield queue.shift()!;
            }
          },
        },
      };
      return stream;
    },
  };
  return { model, say: (utterance: number, text: string, final = false) => pushers[utterance]!({ text, final }) };
}

async function harness() {
  const stt = streamingStt();
  const requests: TextRequest[] = [];
  const llm: TextModel = {
    async *stream(request) {
      requests.push(structuredClone({ ...request, messages: request.messages }));
      yield { type: 'text', delta: 'Done.' };
    },
  };
  const runs = vi.fn(() => 'ok');
  const act = tool({ description: 'a tool with side effects', parameters: { type: 'object' }, run: runs }) as Tool<never, unknown>;
  const session = await startSession(defineAgent({ model: cascade({ llm, stt: stt.model }), instructions: 'x', tools: { act } }));
  const published: Speculation<string>[] = [];
  const tasks: { text: string; signal: AbortSignal; done: ReturnType<typeof deferred<string>> }[] = [];
  const speculation = speculate<string>((text, signal) => {
    const done = deferred<string>();
    tasks.push({ text, signal, done });
    return done.promise;
  }, (s) => published.push(s));
  session.on('transcript', (event) => speculation.update(event));
  const results = () => published.filter((s) => s.status === 'result').map((s) => `${s.itemId}#${s.revision}:${s.value}`);
  return { session, stt, requests, runs, speculation, published, tasks, results };
}

describe('revision-aware speculation (reference composition)', () => {
  it('partial r1, revised r2, final: only the current revision is observable', async () => {
    const { session, stt, speculation, tasks, results, published, runs } = await harness();
    session.sendAudio(chunk);
    stt.say(0, 'turn on');
    await flush();
    stt.say(0, 'turn on the');
    await flush();
    // r1 was aborted the moment r2 arrived, before any await.
    expect(tasks.map((t) => t.signal.aborted)).toEqual([true, false]);
    // r1 ignores its signal and finishes late: it must not count.
    tasks[0]!.done.resolve('stale r1');
    tasks[1]!.done.resolve('preview r2');
    await flush();
    expect(results()).toEqual(['cascade-user-1#2:preview r2']);
    session.commitAudio();
    stt.say(0, 'turn on the lights', true);
    await flush();
    expect(tasks[1]!.signal.aborted).toBe(true);
    tasks[2]!.done.resolve('preview final');
    await flush();
    expect(results()).toEqual(['cascade-user-1#2:preview r2', 'cascade-user-1#3:preview final']);
    expect(published.find((s) => s.revision === 3 && s.status === 'result')).toMatchObject({ final: true });
    expect(runs).not.toHaveBeenCalled();
    speculation.close();
    await session.close();
  });

  it('keeps utterances apart', async () => {
    const { session, stt, tasks, results } = await harness();
    session.sendAudio(chunk);
    session.commitAudio();
    session.sendAudio(chunk);
    stt.say(0, 'first');
    stt.say(1, 'second');
    await flush();
    expect(tasks.map((t) => t.text)).toEqual(['first', 'second']);
    expect(tasks.every((t) => !t.signal.aborted)).toBe(true);
    tasks[1]!.done.resolve('B');
    tasks[0]!.done.resolve('A');
    await flush();
    expect(results()).toEqual(['cascade-user-2#1:B', 'cascade-user-1#1:A']);
    await session.close();
  });

  it('ignores repeated and older revisions, and a revision that arrives after the final', () => {
    const published: Speculation<string>[] = [];
    const started: string[] = [];
    const speculation = speculate<string>(async (text) => { started.push(text); return text; }, (s) => published.push(s));
    const t = (revision: number, text: string, final = false): UserTranscript => ({ type: 'transcript', role: 'user', itemId: 'u1', text, final, revision });
    speculation.update(t(1, 'a'));
    speculation.update(t(1, 'a, conflicting'));
    speculation.update(t(3, 'abc', true));
    speculation.update(t(2, 'ab'));
    speculation.update(t(3, 'abc, again', true));
    expect(started).toEqual(['a', 'abc']);
  });

  it('a burst of revisions leaves one task running and publishes only the last result', async () => {
    const { session, stt, tasks, results, speculation } = await harness();
    session.sendAudio(chunk);
    for (let i = 1; i <= 50; i++) stt.say(0, `word ${i}`);
    await flush();
    expect(tasks.filter((t) => !t.signal.aborted)).toHaveLength(1);
    for (const task of tasks) task.done.resolve(task.text);
    await flush();
    expect(results()).toEqual([`cascade-user-1#${tasks.length}:word 50`]);
    expect(speculation.size).toBe(1);
    await session.close();
  });

  it('bounds the utterances speculated on at once', async () => {
    const { session, stt, tasks, speculation, published } = await harness();
    for (let i = 0; i < 3; i++) {
      session.sendAudio(chunk);
      session.commitAudio();
    }
    stt.say(0, 'one');
    stt.say(1, 'two');
    stt.say(2, 'three');
    await flush();
    expect(speculation.size).toBe(2);
    expect(tasks.map((t) => t.signal.aborted)).toEqual([true, false, false]);
    expect(published).toContainEqual({ itemId: 'cascade-user-1', revision: 1, final: false, status: 'cancelled' });
    await session.close();
  });

  it('reports a failed task with its identity, but not one already replaced', async () => {
    const { session, stt, tasks, published } = await harness();
    session.sendAudio(chunk);
    stt.say(0, 'a');
    await flush();
    stt.say(0, 'ab');
    await flush();
    tasks[0]!.done.reject(new Error('stale failure'));
    tasks[1]!.done.reject(new Error('planner down'));
    await flush();
    expect(published.filter((s) => s.status === 'error')).toEqual([{ itemId: 'cascade-user-1', revision: 2, final: false, status: 'error', error: new Error('planner down') }]);
    await session.close();
  });

  it('a task that never returns is cancelled by a retraction and by close; closing twice is harmless', async () => {
    const { session, stt, tasks, speculation, published } = await harness();
    session.sendAudio(chunk);
    stt.say(0, 'hm');
    await flush();
    // Nothing was recognised after all: the utterance is retracted with an empty final.
    session.commitAudio();
    stt.say(0, '', true);
    await flush();
    expect(tasks[0]!.signal.aborted).toBe(true);
    session.sendAudio(chunk);
    stt.say(1, 'something else');
    await flush();
    speculation.close();
    speculation.close();
    expect(tasks.every((t) => t.signal.aborted)).toBe(true);
    expect(speculation.size).toBe(0);
    const count = published.length;
    stt.say(1, 'after close');
    await flush();
    expect(published).toHaveLength(count);
    await session.close();
  });

  it('the final transcript does not promote a preview: the formal request is the app\'s own, re-checked', async () => {
    const { session, stt, tasks, requests, runs } = await harness();
    session.sendAudio(chunk);
    stt.say(0, 'delete chapter two');
    await flush();
    tasks[0]!.done.resolve('would delete chapter 2');
    session.commitAudio();
    stt.say(0, 'delete chapter two', true);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    // The model sees the transcript, never the speculative output, and no tool ran for a preview.
    expect(JSON.stringify(requests[0]!.messages)).not.toContain('would delete');
    expect(runs).not.toHaveBeenCalled();
    await session.close();
  });
});
