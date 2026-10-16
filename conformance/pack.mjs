import { mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const destination = fileURLToPath(new URL('../release/', import.meta.url));
mkdirSync(destination, { recursive: true });
execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--pack-destination', destination], {
  cwd: fileURLToPath(new URL('.', import.meta.url)), stdio: 'inherit',
});
