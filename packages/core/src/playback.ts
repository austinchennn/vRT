/** Truncate `itemId` to `audioEndMs`: the share of its `receivedMs` the user actually heard. */
export interface Truncation {
  itemId: string;
  audioEndMs: number;
  receivedMs: number;
}

/**
 * - `live`: audio of the current turn.
 * - `trailing`: its turn ended, but the edge may still be playing it.
 * - `cut`: trailing audio the user talked over; the next report decides how much was heard.
 * - `interrupted`: cut short; every report truncates it.
 */
type Phase = 'live' | 'trailing' | 'cut' | 'interrupted';

interface Entry {
  responseId: string;
  receivedMs: number;
  phase: Phase;
  playedMs: number | undefined;
  /** The agent's full text before the first truncation, so a later report cuts from the original. */
  fullText: string | undefined;
}

/** Trailing audio kept per session; older trailing items are forgotten. */
const TRAILING_KEPT = 16;

/**
 * Reconciles the audio sent to the edge with what the edge reports as heard
 * (spec/protocol.md §8.4, interruption guarantee 3), one record per audio item.
 * It only decides: every method returns the truncations the session applies to
 * the model and the transcript, so it is testable without either.
 */
export class PlaybackLedger {
  readonly #items = new Map<string, Entry>();

  /** Hot path: `ms` more audio of `itemId` went to the edge. */
  received(itemId: string, responseId: string, ms: number): void {
    const entry = this.#items.get(itemId);
    if (entry) entry.receivedMs += ms;
    else this.#items.set(itemId, { responseId, receivedMs: ms, phase: 'live', playedMs: undefined, fullText: undefined });
  }

  /** The edge reports how much of `itemId` was played. */
  report(itemId: string, playedMs: number): Truncation[] {
    const entry = this.#items.get(itemId);
    if (!entry) return [];
    entry.playedMs = playedMs;
    return this.#resolve(itemId, entry);
  }

  /** The current turn was interrupted: live audio of the responses `closed` selects was cut short. */
  interrupt(closed: (responseId: string) => boolean): Truncation[] {
    const out: Truncation[] = [];
    for (const [itemId, entry] of this.#items) {
      if (entry.phase !== 'live' || !closed(entry.responseId)) continue;
      entry.phase = 'interrupted';
      out.push(...this.#resolve(itemId, entry));
    }
    return out;
  }

  /** The turn ended: its live audio may still be playing. */
  endTurn(): void {
    let trailing = 0;
    for (const entry of this.#items.values()) {
      if (entry.phase === 'live') entry.phase = 'trailing';
      if (entry.phase === 'trailing' || entry.phase === 'cut') trailing++;
    }
    for (const [itemId, entry] of this.#items) {
      if (trailing <= TRAILING_KEPT) break;
      if (entry.phase !== 'trailing' && entry.phase !== 'cut') continue;
      this.#items.delete(itemId);
      trailing--;
    }
  }

  /** The user took the floor: trailing audio was heard only as far as the edge reports. */
  userTookFloor(): Truncation[] {
    const out: Truncation[] = [];
    for (const [itemId, entry] of this.#items) {
      if (entry.phase !== 'trailing') continue;
      entry.phase = 'cut';
      out.push(...this.#resolve(itemId, entry));
    }
    return out;
  }

  isInterrupted(itemId: string): boolean {
    return this.#items.get(itemId)?.phase === 'interrupted';
  }

  /** The item's text before its first truncation; `current` is remembered as that text the first time. */
  originalText(itemId: string, current: string): string {
    const entry = this.#items.get(itemId);
    if (!entry) return current;
    entry.fullText ??= current;
    return entry.fullText;
  }

  #resolve(itemId: string, entry: Entry): Truncation[] {
    const { playedMs } = entry;
    if (playedMs === undefined || entry.phase === 'live') return [];
    if (entry.phase === 'trailing' || entry.phase === 'cut') {
      if (Math.round(playedMs) >= Math.round(entry.receivedMs)) {
        // Heard in full: nothing to correct, and nothing left to remember.
        this.#items.delete(itemId);
        return [];
      }
      if (entry.phase === 'trailing') return [];
      entry.phase = 'interrupted';
    }
    return [{ itemId, audioEndMs: Math.max(0, Math.min(Math.round(playedMs), Math.round(entry.receivedMs))), receivedMs: entry.receivedMs }];
  }
}
