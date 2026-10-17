// Installs the exact tarball into an unrelated temp checkout, with no SDK peers.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('..', import.meta.url));
const temp = mkdtempSync(join(tmpdir(), 'vrt-conformance-consumer-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
try {
  const packed = JSON.parse(execFileSync(npm, ['pack', '--json', '--pack-destination', temp], { cwd: root, encoding: 'utf8' }))[0];
  execFileSync(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', '--prefix', temp, join(temp, packed.filename)], { cwd: temp, stdio: 'inherit' });
  const pkg = join(temp, 'node_modules/@vrealtime/conformance');
  const cli = join(temp, 'node_modules/.bin/vrt-conformance');
  const dependencies = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).dependencies;
  assert.deepEqual(Object.keys(dependencies).sort(), ['ajv', 'ws']);
  for (const mode of ['client', 'server']) {
    const output = execFileSync(cli, [mode, '--exec', process.execPath, '--json', '--', join(pkg, `dist/node/drivers/typescript-${mode}.js`)], { cwd: temp, encoding: 'utf8', timeout: 15000 });
    const report = JSON.parse(output);
    assert.ok(report.cases.every(c => c.status === 'pass'), output);
    assert.equal(report.fullSuite, 'incomplete');
  }
  const cancellation = JSON.parse(execFileSync(cli, ['client', '--profile', 'tool-cancellation-v1', '--exec', process.execPath, '--json', '--', join(pkg, 'dist/node/drivers/typescript-client.js')], { cwd: temp, encoding: 'utf8', timeout: 15000 }));
  assert.equal(cancellation.profile, 'tool-cancellation-v1');
  assert.equal(cancellation.fullSuite, 'incomplete');
  assert.equal(cancellation.cases.length, 2);
  assert.ok(cancellation.cases.every(c => c.status === 'pass'), JSON.stringify(cancellation));
  const authArgs = ['server', '--profile', 'server-auth-v1', '--exec', process.execPath, '--json', '--', join(pkg, 'dist/node/drivers/typescript-server.js')];
  const auth = JSON.parse(execFileSync(cli, authArgs, { cwd: temp, encoding: 'utf8', timeout: 15000 }));
  assert.equal(auth.cases.length, 4);
  assert.ok(auth.cases.every(c => c.status === 'pass'));
  assert.equal(auth.fullSuite, 'incomplete');
  const streamArgs = ['server', '--profile', 'server-tool-stream-v1', '--exec', process.execPath, '--json', '--', join(pkg, 'dist/node/drivers/typescript-server.js')];
  const stream = JSON.parse(execFileSync(cli, streamArgs, { cwd: temp, encoding: 'utf8', timeout: 15000 }));
  assert.equal(stream.profile, 'server-tool-stream-v1');
  assert.equal(stream.cases.length, 5);
  assert.ok(stream.cases.every(c => c.status === 'pass'));
  assert.deepEqual(stream.capabilities, ['tool-stream-v1']);
  assert.equal(stream.fullSuite, 'incomplete');
  const heartbeatArgs = ['server', '--profile', 'server-heartbeat-v1', '--heartbeat-timeout-ms', '1001', '--exec', process.execPath, '--json', '--', join(pkg, 'dist/node/drivers/typescript-server.js')];
  const heartbeat = JSON.parse(execFileSync(cli, heartbeatArgs, { cwd: temp, encoding: 'utf8', timeout: 15000 }));
  assert.equal(heartbeat.profile, 'server-heartbeat-v1');
  assert.equal(heartbeat.cases.length, 8);
  assert.ok(heartbeat.cases.every(c => c.status === 'pass'), JSON.stringify(heartbeat));
  assert.equal(heartbeat.fullSuite, 'incomplete');
  const inputArgs = ['server', '--profile', 'server-input-validation-v1', '--exec', process.execPath, '--json', '--', join(pkg, 'dist/node/drivers/typescript-server.js')];
  const input = JSON.parse(execFileSync(cli, inputArgs, { cwd: temp, encoding: 'utf8', timeout: 15000 }));
  assert.equal(input.profile, 'server-input-validation-v1');
  assert.equal(input.cases.length, 7);
  assert.ok(input.cases.every(item => item.status === 'pass'), JSON.stringify(input));
  assert.equal(input.fullSuite, 'incomplete');
  assert.deepEqual(input.capabilities, []);
  // A partial/corrupt scenario inventory must not silently become a smaller passing profile.
  const inventory = join(pkg, 'dist/assets/scenarios.json');
  const definitions = JSON.parse(readFileSync(inventory, 'utf8'));
  writeFileSync(inventory, JSON.stringify(definitions.filter(s => s.id !== 'client/interrupt/stale-call')));
  assert.throws(() => execFileSync(cli, ['client', '--exec', process.execPath, '--json', '--', join(pkg, 'dist/node/drivers/typescript-client.js')], { cwd: temp, encoding: 'utf8', stdio: 'pipe' }), error => {
    const report = JSON.parse(error.stdout);
    return error.status === 1 && report.cases.some(c => c.id === 'client/interrupt/stale-call' && c.status === 'incomplete');
  });
  writeFileSync(inventory, JSON.stringify(definitions.filter(s => s.id !== 'server/auth/wrong-token')));
  assert.throws(() => execFileSync(cli, authArgs, { cwd: temp, encoding: 'utf8', stdio: 'pipe' }), error => {
    const report = JSON.parse(error.stdout);
    return error.status === 1 && report.cases.some(c => c.id === 'server/auth/wrong-token' && c.status === 'incomplete');
  });
  writeFileSync(inventory, JSON.stringify(definitions.filter(s => s.id !== 'client/cancellation/late-rejection')));
  assert.throws(() => execFileSync(cli, ['client', '--profile', 'tool-cancellation-v1', '--exec', process.execPath, '--json', '--', join(pkg, 'dist/node/drivers/typescript-client.js')], { cwd: temp, encoding: 'utf8', stdio: 'pipe' }), error => {
    const report = JSON.parse(error.stdout);
    return error.status === 1 && report.cases.some(c => c.id === 'client/cancellation/late-rejection' && c.status === 'incomplete');
  });
  writeFileSync(inventory, JSON.stringify(definitions.filter(s => s.id !== 'server/tool-stream/lifecycle')));
  assert.throws(() => execFileSync(cli, streamArgs, { cwd: temp, encoding: 'utf8', stdio: 'pipe' }), error => {
    const report = JSON.parse(error.stdout);
    return error.status === 1 && report.cases.some(c => c.id === 'server/tool-stream/lifecycle' && c.status === 'incomplete');
  });
  writeFileSync(inventory, JSON.stringify(definitions.filter(s => s.id !== 'server/heartbeat/idle-resume')));
  assert.throws(() => execFileSync(cli, heartbeatArgs, { cwd: temp, encoding: 'utf8', stdio: 'pipe' }), error => {
    const report = JSON.parse(error.stdout);
    return error.status === 1 && report.cases.some(c => c.id === 'server/heartbeat/idle-resume' && c.status === 'incomplete');
  });
  writeFileSync(inventory, JSON.stringify(definitions.filter(item => item.id !== 'server/input/binary-post')));
  assert.throws(() => execFileSync(cli, inputArgs, { cwd: temp, encoding: 'utf8', stdio: 'pipe' }), error => {
    const report = JSON.parse(error.stdout);
    return error.status === 1 && report.cases.some(item => item.id === 'server/input/binary-post' && item.status === 'incomplete' && item.stage === 'inventory');
  });
  console.log('Packed CLI passes client/server profile outside repository, no SDK installation required');
} finally { rmSync(temp, { recursive: true, force: true }); }
