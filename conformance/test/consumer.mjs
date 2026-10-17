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
  // A partial/corrupt scenario inventory must not silently become a smaller passing profile.
  const inventory = join(pkg, 'dist/assets/scenarios.json');
  const definitions = JSON.parse(readFileSync(inventory, 'utf8'));
  writeFileSync(inventory, JSON.stringify(definitions.filter(s => s.id !== 'client/interrupt/stale-call')));
  assert.throws(() => execFileSync(cli, ['client', '--exec', process.execPath, '--json', '--', join(pkg, 'dist/node/drivers/typescript-client.js')], { cwd: temp, encoding: 'utf8', stdio: 'pipe' }), error => {
    const report = JSON.parse(error.stdout);
    return error.status === 1 && report.cases.some(c => c.id === 'client/interrupt/stale-call' && c.status === 'incomplete');
  });
  console.log('Packed CLI passes client/server profile outside repository, no SDK installation required');
} finally { rmSync(temp, { recursive: true, force: true }); }
