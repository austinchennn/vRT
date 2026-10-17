import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'dist/node/cli.js');
async function run(name, args = [], timeout = '1500') {
  let result;
  try { result = await exec(process.execPath, [cli, 'client', '--profile', 'client-control-validation-v1', '--timeout-ms', timeout,
    '--exec', process.execPath, '--json', '--', join(root, `dist/node/${name}.js`), ...args], { timeout: 25000, maxBuffer: 1024 * 1024 }); }
  catch (error) { if (error.killed || !error.stdout) throw error; result = error; }
  return { code: result.code ?? 0, report: JSON.parse(result.stdout) };
}
const get = (report, kind) => report.cases.find(item => item.id === `client/control/${kind}`);
test('public SDK reports invalid input, preserves state and executes/retransmits legal call once', async () => {
  const { code, report } = await run('drivers/typescript-client');
  assert.equal(code, 0, JSON.stringify(report));
  assert.equal(report.fullSuite, 'incomplete'); assert.deepEqual(report.capabilities, []);
  assert.equal(report.cases.length, 5);
  assert.ok(report.cases.every(item => item.status === 'pass'));
  assert.ok(get(report, 'types').actual.tested.includes('server/envelope/type-proto'));
  assert.ok(get(report, 'state-call').actual.tested.includes('local/call/missing-arguments'));
  for (const item of report.cases) {
    assert.equal(item.actual.effects.started, 1); assert.equal(item.actual.effects.committed, 1);
    assert.equal(item.actual.logicalResults, 1); assert.equal(item.actual.effects.closed, true);
  }
});
for (const [fault, kind, reason] of [
  ['missing-observations', 'framing', /Unexpected\/missing control observations/],
  ['priority', 'version', /Unexpected\/missing control observations/],
  ['ignore-error', 'framing', /Timeout: driver waitControlErrors/],
  ['execute-invalid', 'state-call', /Unexpected\/missing control observations/],
  ['advance-invalid', 'fields', /Timeout: legal tool result/],
  ['reserve-invalid', 'state-call', /Timeout: legal tool result/],
  ['epoch-invalid', 'state-call', /Expected observed epoch 1, got 99/],
  ['close-error', 'framing', /closed|CLOSED|not open|exited/i],
  ['duplicate-result', 'state-call', /Expected one logical tool result/],
  ['conflicting-result', 'state-call', /Conflicting replay/],
]) test(`wire/control fault ${fault} fails stable client case`, async () => {
  const { code, report } = await run('fixtures/control-client', [fault]);
  assert.equal(code, 1);
  const result = get(report, kind);
  assert.equal(result.status, 'fail'); assert.match(result.actual.error, reason);
  assert.ok(result.stage); assert.ok(result.expected);
});
for (const fault of ['none', 'replay-result']) test(`independent correct client ${fault} passes`, async () => {
  const { code, report } = await run('fixtures/control-client', [fault]);
  assert.equal(code, 0, JSON.stringify(report));
});
test('legacy client instrumentation is incomplete, not a silent pass', async () => {
  for (const fault of ['legacy', 'malformed-capability']) {
    const { code, report } = await run('fixtures/control-client', [fault]);
    assert.equal(code, 1); assert.ok(report.cases.every(item => item.status === 'incomplete'));
  }
});
test('bounded ready/error/result/finish/exit cleanup leaves no directly managed client', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'vrt-control-cleanup-'));
  try {
    for (const fault of ['none', 'hang-ready', 'ignore-error', 'hold-call', 'hang-finish', 'exit', 'exit-on-error', 'close-error']) {
      const file = join(temp, fault);
      const { code, report } = await run('fixtures/control-client', [fault, file], '500');
      assert.equal(code, fault === 'none' ? 0 : 1); assert.equal(report.cases.length, 5);
      const pids = (await readFile(file, 'utf8')).trim().split('\n').map(Number);
      assert.equal(pids.length, 5);
      for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
});
test('control profile rejects server mode and URL-only connection', async () => {
  for (const args of [['server', '--exec', process.execPath], ['client', '--url', 'ws://127.0.0.1:1']]) {
    await assert.rejects(exec(process.execPath, [cli, ...args, '--profile', 'client-control-validation-v1']), error => error.code === 2);
  }
});
