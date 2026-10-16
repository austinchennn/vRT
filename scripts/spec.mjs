// Reads spec/: the JSON Schemas and the test vectors. Shared by scripts/check-spec.mjs
// (is the spec self-consistent?) and implementation tests (does an implementation match it?).
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { root } from './packages.mjs';

export const SPEC_DIR = join(root, 'spec');
export const SCHEMA_DIR = join(SPEC_DIR, 'schema');
export const EXAMPLES_DIR = join(SPEC_DIR, 'examples');
export const VECTORS_SCHEMA = join(EXAMPLES_DIR, 'vectors.schema.json');
export const CAPABILITY_REGISTRY = join(SPEC_DIR, 'capabilities.json');
export const CAPABILITY_REGISTRY_SCHEMA = join(SPEC_DIR, 'capabilities.schema.json');
export const PROTOCOL_DOC = join(SPEC_DIR, 'protocol.md');
export const DIRECTIONS = /** @type {const} */ (['client', 'server']);

/** Root schema validating any message sent by `direction`. */
export const messageSchemaPath = (direction) => `${direction}-message.json`;

function jsonFiles(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

/** Every schema under spec/schema, keyed by its path relative to that directory (always with '/'). */
export function loadSchemas() {
  return new Map(jsonFiles(SCHEMA_DIR).map((path) => [relative(SCHEMA_DIR, path).split('\\').join('/'), readJson(path)]));
}

/** The message type each per-message schema in `direction/` defines, keyed by type. */
export function messageSchemas(schemas, direction) {
  const byType = new Map();
  for (const [path, schema] of schemas) {
    if (!path.startsWith(`${direction}/`)) continue;
    const type = schema.properties?.type?.const;
    if (typeof type !== 'string') throw new Error(`${path}: properties.type.const must name the message type`);
    byType.set(type, { path, schema });
  }
  return byType;
}

/** spec/capabilities.json: every standard capability (protocol.md §3.4). */
export function loadCapabilityRegistry() {
  return readJson(CAPABILITY_REGISTRY);
}

/** Every token in the capability registry. */
export function registeredCapabilities(registry = loadCapabilityRegistry()) {
  return new Set(registry.capabilities.map((capability) => capability.token));
}

/** Every vector file under spec/examples: its path relative to spec/examples and its content. */
export function loadVectorFiles() {
  return jsonFiles(EXAMPLES_DIR)
    .filter((path) => path !== VECTORS_SCHEMA)
    .map((path) => ({ path: relative(EXAMPLES_DIR, path).split('\\').join('/'), vectors: readJson(path) }));
}

/** Control-message cases, flattened, each carrying its suite's direction and file. */
export function controlCases(files = loadVectorFiles()) {
  return files
    .filter(({ vectors }) => vectors.suite === 'control')
    .flatMap(({ path, vectors }) => vectors.cases.map((c) => ({ ...c, direction: vectors.direction, file: path })));
}

/** Binary audio frame cases, flattened. */
export function audioCases(files = loadVectorFiles()) {
  return files.filter(({ vectors }) => vectors.suite === 'audio').flatMap(({ path, vectors }) => vectors.cases.map((c) => ({ ...c, file: path })));
}

/** The JSON value a control case puts on the wire, or `{ ok: false }` when its raw frame is not JSON. */
export function caseValue(testCase) {
  if (!('raw' in testCase)) return { ok: true, value: testCase.message };
  try {
    return { ok: true, value: JSON.parse(testCase.raw) };
  } catch {
    return { ok: false };
  }
}

/** The text frame a control case puts on the wire. */
export function caseFrame(testCase) {
  return 'raw' in testCase ? testCase.raw : JSON.stringify(testCase.message);
}

/**
 * A strict JSON Schema 2020-12 validator loaded with every spec schema.
 * `validate(direction, value)` checks a value against that direction's message schema.
 */
export function createValidator(schemas = loadSchemas()) {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  for (const schema of schemas.values()) ajv.addSchema(schema);
  const registry = ajv.compile(readJson(CAPABILITY_REGISTRY_SCHEMA));
  // The vector format is tooling, not protocol: its exactly-one-of and if/then
  // rules name members in `required` only, which strictRequired forbids.
  const vectorFile = new Ajv2020({ strict: true, strictRequired: false, allErrors: true }).compile(readJson(VECTORS_SCHEMA));
  const byId = (path) => {
    const id = schemas.get(path)?.$id;
    const validate = id && ajv.getSchema(id);
    if (!validate) throw new Error(`spec/schema/${path} is missing or has no $id`);
    return validate;
  };
  const roots = Object.fromEntries(DIRECTIONS.map((direction) => [direction, byId(messageSchemaPath(direction))]));
  return {
    ajv,
    /** Compiles every schema; throws on the first schema error. */
    compileAll: () => [...schemas.keys()].forEach(byId),
    schema: byId,
    validate(direction, value) {
      const validate = roots[direction];
      return validate(value) ? { valid: true } : { valid: false, errors: ajv.errorsText(validate.errors) };
    },
    /** Checks the capability registry's format. */
    capabilityRegistry(content) {
      return registry(content) ? { valid: true } : { valid: false, errors: ajv.errorsText(registry.errors) };
    },
    /** Checks one vector file's format. */
    vectorFile(file) {
      return vectorFile(file) ? { valid: true } : { valid: false, errors: ajv.errorsText(vectorFile.errors) };
    },
  };
}
