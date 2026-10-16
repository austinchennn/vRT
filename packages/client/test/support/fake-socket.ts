import { PROTOCOL_VERSION, TRANSIENT_TYPES, decodeClientMessage, type ClientMessage, type ServerMessage, type Unsequenced } from '@vrealtime/protocol';

type Listener = (event: any) => void;

/** A browser-like WebSocket the tests drive by hand, playing the server side. */
export class FakeSocket {
  static instances: FakeSocket[] = [];
  /** Control frames the client sent that are not valid client messages (spec/); tests expect none. */
  static offSpec: string[] = [];
  readyState = 0;
  binaryType = 'blob';
  sent: (string | Uint8Array)[] = [];
  closedWith: [number | undefined, string | undefined] | undefined;
  #listeners: Record<string, Listener[]> = {};
  #serverSeq = 0;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  addEventListener(type: string, listener: Listener) {
    (this.#listeners[type] ??= []).push(listener);
  }
  send(data: string | Uint8Array) {
    const decoded = typeof data === 'string' ? decodeClientMessage(data) : undefined;
    if (decoded && !decoded.ok) FakeSocket.offSpec.push(`${decoded.error.message}: ${data}`);
    this.sent.push(data);
  }
  close(code?: number, reason?: string) {
    this.closedWith = [code, reason];
    this.drop(code ?? 1000, reason ?? '');
  }
  open() {
    this.readyState = 1;
    this.#fire('open', {});
  }
  drop(code = 1006, reason = '') {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.#fire('close', { code, reason });
  }
  /** Delivers a server message, stamping `seq` as a conforming server would unless `seq` is given. */
  server(message: Unsequenced<ServerMessage>, seq?: number) {
    const stamped = seq ?? (TRANSIENT_TYPES.has(message.type) ? 0 : ++this.#serverSeq);
    this.#fire('message', { data: JSON.stringify({ v: PROTOCOL_VERSION, seq: stamped, ...message }) });
  }
  binary(frame: Uint8Array) {
    this.#fire('message', { data: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) });
  }
  messages(): ClientMessage[] {
    return this.sent.filter((d): d is string => typeof d === 'string').map((d) => JSON.parse(d));
  }
  ofType<T extends ClientMessage['type']>(type: T) {
    return this.messages().filter((m): m is Extract<ClientMessage, { type: T }> => m.type === type);
  }
  #fire(type: string, event: unknown) {
    for (const listener of this.#listeners[type] ?? []) listener(event);
  }
}

export const latest = () => FakeSocket.instances.at(-1)!;

/** Lets queued promise callbacks run. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
