/// <reference types="node" />
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentDefinition } from '@vrealtime/core';
import { Hub, type AttachOptions } from '../index.js';
import { DEBUG_PAGE } from './debug-page.js';

export interface ServeOptions extends AttachOptions {
  /** Default 8790; 0 picks a free port. */
  port?: number;
  /** Default `localhost`. */
  host?: string;
  /** Serve static files from this directory; its `index.html` replaces the debug page. */
  publicDir?: string | URL;
  /** Called once listening; logs the URL by default. */
  onListening?: (url: string) => void;
}

export interface RunningServer {
  url: string;
  port: number;
  hub: Hub;
  close(): Promise<void>;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
};

type RawData = Uint8Array | ArrayBuffer | Uint8Array[];

function toHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else if (value !== undefined) headers.set(name, value);
  }
  return headers;
}
const utf8 = new TextDecoder();

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  return data instanceof ArrayBuffer ? new Uint8Array(data) : data;
}

/**
 * Serves `agent` on Node: WebSocket protocol v1 on every path, the microphone
 * debug page (or `publicDir`) over HTTP. Needs the optional peer dependency `ws`.
 */
export async function serve(agent: AgentDefinition, options: ServeOptions = {}): Promise<RunningServer> {
  let ws: typeof import('ws');
  try {
    ws = await import('ws');
  } catch {
    throw new Error('@vrealtime/server/node: serve() needs the optional peer dependency "ws" (npm i ws)');
  }
  const hub = new Hub(agent, options);
  const publicDir = options.publicDir === undefined ? undefined : resolve(options.publicDir instanceof URL ? fileURLToPath(options.publicDir) : options.publicDir);
  const wss = new ws.WebSocketServer({ noServer: true });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    if (publicDir !== undefined) {
      const file = resolve(publicDir, `.${path.endsWith('/') ? `${path}index.html` : path}`);
      if (file !== publicDir && !file.startsWith(publicDir + sep)) {
        res.writeHead(403).end();
        return;
      }
      try {
        const body = await readFile(file);
        res.writeHead(200, { 'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream' }).end(req.method === 'HEAD' ? undefined : body);
      } catch {
        res.writeHead(404).end('Not found');
      }
      return;
    }
    if (path !== '/') {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, { 'content-type': CONTENT_TYPES['.html']! }).end(req.method === 'HEAD' ? undefined : DEBUG_PAGE);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => res.writeHead(500).end());
  });
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (client) => {
      const connection = hub.attach({
        send: (data) => client.send(data),
        close: (code, reason) => client.close(code, reason),
        get bufferedAmount() {
          return client.bufferedAmount;
        },
      }, { headers: toHeaders(req) });
      client.on('message', (data: RawData, isBinary: boolean) => connection.receive(isBinary ? toBytes(data) : utf8.decode(toBytes(data))));
      client.on('close', () => connection.closed());
      client.on('error', () => connection.closed());
    });
  });

  const host = options.host ?? 'localhost';
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 8790, host, () => {
      server.off('error', reject);
      resolveListen();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : (options.port ?? 8790);
  const url = `http://${host}:${port}`;
  (options.onListening ?? ((u) => console.log(`vRealTime listening on ${u}`)))(url);

  return {
    url,
    port,
    hub,
    async close() {
      for (const client of wss.clients) client.terminate();
      await hub.close();
      wss.close();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}
