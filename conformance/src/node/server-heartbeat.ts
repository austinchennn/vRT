import WebSocket from 'ws';
import type { Oracle } from '../oracle.js';
import type { Wire } from '../report.js';
import { heartbeatAlive, heartbeatExpired, type HeartbeatSettings } from '../heartbeat-oracle.js';
import { dial, type Peer } from './ws-peer.js';
import type { ProcessDriver } from './process-driver.js';
export const HEARTBEAT_PROFILE = 'server-heartbeat-v1';
export const HEARTBEAT_KINDS = ['pong-awaiting-hello', 'pong-opening', 'pong-ready', 'idle-sessionless', 'idle-resume', 'activity-context', 'activity-malformed', 'activity-binary'] as const;
export const HEARTBEAT_CASES = HEARTBEAT_KINDS.map(kind => `server/heartbeat/${kind}`);
export class IncompleteHeartbeat extends Error {}

export async function serverHeartbeat(
  id: string, peer: Peer, extras: Peer[], driver: ProcessDriver, oracle: Oracle,
  hello: Wire, url: string, settings: HeartbeatSettings, end: number,
  stage: (value: string) => void, evidence: Wire,
): Promise<Wire> {
  const kind = id.split('/').at(-1)!;
  let now = 0;
  Object.assign(evidence, { settings: { clock: 'virtual', ...settings }, timeline: [], received: [], capabilities: [] });
  const wait = async (event: string, connection = 1) => {
    const receipt = await driver.request('waitHeartbeat', { event, connection }, end);
    if (receipt.now !== now) throw new Error('Receipt clock mismatch');
  };
  const received = (type: string) => evidence.received.push({ type, at: now });
  async function advance(target: number): Promise<Wire> {
    stage(`clock advance to ${target}`);
    const info = await driver.request('advanceHeartbeat', { ms: target - now }, end);
    if (info.now !== target || !Array.isArray(info.connections)) throw new Error('Clock acknowledgement mismatch');
    now = target;
    const connection = info.connections[0];
    if (!connection || typeof connection.open !== 'boolean') throw new Error('Missing public connection observation');
    const point = { at: now, serverOpen: connection.open, peerOpen: peer.socket.readyState === WebSocket.OPEN, closeRequestedAt: connection.closeRequestedAt };
    evidence.timeline.push(point); return point;
  }
  async function ping(): Promise<void> {
    const offset = peer.messages.length;
    peer.send({ v: 1, seq: 0, type: 'ping' });
    const pong = await peer.expect(m => m.type === 'pong', end, 'heartbeat pong', offset);
    oracle.message('server', pong); received('ping');
    if (pong.seq !== 0) throw new Error('Pong must use seq 0');
  }
  async function ready(): Promise<Wire> {
    const message = await peer.expect(m => m.type === 'ready' || m.type === 'error', end, 'heartbeat ready');
    oracle.message('server', message);
    if (message.type !== 'ready' || (message.capabilities ?? []).length !== 0) throw new Error('Expected baseline ready');
    received('hello'); return message;
  }
  async function expire(lastReceived: number): Promise<void> {
    heartbeatAlive(await advance(lastReceived + settings.timeoutMs - 1));
    const point = await advance(lastReceived + settings.timeoutMs + settings.delayAllowanceMs);
    stage('heartbeat close fence'); await peer.closed(end);
    heartbeatExpired(settings, lastReceived, point, peer.closeInfo?.code);
    evidence.close = peer.closeInfo;
  }
  stage('connection barrier'); await wait('connected');
  if (kind === 'pong-awaiting-hello') {
    await ping();
    if (peer.messages.some(m => m.type === 'ready')) throw new Error('Ping opened a session');
    peer.send(hello); await ready();
  } else if (kind === 'pong-opening') {
    peer.send(hello); stage('opening hook barrier'); await wait('opening');
    stage('pong while opening held'); await ping();
    if (peer.messages.some(m => m.type === 'ready')) throw new Error('Ready before opening release');
    stage('release opening'); await driver.request('releaseHeartbeatOpening', {}, end); await ready();
  } else if (kind === 'idle-sessionless') {
    await expire(0);
    if (peer.messages.some(m => m.type === 'ready')) throw new Error('Idle connection opened a session');
  } else {
    peer.send(hello); const initial = await ready();
    if (kind === 'pong-ready') {
      await ping(); await ping();
      peer.sendRaw('{');
      const error = await peer.expect(m => m.type === 'error', end, 'sequenced error after pings');
      oracle.error(error, 'MALFORMED', true); received('malformed'); oracle.sessionErrors(peer.messages);
      evidence.nextSequencedError = error.seq;
    } else if (kind === 'idle-resume') {
      // No application sends: client cursor is zero; consume any valid server control traffic.
      await expire(0);
      const serverCursor = Math.max(0, ...peer.messages.map(m => m.seq));
      stage('minimal resume connection'); const resumed = await dial(url, end); extras.push(resumed);
      await wait('connected', 2);
      evidence.resume = { attemptAt: now, serverCursor, trace: resumed.messages };
      resumed.send({ ...hello, sessionId: initial.sessionId, resumeFrom: serverCursor });
      const response = await resumed.expect(m => m.type === 'ready' || m.type === 'error', end, 'minimal resumed ready');
      oracle.message('server', response);
      if (response.type !== 'ready' || response.sessionId !== initial.sessionId || response.resumedFrom !== 0 || (response.capabilities ?? []).length !== 0) throw new Error('Expected same-session ready with resumedFrom 0 after heartbeat timeout');
      resumed.socket.close(1000, 'resume probe complete'); await resumed.closed(end);
      oracle.traffic('server', resumed.messages, [], serverCursor);
      Object.assign(evidence.resume, { sameSession: true, resumedFrom: response.resumedFrom, scope: 'no-application-replay handshake only' });
    } else {
      const activityAt = Math.floor(settings.timeoutMs * 3 / 4);
      heartbeatAlive(await advance(activityAt));
      stage('non-ping activity receipt');
      if (kind === 'activity-context') {
        peer.send({ v: 1, seq: 1, type: 'context', context: { heartbeatReceipt: 'receipt-1' } });
        await wait('context:receipt-1');
      } else if (kind === 'activity-malformed') {
        peer.sendRaw('{');
        const error = await peer.expect(m => m.type === 'error', end, 'malformed activity receipt');
        oracle.error(error, 'MALFORMED', true);
      } else {
        // kind 1, sequence 0, one opaque PCM16 sample; no hardware or SDK codec.
        peer.socket.send(new Uint8Array([1, 0, 0, 0, 0, 0, 0])); await wait('audio');
      }
      received(kind);
      // No probe traffic here: only the public receipt barrier and clock channel.
      heartbeatAlive(await advance(Math.floor(settings.timeoutMs * 5 / 4)));
      await expire(activityAt);
    }
  }
  stage('heartbeat final oracle'); oracle.sessionErrors(peer.messages);
  if (peer.socket.readyState !== WebSocket.CLOSED) { peer.socket.close(1000, 'scenario complete'); await peer.closed(end); }
  oracle.sessionErrors(peer.messages);
  return evidence;
}
