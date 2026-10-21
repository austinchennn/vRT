// Installs the release/ tarballs into an empty project, the way an app like vdoc
// would, then imports every entry point in Node and type-checks a TypeScript consumer.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { root, workspacePackages } from './packages.mjs';

const release = join(root, 'release');
const tarballs = Object.fromEntries(readdirSync(release).filter((f) => f.endsWith('.tgz')).map((f) => {
  const name = `@vrealtime/${f.replace(/^vrealtime-/, '').replace(/-\d+\.\d+\.\d+\.tgz$/, '')}`;
  return [name, `file:${join(release, f)}`];
}));
const expected = workspacePackages().map((p) => p.name).sort();
if (JSON.stringify(Object.keys(tarballs).sort()) !== JSON.stringify(expected)) {
  throw new Error(`release/ does not match the workspace packages; run npm run pack first.\n  have: ${Object.keys(tarballs).sort()}\n  want: ${expected}`);
}

const dir = mkdtempSync(join(tmpdir(), 'vrt-consumer-'));
const run = (cmd, args) => execFileSync(cmd, args, { cwd: dir, stdio: 'inherit' });
try {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'vrt-consumer',
    private: true,
    type: 'module',
    dependencies: { ...tarballs, ws: '8.18.3', react: '19.3.1', ai: '7.0.142' },
    devDependencies: { typescript: '5.9.3', '@types/node': '22.18.0', '@types/react': '19.3.0' },
    // Internal ranges must resolve to these tarballs, not the registry.
    overrides: tarballs,
  }, null, 2));
  run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error']);

  writeFileSync(join(dir, 'imports.mjs'), `
const checks = {
  '@vrealtime/core': ['defineAgent', 'startSession', 'tool', 'AgentSession'],
  '@vrealtime/protocol': ['decodeClientMessage', 'decodeServerMessage', 'encodeAudioFrame', 'Outbox', 'Inbox', 'GLOBAL_TOOL_IDS_V1'],
  '@vrealtime/openai-compatible': ['createCompatibleModel', 'fetchSocket'],
  '@vrealtime/boson': ['boson', 'fetchSocket', 'bosonTts'],
  '@vrealtime/openai': ['openai', 'openaiStt', 'openaiTts'],
  '@vrealtime/gemini': ['gemini'],
  '@vrealtime/cascade': ['cascade', 'SentenceBuffer'],
  '@vrealtime/ai-sdk': ['aiSdk', 'toModelMessages'],
  '@vrealtime/vad': ['energyVad'],
  '@vrealtime/vosk': ['voskStt'],
  '@vrealtime/server': ['attach', 'Hub'],
  '@vrealtime/server/node': ['serve'],
  '@vrealtime/server/workers': ['upgrade'],
  '@vrealtime/client': ['connect', 'ClientSession', 'createMicrophone', 'createSpeaker'],
  '@vrealtime/react': ['useRealtime'],
  '@vrealtime/testing': ['fakeModel', 'VirtualClock'],
};
for (const [entry, names] of Object.entries(checks)) {
  const mod = await import(entry);
  const missing = names.filter((n) => mod[n] === undefined);
  if (missing.length) throw new Error(entry + ' is missing ' + missing.join(', '));
}
// A real round trip through the installed packages.
const { defineAgent, startSession } = await import('@vrealtime/core');
const { fakeModel } = await import('@vrealtime/testing');
const agent = defineAgent({ model: fakeModel(), instructions: 'x' });
const session = await startSession(agent);
session.sendText('hi');
if (session.state !== 'thinking') throw new Error('runtime did not start a turn');
const another = await startSession(agent);
another.sendText('hi');
if (session.turn.id === another.turn.id) throw new Error('installed core reused a turn ID across sessions');
await Promise.all([session.close(), another.close()]);
console.log('imports ok: ' + Object.keys(checks).length + ' entry points');
`);
  run(process.execPath, ['imports.mjs']);

  writeFileSync(join(dir, 'consumer.ts'), `
import { defineAgent, type AgentDefinition, type ToolContext } from '@vrealtime/core';
import { boson, fetchSocket } from '@vrealtime/boson';
import { openai, openaiStt, openaiTts } from '@vrealtime/openai';
import { gemini } from '@vrealtime/gemini';
import { cascade } from '@vrealtime/cascade';
import { aiSdk } from '@vrealtime/ai-sdk';
import { energyVad } from '@vrealtime/vad';
import { attach, type AttachOptions, type Principal } from '@vrealtime/server';
import { serve } from '@vrealtime/server/node';
import { upgrade } from '@vrealtime/server/workers';
import { connect, type ClientTool } from '@vrealtime/client';
import { useRealtime } from '@vrealtime/react';
import { fakeModel } from '@vrealtime/testing';
import { decodeServerMessage, type ServerMessage } from '@vrealtime/protocol';

export const agent: AgentDefinition = defineAgent({
  model: boson({ apiKey: 'k', socket: fetchSocket(), voice: 'default' }),
  instructions: 'Edit the document.',
  clientTools: 'accept',
  vad: energyVad(),
});
export const models = [openai({ apiKey: 'k' }), gemini({ apiKey: 'k' }), fakeModel(), cascade({ stt: openaiStt({ apiKey: 'k' }), tts: openaiTts({ apiKey: 'k' }), llm: { async *stream() {} } })];
export const options: AttachOptions = {
  authenticate: async ({ token }): Promise<Principal | undefined> => (token ? { id: token, docId: 'doc-1' } : undefined),
  configure: (principal) => ({ instructions: 'Edit ' + String(principal?.['docId']) }),
};
export const applyOperations: ClientTool = { parameters: { type: 'object' }, run: (_args, context) => context.turnId };
export const serverTool = (context: ToolContext) => context.data;
export const message: ServerMessage | undefined = (() => { const r = decodeServerMessage('{}'); return r.ok ? r.message : undefined; })();
export { aiSdk, attach, connect, serve, upgrade, useRealtime };
`);
  const tsconfig = (moduleResolution, module) => JSON.stringify({
    compilerOptions: { target: 'ES2022', module, moduleResolution, strict: true, noEmit: true, skipLibCheck: true, lib: ['dom', 'esnext'], types: ['node'] },
    files: ['consumer.ts'],
  });
  for (const [name, resolution, module] of [['bundler', 'bundler', 'esnext'], ['nodenext', 'nodenext', 'nodenext']]) {
    writeFileSync(join(dir, `tsconfig.${name}.json`), tsconfig(resolution, module));
    run(join(dir, 'node_modules/.bin/tsc'), ['-p', `tsconfig.${name}.json`]);
    console.log(`types ok: moduleResolution ${resolution}`);
  }
} finally {
  if (!process.env.KEEP_CONSUMER) rmSync(dir, { recursive: true, force: true });
}
