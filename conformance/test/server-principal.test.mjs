import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'dist/node/cli.js');
async function run(name, args = [], timeout = '900') {
  let result;
  try { result = await exec(process.execPath, [cli, 'server', '--profile', 'server-resume-principal-v1', '--timeout-ms', timeout,
    '--exec', process.execPath, '--json', '--', join(root, `dist/node/${name}.js`), ...args], { timeout: 18000, maxBuffer: 1024 * 1024 }); }
  catch (error) { if (error.killed || !error.stdout) throw error; result = error; }
  return { code: result.code ?? 0, report: JSON.parse(result.stdout), output: result.stdout + result.stderr };
}
const get = (report, kind) => report.cases.find(item => item.id === `server/resume-principal/${kind}`);
test('official SDK reauthenticates, isolates principal.id and preserves parked/live owners', async () => {
  const { code, report } = await run('drivers/typescript-server');
  assert.equal(code, 0, JSON.stringify(report)); assert.equal(report.cases.length, 4);
  assert.ok(report.cases.every(item => item.status === 'pass')); assert.equal(report.fullSuite, 'incomplete'); assert.deepEqual(report.capabilities, []);
  assert.deepEqual(get(report, 'same-owner').actual.effects.auth, [{ label: 'alice-a', resume: false }, { label: 'alice-b', resume: true }]);
  assert.equal(get(report, 'foreign-parked').actual.connections.length, 4);
  assert.equal(get(report, 'foreign-live').actual.connections.length, 2);
  assert.deepEqual(get(report, 'reauth').actual.effects.auth.map(item => item.label), ['alice-a', 'invalid', 'missing', 'alice-b']);
  for (const item of report.cases) { assert.equal(item.actual.effects.sessions, 1); assert.equal(item.actual.ownerPreserved, true); }
});
for (const [fault, kind, reason] of [
  ['skip-reauth', 'reauth', /Timeout/],
  ['token-bound', 'same-owner', /Same principal/],
  ['accept-foreign', 'foreign-parked', /Timeout/],
  ['leak-ready', 'foreign-parked', /Rejected principal/],
  ['leak-data', 'foreign-parked', /Rejected principal/],
  ['close-owner', 'foreign-live', /closed|open|Timeout/i],
  ['delete-owner', 'foreign-parked', /Same principal/],
  ['wrong-code', 'reauth', /Expected UNAUTHORIZED/],
  ['foreign-unauthorized', 'foreign-parked', /Expected RESUME_FAILED/],
  ['positive-error', 'foreign-parked', /seq 0/],
  ['new-model', 'same-owner', /Principal effects mismatch/],
  ['wrong-cursor', 'same-owner', /Owner identity/],
  ['fresh-session', 'same-owner', /Owner identity/],
  ['conflicting-replay', 'same-owner', /Conflicting replay/],
  ['missing-observations', 'same-owner', /Principal effects mismatch/],
]) test(`real wire fault ${fault} fails its stable principal case`, async () => {
  const { code, report } = await run('fixtures/principal-server', [fault]);
  assert.equal(code, 1); const result = get(report, kind);
  assert.equal(result.status, 'fail'); assert.match(result.actual.error, reason, JSON.stringify(result));
  assert.ok(result.stage); assert.ok(result.expected); assert.ok(result.actual.connections.length);
});
for (const fault of ['none', 'replay-repeat', 'sdk-throw']) test(`correct principal control ${fault} passes`, async () => {
  const { code, report } = await run('fixtures/principal-server', [fault]); assert.equal(code, 0, JSON.stringify(report));
});
test('missing/malformed principal instrumentation is incomplete/nonzero', async () => {
  for (const fault of ['legacy', 'malformed-capability']) {
    const { code, report } = await run('fixtures/principal-server', [fault]);
    assert.equal(code, 1); assert.ok(report.cases.every(item => item.status === 'incomplete'));
  }
});
test('multi-peer timeouts/exits/early closes and repeated cleanup leave no direct child', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'vrt-principal-cleanup-'));
  try {
    for (const fault of ['none', 'hang-ready', 'hang-auth', 'hang-closed', 'hang-context', 'hang-finish', 'hold-owner', 'early-owner', 'exit', 'exit-emit', 'no-close']) {
      const file = join(temp, fault);
      const { code, report } = await run('fixtures/principal-server', [fault, file], '450');
      assert.equal(code, fault === 'none' ? 0 : 1); assert.equal(report.cases.length, 4);
      const records = (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line)); assert.equal(records.length, 4);
      for (const record of records) assert.throws(() => process.kill(record.pid, 0), { code: 'ESRCH' });
      if (fault === 'hold-owner' || fault === 'early-owner') assert.ok(get(report, 'foreign-parked').actual.connections.length === 4);
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
});
test('all four credentials stay fresh/redacted across wire, control, stderr and URL failures', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'vrt-principal-secrets-'));
  try {
    for (const fault of ['echo-token', 'reject-ready', 'exit-secret', 'url-token']) {
      const file = join(temp, fault); const { code, output } = await run('fixtures/principal-server', [fault, file]);
      assert.equal(code, fault === 'echo-token' ? 0 : 1);
      const records = (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      const hashes = new Set(records.flatMap(record => record.hashes)); assert.equal(hashes.size, 16);
      for (const candidate of output.match(/[0-9a-f]{64}/g) ?? []) assert.ok(!hashes.has(createHash('sha256').update(candidate).digest('hex')), `${fault} leaked a credential`);
      if (fault !== 'url-token') assert.match(output, /\[redacted\]/);
      for (const record of records) assert.throws(() => process.kill(record.pid, 0), { code: 'ESRCH' });
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
});
test('principal profile rejects client/URL modes and heartbeat-only flags', async () => {
  for (const args of [['client', '--exec', process.execPath], ['server', '--url', 'ws://127.0.0.1:1'], ['server', '--exec', process.execPath, '--heartbeat-timeout-ms', '100']]) {
    await assert.rejects(exec(process.execPath, [cli, ...args, '--profile', 'server-resume-principal-v1']), error => error.code === 2);
  }
});
