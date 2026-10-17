import type { Wire } from '../report.js';
import type { Oracle } from '../oracle.js';
import type { ProcessDriver } from './process-driver.js';
import type { Peer } from './ws-peer.js';

export const CANCELLATION_PROFILE = 'tool-cancellation-v1';
export const CANCELLATION_CASES = [
  'client/cancellation/queued-running',
  'client/cancellation/late-rejection',
];

export class IncompleteDriver extends Error {}

/** A running, B observed queued, C delivered after the local interrupt fence. */
export async function cancellation(
  peer: Peer, driver: ProcessDriver, oracle: Oracle, info: Wire,
  end: number, rejection: boolean, stage: (value: string) => void,
): Promise<Wire> {
  if (!Array.isArray(info.driverCapabilities) || !info.driverCapabilities.includes(CANCELLATION_PROFILE)) {
    throw new IncompleteDriver('Driver does not advertise tool-cancellation-v1 instrumentation');
  }
  const ids: [string, string, string] = ['cancel-A', 'cancel-B', 'cancel-C'];
  const [a, b, c] = ids;
  const epoch = 1;
  stage('prepare cancellation');
  await driver.request('prepareCancellation', { callIds: ids, blockedCallId: a }, end);
  peer.send({ v: 1, seq: 1, type: 'turn.state', turnId: 'cancel-turn', epoch, state: 'thinking' });
  await driver.request('observe', { epoch }, end);
  const sendCall = (callId: string, seq: number) => peer.send({
    v: 1, seq, type: 'tool.call', callId, epoch, turnId: 'cancel-turn', name: 'probe', arguments: {},
  });
  stage('A running'); sendCall(a, 2);
  await driver.request('waitForCall', { callId: a, phase: 'started' }, end);
  stage('B received while A blocked'); sendCall(b, 3);
  await driver.request('waitForCall', { callId: b, phase: 'received' }, end);
  oracle.queued(await driver.request('readEffects', {}, end), ids);
  stage('local cancellation signal');
  await driver.request('interrupt', {}, end);
  await peer.expect(m => m.type === 'interrupt' && m.epoch === epoch, end, 'wire interrupt');
  await driver.request('waitForCall', { callId: a, phase: 'aborted' }, end);
  stage('C after interrupt'); sendCall(c, 4);
  await driver.request('waitForCall', { callId: c, phase: 'received' }, end);
  // §7.2 permits A's INTERRUPTED result after A finishes. Do not wait for that
  // result before releasing A, or a conforming deferred-settlement SDK deadlocks.
  stage('release A after cancellation');
  await driver.request('releaseCall', { callId: a, outcome: rejection ? 'reject' : 'resolve' }, end);
  stage('completion and close fence');
  const effects = await driver.request('finish', { callIds: ids }, end);
  await peer.closed(end);
  stage('cancellation oracle');
  oracle.baseline('client', peer.messages);
  oracle.cancelled(peer.messages, effects, ids, epoch);
  return { driverCapabilities: info.driverCapabilities, effects, logicalResults: ids.length, releasedAs: rejection ? 'rejection' : 'success', wireFrames: peer.messages.length };
}
