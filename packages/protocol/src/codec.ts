import { PROTOCOL_VERSION, SESSIONLESS_TYPES, TRANSIENT_TYPES, type ClientMessage, type ServerMessage } from './messages.js';

export type ProtocolErrorCode = 'MALFORMED' | 'UNSUPPORTED_VERSION' | 'UNKNOWN_TYPE' | 'INVALID_FIELD';
export interface ProtocolError { code: ProtocolErrorCode; message: string }
export type DecodeResult<M> = { ok: true; message: M } | { ok: false; error: ProtocolError };

// Field rules mirror spec/schema; packages/protocol/test/spec.test.ts keeps them in step.
type Check = (value: unknown) => boolean;
type Shape = Readonly<Record<string, Check>>;
type Message = Record<string, unknown>;
/** Fields whose rules depend on another field's value, e.g. `tool.result` by `ok`. */
type Variant = (message: Message) => Shape;

const MAX_UINT32 = 0xffffffff;
const CAPABILITY = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const CAPABILITY_MAX_LENGTH = 64;
const ERROR_CODE = /^[A-Z][A-Z0-9_]*$/;

const str: Check = (v) => typeof v === 'string';
const bool: Check = (v) => typeof v === 'boolean';
const uint32: Check = (v) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= MAX_UINT32;
const positiveUint32: Check = (v) => uint32(v) && v !== 0;
const nonNegative: Check = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
/** Opaque and non-empty. */
const id: Check = (v) => typeof v === 'string' && v.length > 0;
/** Any JSON value, null included; only a missing member fails. */
const json: Check = (v) => v !== undefined;
const zero: Check = (v) => v === 0;
const opt = (check: Check): Check => (v) => v === undefined || check(v);
const oneOf = (...values: readonly unknown[]): Check => (v) => values.includes(v);
const matches = (pattern: RegExp, maxLength = Infinity): Check => (v) => typeof v === 'string' && v.length <= maxLength && pattern.test(v);
const isObject = (v: unknown): v is Message => typeof v === 'object' && v !== null && !Array.isArray(v);
const object = (shape: Shape): Check => (v) => isObject(v) && fieldError(v, shape) === undefined;
const arrayOf = (check: Check): Check => (v) => Array.isArray(v) && v.every(check);

const format = object({ encoding: oneOf('pcm16', 'opus', 'pcmu'), sampleRate: opt(positiveUint32) });
const toolSpec = object({ name: id, description: str, parameters: isObject });
const capabilities = arrayOf(matches(CAPABILITY, CAPABILITY_MAX_LENGTH));
const failureCode = oneOf('INTERRUPTED', 'REJECTED', 'INVALID', 'TIMEOUT', 'FAILED');
const turnState = oneOf('idle', 'listening', 'thinking', 'speaking', 'acting');

const CLIENT = {
  hello: { tools: arrayOf(toolSpec), input: opt(format), output: opt(format), sessionId: opt(id), resumeFrom: opt(uint32), capabilities: opt(capabilities), context: opt(json), auth: opt(str) },
  text: { text: str },
  interrupt: { epoch: uint32, reason: oneOf('speech', 'user', 'keyboard') },
  playback: { itemId: id, playedMs: nonNegative },
  'tool.result': { callId: id, epoch: uint32, ok: bool },
  context: { context: json },
  ack: { upTo: uint32 },
  ping: {},
} satisfies Record<ClientMessage['type'], Shape>;

const CLIENT_VARIANTS: Partial<Record<ClientMessage['type'], Variant>> = {
  'tool.result': (m) => (m['ok'] === true ? { output: json } : { code: failureCode, message: str }),
};

const SERVER = {
  ready: { sessionId: id, input: format, output: format, resumedFrom: opt(uint32), capabilities: opt(capabilities) },
  'audio.start': { itemId: id, responseId: id, epoch: uint32 },
  'turn.state': { turnId: id, epoch: uint32, state: turnState },
  transcript: { role: oneOf('user', 'agent'), itemId: id, text: str, final: bool },
  text: { responseId: id, delta: str },
  'tool.call.delta': { callId: id, epoch: uint32, name: id, preview: json },
  'tool.call': { callId: id, epoch: uint32, turnId: id, name: id, arguments: json },
  interrupted: { epoch: uint32 },
  ack: { upTo: uint32 },
  pong: {},
  error: { code: matches(ERROR_CODE), message: str, recoverable: bool },
} satisfies Record<ServerMessage['type'], Shape>;

/** Every message type a client may send. */
export const CLIENT_MESSAGE_TYPES = Object.keys(CLIENT) as readonly ClientMessage['type'][];
/** Every message type a server may send. */
export const SERVER_MESSAGE_TYPES = Object.keys(SERVER) as readonly ServerMessage['type'][];

/** spec/protocol.md §4.1: transient messages carry 0, sequenced ones start at 1. */
function seqRule(type: string): Check {
  if (TRANSIENT_TYPES.has(type)) return zero;
  return SESSIONLESS_TYPES.has(type) ? uint32 : positiveUint32;
}

function fieldError(value: Message, shape: Shape): string | undefined {
  for (const key in shape) if (!shape[key]!(value[key])) return key;
  return undefined;
}

function fail(code: ProtocolErrorCode, message: string): { ok: false; error: ProtocolError } {
  return { ok: false, error: { code, message } };
}

/** Classifies in the order spec/protocol.md §9.1 requires: framing, version, type, fields. */
function parse<M>(value: unknown, shapes: Readonly<Record<string, Shape>>, variants: Readonly<Record<string, Variant>>): DecodeResult<M> {
  if (!isObject(value)) return fail('MALFORMED', 'Message must be a JSON object');
  if (value['v'] !== PROTOCOL_VERSION) return fail('UNSUPPORTED_VERSION', `Unsupported protocol version: ${String(value['v'])}`);
  const type = value['type'];
  if (typeof type !== 'string' || !Object.hasOwn(shapes, type)) return fail('UNKNOWN_TYPE', `Unknown message type: ${String(type)}`);
  const variant = Object.hasOwn(variants, type) ? variants[type] : undefined;
  const bad = (seqRule(type)(value['seq']) ? undefined : 'seq') ?? fieldError(value, shapes[type]!) ?? (variant && fieldError(value, variant(value)));
  if (bad !== undefined) return fail('INVALID_FIELD', `Invalid field for ${type}: ${bad}`);
  return { ok: true, message: value as M };
}

/** Validates an already-parsed value. Never throws. */
export function parseClientMessage(value: unknown): DecodeResult<ClientMessage> {
  return parse(value, CLIENT, CLIENT_VARIANTS);
}

export function parseServerMessage(value: unknown): DecodeResult<ServerMessage> {
  return parse(value, SERVER, {});
}

function decode<M>(text: unknown, parseValue: (value: unknown) => DecodeResult<M>): DecodeResult<M> {
  if (typeof text !== 'string') return fail('MALFORMED', 'Control frames must be text');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return fail('MALFORMED', 'Invalid JSON');
  }
  return parseValue(value);
}

/** Decodes a JSON text frame from a client. Never throws. */
export function decodeClientMessage(text: unknown): DecodeResult<ClientMessage> {
  return decode(text, parseClientMessage);
}

/** Decodes a JSON text frame from a server. Never throws. */
export function decodeServerMessage(text: unknown): DecodeResult<ServerMessage> {
  return decode(text, parseServerMessage);
}

export function encodeMessage(message: ClientMessage | ServerMessage): string {
  return JSON.stringify(message);
}
