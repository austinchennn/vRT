import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync, chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('.', import.meta.url));
const out = join(root, 'dist');
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'assets'), { recursive: true });
for (const entry of ['cli', 'drivers/typescript-client', 'drivers/typescript-server', 'fixtures/broken-client', 'fixtures/reject-server', 'fixtures/cancellation-client', 'fixtures/auth-server', 'fixtures/tool-stream-server', 'fixtures/held-tool-stream', 'fixtures/heartbeat-server', 'fixtures/held-heartbeat', 'fixtures/principal-server']) {
  await build({ entryPoints: [join(root, `src/node/${entry}.ts`)], outfile: join(out, `node/${entry}.js`),
    bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external',
    // Reference drivers travel with the package; no SDK dependency is imposed on external drivers.
    plugins: [{ name: 'inline-reference-sdk', setup(b) {
      b.onResolve({ filter: /^@vrealtime\// }, args => ({ path: fileURLToPath(new URL(`../packages/${args.path.split('/')[1]}/dist/${args.path.endsWith('/node') ? 'node/index.js' : 'index.js'}`, import.meta.url)) }));
    } }],
  });
}
cpSync(join(root, '../spec/schema'), join(out, 'assets/schema'), { recursive: true });
cpSync(join(root, '../spec/examples'), join(out, 'assets/examples'), { recursive: true });
cpSync(join(root, '../spec/capabilities.json'), join(out, 'assets/capabilities.json'));
const scenarios = ['phase1', 'cancellation', 'auth', 'server-tool-stream', 'server-heartbeat', 'server-principal'].flatMap(name => JSON.parse(readFileSync(join(root, `scenarios/${name}.json`), 'utf8')));
writeFileSync(join(out, 'assets/scenarios.json'), JSON.stringify(scenarios, null, 2));
cpSync(join(root, '../LICENSE'), join(root, 'LICENSE'));
chmodSync(join(out, 'node/cli.js'), 0o755);
console.log('Built standalone conformance CLI, reference drivers and spec assets');
