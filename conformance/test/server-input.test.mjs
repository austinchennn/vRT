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
async function run(name, args = [], timeout = '1800') {
  let result;
  try { result = await exec(process.execPath, [cli, 'server', '--profile', 'server-input-validation-v1', '--timeout-ms', timeout,
    '--exec', process.execPath, '--json', '--', join(root, `dist/node/${name}.js`), ...args], { timeout: 30000, maxBuffer: 1024 * 1024 }); }
  catch (error) { if (error.killed || !error.stdout) throw error; result = error; }
  return { code: result.code ?? 0, report: JSON.parse(result.stdout) };
}
const get = (report, kind) => report.cases.find(item => item.id === `server/input/${kind}`);
test('official public SDK passes input priority, session boundaries, binary and model observations', async () => {
  const { code, report } = await run('drivers/typescript-server');
  assert.equal(code, 0, JSON.stringify(report));
  assert.equal(report.fullSuite, 'incomplete');
  assert.deepEqual(report.capabilities, []);
  assert.equal(report.cases.length, 7);
  assert.ok(report.cases.every(item => item.status === 'pass'));
  assert.ok(get(report, 'control-post').actual.tested.includes('client/envelope/version-before-type'));
  assert.ok(get(report, 'types').actual.tested.includes('input/type/proto'));
  assert.equal(get(report, 'binary-pre').actual.tested.length, 9);
  assert.equal(get(report, 'audio-before-ready').actual.effects.audio.length, 1);
  assert.equal(get(report, 'audio-ready').actual.effects.audio[0].hex, '02000300');
});
for (const [fault, kind, reason] of [
  ['priority', 'control-pre', /Expected UNSUPPORTED_VERSION/],
  ['control-effect', 'control-post', /Unexpected model inputs/],
  ['binary-effect', 'binary-post', /Unexpected model inputs/],
  ['close-error', 'control-pre', /closed|open|CLOSING|CLOSED/i],
  ['buffer-pre', 'audio-before-ready', /Unexpected model inputs/],
  ['advance-invalid', 'control-post', /Unexpected model inputs/],
  ['bound-zero', 'control-post', /session error sequence boundary/],
  ['sessionless-positive', 'control-pre', /session error sequence boundary/],
  ['audio-ack', 'audio-ready', /Audio advanced control ACK cursor/],
  ['audio-sequence', 'audio-ready', /Noncontiguous sequence/],
  ['conflicting-marker', 'audio-ready', /Conflicting replay/],
  ['unexpected-binary', 'audio-ready', /Unexpected binary frame/],
  ['missing-observations', 'audio-ready', /Missing\/invalid model input observations/],
]) test(`real wire fault ${fault} fails stable input case`, async () => {
  const { code, report } = await run('fixtures/input-server', [fault]);
  assert.equal(code, 1);
  const item = get(report, kind);
  assert.equal(item.status, 'fail'); assert.match(item.actual.error, reason);
  assert.ok(item.stage); assert.ok(item.expected);
});
for (const fault of ['none', 'ignore-empty', 'zero-ack', 'replay-marker']) test(`independent valid wire fixture ${fault} passes`, async () => {
  const { code, report } = await run('fixtures/input-server', [fault]);
  assert.equal(code, 0, JSON.stringify(report));
});
test('legacy input instrumentation is incomplete and nonzero', async () => {
  const { code, report } = await run('fixtures/input-server', ['legacy']);
  assert.equal(code, 1); assert.ok(report.cases.every(item => item.status === 'incomplete'));
});
test('input success, timeout, exit, early close and repeated cleanup leave no direct child', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'vrt-input-cleanup-'));
  try {
    for (const fault of ['none', 'hang-ready', 'hang-finish', 'exit', 'early-close']) {
      const file = join(temp, fault);
      const { code, report } = await run('fixtures/input-server', [fault, file], '500');
      assert.equal(code, fault === 'none' ? 0 : 1);
      assert.equal(report.cases.length, 7);
      if (fault === 'hang-finish') assert.ok(report.cases.every(item => item.stage === 'drain input observations'));
      const pids = (await readFile(file, 'utf8')).trim().split('\n').map(Number);
      assert.equal(pids.length, 7);
      for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
});
test('input profile rejects client mode and bare URL', async () => {
  for (const args of [['client', '--exec', process.execPath], ['server', '--url', 'ws://127.0.0.1:1']]) {
    await assert.rejects(exec(process.execPath, [cli, ...args, '--profile', 'server-input-validation-v1']), error => error.code === 2);
  }
});
