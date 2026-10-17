import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Wire } from '../report.js';
import type { Oracle } from '../oracle.js';
import { CONTROL_PROFILE, CONTROL_CALL, CONTROL_TURN, CONTROL_MARKER, IncompleteControl, controlEffects, controlResult } from '../client-control-oracle.js';
import type { Peer } from './ws-peer.js';
import type { ProcessDriver } from './process-driver.js';

export function controlVectors(directory: string, kind: string): Wire[] {
  const shared: Wire[] = JSON.parse(readFileSync(join(directory, 'examples/server/envelope.json'), 'utf8')).cases.filter((item: Wire) => !item.valid);
  const groups: Record<string, Wire[]> = {
    framing: shared.filter(item => item.error === 'MALFORMED').concat(['null', '[]', 'true', '"text"'].map(raw => ({ id: `local/framing/${raw}`, raw, error: 'MALFORMED' }))),
    version: shared.filter(item => item.error === 'UNSUPPORTED_VERSION').concat([
      { id: 'local/version/missing', message: { seq: 1, type: 'text' }, error: 'UNSUPPORTED_VERSION' },
      { id: 'local/version/string', message: { v: '1', seq: 0, type: 'pong' }, error: 'UNSUPPORTED_VERSION' },
      { id: 'local/version/before-type-fields', message: { v: 2, seq: -1, type: 'nope' }, error: 'UNSUPPORTED_VERSION' },
    ]),
    types: shared.filter(item => item.error === 'UNKNOWN_TYPE').concat([
      { id: 'local/type/toString', message: { v: 1, seq: 1, type: 'toString' }, error: 'UNKNOWN_TYPE' },
      { id: 'local/type/missing', message: { v: 1, seq: 1 }, error: 'UNKNOWN_TYPE' },
      { id: 'local/type/number', message: { v: 1, seq: 1, type: 7 }, error: 'UNKNOWN_TYPE' },
      { id: 'local/type/before-fields', message: { v: 1, seq: -1, type: 'nope' }, error: 'UNKNOWN_TYPE' },
    ]),
    fields: shared.filter(item => item.error === 'INVALID_FIELD').concat([0, -1, 1.5, 4294967296, '1', true].map(seq => ({ id: `local/seq/${typeof seq}/${seq}`, message: { v: 1, seq, type: 'text', responseId: 'r', delta: 'invalid' }, error: 'INVALID_FIELD' }))),
    'state-call': [
      { id: 'local/state/invalid-enum', message: { v: 1, seq: 1, type: 'turn.state', turnId: CONTROL_TURN, epoch: 99, state: 'not-a-state' }, error: 'INVALID_FIELD' },
      { id: 'local/call/missing-arguments', message: { v: 1, seq: 2, type: 'tool.call', callId: CONTROL_CALL, turnId: CONTROL_TURN, epoch: 1, name: 'probe' }, error: 'INVALID_FIELD' },
      { id: 'local/call/invalid-epoch', message: { v: 1, seq: 2, type: 'tool.call', callId: CONTROL_CALL, turnId: CONTROL_TURN, epoch: '1', name: 'probe', arguments: {} }, error: 'INVALID_FIELD' },
    ],
  };
  const selected = groups[kind];
  if (!selected?.length) throw new Error(`Missing control vectors ${kind}`);
  return selected;
}
export async function clientControl(id: string, peer: Peer, driver: ProcessDriver, oracle: Oracle, info: Wire,
  directory: string, end: number, stage: (value: string) => void): Promise<Wire> {
  if (!Array.isArray(info.driverCapabilities) || !info.driverCapabilities.every((item: unknown) => typeof item === 'string') || !info.driverCapabilities.includes(CONTROL_PROFILE)) throw new IncompleteControl('Driver lacks client-control-validation-v1 instrumentation');
  const codes: string[] = []; const tested: string[] = [];
  stage('prepare control observations'); controlEffects(await driver.request('prepareControl', {}, end), codes);
  for (const vector of controlVectors(directory, id.split('/').at(-1)!)) {
    stage(`application error ${vector.id}`);
    peer.sendRaw('raw' in vector ? vector.raw : JSON.stringify(vector.message));
    codes.push(vector.error); tested.push(vector.id);
    controlEffects(await driver.request('waitControlErrors', { count: codes.length }, end), codes);
  }
  stage('valid state/call counterexample');
  peer.send({ v: 1, seq: 1, type: 'turn.state', turnId: CONTROL_TURN, epoch: 1, state: 'thinking' });
  const call = { v: 1, seq: 2, type: 'tool.call', callId: CONTROL_CALL, turnId: CONTROL_TURN, epoch: 1, name: 'probe', arguments: {}, 'x-control-probe': true };
  peer.send(call); peer.send(call); // Identical seq retransmission must not re-execute.
  await peer.expect(message => message.type === 'tool.result' && message.callId === CONTROL_CALL, end, 'legal tool result');
  stage('transcript receipt fence');
  peer.send({ v: 1, seq: 3, type: 'transcript', role: 'user', itemId: CONTROL_MARKER, text: 'control-complete', final: true });
  await driver.request('waitControlMarker', { itemId: CONTROL_MARKER }, end);
  stage('observed epoch probe');
  await driver.request('interrupt', {}, end);
  const interrupt = await peer.expect(message => message.type === 'interrupt', end, 'public interrupt epoch');
  if (interrupt.epoch !== 1) throw new Error(`Expected observed epoch 1, got ${interrupt.epoch}`);
  stage('drain and close control scenario');
  const effects = await driver.request('finishControl', {}, end);
  await peer.closed(end);
  stage('complete control oracle');
  oracle.baseline('client', peer.messages); // Only target output, never deliberately invalid injections.
  controlEffects(effects, codes, true); controlResult(peer.messages);
  return { capabilities: [], tested, effects, logicalResults: 1, closeFence: true };
}
