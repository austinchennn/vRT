import { createInterface } from 'node:readline';
import type { Wire } from '../../report.js';
/** Drivers serialize requests. All application-owned tasks must drain before finish. */
export function control(handle: (command: string, data: Wire) => Promise<Wire>, cleanup: () => Promise<void>): void {
  const input = createInterface({ input: process.stdin });
  let chain = Promise.resolve();
  input.on('line', line => {
    chain = chain.then(async () => {
      let request: Wire;
      try { request = JSON.parse(line); }
      catch { console.error('Invalid JSONL request'); process.exitCode = 1; input.close(); return; }
      try {
        if (typeof request.requestId !== 'string' || typeof request.command !== 'string') throw new Error('Invalid request');
        const data = await handle(request.command, request.data ?? {});
        process.stdout.write(JSON.stringify({ requestId: request.requestId, ok: true, data }) + '\n');
      } catch (error) {
        process.stdout.write(JSON.stringify({ requestId: request.requestId, ok: false, error: String(error) }) + '\n');
      }
    }).catch(error => { console.error(error); process.exitCode = 1; });
  });
  input.on('close', () => { void chain.finally(cleanup).catch(error => { console.error(error); process.exitCode = 1; }); });
}
