import { boson } from '@vrealtime/boson';
import type { RealtimeSession } from '@vrealtime/core';
import { defaultSocketFactory, type ProviderSocket } from '@vrealtime/openai-compatible';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Truncation must change what Boson keeps, not only be acknowledged: Boson acks a
 * truncate even for an item that does not exist. So these read the stored item back
 * with `conversation.item.retrieve`, instead of trusting the ack or asking the model
 * (which can rebuild a cut reply from the prompt that asked for it).
 */
const apiKey = process.env['BOSON_API_KEY'];

type Message = Record<string, unknown> & { type?: string };

interface Live {
  session: RealtimeSession;
  received: Message[];
  socket: ProviderSocket;
}

const sessions: RealtimeSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});

async function connect(): Promise<Live> {
  const received: Message[] = [];
  let socket: ProviderSocket | undefined;
  const session = await boson({
    apiKey: apiKey!,
    turnDetection: null,
    // The adapter's own socket, tapped so the test can see and add raw provider messages.
    socket: async (url, headers) => {
      socket = await defaultSocketFactory(url, headers);
      socket.addEventListener('message', (event) => received.push(JSON.parse(String(event.data)) as Message));
      return socket;
    },
  }).connect({ instructions: 'Follow instructions literally.' });
  sessions.push(session);
  return { session, received, socket: socket! };
}

async function until<T>(find: () => T | undefined, what: string, ms = 45_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = find();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** One spoken reply; resolves to its item and how much audio it had. */
async function reply(live: Live, prompt: string): Promise<{ itemId: string; audioMs: number }> {
  const audio = new Map<string, number>();
  let ended = false;
  const offAudio = live.session.on('output.audio', (e) => audio.set(e.itemId, (audio.get(e.itemId) ?? 0) + (e.chunk.durationMs ?? 0)));
  const offEnd = live.session.on('response.end', () => { ended = true; });
  live.session.sendText(prompt);
  live.session.respond();
  await until(() => (ended ? true : undefined), 'response.end');
  offAudio();
  offEnd();
  const [itemId, audioMs] = [...audio][0] ?? [];
  if (!itemId || !audioMs) throw new Error('no audio in the reply');
  return { itemId, audioMs };
}

/** The text Boson stores for an assistant item, read back from the provider. */
async function storedText(live: Live, itemId: string): Promise<string> {
  const from = live.received.length;
  live.socket.send(JSON.stringify({ type: 'conversation.item.retrieve', item_id: itemId }));
  const message = await until(() => live.received.slice(from).find((m) => m.type === 'conversation.item.retrieved' || m.type === 'error'), 'conversation.item.retrieved');
  if (message.type === 'error') throw new Error(`retrieve failed: ${JSON.stringify(message['error'])}`);
  const content = (message['item'] as { content?: { type: string; text?: string; transcript?: string }[] }).content ?? [];
  return content.map((part) => part.text ?? part.transcript ?? '').join('');
}

async function truncated(live: Live, itemId: string, audioEndMs: number): Promise<void> {
  const from = live.received.length;
  live.session.truncate(itemId, audioEndMs);
  await until(() => live.received.slice(from).find((m) => m.type === 'conversation.item.truncated' && m['item_id'] === itemId), 'conversation.item.truncated');
}

const PROMPT = 'Say exactly: "First, the color is blue. Then, the animal is a tiger. Finally, the city is Lisbon."';
const MARKER = '<|INTERRUPTED|>';

describe.skipIf(!apiKey)('boson (live): truncation changes the stored conversation', () => {
  it('truncating to 0 ms leaves none of the reply', async () => {
    const live = await connect();
    const { itemId } = await reply(live, PROMPT);
    expect(await storedText(live, itemId)).toContain('Lisbon');
    await truncated(live, itemId, 0);
    expect(await storedText(live, itemId)).toBe('');
  });

  it('truncating part way keeps only the start of the reply', async () => {
    const live = await connect();
    const { itemId, audioMs } = await reply(live, PROMPT);
    const full = await storedText(live, itemId);
    await truncated(live, itemId, Math.round(audioMs * 0.35));
    const kept = await storedText(live, itemId);
    const heard = kept.replace(MARKER, '');
    expect(heard.length).toBeGreaterThan(0);
    expect(heard.length).toBeLessThan(full.length);
    expect(full.startsWith(heard.trimEnd())).toBe(true);
    expect(kept).not.toContain('Lisbon');
  });
});
