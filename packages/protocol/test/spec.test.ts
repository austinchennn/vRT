// Checks this implementation against spec/, the normative definition of the protocol:
// the message set, every test vector, and (differentially) the JSON Schemas on
// messages mutated from the valid vectors, so the guards cannot drift from the schemas.
import { describe, expect, it } from 'vitest';
import { DIRECTIONS, audioCases, caseFrame, caseValue, controlCases, createValidator, loadSchemas, messageSchemas } from '../../../scripts/spec.mjs';
import {
  CLIENT_MESSAGE_TYPES,
  SERVER_MESSAGE_TYPES,
  decodeAudioFrame,
  decodeClientMessage,
  decodeServerMessage,
  encodeAudioFrame,
  parseClientMessage,
  parseServerMessage,
  type DecodeResult,
} from '../src/index.js';

type Direction = (typeof DIRECTIONS)[number];
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const implementation: Record<Direction, { types: readonly string[]; decode: (text: unknown) => DecodeResult<unknown>; parse: (value: unknown) => DecodeResult<unknown> }> = {
  client: { types: CLIENT_MESSAGE_TYPES, decode: decodeClientMessage, parse: parseClientMessage },
  server: { types: SERVER_MESSAGE_TYPES, decode: decodeServerMessage, parse: parseServerMessage },
};

const schemas = loadSchemas();
const validator = createValidator(schemas);
const controls = controlCases();

describe.each(DIRECTIONS)('%s messages', (direction: Direction) => {
  const { types, decode, parse } = implementation[direction];

  it('are exactly the message types the spec defines', () => {
    expect([...types].sort()).toEqual([...messageSchemas(schemas, direction).keys()].sort());
  });

  it.each(controls.filter((c: { direction: string }) => c.direction === direction))('$id', (testCase) => {
    const result = decode(caseFrame(testCase));
    if (testCase.valid) expect(result).toEqual({ ok: true, message: caseValue(testCase).value });
    else expect(result).toMatchObject({ ok: false, error: { code: testCase.error } });
  });

  it('agrees with the schemas on every single-member mutation of the valid vectors', () => {
    const valid = controls.filter((c: { direction: string; valid: boolean }) => c.direction === direction && c.valid);
    let checked = 0;
    for (const testCase of valid) {
      for (const { path, value } of mutations(caseValue(testCase).value)) {
        const schema = validator.validate(direction, value).valid;
        const result = parse(value);
        const mutated = valueAt(value, path);
        const where = `${testCase.id} with ${path.join('.')} ${mutated === undefined ? 'removed' : `= ${JSON.stringify(mutated)}`}`;
        expect(result.ok, where).toBe(schema);
        if (!result.ok) expect(result.error.code, where).toBe(expectedError(path));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(valid.length);
  });
});

describe('audio frames', () => {
  it.each(audioCases())('$id', (testCase) => {
    const bytes = fromHex(testCase.bytes);
    // Decode from a view that does not start at offset 0 of its buffer.
    const backing = new Uint8Array(bytes.byteLength + 3);
    backing.set(bytes, 3);
    const decoded = decodeAudioFrame(backing.subarray(3));
    if (!testCase.valid) {
      expect(decoded).toBeUndefined();
      return;
    }
    expect(decoded && { kind: decoded.kind, seq: decoded.seq, payload: toHex(decoded.payload) }).toEqual(testCase.frame);
    expect(toHex(encodeAudioFrame(testCase.frame.kind, testCase.frame.seq, fromHex(testCase.frame.payload)))).toBe(testCase.bytes);
  });
});

/** Values that exercise every JSON type and the integer boundaries the spec uses. */
const REPLACEMENTS: readonly Json[] = [null, true, 0, -1, 1.5, 4294967296, '', 'x', 'UPPER_CASE', [], {}];

/** Every message obtained by removing or replacing exactly one member or element, at any depth. */
function* mutations(message: Json): Generator<{ path: (string | number)[]; value: Json }> {
  function* walk(node: Json, path: (string | number)[]): Generator<{ path: (string | number)[]; value: Json }> {
    if (node === null || typeof node !== 'object') return;
    const keys: (string | number)[] = Array.isArray(node) ? node.map((_, i) => i) : Object.keys(node);
    for (const key of keys) {
      const at = [...path, key];
      if (!Array.isArray(node)) yield { path: at, value: replace(message, at, undefined) };
      for (const replacement of REPLACEMENTS) yield { path: at, value: replace(message, at, replacement) };
      yield* walk((node as Record<string | number, Json>)[key]!, at);
    }
  }
  yield* walk(message, []);
}

/** A deep copy of `root` with the member at `path` replaced, or removed when `value` is undefined. */
function replace(root: Json, path: (string | number)[], value: Json | undefined): Json {
  const copy = structuredClone(root);
  let parent = copy as Record<string | number, Json>;
  for (const key of path.slice(0, -1)) parent = parent[key] as Record<string | number, Json>;
  const last = path.at(-1)!;
  if (value === undefined) delete parent[last];
  else parent[last] = value;
  return copy;
}

function valueAt(root: Json, path: (string | number)[]): Json | undefined {
  return path.reduce<Json | undefined>((node, key) => (node as Record<string | number, Json> | undefined)?.[key], root);
}

/** The classification order of spec/protocol.md §9.1, for a message that was valid before the mutation. */
function expectedError(path: (string | number)[]): string {
  if (path.length === 1 && path[0] === 'v') return 'UNSUPPORTED_VERSION';
  if (path.length === 1 && path[0] === 'type') return 'UNKNOWN_TYPE';
  return 'INVALID_FIELD';
}

function fromHex(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
