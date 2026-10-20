import { describe, expect, it } from 'vitest';
import { addUsage } from '../src/index.js';

describe('addUsage', () => {
  it('sums field by field and keeps a field either side reports', () => {
    expect(addUsage(undefined, { inputTokens: 5 })).toEqual({ inputTokens: 5 });
    expect(addUsage({ inputTokens: 5, cachedInputTokens: 0 }, { inputTokens: 7, outputTokens: 2, cachedInputTokens: 3, outputAudioMs: 400 })).toEqual({
      inputTokens: 12,
      outputTokens: 2,
      cachedInputTokens: 3,
      outputAudioMs: 400,
    });
  });

  it('does not change its arguments', () => {
    const a = { inputTokens: 1 };
    addUsage(a, { inputTokens: 1 });
    expect(a).toEqual({ inputTokens: 1 });
  });
});
