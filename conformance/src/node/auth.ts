import { randomBytes } from 'node:crypto';
import type { Wire } from '../report.js';
import type { Oracle } from '../oracle.js';
import type { Peer } from './ws-peer.js';

export const AUTH_PROFILE = 'server-auth-v1';
export const AUTH_CASES = [
  'server/auth/missing-token', 'server/auth/wrong-token',
  'server/auth/correct-token', 'server/auth/error-sequence',
];
export class IncompleteAuthDriver extends Error {}

/** Each case owns two random test-only credentials; none belong in a report. */
export function authCredentials() {
  const token = randomBytes(32).toString('hex');
  const wrongToken = randomBytes(32).toString('hex');
  return {
    token, wrongToken,
    redact(value: unknown): unknown {
      return JSON.parse(JSON.stringify(value).split(token).join('[redacted]').split(wrongToken).join('[redacted]'));
    },
  };
}

export async function authenticateScenario(
  id: string, peer: Peer, oracle: Oracle, hello: Wire,
  credentials: ReturnType<typeof authCredentials>, end: number,
  stage: (value: string) => void,
): Promise<Wire> {
  const missing = id.endsWith('missing-token');
  const rejected = missing || id.endsWith('wrong-token');
  if (rejected) {
    stage('authentication refusal');
    peer.send({ ...hello, ...(missing ? {} : { auth: credentials.wrongToken }) });
    const first = await peer.expect(m => m.type === 'error' || m.type === 'ready', end, 'authentication response');
    oracle.error(first, 'UNAUTHORIZED', false);
    stage('unauthorized close'); await peer.closed(end);
    stage('refusal oracle'); oracle.refused(peer.messages, peer.closeInfo);
    return { authorized: false, error: 'UNAUTHORIZED', seq: first.seq, close: peer.closeInfo };
  }
  const sequence = id.endsWith('error-sequence');
  if (sequence) {
    stage('malformed before binding'); peer.sendRaw('{');
    const error = await peer.expect(m => m.type === 'error' || m.type === 'ready', end, 'sessionless malformed response');
    oracle.error(error, 'MALFORMED', true);
    if (peer.messages.some(m => m.type === 'ready')) throw new Error('Unexpected ready before authenticated hello');
    oracle.sessionErrors(peer.messages);
  }
  stage('authorized ready');
  const beforeReady = peer.messages.length;
  peer.send({ ...hello, auth: credentials.token });
  const ready = await peer.expect(m => m.type === 'ready' || m.type === 'error', end, 'authenticated ready', beforeReady);
  oracle.message('server', ready);
  if (ready.type !== 'ready' || (ready.capabilities ?? []).length !== 0) throw new Error('Expected baseline ready for correct token');
  let afterSeq: number | undefined;
  if (sequence) {
    stage('malformed after binding');
    const afterReady = peer.messages.length;
    peer.sendRaw('{');
    const error = await peer.expect(m => m.type === 'error', end, 'bound malformed response', afterReady);
    oracle.error(error, 'MALFORMED', true);
    oracle.sessionErrors(peer.messages); afterSeq = error.seq;
    stage('connection still usable');
    const afterError = peer.messages.length;
    peer.send({ v: 1, seq: 0, type: 'ping' });
    await peer.expect(m => m.type === 'pong', end, 'pong after recoverable error', afterError);
  }
  stage('authorized close fence'); peer.socket.close(1000, 'scenario complete'); await peer.closed(end);
  stage('session oracle'); oracle.sessionErrors(peer.messages);
  return { authorized: true, capabilities: [], ...(sequence ? { beforeSeq: 0, afterSeq, connectionUsable: true } : {}) };
}
