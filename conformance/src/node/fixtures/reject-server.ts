import { createServer } from 'node:http';
import { control } from '../drivers/control.js';
let server: ReturnType<typeof createServer> | undefined;
async function close(): Promise<void> {
  const current = server; server = undefined;
  if (current) await new Promise<void>(resolve => current.close(() => resolve()));
}
control(async command => {
  if (command === 'ready') {
    server = createServer();
    server.on('upgrade', (_request, socket) => socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No address');
    return { url: `ws://127.0.0.1:${address.port}` };
  }
  if (command === 'close') { await close(); return {}; }
  throw new Error('Unknown command');
}, close);
