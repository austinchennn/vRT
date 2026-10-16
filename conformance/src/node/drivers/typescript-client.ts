import { connect, type ClientSession } from '@vrealtime/client';
import { control } from './control.js';
import { deferred } from '../deadline.js';

let session: ClientSession | undefined;
let epoch = 0;
let started = 0; let committed = 0;
const results = new Set<string>();
const changed = new Set<() => void>();
const closed = deferred<void>();
const wait = (predicate: () => boolean) => new Promise<void>(resolve => {
  const check = () => { if (predicate()) { changed.delete(check); resolve(); } };
  changed.add(check); check();
});
async function close(): Promise<void> {
  if (!session) return;
  await session.close(); await closed.promise;
}
control(async (command, data) => {
  switch (command) {
    case 'ready':
      session = await connect(process.env.VRT_CONFORMANCE_URL!, {
        reconnect: false, audio: false,
        tools: { probe: { description: 'Counts tool starts and effects', parameters: { type: 'object' }, run: () => { started++; committed++; return null; } } },
      });
      session.on('state', e => { epoch = e.epoch; for (const check of [...changed]) check(); });
      session.on('tool.result', e => { results.add(e.callId); for (const check of [...changed]) check(); });
      session.on('closed', () => closed.resolve());
      return { capabilities: [...session.capabilities] };
    case 'observe': await wait(() => epoch === data.epoch); return {};
    case 'interrupt': session!.interrupt(); return {};
    case 'finish':
      if (data.callId) await wait(() => results.has(data.callId));
      await close(); return { started, committed };
    case 'readEffects': return { started, committed };
    case 'close': await close(); return {};
    default: throw new Error(`Unknown command ${command}`);
  }
}, close);
