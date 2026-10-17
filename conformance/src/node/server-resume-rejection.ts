import type { Wire } from '../report.js';
import type { Oracle } from '../oracle.js';
import { ackBoundaryReplay, rejectionEffects, resumeRefused } from '../resume-rejection-oracle.js';
import { ResumeFailure } from './server-resume.js';
import { dial, type Peer } from './ws-peer.js';
import type { ProcessDriver } from './process-driver.js';

export async function serverResumeRejection(id: string, first: Peer, url: string, driver: ProcessDriver, oracle: Oracle,
  hello: Wire, end: number, stage: (value: string) => void): Promise<Wire> {
  const kind = id.split('/').at(-1)!;
  const peers = [first]; let failure: unknown; let result: Wire | undefined;
  const traces = () => peers.map(peer => ({ messages: peer.messages, close: peer.closeInfo }));
  const fence = async (peer: Peer, label: string) => {
    stage(label); const offset = peer.messages.length;
    peer.send({ v: 1, seq: 0, type: 'ping' });
    await peer.expect(message => message.type === 'pong', end, label, offset);
  };
  try {
    if (kind === 'unknown') {
      stage('unknown-session hello'); first.send({ ...hello, sessionId: 'conformance-unknown-session', resumeFrom: 0 });
      await first.expect(message => message.type === 'error', end, 'unknown-session rejection');
      stage('unknown-session close'); await first.closed(end);
      await driver.request('waitResumeClosed', { connection: 1 }, end);
      stage('unknown-session oracle'); resumeRefused(oracle, first.messages, first.closeInfo);
      stage('drain unknown-session work'); const effects = await driver.request('finishResume', {}, end);
      rejectionEffects(effects, 0, 1, [1], [], false, 0);
      result = { capabilities: [], effects, connections: traces(), closeFence: true };
    } else {
      stage('new boundary session'); first.send(hello);
      const original = await first.expect(message => message.type === 'ready', end, 'first ready');
      oracle.message('server', original);
      if (original.resumedFrom !== undefined || (original.capabilities ?? []).length) throw new Error('Expected new baseline session');
      stage('retained model history'); await driver.request('emitResume', { markers: ['before', 'retained'] }, end);
      await first.expect(message => message.type === 'transcript' && message.itemId === 'resume-retained', end, 'retained on wire');
      await fence(first, 'history receipt fence');
      oracle.baseline('server', first.messages);
      const history = first.messages.filter(message => message.seq > 0);
      if (history.length !== 2 || ['before', 'retained'].some((marker, index) => {
        const message = history[index]!;
        return message.seq !== index + 1 || message.type !== 'transcript' || message.role !== 'user' || message.itemId !== `resume-${marker}` || message.text !== marker || message.final !== true;
      })) throw new Error('Expected controlled transcript history seq 1,2');
      const ack = kind !== 'ahead';
      if (ack) {
        stage('ACK SDK receipt confirmation'); first.send({ v: 1, seq: 0, type: 'ack', upTo: 1 });
        rejectionEffects(await driver.request('waitResumeAck', { connection: 1, upTo: 1 }, end), 1, 1, [], ['before', 'retained'], true, 0);
      }
      stage('first wire close'); first.socket.close(1000, 'test disconnect'); await first.closed(end);
      stage('first SDK close confirmation'); await driver.request('waitResumeClosed', { connection: 1 }, end);
      stage('recovery connection'); const second = await dial(url, end); peers.push(second);
      const cursor = kind === 'ahead' ? 3 : kind === 'ack-boundary' ? 1 : 0;
      second.send({ ...hello, sessionId: original.sessionId, resumeFrom: cursor });
      let effects: Wire;
      if (kind === 'ack-boundary') {
        stage('boundary ready/replay');
        await second.expect(message => message.type === 'ready', end, 'boundary ready');
        await second.expect(message => message.seq === 2 && message.type === 'transcript', end, 'retained suffix');
        stage('new model marker'); await driver.request('emitResume', { markers: ['after'] }, end);
        await second.expect(message => message.itemId === 'resume-after', end, 'new marker');
        await fence(second, 'boundary completion fence');
        stage('boundary close'); second.socket.close(1000, 'scenario complete'); await second.closed(end);
        await driver.request('waitResumeClosed', { connection: 2 }, end);
        effects = await driver.request('finishResume', {}, end);
        stage('boundary complete oracle'); ackBoundaryReplay(oracle, first.messages, second.messages);
        rejectionEffects(effects, 1, 2, [1, 2], ['before', 'retained', 'after'], true, 0);
      } else {
        stage('recovery failure'); await second.expect(message => message.type === 'error', end, 'RESUME_FAILED');
        stage('failed recovery close'); await second.closed(end);
        await driver.request('waitResumeClosed', { connection: 2 }, end);
        stage('failed recovery oracle'); resumeRefused(oracle, second.messages, second.closeInfo, first.messages);
        // A third connection verifies that failure closed the session, not only its socket.
        stage('closed-session probe'); const probe = await dial(url, end); peers.push(probe);
        probe.send({ ...hello, sessionId: original.sessionId, resumeFrom: 2 });
        await probe.expect(message => message.type === 'error', end, 'closed-session rejection');
        await probe.closed(end); await driver.request('waitResumeClosed', { connection: 3 }, end);
        resumeRefused(oracle, probe.messages, probe.closeInfo);
        effects = await driver.request('finishResume', {}, end);
        rejectionEffects(effects, 1, 3, [1, 2, 3], ['before', 'retained'], ack, 1);
      }
      result = { capabilities: [], sessionId: original.sessionId, processedCursor: cursor, ackBoundary: ack ? 1 : null,
        retention: { acknowledged: 'discard' }, effects, connections: traces(), closeFence: true };
    }
  } catch (error) { failure = error; }
  finally {
    const cleanup = await Promise.allSettled(peers.slice(1).map(peer => peer.dispose()));
    const failed = cleanup.find(item => item.status === 'rejected');
    if (failed?.status === 'rejected') failure = new Error(`Recovery peer cleanup failed: ${String(failed.reason)}; previous: ${String(failure)}`);
  }
  if (failure !== undefined) throw new ResumeFailure(failure instanceof Error ? failure.message : String(failure), traces());
  return result!;
}
