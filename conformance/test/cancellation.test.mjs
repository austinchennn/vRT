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
const official = join(root, 'dist/node/drivers/typescript-client.js');
const fixture = join(root, 'dist/node/fixtures/cancellation-client.js');
const ids = ['client/cancellation/queued-running', 'client/cancellation/late-rejection'];
async function run(driver, args = [], options = []) {
  const argv = [cli, 'client', '--profile', 'tool-cancellation-v1', '--exec', process.execPath, '--json', ...options, '--', driver, ...args];
  try {
    const { stdout } = await exec(process.execPath, argv, { timeout: 15000, maxBuffer: 1024 * 1024 });
    return { code: 0, report: JSON.parse(stdout) };
  } catch (error) {
    if (error.killed || !error.stdout) throw error;
    return { code: error.code, report: JSON.parse(error.stdout) };
  }
}
test('public SDK cancels A, keeps B/C unstarted and suppresses late success/rejection', async () => {
  const { code, report } = await run(official);
  assert.equal(code, 0, JSON.stringify(report));
  assert.equal(report.profile, 'tool-cancellation-v1');
  assert.equal(report.fullSuite, 'incomplete');
  assert.deepEqual(report.capabilities, []);
  assert.deepEqual(report.cases.map(c => [c.id, c.status]), ids.map(id => [id, 'pass']));
  assert.deepEqual(report.cases.map(c => c.actual.releasedAs), ['success', 'rejection']);
  for (const entry of report.cases) {
    assert.deepEqual(entry.actual.effects.calls['cancel-A'], { received: true, started: 1, committed: 0, aborted: true, completed: 1 });
    for (const id of ['cancel-B', 'cancel-C']) assert.equal(entry.actual.effects.calls[id].started, 0);
    assert.equal(entry.actual.logicalResults, 3);
  }
});
for (const [mode, reason] of [['start-queued', /effects failed for cancel-B/], ['late-duplicate', /one logical result, received 2/]]) {
  test(`wire fault ${mode} fails at the stable cancellation case IDs`, async () => {
    const { code, report } = await run(fixture, [mode]);
    assert.equal(code, 1);
    assert.deepEqual(report.cases.map(c => c.id), ids);
    for (const entry of report.cases) {
      assert.equal(entry.status, 'fail');
      assert.equal(entry.stage, 'cancellation oracle');
      assert.match(entry.actual.error, reason);
      assert.ok(entry.actual.trace.some(m => m.type === 'tool.result'));
    }
  });
}
test('deferred INTERRUPTED settlement after A finishes is allowed by spec 7.2', async () => {
  const { code, report } = await run(fixture, ['deferred-result']);
  assert.equal(code, 0, JSON.stringify(report));
  assert.ok(report.cases.every(c => c.status === 'pass'));
});
test('same-seq result retransmission after release is not duplicate settlement', async () => {
  const { code, report } = await run(fixture, ['same-seq-replay']);
  assert.equal(code, 0, JSON.stringify(report));
  assert.ok(report.cases.every(c => c.status === 'pass'));
});
test('old driver is incomplete for new profile rather than silently upgraded', async () => {
  const old = join(root, 'dist/node/fixtures/broken-client.js');
  const { code, report } = await run(old);
  assert.equal(code, 1);
  assert.ok(report.cases.every(c => c.status === 'incomplete'));
  assert.match(report.cases[0].actual.error, /does not advertise/);
});
test('held release, premature exit and held finish fail boundedly with no driver PIDs left', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vrt-cancellation-cleanup-'));
  try {
    for (const mode of ['hold-release', 'exit-on-release', 'hang-finish', 'ignore-abort']) {
      const pidFile = join(directory, mode);
      const { code, report } = await run(fixture, [mode, pidFile], ['--timeout-ms', '1000']);
      assert.equal(code, 1);
      assert.ok(report.cases.every(c => c.status === 'fail'), JSON.stringify(report));
      const stage = mode === 'hang-finish' ? 'completion and close fence' : mode === 'ignore-abort' ? 'local cancellation signal' : 'release A after cancellation';
      assert.ok(report.cases.every(c => c.stage === stage), JSON.stringify(report));
      const pids = (await readFile(pidFile, 'utf8')).trim().split(/\s+/).map(Number);
      assert.equal(pids.length, 2);
      for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('invalid profile and unsupported server/profile combinations reject', async () => {
  for (const args of [['client', '--profile', 'unknown', '--exec', process.execPath], ['server', '--profile', 'tool-cancellation-v1', '--url', 'ws://localhost']]) {
    await assert.rejects(exec(process.execPath, [cli, ...args]), error => error.code === 2);
  }
});
