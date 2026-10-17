#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './runner.js';

try {
  const split = process.argv.indexOf('--');
  const argv = split < 0 ? process.argv.slice(2) : process.argv.slice(2, split);
  const driverArgs = split < 0 ? [] : process.argv.slice(split + 1);
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    profile: { type: 'string', default: 'handshake-interrupt-v1' }, exec: { type: 'string' }, url: { type: 'string' }, json: { type: 'boolean' },
    'heartbeat-timeout-ms': { type: 'string' },
    'timeout-ms': { type: 'string', default: '5000' },
  } });
  const mode = positionals[0];
  const profile = values.profile;
  if (profile !== 'handshake-interrupt-v1' && profile !== 'tool-cancellation-v1' && profile !== 'server-auth-v1' && profile !== 'server-tool-stream-v1' && profile !== 'server-heartbeat-v1' && profile !== 'server-resume-replay-v1') throw new Error('Unknown profile');
  if (profile === 'tool-cancellation-v1' && mode !== 'client') throw new Error('Cancellation profile requires client mode');
  if (profile === 'server-auth-v1' && (mode !== 'server' || !values.exec || values.url)) throw new Error('server-auth-v1 requires server mode and --exec');
  if (profile === 'server-tool-stream-v1' && (mode !== 'server' || !values.exec || values.url)) throw new Error('server-tool-stream-v1 requires server mode and --exec');
  if (profile === 'server-heartbeat-v1' && (mode !== 'server' || !values.exec || values.url)) throw new Error('server-heartbeat-v1 requires server mode and --exec');
  if (profile === 'server-resume-replay-v1' && (mode !== 'server' || !values.exec || values.url)) throw new Error('server-resume-replay-v1 requires server mode and --exec');
  const heartbeatTimeoutMs = Number(values['heartbeat-timeout-ms'] ?? '1200');
  if (!Number.isInteger(heartbeatTimeoutMs) || heartbeatTimeoutMs < 100 || heartbeatTimeoutMs > 60000 || (values['heartbeat-timeout-ms'] !== undefined && profile !== 'server-heartbeat-v1')) throw new Error('heartbeat-timeout-ms requires heartbeat profile and integer 100..60000');
  const timeoutMs = Number(values['timeout-ms']);
  if (positionals.length !== 1 || (mode !== 'client' && mode !== 'server') || !Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60000) {
    throw new Error('Usage: vrt-conformance client|server [--exec PROGRAM | --url WS_URL] [--json] [--profile NAME] [--timeout-ms 5000] [--heartbeat-timeout-ms 1200] -- DRIVER_ARGS (timeout 1..60000 ms)');
  }
  if (!values.exec && (mode === 'client' || !values.url)) throw new Error('Missing --exec or --url');
  if (values.exec && values.url) throw new Error('Choose --exec or --url, not both');
  const report = await run({ mode, profile, heartbeatTimeoutMs, args: driverArgs, timeoutMs,
    assets: join(dirname(fileURLToPath(import.meta.url)), '../assets'),
    ...(values.exec ? { command: values.exec } : {}), ...(values.url ? { url: values.url } : {}),
  });
  if (values.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`${report.profile}: protocol ${report.protocol}, ${report.mode}, capabilities ${JSON.stringify(report.capabilities)}`);
    for (const result of report.cases) console.log(`${result.status.toUpperCase()} ${result.id} (${result.durationMs.toFixed(1)} ms) stage=${result.stage} expected=${JSON.stringify(result.expected)} actual=${JSON.stringify(result.actual)}`);
    console.log(`Full suite: ${report.fullSuite}. Not covered: ${report.remaining.join(', ')}`);
  }
  process.exitCode = report.cases.length > 0 && report.cases.every(c => c.status === 'pass') ? 0 : 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2;
}
