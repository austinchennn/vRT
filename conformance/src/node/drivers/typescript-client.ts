import { connect, type ClientSession, type ClientToolContext } from '@vrealtime/client';
import type { Wire } from '../../report.js';
import { control } from './control.js';
import { deferred } from '../deadline.js';

interface Effects { received: boolean; started: number; committed: number; aborted: boolean; completed: number }
let session: ClientSession | undefined;
let epoch = 0;
let started = 0;
let committed = 0;
let blocked: string | undefined;
const calls = new Map<string, Effects>();
const tasks = new Set<Promise<unknown>>();
const release = deferred<'resolve' | 'reject'>();
let released = false;
const results = new Set<string>();
const changed = new Set<() => void>();
const closed = deferred<void>();
function notify(): void { for (const check of [...changed]) check(); }
const wait = (predicate: () => boolean) => new Promise<void>(resolve => {
  const check = () => { if (predicate()) { changed.delete(check); resolve(); } };
  changed.add(check); check();
});
function releaseBlocked(outcome: 'resolve' | 'reject'): void {
  if (released) throw new Error('Blocked call was already released');
  released = true;
  release.resolve(outcome);
}
function probe(context: ClientToolContext): unknown {
  started++;
  const effects = calls.get(context.callId);
  if (!effects) { committed++; return null; } // Original profile remains unchanged.
  effects.started++;
  if (context.callId !== blocked) { effects.committed++; committed++; notify(); return null; }
  const abort = () => { effects.aborted = true; notify(); };
  context.signal.addEventListener('abort', abort, { once: true });
  if (context.signal.aborted) abort();
  const task = (async () => {
    try {
      const outcome = await release.promise;
      // Cooperative application commit gate; it cannot prove SDK non-execution.
      if (!context.signal.aborted) { effects.committed++; committed++; }
      if (outcome === 'reject') throw new Error('Controlled late application rejection');
      return { completed: true };
    } finally {
      effects.completed++;
      context.signal.removeEventListener('abort', abort);
      notify();
    }
  })();
  tasks.add(task);
  void task.then(() => tasks.delete(task), () => tasks.delete(task));
  notify();
  return task;
}
async function drain(): Promise<void> {
  await Promise.allSettled([...tasks]);
  // Event-loop fence, not a timed sleep: flush SDK continuations attached to tasks.
  await new Promise<void>(resolve => setImmediate(resolve));
}
async function close(): Promise<void> {
  if (!session) return;
  await session.close();
  if (!released) releaseBlocked('resolve');
  await drain();
  await closed.promise;
}
function effects(): Wire { return { started, committed, calls: Object.fromEntries(calls) }; }
control(async (command, data) => {
  switch (command) {
    case 'ready':
      session = await connect(process.env.VRT_CONFORMANCE_URL!, {
        reconnect: false, audio: false,
        tools: { probe: { description: 'Counts tool starts and effects', parameters: { type: 'object' }, run: (_args, context) => probe(context) } },
      });
      session.on('state', e => { epoch = e.epoch; notify(); });
      session.on('tool.call', e => { const entry = calls.get(e.callId); if (entry) entry.received = true; notify(); });
      session.on('tool.result', e => { results.add(e.callId); notify(); });
      session.on('closed', () => closed.resolve());
      return { capabilities: [...session.capabilities], driverCapabilities: ['tool-cancellation-v1'] };
    case 'observe': await wait(() => epoch === data.epoch); return {};
    case 'prepareCancellation': {
      if (blocked || !Array.isArray(data.callIds) || data.callIds.length !== 3 ||
          !data.callIds.every((id: unknown) => typeof id === 'string') ||
          new Set(data.callIds).size !== 3 || !data.callIds.includes(data.blockedCallId)) throw new Error('Invalid preparation');
      blocked = data.blockedCallId;
      for (const id of data.callIds) calls.set(id, { received: false, started: 0, committed: 0, aborted: false, completed: 0 });
      return {};
    }
    case 'waitForCall': {
      const entry = calls.get(data.callId);
      if (!entry || !['received', 'started', 'aborted'].includes(data.phase)) throw new Error('Unknown call/phase');
      await wait(() => data.phase === 'received' ? entry.received : data.phase === 'started' ? entry.started > 0 : entry.aborted);
      return {};
    }
    case 'interrupt': session!.interrupt(); return {};
    case 'releaseCall':
      if (data.callId !== blocked || !['resolve', 'reject'].includes(data.outcome)) throw new Error('Unknown release');
      releaseBlocked(data.outcome); await drain(); return {};
    case 'finish': {
      const ids = data.callIds ?? (data.callId ? [data.callId] : []);
      await wait(() => ids.every((id: string) => results.has(id)));
      await drain(); await close();
      // Preserve the original finish data shape for original-profile drivers/tests.
      return blocked ? effects() : { started, committed };
    }
    case 'readEffects': return effects();
    case 'close': await close(); return {};
    default: throw new Error(`Unknown command ${command}`);
  }
}, close);
