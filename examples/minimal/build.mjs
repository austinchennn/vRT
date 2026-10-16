// Bundles the browser page (app.js + @vrealtime/client) into public/app.js.
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = (path) => fileURLToPath(new URL(path, import.meta.url));

await build({
  entryPoints: [here('./app.js')],
  outfile: here('./public/app.js'),
  bundle: true,
  format: 'esm',
  target: 'es2022',
  sourcemap: true,
  logLevel: 'warning',
});
