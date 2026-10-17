import { appendFileSync } from 'node:fs';
import { heartbeatServer } from '../drivers/server-heartbeat.js';
import { control } from '../drivers/control.js';
let server: Awaited<ReturnType<typeof heartbeatServer>> | undefined;
if (process.argv[2]) appendFileSync(process.argv[2], process.pid + '\n');
async function close(): Promise<void> { await server?.close(); }
control(async (command, data) => {
  if (command === 'ready') { server = await heartbeatServer(data); return { url: server.url, timing: server.timing, driverCapabilities: ['server-heartbeat-v1'] }; }
  if (command === 'close') { await close(); await close(); return {}; }
  if (command === 'releaseHeartbeatOpening') return new Promise(() => {});
  if (!server) throw new Error('Not ready');
  return server.handle(command, data);
}, close);
