import { describe, expect, it } from 'vitest';
import { PlaybackLedger } from '../src/playback.js';

const cut = (itemId: string, audioEndMs: number, receivedMs: number) => [{ itemId, audioEndMs, receivedMs }];

describe('PlaybackLedger', () => {
  it('truncates interrupted live audio to the last report, and refines on later ones', () => {
    const ledger = new PlaybackLedger();
    ledger.received('a1', 'r1', 600);
    ledger.received('a1', 'r1', 400);
    expect(ledger.report('a1', 300)).toEqual([]);
    expect(ledger.interrupt((responseId) => responseId === 'r1')).toEqual(cut('a1', 300, 1000));
    expect(ledger.isInterrupted('a1')).toBe(true);
    expect(ledger.report('a1', 450.4)).toEqual(cut('a1', 450, 1000));
  });

  it('interrupts only the responses the session closed', () => {
    const ledger = new PlaybackLedger();
    ledger.received('a1', 'r1', 100);
    ledger.received('a2', 'r2', 100);
    ledger.interrupt((responseId) => responseId === 'r2');
    expect([ledger.isInterrupted('a1'), ledger.isInterrupted('a2')]).toEqual([false, true]);
  });

  it('never truncates past the audio received', () => {
    const ledger = new PlaybackLedger();
    ledger.received('a1', 'r1', 100);
    ledger.interrupt(() => true);
    expect(ledger.report('a1', 5000)).toEqual(cut('a1', 100, 100));
  });

  it('truncates trailing audio once the user takes the floor', () => {
    const ledger = new PlaybackLedger();
    ledger.received('a1', 'r1', 20000);
    ledger.endTurn();
    expect(ledger.report('a1', 3000)).toEqual([]);
    expect(ledger.userTookFloor()).toEqual(cut('a1', 3000, 20000));
    expect(ledger.isInterrupted('a1')).toBe(true);
  });

  it('waits for the report when the user took the floor first', () => {
    const ledger = new PlaybackLedger();
    ledger.received('a1', 'r1', 20000);
    ledger.endTurn();
    expect(ledger.userTookFloor()).toEqual([]);
    expect(ledger.report('a1', 3500)).toEqual(cut('a1', 3500, 20000));
  });

  it('forgets trailing audio that was heard in full', () => {
    const ledger = new PlaybackLedger();
    ledger.received('a1', 'r1', 1000);
    ledger.endTurn();
    expect(ledger.report('a1', 1000)).toEqual([]);
    expect(ledger.userTookFloor()).toEqual([]);
    expect(ledger.report('a1', 10)).toEqual([]);
  });

  it('ignores reports for audio it never received', () => {
    expect(new PlaybackLedger().report('unknown', 10)).toEqual([]);
  });

  it('remembers the text from before the first truncation', () => {
    const ledger = new PlaybackLedger();
    ledger.received('a1', 'r1', 100);
    expect(ledger.originalText('a1', 'Hello there')).toBe('Hello there');
    expect(ledger.originalText('a1', 'Hello')).toBe('Hello there');
    expect(ledger.originalText('unknown', 'x')).toBe('x');
  });
});
