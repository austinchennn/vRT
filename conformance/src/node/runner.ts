import type { CaseResult, Profile, Report, Wire } from '../report.js';
import { cancellation, CANCELLATION_CASES, IncompleteDriver } from './cancellation.js';
import { authCredentials, authenticateScenario, AUTH_CASES, AUTH_PROFILE, IncompleteAuthDriver } from './auth.js';
import { serverToolStream, STREAM_CASES, STREAM_PROFILE, IncompleteStream } from './server-tool-stream.js';
import { INPUT_CASES, INPUT_PROFILE, IncompleteInput } from '../input-oracle.js';
import { serverInput } from './server-input.js';
import { assets } from './assets.js';
import { until } from './deadline.js';
import { ProcessDriver } from './process-driver.js';
import { dial, listen, type Peer } from './ws-peer.js';

export interface Options {
  mode: 'client' | 'server'; command?: string; args: string[];
  url?: string; profile?: Profile; timeoutMs: number; assets: string;
}
const PCM = { encoding: 'pcm16', sampleRate: 24000 };
const CALL = 'conformance-call';
const EPOCH = 1;
export async function run(options: Options): Promise<Report> {
  const { oracle, scenarios, hello: baselineHello, wrongVersion } = assets(options.assets);
  const profile = options.profile ?? 'handshake-interrupt-v1';
  if (profile === 'tool-cancellation-v1' && options.mode !== 'client') throw new Error('tool-cancellation-v1 only supports client mode');
  if (profile === AUTH_PROFILE && (options.mode !== 'server' || !options.command || options.url)) throw new Error('server-auth-v1 requires server mode and --exec');
  if (profile === STREAM_PROFILE && (options.mode !== 'server' || !options.command || options.url)) throw new Error('server-tool-stream-v1 requires server mode and --exec');
  if (profile === INPUT_PROFILE && (options.mode !== 'server' || !options.command || options.url)) throw new Error('server-input-validation-v1 requires server mode and --exec');
  const report: Report = {
    protocol: 1, profile, fullSuite: 'incomplete', mode: options.mode,
    capabilities: [], cases: [], remaining: ['resume/replay', 'heartbeat', 'audio', 'queued/running cancellation', 'optional capabilities', 'server interruption routing'],
  };
  const selected = scenarios.filter(s => (s.profile ?? 'handshake-interrupt-v1') === profile && s.id.startsWith(options.mode + '/'));
  if (profile === 'tool-cancellation-v1') report.remaining = ['handshake/old-epoch baseline (separate profile)', ...report.remaining.filter(item => item !== 'queued/running cancellation')];
  else report.remaining = report.remaining.map(item => item === 'queued/running cancellation' ? item + ' (separate profile)' : item);
  if (profile === AUTH_PROFILE) report.remaining.unshift('handshake/interrupt baseline (separate profile)', 'resume principal isolation');
  if (profile === STREAM_PROFILE) report.remaining.unshift('handshake/auth/cancellation (separate profiles)', 'client tool-stream observations', 'additional capability matrices');
  if (profile === INPUT_PROFILE) report.remaining = ['other profiles (selected separately)', 'resume/replay', 'client invalid-input handling', 'output audio/playback/devices', 'additional audio/exception matrices', 'Python driver'];
  const required = profile === INPUT_PROFILE ? INPUT_CASES : profile === STREAM_PROFILE ? STREAM_CASES : profile === AUTH_PROFILE ? AUTH_CASES : profile === 'tool-cancellation-v1' ? CANCELLATION_CASES : options.mode === 'client'
    ? ['client/handshake/baseline', 'client/interrupt/stale-call']
    : ['server/handshake/baseline', 'server/handshake/version'];
  for (const id of required) {
    const definitions = selected.filter(s => s.id === id);
    if (definitions.length > 1) throw new Error(`Duplicate scenario ${id}`);
    if (definitions.length === 0) report.cases.push({ id, status: 'incomplete', durationMs: 0, expected: 'Required profile scenario present', actual: 'Missing scenario definition', stage: 'inventory' });
  }
  for (const scenario of selected) {
    if (!['client/handshake/baseline', 'client/interrupt/stale-call', 'server/handshake/baseline', 'server/handshake/version', ...AUTH_CASES, ...CANCELLATION_CASES, ...STREAM_CASES, ...INPUT_CASES].includes(scenario.id)) throw new Error(`Unknown scenario ${scenario.id}`);
    const start = performance.now(); const end = start + options.timeoutMs;
    let stage = 'setup';
    const credentials = profile === AUTH_PROFILE ? authCredentials() : undefined;
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
        if (profile === 'tool-cancellation-v1') {
          result.actual = await cancellation(peer, driver, oracle, info, end, scenario.id.endsWith('late-rejection'), value => { stage = value; });
        } else if (scenario.id === 'client/interrupt/stale-call') {
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
          stage = 'server ready'; const info = await driver.request('ready', credentials ? { profile: AUTH_PROFILE, authToken: credentials.token } : profile === STREAM_PROFILE ? { profile, argumentStreaming: !scenario.id.endsWith('no-delta') } : profile === INPUT_PROFILE ? { profile } : {}, end);
          if (credentials && (!Array.isArray(info.driverCapabilities) || !info.driverCapabilities.includes(AUTH_PROFILE))) throw new IncompleteAuthDriver('Driver does not advertise server-auth-v1 instrumentation');
          if (profile === STREAM_PROFILE && (!Array.isArray(info.driverCapabilities) || !info.driverCapabilities.every((token: unknown) => typeof token === 'string') || !info.driverCapabilities.includes(STREAM_PROFILE))) throw new IncompleteStream('Driver lacks server-tool-stream-v1 instrumentation');
          if (profile === INPUT_PROFILE && (!Array.isArray(info.driverCapabilities) || !info.driverCapabilities.every((token: unknown) => typeof token === 'string') || !info.driverCapabilities.includes(INPUT_PROFILE))) throw new IncompleteInput('Driver lacks server-input-validation-v1 instrumentation');
          url = info.url;
        }
        if (typeof url !== 'string' || !/^wss?:\/\//.test(url)) throw new Error('Server mode needs --url or driver ready.url');
        if (credentials && (url.includes(credentials.token) || url.includes(credentials.wrongToken))) throw new Error('Driver URL must not contain a test credential');
        peer = await dial(url, end);
        if (profile === INPUT_PROFILE) {
          result.actual = await serverInput(scenario.id, peer, driver!, oracle, baselineHello, options.assets, end, value => { stage = value; });
        } else if (profile === STREAM_PROFILE) {
          const actual = await serverToolStream(scenario.id, peer, driver!, oracle, baselineHello, end, value => { stage = value; });
          result.actual = actual;
          report.capabilities = [...new Set([...report.capabilities, ...actual.capabilities])];
        } else if (credentials) {
          result.actual = await authenticateScenario(scenario.id, peer, oracle, baselineHello, credentials, end, value => { stage = value; });
        } else {
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
      }
      result.status = 'pass';
    } catch (error) {
      if (error instanceof IncompleteInput || error instanceof IncompleteStream || error instanceof IncompleteAuthDriver || error instanceof IncompleteDriver) result.status = 'incomplete';
      result.actual = { error: error instanceof Error ? error.message : String(error), trace: peer?.messages ?? [], close: peer?.closeInfo };
    }
    finally {
      // Stop untrusted processes even when their protocol is broken, then close sockets.
      const cleanup = await Promise.allSettled([driver?.stop(), peer?.dispose()]);
      try { await host?.close(); } catch (error) { cleanup.push({ status: 'rejected', reason: error }); }
      const failed = cleanup.find(c => c.status === 'rejected');
      if (failed?.status === 'rejected') { result.status = 'fail'; result.actual = { previous: result.actual, cleanup: String(failed.reason) }; }
      if (credentials) result.actual = credentials.redact(result.actual);
      result.stage = stage; result.durationMs = performance.now() - start; report.cases.push(result);
    }
  }
  return report;
}
