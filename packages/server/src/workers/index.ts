import type { AgentDefinition } from '@vrealtime/core';
import { Hub, type AttachOptions, type WebSocketLike } from '../index.js';

/** The Workers `WebSocket` surface the server needs (`accept()` plus event listeners). */
interface WorkersSocket extends WebSocketLike {
  accept(): void;
}

type WebSocketPairConstructor = new () => { 0: WorkersSocket; 1: WorkersSocket };

const hubs = new WeakMap<AgentDefinition, Hub>();

function hubFor(agent: AgentDefinition | Hub, options: AttachOptions | undefined): Hub {
  if (agent instanceof Hub) return agent;
  let hub = hubs.get(agent);
  if (!hub) {
    hub = new Hub(agent, options);
    hubs.set(agent, hub);
  }
  return hub;
}

/**
 * Upgrades a request to a vRealTime session on Cloudflare Workers or inside a
 * Durable Object's `fetch()`. Sessions live in memory (per isolate, or per object),
 * so route reconnects to the same Durable Object to resume. Use the standard,
 * non-hibernating WebSocket API.
 *
 * ```ts
 * export default { fetch: (request) => upgrade(agent, request) };
 * ```
 */
export function upgrade(agent: AgentDefinition | Hub, request: Request, options?: AttachOptions): Response {
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('Expected a WebSocket upgrade', { status: 426, headers: { Upgrade: 'websocket' } });
  }
  const Pair = (globalThis as { WebSocketPair?: WebSocketPairConstructor }).WebSocketPair;
  if (!Pair) throw new Error('@vrealtime/server/workers: upgrade() needs the Workers runtime (WebSocketPair)');
  const pair = new Pair();
  const client = pair[0];
  const server = pair[1];
  server.accept();
  hubFor(agent, options).attach(server, { headers: request.headers });
  return new Response(null, { status: 101, webSocket: client } as ResponseInit);
}

export type { AttachOptions, AuthRequest, Connection, Principal } from '../index.js';
export { Hub };
