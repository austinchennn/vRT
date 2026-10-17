import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Wire } from '../report.js';
import type { Oracle } from '../oracle.js';
import { expectedInputs, IncompleteInput } from '../input-oracle.js';
import type { Peer } from './ws-peer.js';
import type { ProcessDriver } from './process-driver.js';

/** Load unmodified shipped vectors; layout is checked without the SDK's encoder/decoder. */
export function inputVectors(directory: string) {
  const read = (path: string): Wire[] => JSON.parse(readFileSync(join(directory, 'examples', path), 'utf8')).cases;
  const envelope = read('client/envelope.json').filter(vector => !vector.valid);
  const control = envelope.concat([
    { id: 'input/text/invalid-field', message: { v: 1, seq: 1, type: 'text', text: 7 }, error: 'INVALID_FIELD' },
    { id: 'input/text/zero-seq', message: { v: 1, seq: 0, type: 'text', text: 'invalid-zero' }, error: 'INVALID_FIELD' },
    { id: 'input/ping/numbered', message: { v: 1, seq: 1, type: 'ping' }, error: 'INVALID_FIELD' },
  ]);
  const types = envelope.filter(vector => vector.id.includes('/type-')).concat([
    { id: 'input/type/proto', message: { v: 1, seq: 1, type: '__proto__' }, error: 'UNKNOWN_TYPE' },
  ]);
  const binary = read('binary/audio-frames.json');
  for (const vector of binary.filter(vector => vector.valid)) {
    const bytes = Buffer.from(vector.bytes, 'hex');
    if (bytes[0] !== vector.frame.kind || bytes.readUInt32BE(1) !== vector.frame.seq || bytes.subarray(5).toString('hex') !== vector.frame.payload) throw new Error(`Shared audio layout mismatch: ${vector.id}`);
  }
  const invalidBinary = binary.filter(vector => !vector.valid).map(vector => ({ id: vector.id, hex: vector.bytes }));
  invalidBinary.push({ id: 'input/audio/two-byte-header', hex: '0100' }, { id: 'input/audio/three-byte-header', hex: '010000' });
  // Golden vector is structurally valid, but wrong for a server receiver (§8.1).
  const output = binary.find(vector => vector.id === 'audio/frame/output-max-seq');
  const pcm = binary.find(vector => vector.id === 'audio/frame/input-pcm');
  if (!output || !pcm) throw new Error('Missing required audio vectors');
  invalidBinary.push({ id: output.id + '/wrong-direction', hex: output.bytes });
  return { control, types, invalidBinary, pcmPayload: pcm.frame.payload as string };
}

export async function serverInput(id: string, peer: Peer, driver: ProcessDriver, oracle: Oracle, hello: Wire,
  directory: string, end: number, stage: (value: string) => void): Promise<Wire> {
  const kind = id.split('/').at(-1)!;
  const vectors = inputVectors(directory);
  const expectedErrors: string[] = []; const tested: string[] = [];
  let ready: Wire | undefined;
  const marker = 'input-validation-control';
  const payload = vectors.pcmPayload;
  const afterPayload = '02000300';
  async function fence(label: string): Promise<void> {
    stage(label); const offset = peer.messages.length;
    peer.send({ v: 1, seq: 0, type: 'ping' });
    await peer.expect(message => message.type === 'pong', end, label, offset);
  }
  async function handshake(): Promise<void> {
    stage('input handshake');
    peer.send({ ...hello, input: { encoding: 'pcm16', sampleRate: 24000 } });
    ready = await peer.expect(message => message.type === 'ready', end, 'input ready');
    oracle.message('server', ready);
    if ((ready.capabilities ?? []).length !== 0) throw new Error('Server enabled unoffered capability');
    if (ready.input.encoding !== 'pcm16' || (ready.input.sampleRate ?? 24000) !== 24000) throw new IncompleteInput('Instrumented fixture requires PCM16/24000 input');
  }
  async function invalid(vector: Wire, binary = false): Promise<void> {
    stage(`reject ${vector.id}`); const offset = peer.messages.length;
    if (binary) peer.sendBinary(Buffer.from(vector.hex, 'hex'));
    else peer.sendRaw('raw' in vector ? vector.raw : JSON.stringify(vector.message));
    const error = await peer.expect(message => message.type === 'error', end, `reject ${vector.id}`, offset);
    oracle.error(error, binary ? 'MALFORMED' : vector.error, true);
    if ((ready === undefined && error.seq !== 0) || (ready !== undefined && error.seq === 0)) throw new Error('Incorrect session error sequence boundary');
    expectedErrors.push(binary ? 'MALFORMED' : vector.error); tested.push(vector.id);
  }
  function audio(seq: number, hex: string): void {
    const bytes = Buffer.alloc(5 + hex.length / 2);
    bytes[0] = 1; bytes.writeUInt32BE(seq, 1); bytes.set(Buffer.from(hex, 'hex'), 5);
    peer.sendBinary(bytes);
  }
  const boundFirst = ['control-post', 'types', 'binary-post', 'audio-ready'].includes(kind);
  if (boundFirst) await handshake();
  if (kind.startsWith('control') || kind === 'types') {
    for (const vector of kind === 'types' ? vectors.types : vectors.control) await invalid(vector);
  } else if (kind.startsWith('binary')) {
    for (const vector of vectors.invalidBinary) await invalid(vector, true);
  } else if (kind === 'audio-before-ready') {
    audio(0, payload);
  }
  if (!ready) {
    await fence('pre-session receipt fence');
    if (peer.messages.some(message => message.type === 'ready')) throw new Error('Input established a session before hello');
    stage('pre-session effects');
    expectedInputs(await driver.request('readInputs', {}, end), 0, [], []);
    await handshake();
  }
  const audioCase = kind === 'audio-ready' || kind === 'audio-before-ready';
  if (audioCase) {
    // No control stream activity has been sent. Audio must not create control ACKs/seq.
    audio(0, afterPayload);
    if (kind === 'audio-ready') audio(1, ''); // MAY be ignored, or forwarded empty once.
    await fence('audio receipt fence');
    if (peer.messages.some(message => message.type === 'ack' && message.upTo > 0)) throw new Error('Audio advanced control ACK cursor');
  }
  stage('pre-control cursor check');
  if (peer.messages.some(message => message.type === 'ack' && message.upTo > 0)) throw new Error('Invalid input advanced receive cursor');
  stage('valid control counterexample');
  // Additional properties are allowed. All earlier invalid seq values must be ignored.
  peer.send({ v: 1, seq: 1, type: 'text', text: marker, 'x-input-probe': true });
  await fence('ordered input receipt fence');
  stage('drain input observations');
  const markerOffset = peer.messages.length;
  const effects = await driver.request('finishInputs', {}, end);
  stage('model marker on wire');
  await peer.expect(message => message.type === 'transcript' && message.itemId === 'input-finish-marker' && message.text === 'input-observation-marker' && message.final === true, end, 'model marker on wire', markerOffset);
  stage('input effects oracle');
  expectedInputs(effects, 1, [marker], audioCase ? [afterPayload] : [], ready!.input, kind === 'audio-ready');
  await fence('input live completion fence');
  stage('input close fence'); peer.socket.close(1000, 'scenario complete'); await peer.closed(end);
  oracle.sessionErrors(peer.messages);
  const seen = new Set<number>();
  const logical = peer.messages.filter(message => {
    if (message.seq === 0) return true;
    if (seen.has(message.seq)) return false;
    seen.add(message.seq); return true;
  });
  const errors = logical.filter(message => message.type === 'error');
  if (JSON.stringify(errors.map(message => message.code)) !== JSON.stringify(expectedErrors) || errors.some(message => message.recoverable !== true)) throw new Error('Unexpected/missing error in complete input trace');
  if (logical.filter(message => message.type === 'transcript' && message.itemId === 'input-finish-marker').length !== 1) throw new Error('Expected exactly one model finish marker');
  if (logical.filter(message => message.type === 'ready').length !== 1) throw new Error('Expected exactly one ready');
  if (logical.some(message => message.type === 'ack' && message.upTo > 1)) throw new Error('Invalid input advanced receive cursor');
  return { capabilities: [], tested, effects, emptyPayload: kind === 'audio-ready' ? 'ignored or forwarded once' : 'not tested', liveCompletionFence: true };
}
