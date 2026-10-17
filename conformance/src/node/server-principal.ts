import { randomBytes } from 'node:crypto';
import type { Wire } from '../report.js';
import type { Oracle } from '../oracle.js';
import { LIVE_CONTEXT, principalEffects, principalOwner, principalRefusal } from '../principal-oracle.js';
import { dial, type Peer } from './ws-peer.js';
import type { ProcessDriver } from './process-driver.js';
export function principalCredentials() {
  const tokens = { aliceA: randomBytes(32).toString('hex'), aliceB: randomBytes(32).toString('hex'), bob: randomBytes(32).toString('hex'), invalid: randomBytes(32).toString('hex') };
  return { tokens, contains: (value: string) => Object.values(tokens).some(token => value.includes(token)),
    redact(value: unknown): unknown {
      let serialized = JSON.stringify(value);
      for (const token of Object.values(tokens)) serialized = serialized.split(token).join('[redacted]');
      return JSON.parse(serialized);
    } };
}
export class PrincipalFailure extends Error {
  constructor(message: string, readonly connections: Wire[]) { super(message); }
}
export async function serverPrincipal(id: string, first: Peer, url: string, driver: ProcessDriver, oracle: Oracle,
  hello: Wire, secrets: ReturnType<typeof principalCredentials>, end: number, stage: (value: string) => void): Promise<Wire> {
  const kind = id.split('/').at(-1)!; const peers = [first];
  let result: Wire | undefined; let failure: unknown;
  const traces = () => peers.map(peer => ({ messages: peer.messages, close: peer.closeInfo }));
  const closeOwner = async (peer: Peer, number: number) => {
    stage('owner wire close'); peer.socket.close(1000, 'scenario complete'); await peer.closed(end);
    stage('owner SDK close confirmation'); await driver.request('waitPrincipalClosed', { connection: number }, end);
  };
  const marker = async (peer: Peer, name: string) => {
    stage(`${name} model marker`); await driver.request('emitPrincipal', { marker: name }, end);
    await peer.expect(message => message.itemId === `principal-${name}`, end, `${name} on wire`);
  };
  try {
    stage('initial Alice ready'); first.send({ ...hello, auth: secrets.tokens.aliceA });
    const original = await first.expect(message => message.type === 'ready' || message.type === 'error', end, 'Alice ready');
    oracle.message('server', original);
    if (original.type !== 'ready' || original.resumedFrom !== undefined || (original.capabilities ?? []).length) throw new Error('Expected new Alice baseline session');
    await marker(first, 'before');
    if (kind !== 'foreign-live') await closeOwner(first, 1);
    const labels = ['alice-a'];
    const reject = async (token: string | undefined, sessionId: string, code: 'UNAUTHORIZED' | 'RESUME_FAILED', label: string) => {
      stage(`${label} rejection connect`); const peer = await dial(url, end); peers.push(peer);
      peer.send({ ...hello, sessionId, resumeFrom: 1, ...(token === undefined ? {} : { auth: token }) }); labels.push(label);
      stage(`${label} refusal`); await peer.expect(message => message.type === 'error' || message.type === 'ready', end, `${label} response`);
      stage(`${label} close`); await peer.closed(end);
      await driver.request('waitPrincipalClosed', { connection: peers.length }, end);
      stage(`${label} refusal oracle`); principalRefusal(oracle, peer.messages, peer.closeInfo, code);
    };
    if (kind.startsWith('foreign-')) {
      await reject(secrets.tokens.bob, original.sessionId, 'RESUME_FAILED', 'bob');
      if (kind === 'foreign-parked') await reject(secrets.tokens.bob, 'principal-unknown-session', 'RESUME_FAILED', 'bob');
    } else if (kind === 'reauth') {
      await reject(secrets.tokens.invalid, original.sessionId, 'UNAUTHORIZED', 'invalid');
      await reject(undefined, original.sessionId, 'UNAUTHORIZED', 'missing');
    }
    let owner = first;
    if (kind !== 'foreign-live') {
      stage('same principal new-token recovery'); owner = await dial(url, end); peers.push(owner);
      owner.send({ ...hello, sessionId: original.sessionId, resumeFrom: 1, auth: secrets.tokens.aliceB }); labels.push('alice-b');
      const ready = await owner.expect(message => message.type === 'ready' || message.type === 'error', end, 'owner recovery');
      oracle.message('server', ready);
      if (ready.type !== 'ready') throw new Error('Same principal with a new token could not resume');
    } else {
      stage('live owner context'); owner.send({ v: 1, seq: 1, type: 'context', context: LIVE_CONTEXT });
      await driver.request('waitPrincipalContext', {}, end);
    }
    await marker(owner, 'after');
    stage('owner live completion fence'); const offset = owner.messages.length;
    owner.send({ v: 1, seq: 0, type: 'ping' }); await owner.expect(message => message.type === 'pong', end, 'owner pong', offset);
    await closeOwner(owner, kind === 'foreign-live' ? 1 : peers.length);
    stage('drain principal work'); const effects = await driver.request('finishPrincipal', {}, end);
    stage('principal complete oracle');
    principalOwner(oracle, first.messages, owner.messages, owner !== first);
    principalEffects(effects, labels, kind === 'foreign-live' ? [LIVE_CONTEXT] : [], peers.length);
    result = { capabilities: [], sessionId: original.sessionId, effects, connections: traces(), ownerPreserved: true, closeFence: true };
  } catch (error) { failure = error; }
  finally {
    const cleanup = await Promise.allSettled(peers.slice(1).map(peer => peer.dispose()));
    const failed = cleanup.find(item => item.status === 'rejected');
    if (failed?.status === 'rejected') failure = new Error(`Principal peer cleanup failed: ${String(failed.reason)}; previous: ${String(failure)}`);
  }
  if (failure !== undefined) throw new PrincipalFailure(failure instanceof Error ? failure.message : String(failure), traces());
  return result!;
}
