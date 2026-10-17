import type { CaseResult, Report, Wire } from '../report.js';
import { assets } from './assets.js';
import { until } from './deadline.js';
import { ProcessDriver } from './process-driver.js';
import { dial, listen, type Peer } from './ws-peer.js';

export interface Options {
  mode: 'client' | 'server'; command?: string; args: string[];
  url?: string; timeoutMs: number; assets: string;
}
const PCM = { encoding: 'pcm16', sampleRate: 24000 };
const CALL = 'conformance-call';
const EPOCH = 1;
export async function run(options: Options): Promise<Report> {
  const { oracle, scenarios, hello: baselineHello, wrongVersion } = assets(options.assets);
  const report: Report = {
    protocol: 1, profile: 'handshake-interrupt-v1', fullSuite: 'incomplete', mode: options.mode,
    capabilities: [], cases: [], remaining: ['resume/replay', 'heartbeat', 'audio', 'queued/running cancellation', 'optional capabilities', 'server interruption routing'],
  };
  const selected = scenarios.filter(s => s.id.startsWith(options.mode + '/'));
  const required = options.mode === 'client'
    ? ['client/handshake/baseline', 'client/interrupt/stale-call']
    : ['server/handshake/baseline', 'server/handshake/version'];
  for (const id of required) {
    const definitions = selected.filter(s => s.id === id);
    if (definitions.length > 1) throw new Error(`Duplicate scenario ${id}`);
    if (definitions.length === 0) report.cases.push({ id, status: 'incomplete', durationMs: 0, expected: 'Required profile scenario present', actual: 'Missing scenario definition', stage: 'inventory' });
  }
  for (const scenario of selected) {
    if (!['client/handshake/baseline', 'client/interrupt/stale-call', 'server/handshake/baseline', 'server/handshake/version'].includes(scenario.id)) throw new Error(`Unknown scenario ${scenario.id}`);
    const start = performance.now(); const end = start + options.timeoutMs;
    let stage = 'setup';
    const result: CaseResult = { ...scenario, status: 'fail', durationMs: 0, actual: null, stage };
    let peer: Peer | undefined;
    let host: Awaited<ReturnType<typeof listen>> | undefined;
    let driver: ProcessDriver | undefined;
    try {
      if (options.mode === 'client') {
        if (!options.command) throw new Error('Client mode requires --exec');
        host = await listen();
        driver = new ProcessDriver(options.command, options.args, host.url);
        const ready = driver.request('ready', {}, end);
        // Observe rejection while awaiting the network side of the same handshake.
        void ready.catch(() => {});
        stage = 'hello';
        peer = await until(Promise.race([host.connection, ready.then(() => host!.connection)]), end, 'client connection');
        const hello = await peer.expect(m => m.type === 'hello', end, stage);
        oracle.message('client', hello);
        if (hello.sessionId !== undefined) throw new Error('Expected a new session');
        if (!hello.tools.some((t: Wire) => t.name === 'probe')) throw new Error('Driver must declare probe tool');
        peer.send({ v: 1, seq: 0, type: 'ready', sessionId: 'conformance-session', input: PCM, output: PCM });
        stage = 'ready';
        const info = await ready;
        if (!Array.isArray(info.capabilities) || info.capabilities.length !== 0) throw new Error('Baseline negotiated capabilities must be empty');
        if (scenario.id === 'client/interrupt/stale-call') {
          peer.send({ v: 1, seq: 1, type: 'turn.state', turnId: 'conformance-turn', epoch: EPOCH, state: 'thinking' });
          stage = 'observe epoch'; await driver.request('observe', { epoch: EPOCH }, end);
          stage = 'local interrupt'; await driver.request('interrupt', {}, end);
          await peer.expect(m => m.type === 'interrupt' && m.epoch === EPOCH, end, stage);
          peer.send({ v: 1, seq: 2, type: 'tool.call', callId: CALL, epoch: EPOCH, turnId: 'conformance-turn', name: 'probe', arguments: {} });
          stage = 'finish fence';
          const effects = await driver.request('finish', { callId: CALL }, end);
          await peer.closed(end);
          stage = 'interrupt oracle'; oracle.baseline('client', peer.messages);
          oracle.interrupted(peer.messages, effects, CALL, EPOCH);
          result.actual = { effects, logicalResults: 1, wireFrames: peer.messages.length };
        } else {
          stage = 'handshake close'; await driver.request('finish', {}, end); await peer.closed(end);
          oracle.baseline('client', peer.messages);
          result.actual = { hello: true, ready: true, capabilities: [] };
        }
      } else {
        let url = options.url;
        if (options.command) {
          driver = new ProcessDriver(options.command, options.args);
          stage = 'server ready'; const info = await driver.request('ready', {}, end);
          url = info.url;
        }
        if (typeof url !== 'string' || !/^wss?:\/\//.test(url)) throw new Error('Server mode needs --url or driver ready.url');
        peer = await dial(url, end);
        stage = 'server handshake';
        const invalid = scenario.id === 'server/handshake/version';
        peer.send({ ...baselineHello, ...(invalid ? { v: wrongVersion } : {}) });
        if (invalid) {
          const error = await peer.expect(m => m.type === 'error', end, stage);
          oracle.message('server', error);
          if (peer.messages.some(m => m.type === 'ready')) throw new Error('Server opened a session for invalid major');
          if (error.code !== 'UNSUPPORTED_VERSION' || error.recoverable !== true || error.seq !== 0) throw new Error('Expected recoverable sessionless UNSUPPORTED_VERSION');
          // §9.1 keeps the connection open. A valid hello must still work.
          peer.send(baselineHello);
        }
        const ready = await peer.expect(m => m.type === 'ready', end, stage);
        oracle.message('server', ready);
        if ((ready.capabilities ?? []).length !== 0) throw new Error('Server enabled unoffered capability');
        peer.socket.close(1000, 'scenario complete'); await peer.closed(end);
        oracle.baseline('server', peer.messages);
        result.actual = { ready: true, versionRejected: invalid, capabilities: [] };
      }
      result.status = 'pass';
    } catch (error) { result.actual = { error: error instanceof Error ? error.message : String(error), trace: peer?.messages ?? [] }; }
    finally {
      // Stop untrusted processes even when their protocol is broken, then close sockets.
      const cleanup = await Promise.allSettled([driver?.stop(), peer?.dispose()]);
      try { await host?.close(); } catch (error) { cleanup.push({ status: 'rejected', reason: error }); }
      const failed = cleanup.find(c => c.status === 'rejected');
      if (failed?.status === 'rejected') { result.status = 'fail'; result.actual = { previous: result.actual, cleanup: String(failed.reason) }; }
      result.stage = stage; result.durationMs = performance.now() - start; report.cases.push(result);
    }
  }
  return report;
}
