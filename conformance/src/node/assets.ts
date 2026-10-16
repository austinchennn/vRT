import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Scenario, Wire } from '../report.js';
import { Oracle } from '../oracle.js';
export function assets(directory: string) {
  const read = (path: string) => JSON.parse(readFileSync(join(directory, path), 'utf8'));
  const schemas: Wire[] = [];
  const walk = (path: string) => {
    for (const item of readdirSync(join(directory, path), { withFileTypes: true })) {
      const relative = join(path, item.name);
      if (item.isDirectory()) walk(relative);
      else if (item.name.endsWith('.json')) schemas.push(read(relative));
    }
  };
  walk('schema');
  const vector = (path: string, id: string): Wire => {
    const entry = read(`examples/${path}`).cases.find((c: Wire) => c.id === id);
    if (!entry) throw new Error(`Missing shared vector ${id}`);
    return entry.message;
  };
  return { hello: vector('client/hello.json', 'client/hello/minimal'),
    wrongVersion: vector('client/envelope.json', 'client/envelope/version-2').v,
    oracle: new Oracle(schemas, read('capabilities.json'), { client: read('schema/client-message.json').$id, server: read('schema/server-message.json').$id }), scenarios: read('scenarios.json') as Scenario[] };
}
