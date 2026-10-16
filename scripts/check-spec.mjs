// Checks that spec/ is self-consistent, independently of any implementation:
// schemas compile in strict mode, the union schemas cover every message schema,
// the capability registry is coherent, every vector file is well-formed, every
// vector agrees with the schemas, and every link between spec documents resolves.
// Implementations are checked against the vectors by their own tests.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import {
  DIRECTIONS,
  PROTOCOL_DOC,
  SPEC_DIR,
  audioCases,
  caseValue,
  controlCases,
  createValidator,
  loadCapabilityRegistry,
  loadSchemas,
  loadVectorFiles,
  messageSchemaPath,
  messageSchemas,
} from './spec.mjs';

const failures = [];
const fail = (message) => failures.push(message);

const schemas = loadSchemas();
const validator = createValidator(schemas);
try {
  validator.compileAll();
} catch (error) {
  console.error(`✗ ${error.message}`);
  process.exit(1);
}

// ── Schemas ──────────────────────────────────────────────────────────────

const ids = [...schemas].map(([path, schema]) => ({ path, id: schema.$id }));
const base = ids.find(({ path }) => path === 'common.json')?.id?.replace(/common\.json$/, '');
for (const { path, id } of ids) {
  if (id !== `${base}${path}`) fail(`spec/schema/${path}: $id must be ${base}${path}, found ${id}`);
}

const typesByDirection = new Map();
for (const direction of DIRECTIONS) {
  const byType = messageSchemas(schemas, direction);
  typesByDirection.set(direction, new Set(byType.keys()));
  const union = schemas.get(messageSchemaPath(direction));
  const listed = union?.properties?.type?.enum ?? [];
  const branches = new Map((union?.allOf ?? []).map((branch) => [branch.if?.properties?.type?.const, branch.then?.$ref]));
  for (const [type, { path }] of byType) {
    if (!listed.includes(type)) fail(`${messageSchemaPath(direction)}: type enum is missing "${type}"`);
    if (branches.get(type) !== path) fail(`${messageSchemaPath(direction)}: "${type}" must dispatch to ${path}, found ${branches.get(type)}`);
  }
  for (const type of listed) if (!byType.has(type)) fail(`${messageSchemaPath(direction)}: "${type}" has no schema in ${direction}/`);
}

// ── Capability registry (protocol.md §3.4) ───────────────────────────────

const registry = loadCapabilityRegistry();
const registryFormat = validator.capabilityRegistry(registry);
if (!registryFormat.valid) fail(`spec/capabilities.json: ${registryFormat.errors}`);
else {
  const tokens = new Set();
  const gatedBy = new Map();
  for (const { token, specification, messages = {} } of registry.capabilities) {
    if (tokens.has(token)) fail(`spec/capabilities.json: duplicate token ${token}`);
    if (token.startsWith('x-')) fail(`spec/capabilities.json: ${token} is private; x- tokens are never registered`);
    tokens.add(token);
    const anchor = specification.slice(specification.indexOf('#') + 1);
    if (!anchorsOf(PROTOCOL_DOC).has(anchor)) fail(`spec/capabilities.json: ${token} points to a missing section ${specification}`);
    for (const direction of DIRECTIONS) {
      for (const type of messages[direction] ?? []) {
        if (!typesByDirection.get(direction).has(type)) fail(`spec/capabilities.json: ${token} gates ${direction} "${type}", which has no schema`);
        const key = `${direction}/${type}`;
        if (gatedBy.has(key)) fail(`spec/capabilities.json: ${key} is gated by both ${gatedBy.get(key)} and ${token}`);
        gatedBy.set(key, token);
      }
    }
  }
}

// ── Links between spec documents ─────────────────────────────────────────

const LINK = /\]\(([^)\s]+)\)/g;
for (const doc of readdirSync(SPEC_DIR).filter((name) => name.endsWith('.md')).map((name) => join(SPEC_DIR, name))) {
  for (const [, target] of readFileSync(doc, 'utf8').matchAll(LINK)) {
    if (/^[a-z]+:/.test(target)) continue;
    const [path, anchor] = target.split('#');
    const file = path ? join(dirname(doc), path) : doc;
    const where = `spec/${relative(SPEC_DIR, doc)}: link ${target}`;
    if (!existsSync(file)) fail(`${where} points to a missing file`);
    else if (anchor && file.endsWith('.md') && !anchorsOf(file).has(anchor)) fail(`${where} points to a missing section`);
  }
}

/** GitHub-style heading anchors of a Markdown file. */
function anchorsOf(file) {
  return new Set(
    readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => /^#{1,6} /.test(line))
      .map((line) => line.replace(/^#+ /, '').trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-')),
  );
}

// ── Vector files ─────────────────────────────────────────────────────────

const files = loadVectorFiles();
const seenIds = new Set();
for (const { path, vectors } of files) {
  const format = validator.vectorFile(vectors);
  if (!format.valid) {
    fail(`spec/examples/${path}: ${format.errors}`);
    continue;
  }
  const prefix = vectors.suite === 'control' ? `${vectors.direction}/` : 'audio/';
  for (const { id } of vectors.cases) {
    if (seenIds.has(id)) fail(`spec/examples/${path}: duplicate case id ${id}`);
    if (!id.startsWith(prefix)) fail(`spec/examples/${path}: case id ${id} must start with ${prefix}`);
    seenIds.add(id);
  }
}
// Later checks assume well-formed files.
exitOnFailures();

// ── Control vectors against the schemas ──────────────────────────────────

/** The receiver's error classification order (protocol.md §9.1). */
function classify(direction, parsed) {
  if (!parsed.ok) return 'MALFORMED';
  const value = parsed.value;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'MALFORMED';
  if (value.v !== 1) return 'UNSUPPORTED_VERSION';
  if (!typesByDirection.get(direction).has(value.type)) return 'UNKNOWN_TYPE';
  return 'INVALID_FIELD';
}

const coverage = new Map(DIRECTIONS.flatMap((direction) => [...typesByDirection.get(direction)].map((type) => [`${direction}/${type}`, { valid: 0, invalid: 0 }])));
const controls = controlCases(files);
for (const testCase of controls) {
  const parsed = caseValue(testCase);
  const verdict = parsed.ok ? validator.validate(testCase.direction, parsed.value) : { valid: false, errors: 'not JSON' };
  if (verdict.valid !== testCase.valid) {
    fail(`${testCase.id}: vector says ${testCase.valid ? 'valid' : 'invalid'}, schema says ${verdict.valid ? 'valid' : `invalid (${verdict.errors})`}`);
  }
  if (!testCase.valid) {
    const expected = classify(testCase.direction, parsed);
    if (testCase.error !== expected) fail(`${testCase.id}: error must be ${expected} by the classification order, found ${testCase.error}`);
  }
  const counts = parsed.ok && coverage.get(`${testCase.direction}/${parsed.value?.type}`);
  if (counts) counts[testCase.valid ? 'valid' : 'invalid']++;
}
for (const [key, counts] of coverage) {
  if (counts.valid === 0 || counts.invalid === 0) fail(`${key}: needs at least one valid and one invalid vector`);
}

// ── Audio vectors against the frame layout (protocol.md §8.1) ────────────

const HEADER_BYTES = 5;
const KINDS = new Set([1, 2]);
const audios = audioCases(files);
for (const testCase of audios) {
  const bytes = Buffer.from(testCase.bytes, 'hex');
  const valid = bytes.length >= HEADER_BYTES && KINDS.has(bytes[0]);
  if (valid !== testCase.valid) fail(`${testCase.id}: vector says ${testCase.valid ? 'valid' : 'invalid'}, the frame layout says ${valid ? 'valid' : 'invalid'}`);
  if (valid && testCase.frame) {
    const decoded = { kind: bytes[0], seq: bytes.readUInt32BE(1), payload: bytes.subarray(HEADER_BYTES).toString('hex') };
    if (JSON.stringify(decoded) !== JSON.stringify(testCase.frame)) fail(`${testCase.id}: frame must be ${JSON.stringify(decoded)}`);
  }
}

exitOnFailures();
console.log(`✓ spec ok: ${schemas.size} schemas, ${registry.capabilities.length} registered capabilities, ${controls.length} control vectors, ${audios.length} audio vectors`);

function exitOnFailures() {
  if (failures.length === 0) return;
  for (const message of failures) console.error(`✗ ${message}`);
  process.exit(1);
}
