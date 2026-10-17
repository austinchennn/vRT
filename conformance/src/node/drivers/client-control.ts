import { setImmediate } from 'node:timers/promises';
import { connect } from '@vrealtime/client';
import { deferred } from '../deadline.js';
import type { Wire } from '../../report.js';

/** Ready confirms public subscriptions are installed, before runner injects invalid frames. */
export async function controlClient(url: string) {
  const errors: Wire[] = []; const events: Wire[] = [];
  const didClose = deferred<void>();
  const changed = new Set<() => void>();
  let started = 0; let committed = 0; let prepared = false; let closed = false;
  let failure: Error | undefined;
  const notify = () => { for (const check of [...changed]) check(); };
  function append(list: Wire[], event: Wire, limit: number): void {
    if (list.length >= limit) failure = new Error('Control observation bound exceeded');
    else list.push(event);
    notify();
  }
  const session = await connect(url, { reconnect: false, audio: false, tools: {
    probe: { parameters: { type: 'object' }, run: () => { started++; committed++; notify(); return null; } },
  } });
  session.on('error', event => append(errors, { code: event.code, recoverable: event.recoverable }, 64));
  session.on('state', event => append(events, { type: 'state', epoch: event.epoch, turnId: event.turnId, state: event.state }, 128));
  session.on('tool.call', event => append(events, { type: 'tool.call', callId: event.callId, turnId: event.turnId, epoch: event.epoch }, 128));
  session.on('tool.result', event => append(events, { type: 'tool.result', callId: event.callId, turnId: event.turnId, epoch: event.epoch }, 128));
  session.on('transcript', event => append(events, { ...event }, 128));
  for (const type of ['text', 'tool.preview', 'interrupted'] as const) session.on(type, event => append(events, { ...event }, 128));
  session.on('closed', () => { closed = true; didClose.resolve(); notify(); });
  const snapshot = (): Wire => {
    if (failure) throw failure;
    return { errors: errors.map(event => ({ ...event })), events: events.map(event => ({ ...event })), started, committed, closed };
  };
  const wait = (predicate: () => boolean) => new Promise<void>((resolve, reject) => {
    const check = () => {
      if (failure || closed) { changed.delete(check); reject(failure ?? new Error('Client closed during observation')); }
      else if (predicate()) { changed.delete(check); resolve(); }
    };
    changed.add(check); check();
  });
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => { await session.close(); await didClose.promise; await setImmediate(); })();
  async function handle(command: string, data: Wire): Promise<Wire> {
    if (command === 'prepareControl') {
      if (prepared) throw new Error('Repeated control preparation');
      prepared = true; return snapshot();
    }
    if (!prepared) throw new Error('Prepare control observations first');
    if (command === 'waitControlErrors') {
      if (!Number.isInteger(data.count) || data.count < 1 || data.count > 64) throw new Error('Invalid error count');
      await wait(() => errors.length >= data.count); return snapshot();
    }
    if (command === 'waitControlMarker') {
      if (typeof data.itemId !== 'string') throw new Error('Invalid marker');
      await wait(() => events.some(event => event.type === 'transcript' && event.itemId === data.itemId)); return snapshot();
    }
    if (command === 'interrupt') { session.interrupt(); return {}; }
    if (command === 'finishControl') { await setImmediate(); await close(); return snapshot(); }
    throw new Error(`Unknown control-validation command ${command}`);
  }
  return { handle, close, capabilities: [...session.capabilities] };
}
