import WebSocket, { WebSocketServer } from 'ws';
import type { Wire } from '../report.js';
import { deferred, until } from './deadline.js';

/** Records the entire bounded trace through close, not just the first matching frame. */
export class Peer {
  readonly messages: Wire[] = [];
  readonly #changed = new Set<() => void>();
  readonly #closed = deferred<void>();
  #failure: Error | undefined;
  constructor(readonly socket: WebSocket) {
    socket.on('message', (bytes, binary) => {
      try {
        if (binary) throw new Error('Unexpected binary frame in text-only profile');
        if (this.messages.length >= 256) throw new Error('Trace frame limit exceeded');
        const message: unknown = JSON.parse(bytes.toString());
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Expected control object');
        this.messages.push(message as Wire);
      } catch (error) { this.#failure = error as Error; }
      this.#notify();
    });
    socket.on('error', error => { this.#failure = error; this.#notify(); });
    socket.on('close', () => { this.#closed.resolve(); this.#notify(); });
  }
  #notify(): void { for (const changed of [...this.#changed]) changed(); }
  send(message: Wire): void { this.socket.send(JSON.stringify(message)); }
  async expect(predicate: (m: Wire) => boolean, end: number, stage: string): Promise<Wire> {
    const found = deferred<Wire>();
    const check = () => {
      if (this.#failure) return found.reject(this.#failure);
      const message = this.messages.find(predicate);
      if (message) found.resolve(message);
      else if (this.socket.readyState === WebSocket.CLOSED) found.reject(new Error(`Peer closed: ${stage}`));
    };
    this.#changed.add(check);
    check();
    try { return await until(found.promise, end, stage); }
    finally { this.#changed.delete(check); }
  }
  async closed(end: number): Promise<void> {
    await until(this.#closed.promise, end, 'wire close fence');
    if (this.#failure) throw this.#failure;
  }
  async dispose(): Promise<void> {
    if (this.socket.readyState !== WebSocket.CLOSED) this.socket.terminate();
    await until(this.#closed.promise, performance.now() + 1000, 'peer disposal');
  }
}

export async function listen() {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 65536 });
  const connection = deferred<Peer>();
  const peers: Peer[] = [];
  wss.on('connection', socket => {
    const peer = new Peer(socket); peers.push(peer);
    if (peers.length === 1) connection.resolve(peer);
    else socket.close(1008, 'one connection per scenario');
  });
  await new Promise<void>((resolve, reject) => {
    wss.once('listening', resolve); wss.once('error', reject);
  });
  const address = wss.address();
  if (typeof address !== 'object' || address === null) throw new Error('No listening address');
  return {
    url: `ws://127.0.0.1:${address.port}`, connection: connection.promise,
    async close() {
      await Promise.all(peers.map(peer => peer.dispose()));
      await new Promise<void>((resolve, reject) => wss.close(error => error ? reject(error) : resolve()));
    },
  };
}
export async function dial(url: string, end: number): Promise<Peer> {
  const socket = new WebSocket(url, { maxPayload: 65536 });
  const peer = new Peer(socket);
  try {
    await until(new Promise<void>((resolve, reject) => {
      socket.once('open', resolve); socket.once('error', reject);
    }), end, 'WebSocket open');
    return peer;
  } catch (error) { await peer.dispose(); throw error; }
}
