import { describe, expect, it } from 'vitest';
import { RealtimeError, isRealtimeError, type RealtimeErrorCode } from '../src/index.js';

describe('RealtimeError', () => {
  it('carries a neutral code, the provider code and the raw cause', () => {
    const raw = { type: 'insufficient_quota', code: 'monthly_cap_reached', message: 'cap reached' };
    const error = new RealtimeError('quota', 'cap reached', { provider: 'boson', providerCode: 'monthly_cap_reached', cause: raw });
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: 'RealtimeError', code: 'quota', provider: 'boson', providerCode: 'monthly_cap_reached', retryable: false, message: 'cap reached' });
    expect(error.cause).toBe(raw);
  });

  it('defaults retryable by code, and lets an adapter override it', () => {
    const retryable = (code: RealtimeErrorCode) => new RealtimeError(code, '').retryable;
    expect(['rate_limited', 'overloaded', 'session_limit', 'connection', 'provider'].map((c) => retryable(c as RealtimeErrorCode))).toEqual([true, true, true, true, true]);
    expect(['auth', 'quota', 'invalid_request', 'transcription', 'unsupported'].map((c) => retryable(c as RealtimeErrorCode))).toEqual([false, false, false, false, false]);
    expect(new RealtimeError('provider', '', { retryable: false }).retryable).toBe(false);
  });

  it('wraps a foreign error once and passes a RealtimeError through', () => {
    const cause = new Error('tts failed');
    const wrapped = RealtimeError.from(cause, 'provider', { provider: 'cascade' });
    expect(wrapped).toMatchObject({ code: 'provider', provider: 'cascade', message: 'tts failed', cause });
    expect(RealtimeError.from(wrapped, 'connection')).toBe(wrapped);
    expect(RealtimeError.from('boom', 'provider').message).toBe('boom');
  });

  it('is recognised across copies of the package', () => {
    const foreign = Object.assign(new Error('x'), { name: 'RealtimeError', code: 'auth' });
    expect(isRealtimeError(foreign)).toBe(true);
    expect(isRealtimeError(new RealtimeError('auth', 'x'))).toBe(true);
    expect(isRealtimeError(new Error('x'))).toBe(false);
    expect(isRealtimeError({ name: 'RealtimeError', code: 'auth' })).toBe(false);
  });
});
