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
const driver = name => join(root, `dist/node/${name}.js`);
async function run(name, args = [], timeout = '1500') {
  let result;
  try { result = await exec(process.execPath, [cli, 'server', '--profile', 'server-auth-v1', '--timeout-ms', timeout,
    '--exec', process.execPath, '--json', '--', driver(name), ...args], { timeout: 15000, maxBuffer: 1024 * 1024 }); }
  catch (error) { if (error.killed || !error.stdout) throw error; result = error; }
  return { code: result.code ?? 0, report: JSON.parse(result.stdout), output: result.stdout + result.stderr };
}
const find = (report, suffix) => report.cases.find(c => c.id === `server/auth/${suffix}`);
test('official auth profile: refusals, baseline ready and both session error boundaries', async () => {
  const { code, report } = await run('drivers/typescript-server');
  assert.equal(code, 0, JSON.stringify(report));
  assert.equal(report.profile, 'server-auth-v1');
  assert.equal(report.fullSuite, 'incomplete');
  assert.deepEqual(report.capabilities, []);
  assert.deepEqual(report.cases.map(c => [c.id, c.status]), ['missing-token', 'wrong-token', 'correct-token', 'error-sequence'].map(id => [`server/auth/${id}`, 'pass']));
  for (const id of ['missing-token', 'wrong-token']) {
    assert.equal(find(report, id).actual.close.code, 4401);
    assert.equal(find(report, id).actual.seq, 0);
  }
  assert.deepEqual(find(report, 'error-sequence').actual, { authorized: true, capabilities: [], beforeSeq: 0, afterSeq: 1, connectionUsable: true });
});
for (const [fault, suffix, reason] of [
  ['accept-wrong', 'wrong-token', /UNAUTHORIZED/],
  ['pre-seq-positive', 'error-sequence', /sessionless.*seq 0/i],
  ['post-seq-zero', 'error-sequence', /bound.*sequenced/i],
  ['wrong-close', 'missing-token', /4401/],
  ['close-before-error', 'wrong-token', /closed|Timeout/i],
  ['no-close', 'wrong-token', /Timeout/i],
]) {
  test(`wire fault ${fault} fails at stable auth case`, async () => {
    const { code, report } = await run('fixtures/auth-server', [fault], '600');
    assert.equal(code, 1);
    const result = find(report, suffix);
    assert.equal(result.status, 'fail');
    assert.match(result.actual.error, reason);
    assert.ok(result.stage);
    if (fault === 'no-close') assert.equal(result.stage, 'unauthorized close');
  });
}
test('legacy instrumentation is incomplete, rather than a silent auth pass', async () => {
  const { code, report } = await run('fixtures/reject-server');
  assert.equal(code, 1);
  assert.ok(report.cases.every(c => c.status === 'incomplete' && /instrumentation/.test(c.actual.error)));
});
test('auth failures clean direct processes and redact fresh credentials across wire/control/stderr', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'vrt-auth-cleanup-'));
  try {
    for (const fault of ['none', 'no-close', 'echo-token', 'reject-ready', 'exit', 'hang']) {
      const evidence = join(temp, fault);
      const result = await run('fixtures/auth-server', [fault, evidence], '600');
      assert.equal(result.code, fault === 'none' ? 0 : 1);
      const records = (await readFile(evidence, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      const setups = records.filter(record => record.pid);
      assert.equal(setups.length, 4);
      assert.equal(new Set(setups.map(record => record.tokenHash)).size, 4);
      const hashes = new Set(records.map(record => record.tokenHash ?? record.observedTokenHash));
      for (const candidate of result.output.match(/[0-9a-f]{64}/g) ?? []) {
        assert.ok(!hashes.has(createHash('sha256').update(candidate).digest('hex')), `${fault} leaked a test credential`);
      }
      if (['echo-token', 'reject-ready', 'exit'].includes(fault)) assert.match(result.output, /\[redacted\]/);
      for (const record of records) {
        if (record.pid) assert.throws(() => process.kill(record.pid, 0), { code: 'ESRCH' });
      }
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
});
test('auth profile rejects unsupported connection modes and unknown profiles', async () => {
  for (const args of [
    ['client', '--profile', 'server-auth-v1', '--exec', process.execPath],
    ['server', '--profile', 'server-auth-v1', '--url', 'ws://127.0.0.1:1'],
    ['server', '--profile', 'unknown', '--exec', process.execPath],
  ]) await assert.rejects(exec(process.execPath, [cli, ...args]), error => error.code === 2);
});
