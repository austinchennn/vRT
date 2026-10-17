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
const driver = name => join(root, `dist/node/${name}.js`);
async function run(mode, program, args = [], extra = []) {
  try {
    const result = await exec(process.execPath, [cli, mode, '--exec', program, '--json', ...extra, '--', ...args], { timeout: 15000, maxBuffer: 1024 * 1024 });
    return { code: 0, report: JSON.parse(result.stdout) };
  } catch (error) {
    if (error.killed || !error.stdout) throw error;
    return { code: error.code, report: JSON.parse(error.stdout) };
  }
}
test('official client passes baseline and stale-call profile', async () => {
  const { code, report } = await run('client', process.execPath, [driver('drivers/typescript-client')]);
  assert.equal(code, 0);
  assert.deepEqual(report.cases.map(c => [c.id, c.status]), [
    ['client/handshake/baseline', 'pass'], ['client/interrupt/stale-call', 'pass'],
  ]);
  assert.deepEqual(report.cases[1].actual.effects, { started: 0, committed: 0 });
  assert.deepEqual(report.capabilities, []);
  assert.equal(report.fullSuite, 'incomplete');
});
test('official server passes baseline and recoverable wrong-version handshake', async () => {
  const { code, report } = await run('server', process.execPath, [driver('drivers/typescript-server')]);
  assert.equal(code, 0);
  assert.equal(report.cases.length, 2);
  assert.ok(report.cases.every(c => c.status === 'pass'), JSON.stringify(report));
});
for (const [fault, reason] of [['execute-stale', /tool took effect/], ['duplicate-result', /one logical result, received 2/], ['no-result', /one logical result, received 0/], ['wrong-epoch', /Expected INTERRUPTED for epoch/]]) {
  test(`real wire fault ${fault} fails at interrupt case`, async () => {
    const { code, report } = await run('client', process.execPath, [driver('fixtures/broken-client'), fault]);
    assert.equal(code, 1);
    assert.equal(report.cases[0].status, 'pass');
    assert.equal(report.cases[1].id, 'client/interrupt/stale-call');
    assert.equal(report.cases[1].status, 'fail');
    assert.match(report.cases[1].actual.error, reason);
  });
}
test('same-seq retransmission is not a second logical result', async () => {
  const { code, report } = await run('client', process.execPath, [driver('fixtures/broken-client'), 'replay-result']);
  assert.equal(code, 0, JSON.stringify(report));
});
test('close fence sees a delayed duplicate queued by the driver', async () => {
  const { code, report } = await run('client', process.execPath, [driver('fixtures/broken-client'), 'delayed-duplicate']);
  assert.equal(code, 1);
  assert.match(report.cases[1].actual.error, /one logical result, received 2/);
});
test('unresponsive, exiting and malformed drivers fail boundedly and leave no process', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vrt-driver-cleanup-'));
  try {
    for (const fault of ['hang', 'exit', 'malformed', 'reject-ready', 'partial-line', 'handshake', 'ignore-term']) {
      const pidFile = join(directory, fault);
      const code = `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(pidFile)}, process.pid+'\\n'); ` + ({
        hang: `process.stdin.resume();`,
        'ignore-term': `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.stdin.resume();`,
        handshake: `const ws = new WebSocket(process.env.VRT_CONFORMANCE_URL); ws.addEventListener('error', () => {}); process.stdin.resume();`,
        exit: `process.exit(7);`,
        malformed: `console.log('invalid json'); process.stdin.resume();`,
        'reject-ready': `process.stdin.once('data', b => { const r=JSON.parse(b); console.log(JSON.stringify({requestId:r.requestId,ok:false,error:'refused'})); }); process.stdin.resume();`,
        'partial-line': `process.stdout.write('x'.repeat(70000)); process.stdin.resume();`,
      })[fault];
      const result = await run('client', process.execPath, ['--input-type=module', '-e', code], ['--timeout-ms', '300']);
      assert.equal(result.code, 1, fault);
      assert.ok(result.report.cases.every(c => c.status === 'fail'));
      for (const pid of (await readFile(pidFile, 'utf8')).trim().split('\n').filter(Boolean).map(Number)) {
        assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `${fault} leaked ${pid}`);
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('HTTP upgrade refusal exits without hanging', async () => {
  const { code, report } = await run('server', process.execPath, [driver('fixtures/reject-server')], ['--timeout-ms', '500']);
  assert.equal(code, 1);
  assert.ok(report.cases.every(c => c.status === 'fail'));
});
test('bad CLI input rejects promptly', async () => {
  for (const timeout of ['0', '0.5', '-1', 'NaN', 'Infinity', '60001']) {
    await assert.rejects(exec(process.execPath, [cli, 'client', '--exec', process.execPath, '--timeout-ms', timeout]), error => error.code === 2);
  }
});
