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
async function run(name, args = [], timeout = '1600') {
  let result;
  try { result = await exec(process.execPath, [cli, 'server', '--profile', 'server-resume-replay-v1', '--timeout-ms', timeout,
    '--exec', process.execPath, '--json', '--', join(root, `dist/node/${name}.js`), ...args], { timeout: 22000, maxBuffer: 1024 * 1024 }); }
  catch (error) { if (error.killed || !error.stdout) throw error; result = error; }
  return { code: result.code ?? 0, report: JSON.parse(result.stdout) };
}
const get = (report, kind) => report.cases.find(item => item.id === `server/resume/${kind}`);
test('official server replays suffix/all/empty history and replaces a live connection without duplicate context', async () => {
  const { code, report } = await run('drivers/typescript-server');
  assert.equal(code, 0, JSON.stringify(report));
  assert.equal(report.fullSuite, 'incomplete'); assert.deepEqual(report.capabilities, []);
  assert.equal(report.cases.length, 4); assert.ok(report.cases.every(item => item.status === 'pass'));
  assert.equal(get(report, 'from-zero').actual.processedCursor, 0);
  assert.equal(get(report, 'from-zero').actual.capturedSeq, 1);
  assert.equal(get(report, 'replace').actual.connections[0].close.code, 4000);
  for (const item of report.cases) {
    assert.equal(item.actual.effects.sessions, 1);
    assert.deepEqual(item.actual.effects.closedConnections, [1, 2]);
    assert.equal(item.actual.effects.contexts.length, 2);
    assert.equal(item.actual.connections.length, 2);
  }
});
for (const [fault, kind, reason] of [
  ['drop-middle', 'suffix', /Noncontiguous|Incomplete\/unexpected replay/],
  ['drop-last', 'suffix', /Noncontiguous|Incomplete\/unexpected replay/],
  ['changed-content', 'suffix', /Replay\/marker changed/],
  ['renumber', 'suffix', /Noncontiguous|Conflicting replay/],
  ['wrong-cursor', 'suffix', /Session identity\/client cursor changed/],
  ['new-session', 'suffix', /Session identity\/client cursor changed/],
  ['new-model', 'suffix', /Expected one model/],
  ['duplicate-context', 'suffix', /Expected one model/],
  ['keep-old', 'replace', /Timeout: wire close fence/],
  ['wrong-close', 'replace', /Expected replacement close 4000/],
  ['transient-replay', 'suffix', /Expected one new ready/],
  ['conflicting-replay', 'from-zero', /Conflicting replay/],
  ['missing-observations', 'suffix', /Expected one model/],
]) test(`real wire fault ${fault} fails stable resume case`, async () => {
  const { code, report } = await run('fixtures/resume-server', [fault]);
  assert.equal(code, 1);
  const result = get(report, kind);
  assert.equal(result.status, 'fail'); assert.match(result.actual.error, reason);
  assert.ok(result.stage); assert.ok(result.expected);
  assert.ok(result.actual.connections?.length >= 1);
});
for (const fault of ['none', 'replay-repeat']) test(`independent valid server ${fault} passes`, async () => {
  const { code, report } = await run('fixtures/resume-server', [fault]);
  assert.equal(code, 0, JSON.stringify(report));
});
test('missing resume instrumentation is incomplete/nonzero', async () => {
  for (const fault of ['legacy', 'malformed-capability']) {
    const { code, report } = await run('fixtures/resume-server', [fault]);
    assert.equal(code, 1); assert.ok(report.cases.every(item => item.status === 'incomplete'));
  }
});
test('multi-peer success, held confirmations/replay/finish, exit and early resume close clean every direct child', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'vrt-resume-cleanup-'));
  try {
    for (const fault of ['none', 'hang-ready', 'hang-context', 'hang-closed', 'hold-replay', 'hang-finish', 'exit', 'exit-emit', 'early-second']) {
      const file = join(temp, fault);
      const { code, report } = await run('fixtures/resume-server', [fault, file], '500');
      assert.equal(code, fault === 'none' ? 0 : 1); assert.equal(report.cases.length, 4);
      const pids = (await readFile(file, 'utf8')).trim().split('\n').map(Number);
      assert.equal(pids.length, 4);
      for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      if (fault === 'early-second' || fault === 'hold-replay') assert.ok(report.cases.every(item => item.actual.connections.length === 2));
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
});
test('resume profile rejects client mode and URL-only connection', async () => {
  for (const args of [['client', '--exec', process.execPath], ['server', '--url', 'ws://127.0.0.1:1']]) {
    await assert.rejects(exec(process.execPath, [cli, ...args, '--profile', 'server-resume-replay-v1']), error => error.code === 2);
  }
  await assert.rejects(exec(process.execPath, [cli, 'server', '--profile', 'server-resume-replay-v1', '--exec', process.execPath,
    '--heartbeat-timeout-ms', '100', '--', join(root, 'dist/node/fixtures/resume-server.js')], { timeout: 5000 }),
    error => error.code === 2 && /heartbeat-timeout-ms requires heartbeat profile/.test(error.stderr));
});
