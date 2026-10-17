import { Ajv2020 } from 'ajv/dist/2020.js';
import type { Wire } from './report.js';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  return JSON.stringify(value);
}

/** Independent of every SDK's codec, epoch gate and Inbox/Outbox. */
export class Oracle {
  readonly #ajv = new Ajv2020({ allErrors: true, strict: false });
  readonly #types = new Map<string, string>();
  constructor(schemas: Wire[], readonly registry: Wire, ids: Record<'client' | 'server', string>) {
    for (const schema of schemas) {
      this.#ajv.addSchema(schema);
    }
    this.#types.set('client', ids.client); this.#types.set('server', ids.server);
    for (const direction of ['client', 'server']) {
      if (!this.#types.has(direction)) throw new Error(`Missing ${direction} schema`);
      this.#ajv.getSchema(this.#types.get(direction)!);
    }
  }
  message(direction: 'client' | 'server', value: Wire): void {
    const validate = this.#ajv.getSchema(this.#types.get(direction)!)!;
    if (!validate(value)) throw new Error(`${direction} schema: ${this.#ajv.errorsText(validate.errors)}`);
  }
  baseline(direction: 'client' | 'server', messages: Wire[]): void {
    let last = 0;
    const seen = new Set<number>();
    const gated = new Set(this.registry.capabilities.flatMap((c: Wire) => c.messages?.[direction] ?? []));
    for (const message of messages) {
      this.message(direction, message);
      if (gated.has(message.type)) throw new Error(`Unnegotiated message ${message.type}`);
      if (message.seq > 0) {
        // Same-seq replay is one logical message; this first-phase profile has no resume.
        if (seen.has(message.seq)) continue;
        if (message.seq !== last + 1) throw new Error(`Noncontiguous sequence ${message.seq}, expected ${last + 1}`);
        last = message.seq; seen.add(message.seq);
      }
    }
  }
  interrupted(messages: Wire[], effects: Wire, callId: string, epoch: number): void {
    const results = messages.filter(m => m.type === 'tool.result' && m.callId === callId);
    const logical = new Map<number, Wire>();
    for (const result of results) {
      const previous = logical.get(result.seq);
      if (previous && canonical(previous) !== canonical(result)) throw new Error('Conflicting replay');
      logical.set(result.seq, result);
    }
    if (logical.size !== 1) throw new Error(`Expected one logical result, received ${logical.size}`);
    const result = [...logical.values()][0]!;
    if (result.epoch !== epoch || result.ok !== false || result.code !== 'INTERRUPTED') {
      throw new Error(`Expected INTERRUPTED for epoch ${epoch}: ${JSON.stringify(result)}`);
    }
    if (effects.started !== 0 || effects.committed !== 0) {
      throw new Error(`Old-epoch tool took effect: ${JSON.stringify(effects)}`);
    }
  }
}
