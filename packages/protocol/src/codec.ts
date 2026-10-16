import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from './messages.js';

export type ProtocolErrorCode = 'MALFORMED' | 'UNSUPPORTED_VERSION' | 'UNKNOWN_TYPE' | 'INVALID_FIELD';
export interface ProtocolError { code: ProtocolErrorCode; message: string }
export type DecodeResult<M> = { ok: true; message: M } | { ok: false; error: ProtocolError };

type Check = (value: unknown) => boolean;
type Shape = Record<string, Check>;

const str: Check = (v) => typeof v === 'string';
const bool: Check = (v) => typeof v === 'boolean';
const num: Check = (v) => typeof v === 'number' && Number.isFinite(v);
const uint: Check = (v) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 0xffffffff;
const any: Check = () => true;
const opt = (check: Check): Check => Object.assign((v: unknown) => v === undefined || check(v), { optional: true });
const oneOf = (...values: string[]): Check => (v) => values.includes(v as string);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const object = (shape: Shape): Check => (v) => isObject(v) && fieldError(v, shape) === undefined;
const arrayOf = (check: Check): Check => (v) => Array.isArray(v) && v.every(check);

const format = object({ encoding: oneOf('pcm16', 'opus', 'pcmu'), sampleRate: opt(uint) });
const toolSpec = object({ name: str, description: str, parameters: isObject });
const failureCode = oneOf('INTERRUPTED', 'REJECTED', 'INVALID', 'TIMEOUT', 'FAILED');
const turnState = oneOf('idle', 'listening', 'thinking', 'speaking', 'acting');

const CLIENT: Record<string, Shape> = {
  hello: { tools: arrayOf(toolSpec), input: opt(format), output: opt(format), sessionId: opt(str), resumeFrom: opt(uint), context: any, auth: opt(str) },
  text: { text: str },
  interrupt: { epoch: uint, reason: oneOf('speech', 'user', 'keyboard') },
  playback: { itemId: str, playedMs: num },
  'tool.result': { callId: str, epoch: uint, ok: bool, output: any },
  context: { context: any },
  ack: { upTo: uint },
  ping: {},
};

const SERVER: Record<string, Shape> = {
  ready: { sessionId: str, input: format, output: format, resumedFrom: opt(uint) },
  'audio.start': { itemId: str, responseId: str, epoch: uint },
  'turn.state': { turnId: str, epoch: uint, state: turnState },
  transcript: { role: oneOf('user', 'agent'), itemId: str, text: str, final: bool },
  text: { responseId: str, delta: str },
  'tool.call.delta': { callId: str, epoch: uint, name: str, preview: any },
  'tool.call': { callId: str, epoch: uint, turnId: str, name: str, arguments: any },
  interrupted: { epoch: uint },
  ack: { upTo: uint },
  pong: {},
  error: { code: str, message: str, recoverable: bool },
};

function fieldError(value: Record<string, unknown>, shape: Shape): string | undefined {
  for (const key in shape) if (!shape[key]!(value[key])) return key;
  return undefined;
}

function fail(code: ProtocolErrorCode, message: string): { ok: false; error: ProtocolError } {
  return { ok: false, error: { code, message } };
}

function parse<M>(value: unknown, shapes: Record<string, Shape>): DecodeResult<M> {
  if (!isObject(value)) return fail('MALFORMED', 'Message must be a JSON object');
  if (value['v'] !== PROTOCOL_VERSION) return fail('UNSUPPORTED_VERSION', `Unsupported protocol version: ${String(value['v'])}`);
  if (!uint(value['seq'])) return fail('INVALID_FIELD', 'Invalid field: seq');
  const type = value['type'];
  const shape = typeof type === 'string' && Object.hasOwn(shapes, type) ? shapes[type] : undefined;
  if (shape === undefined) return fail('UNKNOWN_TYPE', `Unknown message type: ${String(type)}`);
  const bad = fieldError(value, shape);
  if (bad !== undefined) return fail('INVALID_FIELD', `Invalid field for ${type}: ${bad}`);
  if (type === 'tool.result' && value['ok'] === false && !(failureCode(value['code']) && str(value['message']))) {
    return fail('INVALID_FIELD', 'Invalid field for tool.result: code');
  }
  return { ok: true, message: value as M };
}

/** Validates an already-parsed value. Never throws. */
export function parseClientMessage(value: unknown): DecodeResult<ClientMessage> {
  return parse(value, CLIENT);
}

export function parseServerMessage(value: unknown): DecodeResult<ServerMessage> {
  return parse(value, SERVER);
}

function decode<M>(text: unknown, shapes: Record<string, Shape>): DecodeResult<M> {
  if (typeof text !== 'string') return fail('MALFORMED', 'Control frames must be text');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return fail('MALFORMED', 'Invalid JSON');
  }
  return parse(value, shapes);
}

/** Decodes a JSON text frame from a client. Never throws. */
export function decodeClientMessage(text: unknown): DecodeResult<ClientMessage> {
  return decode(text, CLIENT);
}

/** Decodes a JSON text frame from a server. Never throws. */
export function decodeServerMessage(text: unknown): DecodeResult<ServerMessage> {
  return decode(text, SERVER);
}

export function encodeMessage(message: ClientMessage | ServerMessage): string {
  return JSON.stringify(message);
}
