import { describe, expect, it, vi } from 'vitest';
import { fakeModel, type CapabilityOverrides, type FakeSession } from '@vrealtime/testing';
import { defineAgent, startSession, tool, type AgentEvent, type AgentSession, type Hooks, type Tool, type ToolResult } from '../src/index.js';

const pcm = { encoding: 'pcm16', sampleRate: 24000, channels: 1 } as const;
const audio = (ms: number) => ({ data: new Uint8Array(48 * ms), format: pcm });
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface Setup {
  tools?: Record<string, Tool<never, unknown>>;
  hooks?: Hooks;
  capabilities?: CapabilityOverrides;
  clientTools?: string[];
  clientToolTimeoutMs?: number;
}

async function setup(options: Setup = {}) {
  const model = fakeModel(options.capabilities ? { capabilities: options.capabilities } : {});
  const agent = defineAgent({
    model,
    instructions: 'test',
    clientTools: 'accept',
    ...(options.tools ? { tools: options.tools } : {}),
    ...(options.hooks ? { hooks: options.hooks } : {}),
    ...(options.clientToolTimeoutMs !== undefined ? { clientToolTimeoutMs: options.clientToolTimeoutMs } : {}),
  });
  const session = await startSession(agent, {
    clock: model.clock,
    clientTools: (options.clientTools ?? []).map((name) => ({ name, description: name, parameters: {} })),
  });
  const fake = model.session;
  const events: AgentEvent[] = [];
  for (const type of ['turn.state', 'transcript', 'text', 'audio', 'tool.call', 'tool.result', 'tool.preview', 'interrupted', 'error'] as const) {
    session.on(type, (event) => events.push(event));
  }
  const ofType = <T extends AgentEvent['type']>(type: T) => events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type);
  return { model, session, fake, events, ofType, clock: model.clock };
}

/** User speaks, then the model starts response `id`. */
function userTurn(fake: FakeSession, id = 'r1') {
  fake.emit({ type: 'input.speech.start', atMs: 0 });
  fake.emit({ type: 'input.speech.end', atMs: 500 });
  fake.emit({ type: 'response.start', responseId: id });
}

function speak(fake: FakeSession, responseId: string, itemId: string, ms: number, text = '') {
  fake.emit({ type: 'output.audio', responseId, itemId, chunk: audio(ms) });
  if (text) fake.emit({ type: 'output.transcript', responseId, itemId, delta: text });
}

function call(fake: FakeSession, responseId: string, callId: string, name: string, args: unknown = {}) {
  fake.emit({ type: 'tool.call', responseId, callId, name, arguments: args });
}

const results = (fake: FakeSession) => Object.fromEntries(fake.commandsOf('submitToolResult').map((c) => [c.callId, c.output]));

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('turn state machine', () => {
  it('walks idle → listening → thinking → speaking → idle', async () => {
    const { fake, ofType, session } = await setup();
    userTurn(fake);
    speak(fake, 'r1', 'a1', 20, 'Hello');
    fake.emit({ type: 'response.end', responseId: 'r1', status: 'done' });
    expect(ofType('turn.state').map((e) => e.state)).toEqual(['listening', 'thinking', 'speaking', 'idle']);
    expect(session.state).toBe('idle');
    expect(ofType('transcript').at(-1)).toEqual({ type: 'transcript', role: 'agent', itemId: 'a1', text: 'Hello', final: true });
  });

  it('sendText starts a turn, sends text and requests a response', async () => {
    const { fake, session } = await setup();
    session.sendText('hi');
    expect(session.state).toBe('thinking');
    expect(fake.commands.slice(1).map((c) => c.type)).toEqual(['sendText', 'respond']);
  });

  it('commitAudio commits and requests a response', async () => {
    const { fake, session } = await setup({ capabilities: { turnDetection: { server: false } } });
    session.commitAudio();
    expect(fake.commands.slice(1).map((c) => c.type)).toEqual(['commitAudio', 'respond']);
  });

  it('epoch increases on every turn and every interruption', async () => {
    const { fake, session } = await setup();
    const start = session.epoch;
    userTurn(fake);
    const turnEpoch = session.epoch;
    expect(turnEpoch).toBeGreaterThan(start);
    session.interrupt();
    expect(session.epoch).toBeGreaterThan(turnEpoch);
  });
});

describe('server tools', () => {
  it('runs calls, submits results and fills in respond() when the model will not', async () => {
    const run = vi.fn(async ({ city }: { city: string }) => `sunny in ${city}`);
    const { fake, session, ofType } = await setup({
      tools: { weather: tool({ description: 'w', parameters: {}, run }) as Tool<never, unknown> },
      capabilities: { tools: { autoReplyAfterResult: false } },
    });
    userTurn(fake);
    call(fake, 'r1', 'c1', 'weather', { city: 'Paris' });
    expect(session.state).toBe('acting');
    fake.emit({ type: 'response.end', responseId: 'r1', status: 'done' });
    await flush();
    expect(results(fake)).toEqual({ c1: 'sunny in Paris' });
    expect(fake.commandsOf('submitToolResult')[0]!.options).toEqual({ respond: false });
    expect(fake.commandsOf('respond')).toHaveLength(1);
    expect(session.state).toBe('thinking');
    expect(ofType('tool.result')[0]!.result).toEqual({ ok: true, output: 'sunny in Paris' });
  });

  it('does not call respond() when the model auto-replies', async () => {
    const { fake } = await setup({ tools: { t: tool({ description: '', parameters: {}, run: () => 1 }) as Tool<never, unknown> } });
    userTurn(fake);
    call(fake, 'r1', 'c1', 't');
    fake.emit({ type: 'response.end', responseId: 'r1', status: 'done' });
    await flush();
    expect(results(fake)).toEqual({ c1: 1 });
    expect(fake.commandsOf('respond')).toHaveLength(0);
  });

  it('waits for every call of a response before replying, and runs them in order', async () => {
    const order: string[] = [];
    const first = deferred();
    const { fake } = await setup({
      capabilities: { tools: { autoReplyAfterResult: false } },
      tools: {
        a: tool({ description: '', parameters: {}, run: async () => { order.push('a:start'); await first.promise; order.push('a:end'); } }) as Tool<never, unknown>,
        b: tool({ description: '', parameters: {}, run: () => { order.push('b'); } }) as Tool<never, unknown>,
      },
    });
    userTurn(fake);
    call(fake, 'r1', 'c1', 'a');
    call(fake, 'r1', 'c2', 'b');
    fake.emit({ type: 'response.end', responseId: 'r1', status: 'done' });
    await flush();
    expect(order).toEqual(['a:start']);
    expect(fake.commandsOf('respond')).toHaveLength(0);
    first.resolve();
    await flush();
    expect(order).toEqual(['a:start', 'a:end', 'b']);
    expect(fake.commandsOf('respond')).toHaveLength(1);
  });

  it('maps unknown tools, throwing tools and invalid arguments to error results', async () => {
    const { fake } = await setup({
      tools: {
        boom: tool({ description: '', parameters: {}, run: () => { throw new Error('kaput'); } }) as Tool<never, unknown>,
        strict: tool({
          description: '', parameters: {}, run: () => 'ran',
          validate: { '~standard': { version: 1, vendor: 't', validate: () => ({ issues: [{ message: 'bad' }] }) } },
        }) as Tool<never, unknown>,
      },
    });
    userTurn(fake);
    call(fake, 'r1', 'c1', 'nope');
    call(fake, 'r1', 'c2', 'boom');
    call(fake, 'r1', 'c3', 'strict');
    await flush();
    expect(results(fake)).toEqual({
      c1: { error: { code: 'FAILED', message: 'Unknown tool: nope' } },
      c2: { error: { code: 'FAILED', message: 'kaput' } },
      c3: { error: { code: 'INVALID', message: 'bad' } },
    });
  });

  it('streams previews from context.emit', async () => {
    const { fake, ofType } = await setup({
      tools: { t: tool({ description: '', parameters: {}, run: (_args, ctx) => { ctx.emit({ step: 1 }); } }) as Tool<never, unknown> },
    });
    userTurn(fake);
    call(fake, 'r1', 'c1', 't');
    await flush();
    expect(ofType('tool.preview')).toMatchObject([{ callId: expect.any(String), name: 't', preview: { step: 1 } }]);
  });
});

describe('hooks', () => {
  it('beforeToolCall can reject or rewrite', async () => {
    const run = vi.fn((args: { n: number }) => args.n);
    const { fake } = await setup({
      tools: { t: tool({ description: '', parameters: {}, run, risk: 'high' }) as Tool<never, unknown> },
      hooks: {
        beforeToolCall: async (info) => {
          expect(info.risk).toBe('high');
          return (info.arguments as { n: number }).n < 0 ? { action: 'reject', message: 'negative' } : { action: 'rewrite', arguments: { n: 42 } };
        },
      },
    });
    userTurn(fake);
    call(fake, 'r1', 'c1', 't', { n: -1 });
    call(fake, 'r1', 'c2', 't', { n: 1 });
    await flush();
    expect(results(fake)).toEqual({ c1: { error: { code: 'REJECTED', message: 'negative' } }, c2: 42 });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('reports turn start/end, transcripts, tool results and metrics', async () => {
    const hooks = { onTurnStart: vi.fn(), onTurnEnd: vi.fn(), onTranscript: vi.fn(), afterToolCall: vi.fn(), onError: vi.fn() };
    const { fake, clock } = await setup({ hooks, tools: { t: tool({ description: '', parameters: {}, run: () => 'x' }) as Tool<never, unknown> } });
    fake.emit({ type: 'input.speech.start', atMs: 0 });
    fake.emit({ type: 'input.speech.end', atMs: 0 });
    fake.emit({ type: 'input.transcript', itemId: 'u1', text: 'hello', final: true });
    clock.advance(120);
    fake.emit({ type: 'response.start', responseId: 'r1' });
    call(fake, 'r1', 'c1', 't');
    clock.advance(200);
    speak(fake, 'r1', 'a1', 20);
    fake.emit({ type: 'response.end', responseId: 'r1', status: 'done' });
    await flush();
    fake.emit({ type: 'response.start', responseId: 'r2' });
    fake.emit({ type: 'response.end', responseId: 'r2', status: 'done' });
    fake.emit({ type: 'error', error: new Error('x'), recoverable: true });
    expect(hooks.onTurnStart).toHaveBeenCalledTimes(1);
    expect(hooks.onTranscript).toHaveBeenCalledWith('hello', true, expect.objectContaining({ id: expect.any(String) }));
    expect(hooks.afterToolCall).toHaveBeenCalledWith(expect.objectContaining({ callId: expect.any(String), where: 'server' }), { ok: true, output: 'x' });
    expect(hooks.onTurnEnd).toHaveBeenCalledWith(expect.objectContaining({ interrupted: false }), { toolCalls: 1, timeToFirstToolCallMs: 120, timeToFirstAudioMs: 320 });
    expect(hooks.onError).toHaveBeenCalledWith(new Error('x'), true);
  });

  it('a throwing hook surfaces as an error event without breaking the session', async () => {
    const { fake, ofType, session } = await setup({ hooks: { onTurnStart: () => { throw new Error('hook'); } } });
    userTurn(fake);
    expect(ofType('error')[0]!.error.message).toBe('hook');
    expect(session.state).toBe('thinking');
  });
});

describe('interrupt guarantees', () => {
  const states = ['listening', 'thinking', 'speaking', 'acting'] as const;

  for (const state of states) {
    for (const via of ['speech', 'client'] as const) {
      it(`interrupting while ${state} via ${via} leaves no live work behind`, async () => {
        const run = vi.fn(async (_a: unknown, ctx: { signal: AbortSignal }) => new Promise((_r, reject) => ctx.signal.addEventListener('abort', () => reject(new Error('aborted')))));
        const { fake, session, ofType, events } = await setup({ tools: { slow: tool({ description: '', parameters: {}, run }) as Tool<never, unknown> } });
        fake.emit({ type: 'input.speech.start', atMs: 0 });
        if (state !== 'listening') {
          fake.emit({ type: 'input.speech.end', atMs: 0 });
          fake.emit({ type: 'response.start', responseId: 'r1' });
        }
        if (state === 'speaking') speak(fake, 'r1', 'a1', 20, 'hi');
        if (state === 'acting') call(fake, 'r1', 'c1', 'slow');
        await flush();
        expect(session.state).toBe(state);
        const epoch = session.epoch;

        if (via === 'speech') fake.emit({ type: 'input.speech.start', atMs: 1 });
        else session.interrupt('user');

        if (state === 'listening') {
          expect(ofType('interrupted')).toHaveLength(0);
          return;
        }
        expect(ofType('interrupted')).toEqual([{ type: 'interrupted', epoch, reason: via === 'speech' ? 'speech' : 'user' }]);
        expect(session.epoch).toBeGreaterThan(epoch);
        // Server VAD cancels by itself; client interrupts must cancel explicitly.
        expect(fake.commandsOf('cancel')).toHaveLength(via === 'speech' ? 0 : 1);
        if (state === 'acting') {
          expect(results(fake)).toEqual({ c1: { error: { code: 'INTERRUPTED', message: `Interrupted by ${via === 'speech' ? 'speech' : 'user'}` } } });
        }
        // Stale output from the cancelled response is dropped.
        const before = events.length;
        speak(fake, 'r1', 'a1', 20, 'late');
        call(fake, 'r1', 'c9', 'slow');
        await flush();
        expect(events.slice(before).filter((e) => e.type === 'audio' || e.type === 'text')).toEqual([]);
        expect(results(fake)['c9']).toEqual({ error: { code: 'INTERRUPTED', message: 'Issued by an interrupted turn' } });
        expect(run).toHaveBeenCalledTimes(state === 'acting' ? 1 : 0);
      });
    }
  }

  it('queued calls of an interrupted epoch never start; a running one is aborted; each gets one result', async () => {
    const started: string[] = [];
    let signal: AbortSignal | undefined;
    const gate = deferred();
    const { fake, session } = await setup({
      tools: {
        slow: tool({ description: '', parameters: {}, run: async (_a, ctx) => { started.push('slow'); signal = ctx.signal; await gate.promise; return 'late'; } }) as Tool<never, unknown>,
        fast: tool({ description: '', parameters: {}, run: () => { started.push('fast'); } }) as Tool<never, unknown>,
      },
    });
    userTurn(fake);
    call(fake, 'r1', 'c1', 'slow');
    call(fake, 'r1', 'c2', 'fast');
    await flush();
    session.interrupt();
    gate.resolve();
    await flush();
    expect(started).toEqual(['slow']);
    expect(signal?.aborted).toBe(true);
    expect(fake.commandsOf('submitToolResult').map((c) => c.callId)).toEqual(['c1', 'c2']);
    expect(Object.values(results(fake)).every((r) => (r as { error: { code: string } }).error.code === 'INTERRUPTED')).toBe(true);
  });

  it('an interruption during an async beforeToolCall keeps the call from starting', async () => {
    const approval = deferred<void>();
    const run = vi.fn();
    const { fake, session } = await setup({
      tools: { t: tool({ description: '', parameters: {}, run }) as Tool<never, unknown> },
      hooks: { beforeToolCall: () => approval.promise },
    });
    userTurn(fake);
    call(fake, 'r1', 'c1', 't');
    await flush();
    session.interrupt();
    approval.resolve();
    await flush();
    expect(run).not.toHaveBeenCalled();
    expect(fake.commandsOf('submitToolResult')).toHaveLength(1);
  });

  it('a running async tool survives the interruption and delivers later', async () => {
    const gate = deferred();
    const { fake, session } = await setup({
      capabilities: { tools: { autoReplyAfterResult: false } },
      tools: {
        bg: tool({ description: '', parameters: {}, async: true, run: async (_a, ctx) => { await gate.promise; return ctx.signal.aborted ? 'aborted' : 'done'; } }) as Tool<never, unknown>,
      },
    });
    userTurn(fake);
    call(fake, 'r1', 'c1', 'bg');
    await flush();
    session.interrupt();
    expect(fake.commandsOf('submitToolResult')).toHaveLength(0);
    const respondsBefore = fake.commandsOf('respond').length;
    gate.resolve();
    await flush();
    expect(results(fake)).toEqual({ c1: 'done' });
    expect(fake.commandsOf('respond').length).toBe(respondsBefore + 1);
  });

  it('an interruption before the response starts discards that response', async () => {
    const { fake, session, ofType } = await setup();
    session.sendText('hi');
    session.interrupt('keyboard');
    fake.emit({ type: 'response.start', responseId: 'r1' });
    speak(fake, 'r1', 'a1', 20);
    expect(fake.commandsOf('cancel')).toHaveLength(1);
    expect(ofType('audio')).toHaveLength(0);
  });

  it('handles a model that ends its response synchronously inside cancel()', async () => {
    const { fake, session } = await setup({
      clientTools: ['paint'],
      capabilities: {},
    });
    // Models like Gemini and cascade cannot defer: response.end arrives during cancel().
    const cancel = fake.cancel.bind(fake);
    fake.cancel = () => {
      cancel();
      fake.emit({ type: 'response.end', responseId: 'r1', status: 'cancelled' });
    };
    userTurn(fake);
    speak(fake, 'r1', 'a1', 1000, 'Hello there');
    call(fake, 'r1', 'c1', 'paint');
    await flush();
    session.playback('a1', 400);
    session.interrupt();
    expect(fake.commandsOf('truncate')).toEqual([{ type: 'truncate', itemId: 'a1', audioEndMs: 400 }]);
    expect(results(fake)['c1']).toMatchObject({ error: { code: 'INTERRUPTED' } });
    expect(session.state).toBe('idle');
  });

  it('a provider-side cancel is handled as an interruption', async () => {
    const { fake, session, ofType } = await setup({ tools: { t: tool({ description: '', parameters: {}, run: () => new Promise(() => {}) }) as Tool<never, unknown> } });
    userTurn(fake);
    call(fake, 'r1', 'c1', 't');
    await flush();
    fake.emit({ type: 'response.end', responseId: 'r1', status: 'cancelled' });
    expect(ofType('interrupted')).toHaveLength(1);
    expect(results(fake)['c1']).toMatchObject({ error: { code: 'INTERRUPTED' } });
    expect(session.state).toBe('idle');
  });
});

describe('truncation', () => {
  it('truncates to the played milliseconds the edge reports, including late reports', async () => {
    const { fake, session } = await setup();
    userTurn(fake);
    speak(fake, 'r1', 'a1', 1000, 'Hello there world');
    session.playback('a1', 300);
    session.interrupt();
    session.playback('a1', 450);
    expect(fake.commandsOf('truncate')).toEqual([
      { type: 'truncate', itemId: 'a1', audioEndMs: 300 },
      { type: 'truncate', itemId: 'a1', audioEndMs: 450 },
    ]);
  });

  it('forgets the oldest interrupted items, so only recent late reports truncate', async () => {
    const { fake, session } = await setup();
    // One more than the session keeps.
    for (let i = 1; i <= 17; i++) {
      userTurn(fake, `r${i}`);
      speak(fake, `r${i}`, `a${i}`, 1000, 'Hello there world');
      session.playback(`a${i}`, 100);
      session.interrupt();
    }
    const before = fake.commandsOf('truncate').length;
    session.playback('a1', 450);
    expect(fake.commandsOf('truncate')).toHaveLength(before);
    session.playback('a2', 450);
    session.playback('a17', 450);
    expect(fake.commandsOf('truncate').slice(before)).toEqual([
      { type: 'truncate', itemId: 'a2', audioEndMs: 450 },
      { type: 'truncate', itemId: 'a17', audioEndMs: 450 },
    ]);
  });

  it('never truncates past the audio received', async () => {
    const { fake, session } = await setup();
    userTurn(fake);
    speak(fake, 'r1', 'a1', 100);
    session.playback('a1', 5000);
    session.interrupt();
    expect(fake.commandsOf('truncate')[0]!.audioEndMs).toBe(100);
  });

  it('rewrites the local transcript when the model cannot truncate', async () => {
    const { fake, session, ofType } = await setup({ capabilities: { truncate: false } });
    userTurn(fake);
    speak(fake, 'r1', 'a1', 1000, '0123456789');
    session.playback('a1', 300);
    session.interrupt();
    session.playback('a1', 500);
    expect(fake.commandsOf('truncate')).toHaveLength(0);
    expect(session.transcript.find((t) => t.itemId === 'a1')).toEqual({ role: 'agent', itemId: 'a1', text: '01234', truncated: true });
    expect(ofType('transcript').filter((t) => t.final).map((t) => t.text)).toEqual(['012', '01234']);
  });

  describe('audio still playing after its response ended', () => {
    /** Models generate far faster than real time: 20 s of audio, done long before it is heard. */
    async function heardLater(options: Setup = {}) {
      const harness = await setup(options);
      userTurn(harness.fake);
      speak(harness.fake, 'r1', 'a1', 20000, '0123456789');
      harness.fake.emit({ type: 'response.end', responseId: 'r1', status: 'done' });
      expect(harness.session.state).toBe('idle');
      return harness;
    }

    it('truncates it when the user talks over it', async () => {
      const { fake, session, ofType } = await heardLater();
      const epoch = session.epoch;
      fake.emit({ type: 'input.speech.start', atMs: 0 });
      session.playback('a1', 3500);
      expect(fake.commandsOf('truncate')).toEqual([{ type: 'truncate', itemId: 'a1', audioEndMs: 3500 }]);
      expect(session.transcript.find((t) => t.itemId === 'a1')).toEqual({ role: 'agent', itemId: 'a1', text: '01', truncated: true });
      expect(ofType('transcript').filter((t) => t.final).map((t) => t.text)).toEqual(['0123456789', '01']);
      // Nothing was in flight: no epoch is closed and only the new turn moves it.
      expect(ofType('interrupted')).toHaveLength(0);
      expect(session.epoch).toBe(epoch + 1);
      expect(session.state).toBe('listening');
    });

    it('rewrites the local transcript when the model cannot truncate', async () => {
      const { fake, session } = await heardLater({ capabilities: { truncate: false } });
      fake.emit({ type: 'input.speech.start', atMs: 0 });
      session.playback('a1', 10000);
      expect(fake.commandsOf('truncate')).toHaveLength(0);
      expect(session.transcript.find((t) => t.itemId === 'a1')).toMatchObject({ text: '01234', truncated: true });
    });

    for (const via of ['interrupt', 'sendText'] as const) {
      it(`truncates it after ${via}`, async () => {
        const { fake, session, ofType } = await heardLater();
        if (via === 'interrupt') session.interrupt('user');
        else session.sendText('wait');
        session.playback('a1', 3500);
        expect(fake.commandsOf('truncate')).toEqual([{ type: 'truncate', itemId: 'a1', audioEndMs: 3500 }]);
        expect(ofType('interrupted')).toHaveLength(0);
      });
    }

    it('applies a report that arrived before the user took the floor', async () => {
      const { fake, session } = await heardLater();
      session.playback('a1', 3500);
      expect(fake.commandsOf('truncate')).toHaveLength(0);
      fake.emit({ type: 'input.speech.start', atMs: 0 });
      expect(fake.commandsOf('truncate')).toEqual([{ type: 'truncate', itemId: 'a1', audioEndMs: 3500 }]);
    });

    it('leaves audio that was heard in full alone, and forgets it', async () => {
      const { fake, session } = await heardLater();
      fake.emit({ type: 'input.speech.start', atMs: 0 });
      session.playback('a1', 20000);
      session.playback('a1', 3500);
      expect(fake.commandsOf('truncate')).toHaveLength(0);
      expect(session.transcript.find((t) => t.itemId === 'a1')).toEqual({ role: 'agent', itemId: 'a1', text: '0123456789' });
    });

    it('truncates audio of an earlier response of the interrupted turn', async () => {
      const { fake, session } = await setup({ tools: { t: tool({ description: '', parameters: {}, run: () => 1 }) as Tool<never, unknown> } });
      userTurn(fake);
      speak(fake, 'r1', 'a1', 2000, 'Let me check');
      call(fake, 'r1', 'c1', 't');
      fake.emit({ type: 'response.end', responseId: 'r1', status: 'done' });
      await flush();
      fake.emit({ type: 'response.start', responseId: 'r2' });
      speak(fake, 'r2', 'a2', 5000, 'It is sunny');
      fake.emit({ type: 'input.speech.start', atMs: 0 });
      session.playback('a1', 1500);
      expect(fake.commandsOf('truncate')).toEqual([{ type: 'truncate', itemId: 'a1', audioEndMs: 1500 }]);
    });
  });
});

describe('client tools', () => {
  it('forwards client calls with their epoch and submits the app result', async () => {
    const { fake, session, ofType } = await setup({ clientTools: ['paint'] });
    expect(fake.config.tools?.map((t) => t.name)).toEqual(['paint']);
    userTurn(fake);
    call(fake, 'r1', 'c1', 'paint', { color: 'red' });
    await flush();
    const forwarded = ofType('tool.call')[0]!;
    expect(forwarded).toMatchObject({ callId: expect.any(String), name: 'paint', arguments: { color: 'red' }, epoch: session.epoch });
    session.submitClientToolResult(forwarded.callId, { ok: true, output: 'painted' });
    session.submitClientToolResult(forwarded.callId, { ok: true, output: 'twice' });
    expect(results(fake)).toEqual({ c1: 'painted' });
    expect(fake.commandsOf('submitToolResult')).toHaveLength(1);
  });

  it('times out to TIMEOUT', async () => {
    const { fake, session, clock } = await setup({ clientTools: ['paint'], clientToolTimeoutMs: 1000 });
    userTurn(fake);
    call(fake, 'r1', 'c1', 'paint');
    await flush();
    clock.advance(999);
    expect(results(fake)).toEqual({});
    clock.advance(1);
    expect(results(fake)).toEqual({ c1: { error: { code: 'TIMEOUT', message: 'No result within 1000 ms' } } });
    session.submitClientToolResult('c1', { ok: true, output: 'late' });
    expect(fake.commandsOf('submitToolResult')).toHaveLength(1);
  });

  it('interrupting resolves an outstanding client call as INTERRUPTED and ignores its late result', async () => {
    const { fake, session } = await setup({ clientTools: ['paint'] });
    userTurn(fake);
    call(fake, 'r1', 'c1', 'paint');
    call(fake, 'r1', 'c2', 'paint');
    await flush();
    session.interrupt();
    session.submitClientToolResult('c1', { ok: true, output: 'late' } satisfies ToolResult);
    await flush();
    expect(Object.keys(results(fake))).toEqual(['c1', 'c2']);
    expect(results(fake)['c1']).toMatchObject({ error: { code: 'INTERRUPTED' } });
  });

  it('ignores client tools when the agent does not accept them', async () => {
    const model = fakeModel();
    await startSession(defineAgent({ model, instructions: '', clientTools: 'ignore' }), { clientTools: [{ name: 'x', description: '', parameters: {} }] });
    expect(model.session.config.tools).toEqual([]);
  });
});

describe('lifecycle', () => {
  it('close() aborts running tools and closes the model session', async () => {
    let signal: AbortSignal | undefined;
    const { fake, session } = await setup({ tools: { t: tool({ description: '', parameters: {}, run: (_a, ctx) => { signal = ctx.signal; return new Promise(() => {}); } }) as Tool<never, unknown> } });
    userTurn(fake);
    call(fake, 'r1', 'c1', 't');
    await flush();
    await session.close();
    expect(signal?.aborted).toBe(true);
    expect(fake.closed).toBe(true);
    session.sendText('ignored');
    expect(fake.commandsOf('sendText')).toHaveLength(0);
  });
});

void (null as unknown as AgentSession);
