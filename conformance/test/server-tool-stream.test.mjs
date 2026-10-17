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
  try { result = await exec(process.execPath, [cli, 'server', '--profile', 'server-tool-stream-v1', '--timeout-ms', timeout,
    '--exec', process.execPath, '--json', '--', join(root, `dist/node/${name}.js`), ...args], { timeout: 20000, maxBuffer: 1024 * 1024 }); }
  catch (error) { if (error.killed || !error.stdout) throw error; result = error; }
  return { code: result.code ?? 0, report: JSON.parse(result.stdout) };
}
const get = (report, kind) => report.cases.find(c => c.id === `server/tool-stream/${kind}`);
test('public SDK passes negotiated/legacy, interleaved, direct, failed and cancelled streams', async () => {
  const { code, report } = await run('drivers/typescript-server');
  assert.equal(code, 0, JSON.stringify(report));
  assert.equal(report.profile, 'server-tool-stream-v1');
  assert.equal(report.fullSuite, 'incomplete');
  assert.deepEqual(report.capabilities, ['tool-stream-v1']);
  assert.deepEqual(report.cases.map(c => [c.id, c.status]), ['baseline', 'lifecycle', 'no-delta', 'failed', 'cancelled'].map(kind => [`server/tool-stream/${kind}`, 'pass']));
  assert.deepEqual(get(report, 'baseline').actual.capabilities, []);
  const lifecycle = get(report, 'lifecycle').actual;
  for (const id of ['stream-a', 'stream-b']) {
    assert.deepEqual(lifecycle.calls[id], ['start', 'arguments-delta', 'arguments-delta', 'arguments-complete', 'progress', 'settled']);
    assert.deepEqual(lifecycle.effects.calls[id], { started: 1, committed: 1 });
  }
  assert.deepEqual(get(report, 'no-delta').actual.calls['stream-a'], ['start', 'arguments-complete', 'settled']);
  for (const kind of ['failed', 'cancelled']) {
    assert.deepEqual(get(report, kind).actual.effects.calls['stream-a'], { started: 0, committed: 0 });
    assert.equal(get(report, kind).actual.calls['stream-a'].at(-1), kind);
  }
});
for (const [fault, kind, reason] of [
  ['missing-effects', 'lifecycle', /Missing\/nonzero effects/],
  ['unnegotiated-stream', 'baseline', /Unnegotiated/],
  ['unoffered-capability', 'baseline', /unoffered/],
  ['progress-early', 'lifecycle', /Progress before/],
  ['duplicate-terminal', 'lifecycle', /after terminal/],
  ['missing-terminal', 'lifecycle', /Missing terminal.*live completion/],
  ['conflicting-replay', 'lifecycle', /Conflicting replay/],
  ['legacy-with-stream', 'lifecycle', /Legacy preview/],
  ['complete-twice', 'lifecycle', /Duplicate arguments-complete/],
  ['identity-change', 'lifecycle', /identity changed/],
  ['output-leak', 'lifecycle', /output leaked/],
  ['reopen', 'lifecycle', /after terminal/],
]) test(`wire fault ${fault} fails matching stream case`, async () => {
  const { code, report } = await run('fixtures/tool-stream-server', [fault]);
  assert.equal(code, 1);
  const result = get(report, kind);
  assert.equal(result.status, 'fail'); assert.match(result.actual.error, reason);
  assert.ok(result.stage);
});
test('same-seq terminal retransmission passes, without double counting', async () => {
  const { code, report } = await run('fixtures/tool-stream-server', ['replay-terminal']);
  assert.equal(code, 0, JSON.stringify(report));
  assert.equal(get(report, 'lifecycle').actual.calls['stream-a'].filter(p => p === 'settled').length, 1);
});
test('missing optional capability or legacy instrumentation is incomplete', async () => {
  const declined = await run('fixtures/tool-stream-server', ['decline-capability']);
  assert.equal(declined.code, 1);
  assert.equal(get(declined.report, 'baseline').status, 'pass');
  assert.ok(declined.report.cases.slice(1).every(c => c.status === 'incomplete'));
  const malformed = await run('fixtures/tool-stream-server', ['malformed-instrumentation']);
  assert.equal(malformed.code, 1);
  assert.ok(malformed.report.cases.every(c => c.status === 'incomplete'));
  const legacy = await run('fixtures/reject-server');
  assert.equal(legacy.code, 1);
  assert.ok(legacy.report.cases.every(c => c.status === 'incomplete'));
});
test('early connection close is incomplete rather than a false missing-terminal violation', async () => {
  const { code, report } = await run('fixtures/tool-stream-server', ['early-close']);
  assert.equal(code, 1);
  assert.ok(report.cases.every(c => c.status === 'incomplete'), JSON.stringify(report));
  assert.ok(report.cases.every(c => !/Missing terminal/.test(c.actual.error)));
});
test('success, held work, early exit/close and no response leave no directly managed process', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'vrt-stream-cleanup-'));
  try {
    for (const fault of ['none', 'hang-ready', 'hang-release', 'hold-tool', 'exit', 'early-close']) {
      const file = join(temp, fault);
      const { code, report } = await run('fixtures/tool-stream-server', [fault, file], '500');
      assert.equal(code, fault === 'none' ? 0 : 1);
      assert.equal(report.cases.length, 5);
      const pids = (await readFile(file, 'utf8')).trim().split('\n').map(Number);
      assert.equal(pids.length, 5);
      for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
});
test('real SDK tool held without release fails boundedly and leaves no process', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'vrt-stream-held-sdk-'));
  try {
    const file = join(temp, 'pids');
    const { code, report } = await run('fixtures/held-tool-stream', [file], '500');
    assert.equal(code, 1);
    for (const kind of ['baseline', 'lifecycle', 'no-delta']) {
      assert.equal(get(report, kind).status, 'fail');
      assert.equal(get(report, kind).stage, 'drain scenario work');
      assert.match(get(report, kind).actual.error, /Timeout: driver finishStream/);
    }
    for (const pid of (await readFile(file, 'utf8')).trim().split('\n').map(Number)) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally { await rm(temp, { recursive: true, force: true }); }
});
test('stream profile rejects client mode and bare URL', async () => {
  for (const args of [ ['client', '--exec', process.execPath], ['server', '--url', 'ws://127.0.0.1:1'] ]) {
    await assert.rejects(exec(process.execPath, [cli, ...args, '--profile', 'server-tool-stream-v1']), error => error.code === 2);
  }
});

test('human reports include stable ID, expectation, actual failure and stage', async () => {
  await assert.rejects(exec(process.execPath, [cli, 'server', '--profile', 'server-tool-stream-v1', '--exec', process.execPath, '--', join(root, 'dist/node/fixtures/tool-stream-server.js'), 'progress-early']), error => {
    assert.equal(error.code, 1);
    assert.match(error.stdout, /FAIL server\/tool-stream\/lifecycle/);
    assert.match(error.stdout, /stage=parameter wire fence expected=/);
    assert.match(error.stdout, /actual=.*Progress before arguments-complete/);
    return true;
  });
});
