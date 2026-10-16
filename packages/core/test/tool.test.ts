import { describe, expect, it } from 'vitest';
import { validateToolArgs, type StandardSchemaV1 } from '../src/tool.js';

const city: StandardSchemaV1<unknown, { city: string }> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (value) =>
      typeof value === 'object' && value !== null && typeof (value as { city?: unknown }).city === 'string'
        ? { value: value as { city: string } }
        : { issues: [{ message: 'Expected string', path: ['city'] }, { message: 'Bad', path: [{ key: 'a' }, 0] }] },
  },
};

describe('validateToolArgs', () => {
  it('passes valid values through', async () => {
    expect(await validateToolArgs(city, { city: 'Paris' })).toEqual({ ok: true, value: { city: 'Paris' } });
  });

  it('turns issues into an INVALID result with paths', async () => {
    expect(await validateToolArgs(city, {})).toEqual({ ok: false, code: 'INVALID', message: 'city: Expected string; a.0: Bad' });
  });

  it('supports async validators and treats a throw as INVALID', async () => {
    const asyncSchema: StandardSchemaV1<unknown, number> = { '~standard': { version: 1, vendor: 't', validate: async (v) => ({ value: Number(v) }) } };
    expect(await validateToolArgs(asyncSchema, '3')).toEqual({ ok: true, value: 3 });
    const throwing: StandardSchemaV1 = { '~standard': { version: 1, vendor: 't', validate: () => { throw new Error('nope'); } } };
    expect(await validateToolArgs(throwing, 1)).toEqual({ ok: false, code: 'INVALID', message: 'nope' });
  });
});
