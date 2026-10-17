import type { Wire } from '../report.js';
import type { Oracle } from '../oracle.js';
import { CONTEXT_FIRST, CONTEXT_SECOND, resumeEffects, resumeReady, resumeReplay } from '../resume-oracle.js';
import { dial, type Peer } from './ws-peer.js';
import type { ProcessDriver } from './process-driver.js';
export class ResumeFailure extends Error {
  constructor(message: string, readonly connections: Wire[]) { super(message); }
}

export async function serverResume(id: string, first: Peer, url: string, driver: ProcessDriver, oracle: Oracle,
  hello: Wire, end: number, stage: (value: string) => void): Promise<Wire> {
  const kind = id.split('/').at(-1)!;
  const offline = kind === 'suffix' || kind === 'from-zero' ? ['offline-a', 'offline-b'] : [];
  let second: Peer | undefined; let result: Wire | undefined; let failure: unknown;
  const fence = async (peer: Peer, label: string) => {
    stage(label); const offset = peer.messages.length;
    peer.send({ v: 1, seq: 0, type: 'ping' });
    await peer.expect(message => message.type === 'pong', end, label, offset);
  };
  try {
    stage('new resume session'); first.send(hello);
    const original = await first.expect(message => message.type === 'ready', end, 'first ready');
    oracle.message('server', original);
    if (original.resumedFrom !== undefined || (original.capabilities ?? []).length !== 0) throw new Error('Expected new baseline session');
    stage('first context handled'); first.send({ v: 1, seq: 1, type: 'context', context: CONTEXT_FIRST });
    resumeEffects(await driver.request('waitResumeContext', { count: 1 }, end), [CONTEXT_FIRST], [], 1, []);
    stage('prefix model event'); await driver.request('emitResume', { markers: ['before'] }, end);
    await first.expect(message => message.type === 'transcript' && message.itemId === 'resume-before', end, 'prefix on wire');
    await fence(first, 'prefix receipt fence');
    oracle.baseline('server', first.messages);
    const capturedSeq = Math.max(0, ...first.messages.map(message => message.seq));
    const cursor = kind === 'from-zero' ? 0 : capturedSeq;
    if (kind !== 'replace') {
      stage('first wire close'); first.socket.close(1000, 'test disconnect'); await first.closed(end);
      stage('SDK detach confirmation'); await driver.request('waitResumeClosed', { connection: 1 }, end);
    }
    if (offline.length) {
      stage('offline model events'); await driver.request('emitResume', { markers: offline }, end);
    }
    stage('second connection'); second = await dial(url, end);
    second.send({ ...hello, sessionId: original.sessionId, resumeFrom: cursor });
    const resumed = await second.expect(message => message.type === 'ready' || message.type === 'error', end, 'resume ready');
    oracle.message('server', resumed);
    stage('resume identity/client cursor'); resumeReady(first.messages, second.messages);
    if (kind === 'replace') {
      stage('replaced connection close'); await first.closed(end);
      if (first.closeInfo?.code !== 4000) throw new Error(`Expected replacement close 4000, got ${first.closeInfo?.code}`);
      stage('replacement detach confirmation'); await driver.request('waitResumeClosed', { connection: 1 }, end);
    }
    stage('resumed context deduplication');
    second.send({ v: 1, seq: 1, type: 'context', context: CONTEXT_FIRST });
    second.send({ v: 1, seq: 2, type: 'context', context: CONTEXT_SECOND });
    resumeEffects(await driver.request('waitResumeContext', { count: 2 }, end), [CONTEXT_FIRST, CONTEXT_SECOND], ['before', ...offline], 2, [1]);
    stage('post-resume model marker'); await driver.request('emitResume', { markers: ['after'] }, end);
    await second.expect(message => message.type === 'transcript' && message.itemId === 'resume-after', end, 'new sequenced marker');
    await fence(second, 'resumed live fence');
    stage('second wire close'); second.socket.close(1000, 'scenario complete'); await second.closed(end);
    stage('second SDK close confirmation'); await driver.request('waitResumeClosed', { connection: 2 }, end);
    stage('drain resume work'); const effects = await driver.request('finishResume', {}, end);
    stage('complete resume oracle');
    oracle.baseline('server', [...first.messages, ...second.messages]);
    resumeReplay(first.messages, second.messages, cursor, offline);
    resumeEffects(effects, [CONTEXT_FIRST, CONTEXT_SECOND], ['before', ...offline, 'after'], 2, [1, 2]);
    result = { capabilities: [], sessionId: original.sessionId, capturedSeq, processedCursor: cursor, resumedFrom: 1, offlineMarkers: offline,
      effects, connections: [first, second].map(peer => ({ messages: peer.messages, close: peer.closeInfo })), closeFence: true };
  } catch (error) { failure = error; }
  finally {
    try { await second?.dispose(); }
    catch (error) { failure = new Error(`Second peer cleanup failed: ${String(error)}; previous: ${String(failure)}`); }
  }
  if (failure !== undefined) throw new ResumeFailure(failure instanceof Error ? failure.message : String(failure), [first, ...(second ? [second] : [])].map(peer => ({ messages: peer.messages, close: peer.closeInfo })));
  return result!;
}
