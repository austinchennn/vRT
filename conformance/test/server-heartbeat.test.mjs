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
async function run(driver, args = [], extra = []) {
  let result;
  try { result = await exec(process.execPath, [cli, 'server', '--profile', 'server-heartbeat-v1', '--timeout-ms', '1000', '--exec', process.execPath, '--json', ...extra, '--', join(root, `dist/node/${driver}.js`), ...args], { timeout: 30000, maxBuffer: 1024 * 1024 }); }
  catch (error) { if (error.killed || !error.stdout) throw error; result = error; }
  return { code: result.code ?? 0, report: JSON.parse(result.stdout) };
}
const get = (report, kind) => report.cases.find(c => c.id === `server/heartbeat/${kind}`);
test('official server: every ping state, all data activities, timeout and minimal resume', async () => {
  for (const timeout of [1200, 101, 2401]) {
    const { code, report } = await run('drivers/typescript-server', [], ['--heartbeat-timeout-ms', String(timeout)]);
    assert.equal(code, 0, JSON.stringify(report));
    assert.equal(report.profile, 'server-heartbeat-v1'); assert.equal(report.fullSuite, 'incomplete');
    assert.deepEqual(report.capabilities, []);
    assert.equal(report.cases.length, 8); assert.ok(report.cases.every(c => c.status === 'pass'));
    assert.equal(get(report, 'pong-ready').actual.nextSequencedError, 1);
    assert.equal(get(report, 'idle-resume').actual.resume.sameSession, true);
    assert.equal(get(report, 'idle-resume').actual.resume.resumedFrom, 0);
    for (const kind of ['activity-context', 'activity-malformed', 'activity-binary']) {
      const actual = get(report, kind).actual;
      assert.deepEqual(actual.received.map(point => point.type), ['hello', kind]);
      assert.equal(actual.settings.timeoutMs, timeout); assert.equal(actual.close.code, 4408);
      assert.equal(actual.timeline[1].serverOpen, true);
      assert.ok(actual.timeline[1].at > timeout);
      const receivedAt = actual.received[1].at;
      const closeAt = actual.timeline.at(-1).closeRequestedAt;
      assert.ok(closeAt >= receivedAt + timeout && closeAt <= receivedAt + timeout + Math.ceil(timeout / 2));
    }
  }
});
for (const [fault, kind, reason] of [
  ['buffer-opening-ping', 'pong-opening', /Timeout: heartbeat pong/],
  ['only-ping', 'activity-context', /closed before inactivity/],
  ['only-ping', 'activity-malformed', /closed before inactivity/],
  ['only-ping', 'activity-binary', /closed before inactivity/],
  ['never-close', 'idle-sessionless', /Timeout: wire close/],
  ['early-close', 'idle-sessionless', /closed before inactivity/],
  ['wrong-close', 'idle-sessionless', /4408.*1000/],
  ['destroy-session', 'idle-resume', /same-session ready/],
  ['outbound-resets', 'idle-resume', /Timeout: wire close/],
  ['number-pong', 'pong-ready', /schema|seq 0/],
]) test(`wire fault ${fault} detected at ${kind}`, async () => {
  const { code, report } = await run('fixtures/heartbeat-server', [fault], ['--timeout-ms', '400']);
  assert.equal(code, 1);
  const result = get(report, kind); assert.equal(result.status, 'fail');
  assert.match(result.actual.error, reason);
  assert.ok(result.actual.heartbeat.settings); assert.ok(result.stage);
  if (fault === 'destroy-session') assert.ok(result.actual.heartbeat.resume.trace.some(m => m.type === 'error' && m.code === 'RESUME_FAILED'));
});
test('minimal resume uses observed server cursor and preserves new control sequence continuity', async () => {
  const { code, report } = await run('fixtures/heartbeat-server', ['control-cursor']);
  assert.equal(code, 0, JSON.stringify(report));
  const resume = get(report, 'idle-resume').actual.resume;
  assert.equal(resume.serverCursor, 1);
  assert.ok(resume.trace.some(m => m.type === 'turn.state' && m.seq === 2));
});
test('missing heartbeat instrumentation is incomplete without silently upgrading a driver', async () => {
  for (const [name, args] of [['fixtures/reject-server', []], ['fixtures/heartbeat-server', ['missing-instrumentation']]]) {
    const { code, report } = await run(name, args);
    assert.equal(code, 1); assert.ok(report.cases.every(c => c.status === 'incomplete'));
  }
});
test('success, no response, held opening, exit and clock failure clean direct children', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'vrt-heartbeat-cleanup-'));
  try {
    for (const fault of ['none', 'no-response', 'hold-opening', 'exit', 'clock-error']) {
      const file = join(temp, fault);
      const { code, report } = await run('fixtures/heartbeat-server', [fault, file], ['--timeout-ms', '400']);
      assert.equal(code, fault === 'none' ? 0 : 1, JSON.stringify(report)); assert.equal(report.cases.length, 8);
      if (fault === 'clock-error') assert.match(get(report, 'idle-sessionless').actual.error, /Injected clock failure/);
      const pids = (await readFile(file, 'utf8')).trim().split('\n').map(Number);
      assert.equal(pids.length, 8);
      for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
});
test('real SDK opening hook left held fails boundedly and leaves no process', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'vrt-heartbeat-held-'));
  try {
    const file = join(temp, 'pids');
    const { code, report } = await run('fixtures/held-heartbeat', [file], ['--timeout-ms', '400']);
    assert.equal(code, 1);
    const opening = get(report, 'pong-opening'); assert.equal(opening.status, 'fail');
    assert.equal(opening.stage, 'release opening'); assert.match(opening.actual.error, /Timeout: driver releaseHeartbeatOpening/);
    for (const pid of (await readFile(file, 'utf8')).trim().split('\n').map(Number)) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally { await rm(temp, { recursive: true, force: true }); }
});
test('heartbeat CLI rejects unsupported modes and invalid local timing configuration', async () => {
  for (const args of [
    ['client', '--profile', 'server-heartbeat-v1', '--exec', process.execPath],
    ['server', '--profile', 'server-heartbeat-v1', '--url', 'ws://127.0.0.1:1'],
    ...['0', '-1', '99', '1.5', 'NaN', '60001'].map(value => ['server', '--profile', 'server-heartbeat-v1', '--exec', process.execPath, '--heartbeat-timeout-ms', value]),
    ['server', '--profile', 'server-auth-v1', '--exec', process.execPath, '--heartbeat-timeout-ms', '1200'],
  ]) await assert.rejects(exec(process.execPath, [cli, ...args]), error => error.code === 2);
});
