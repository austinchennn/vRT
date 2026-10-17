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
async function run(name, args = [], timeout = '900') {
  let result;
  try { result = await exec(process.execPath, [cli, 'server', '--profile', 'server-resume-rejection-v1', '--timeout-ms', timeout,
    '--exec', process.execPath, '--json', '--', join(root, `dist/node/${name}.js`), ...args], { timeout: 18000, maxBuffer: 1024 * 1024 }); }
  catch (error) { if (error.killed || !error.stdout) throw error; result = error; }
  return { code: result.code ?? 0, report: JSON.parse(result.stdout) };
}
const get = (report, kind) => report.cases.find(item => item.id === `server/resume-rejection/${kind}`);
test('official server rejects unknown/ahead/deleted history and accepts exact ACK boundary', async () => {
  const { code, report } = await run('drivers/typescript-server');
  assert.equal(code, 0, JSON.stringify(report));
  assert.equal(report.cases.length, 4); assert.equal(report.fullSuite, 'incomplete'); assert.deepEqual(report.capabilities, []);
  assert.ok(report.cases.every(item => item.status === 'pass'));
  assert.equal(get(report, 'unknown').actual.effects.sessions, 0);
  for (const kind of ['ahead', 'ack-history']) {
    const actual = get(report, kind).actual;
    assert.equal(actual.connections.length, 3); assert.equal(actual.effects.closedModels, 1);
    assert.equal(actual.connections[1].messages.find(message => message.type === 'error').seq, 3);
    assert.equal(actual.connections[2].close.code, 4404);
  }
  const boundary = get(report, 'ack-boundary').actual;
  assert.deepEqual(boundary.effects.receivedAcks, [{ connection: 1, upTo: 1 }]);
  assert.deepEqual(boundary.connections[1].messages.filter(message => message.seq > 0).map(message => message.seq), [2, 3]);
});
for (const [fault, kind, reason] of [
  ['new-unknown', 'unknown', /Peer closed|Timeout/],
  ['accept-ahead', 'ahead', /Timeout/],
  ['partial-history', 'ack-history', /Timeout/],
  ['reject-boundary', 'ack-boundary', /Peer closed/],
  ['no-close', 'ahead', /Timeout: wire close fence/],
  ['business-after-error', 'ahead', /Unexpected business\/replay/],
  ['keep-session', 'ahead', /Timeout/],
  ['bound-zero', 'ahead', /Wrong recovery error seq/],
  ['unknown-positive', 'unknown', /Wrong recovery error seq/],
  ['unknown-close', 'unknown', /4404/],
  ['recoverable', 'ahead', /Expected RESUME_FAILED recoverable=false/],
  ['drop-retained', 'ack-boundary', /Timeout/],
  ['changed-retained', 'ack-boundary', /Conflicting replay/],
  ['conflicting-replay', 'ack-boundary', /Conflicting replay/],
  ['missing-observations', 'unknown', /Recovery effects mismatch/],
]) test(`wire fault ${fault} fails its stable recovery case`, async () => {
  const { code, report } = await run('fixtures/resume-rejection-server', [fault]);
  assert.equal(code, 1); const result = get(report, kind);
  assert.equal(result.status, 'fail'); assert.match(result.actual.error, reason, JSON.stringify(result));
  assert.ok(result.stage); assert.ok(result.expected); assert.ok(result.actual.connections.length);
});
for (const fault of ['none', 'replay-repeat', 'error-repeat', 'alternative-close', 'no-ready']) test(`independent correct policy/trace ${fault} passes`, async () => {
  const { code, report } = await run('fixtures/resume-rejection-server', [fault]);
  assert.equal(code, 0, JSON.stringify(report));
});
test('absent/malformed instrumentation or retained-ACK policy is incomplete, not wire nonconformance', async () => {
  for (const fault of ['legacy', 'malformed-capability', 'retain-policy']) {
    const { code, report } = await run('fixtures/resume-rejection-server', [fault]);
    assert.equal(code, 1); assert.ok(report.cases.every(item => item.status === 'incomplete'));
  }
});
test('success, held ACK/close/finish, command error, exits and early close clean all direct children', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'vrt-rejection-cleanup-'));
  try {
    for (const fault of ['none', 'hang-ready', 'hang-ack', 'error-ack', 'hang-closed', 'hang-finish', 'exit', 'exit-emit', 'early-second', 'no-close']) {
      const file = join(temp, fault);
      const { code, report } = await run('fixtures/resume-rejection-server', [fault, file], '450');
      assert.equal(code, fault === 'none' ? 0 : 1); assert.equal(report.cases.length, 4);
      const pids = (await readFile(file, 'utf8')).trim().split('\n').map(Number);
      assert.equal(pids.length, 4);
      for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      if (fault === 'hang-ack') assert.equal(get(report, 'ack-history').stage, 'ACK SDK receipt confirmation');
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
});
test('rejection profile rejects client/URL mode and heartbeat-only flags', async () => {
  for (const args of [['client', '--exec', process.execPath], ['server', '--url', 'ws://127.0.0.1:1'], ['server', '--exec', process.execPath, '--heartbeat-timeout-ms', '100']]) {
    await assert.rejects(exec(process.execPath, [cli, ...args, '--profile', 'server-resume-rejection-v1']), error => error.code === 2);
  }
});
