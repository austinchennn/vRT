import { PRINCIPAL_PROFILE, PRINCIPAL_CASES, IncompletePrincipal } from '../principal-oracle.js';
import { principalCredentials, serverPrincipal, PrincipalFailure } from './server-principal.js';
import { CONTROL_PROFILE, CONTROL_CASES, IncompleteControl } from '../client-control-oracle.js';
import { clientControl } from './client-control.js';
import { INPUT_CASES, INPUT_PROFILE, IncompleteInput } from '../input-oracle.js';
import { serverInput } from './server-input.js';
import type { CaseResult, Profile, Report, Wire } from '../report.js';
import { cancellation, CANCELLATION_CASES, IncompleteDriver } from './cancellation.js';
import { authCredentials, authenticateScenario, AUTH_CASES, AUTH_PROFILE, IncompleteAuthDriver } from './auth.js';
import { serverToolStream, STREAM_CASES, STREAM_PROFILE, IncompleteStream } from './server-tool-stream.js';
import { serverHeartbeat, HEARTBEAT_CASES, HEARTBEAT_PROFILE, IncompleteHeartbeat } from './server-heartbeat.js';
import { assets } from './assets.js';
import { until } from './deadline.js';
import { ProcessDriver } from './process-driver.js';
import { dial, listen, type Peer } from './ws-peer.js';

export interface Options {
  mode: 'client' | 'server'; command?: string; args: string[];
  url?: string; profile?: Profile; heartbeatTimeoutMs?: number; timeoutMs: number; assets: string;
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
  if (profile === HEARTBEAT_PROFILE && (options.mode !== 'server' || !options.command || options.url)) throw new Error('server-heartbeat-v1 requires server mode and --exec');
  if (profile === INPUT_PROFILE && (options.mode !== 'server' || !options.command || options.url)) throw new Error('server-input-validation-v1 requires server mode and --exec');
  if (profile === CONTROL_PROFILE && (options.mode !== 'client' || !options.command || options.url)) throw new Error('client-control-validation-v1 requires client mode and --exec');
  if (profile === PRINCIPAL_PROFILE && (options.mode !== 'server' || !options.command || options.url)) throw new Error('server-resume-principal-v1 requires server mode and --exec');
  const heartbeatTimeout = options.heartbeatTimeoutMs ?? 1200;
  if (profile === HEARTBEAT_PROFILE && (!Number.isInteger(heartbeatTimeout) || heartbeatTimeout < 100 || heartbeatTimeout > 60000)) throw new Error('Invalid local heartbeat timeout policy');
  const settings = { timeoutMs: heartbeatTimeout, delayAllowanceMs: Math.ceil(heartbeatTimeout / 2), resumeWindowMs: heartbeatTimeout * 6 };
  const report: Report = {
    protocol: 1, profile, fullSuite: 'incomplete', mode: options.mode,
    capabilities: [], cases: [], remaining: ['resume/replay', 'heartbeat', 'audio', 'queued/running cancellation', 'optional capabilities', 'server interruption routing'],
  };
  const selected = scenarios.filter(s => (s.profile ?? 'handshake-interrupt-v1') === profile && s.id.startsWith(options.mode + '/'));
  if (profile === 'tool-cancellation-v1') report.remaining = ['handshake/old-epoch baseline (separate profile)', ...report.remaining.filter(item => item !== 'queued/running cancellation')];
  else report.remaining = report.remaining.map(item => item === 'queued/running cancellation' ? item + ' (separate profile)' : item);
  if (profile === AUTH_PROFILE) report.remaining.unshift('handshake/interrupt baseline (separate profile)', 'resume principal isolation');
  if (profile === STREAM_PROFILE) report.remaining.unshift('handshake/auth/cancellation (separate profiles)', 'client tool-stream observations', 'additional capability matrices');
  if (profile === HEARTBEAT_PROFILE) report.remaining = ['client heartbeat SHOULD behavior', 'other profiles (separately selected)', 'full bidirectional resume/replay', 'binary/audio exception matrices', 'WebSocket control-frame timing interpretation', 'Python network driver'];
  if (profile === INPUT_PROFILE) report.remaining = ['other profiles (selected separately)', 'resume/replay', 'client invalid-input handling', 'output audio/playback/devices', 'additional audio/exception matrices', 'Python driver'];
  if (profile === CONTROL_PROFILE) report.remaining = ['other profiles (selected separately)', 'pre-ready client errors', 'binary/audio', 'heartbeat', 'resume/replay', 'additional exception matrices', 'Python driver'];
  if (profile === PRINCIPAL_PROFILE) report.remaining = ['other profiles (selected separately)', 'automatic/bidirectional recovery', 'expiry/capacity', 'lost tool results', 'additional security matrices', 'Python driver'];
  const required = profile === PRINCIPAL_PROFILE ? PRINCIPAL_CASES : profile === CONTROL_PROFILE ? CONTROL_CASES : profile === INPUT_PROFILE ? INPUT_CASES : profile === HEARTBEAT_PROFILE ? HEARTBEAT_CASES : profile === STREAM_PROFILE ? STREAM_CASES : profile === AUTH_PROFILE ? AUTH_CASES : profile === 'tool-cancellation-v1' ? CANCELLATION_CASES : options.mode === 'client'
    ? ['client/handshake/baseline', 'client/interrupt/stale-call']
    : ['server/handshake/baseline', 'server/handshake/version'];
  for (const id of required) {
    const definitions = selected.filter(s => s.id === id);
    if (definitions.length > 1) throw new Error(`Duplicate scenario ${id}`);
    if (definitions.length === 0) report.cases.push({ id, status: 'incomplete', durationMs: 0, expected: 'Required profile scenario present', actual: 'Missing scenario definition', stage: 'inventory' });
  }
  for (const scenario of selected) {
    if (!['client/handshake/baseline', 'client/interrupt/stale-call', 'server/handshake/baseline', 'server/handshake/version', ...AUTH_CASES, ...CANCELLATION_CASES, ...STREAM_CASES, ...HEARTBEAT_CASES, ...INPUT_CASES, ...CONTROL_CASES, ...PRINCIPAL_CASES].includes(scenario.id)) throw new Error(`Unknown scenario ${scenario.id}`);
    const start = performance.now(); const end = start + options.timeoutMs;
    let stage = 'setup';
    const credentials = profile === AUTH_PROFILE ? authCredentials() : undefined;
    const principalSecrets = profile === PRINCIPAL_PROFILE ? principalCredentials() : undefined;
    const result: CaseResult = { ...scenario, status: 'fail', durationMs: 0, actual: null, stage };
    const heartbeatEvidence: Wire = profile === HEARTBEAT_PROFILE ? { settings: { clock: 'virtual', ...settings } } : {};
    const extraPeers: Peer[] = [];
    let peer: Peer | undefined;
    let host: Awaited<ReturnType<typeof listen>> | undefined;
    let driver: ProcessDriver | undefined;
    try {
      if (options.mode === 'client') {
        if (!options.command) throw new Error('Client mode requires --exec');
        host = await listen();
        driver = new ProcessDriver(options.command, options.args, host.url);
        const ready = driver.request('ready', profile === CONTROL_PROFILE ? { profile } : {}, end);
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
        if (profile === CONTROL_PROFILE) {
          result.actual = await clientControl(scenario.id, peer, driver, oracle, info, options.assets, end, value => { stage = value; });
        } else if (profile === 'tool-cancellation-v1') {
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
          let readyData: Wire = {};
          if (credentials) readyData = { profile: AUTH_PROFILE, authToken: credentials.token };
          else if (profile === STREAM_PROFILE) readyData = { profile, argumentStreaming: !scenario.id.endsWith('no-delta') };
          else if (profile === HEARTBEAT_PROFILE) readyData = { profile, timeoutMs: settings.timeoutMs, resumeWindowMs: settings.resumeWindowMs, holdOpening: scenario.id.endsWith('pong-opening') };
          else if (profile === INPUT_PROFILE) readyData = { profile };
          else if (principalSecrets) readyData = { profile, tokens: principalSecrets.tokens };
          stage = 'server ready'; const info = await driver.request('ready', readyData, end);
          if (credentials && (!Array.isArray(info.driverCapabilities) || !info.driverCapabilities.includes(AUTH_PROFILE))) throw new IncompleteAuthDriver('Driver does not advertise server-auth-v1 instrumentation');
          if (profile === STREAM_PROFILE && (!Array.isArray(info.driverCapabilities) || !info.driverCapabilities.every((token: unknown) => typeof token === 'string') || !info.driverCapabilities.includes(STREAM_PROFILE))) throw new IncompleteStream('Driver lacks server-tool-stream-v1 instrumentation');
          if (profile === HEARTBEAT_PROFILE) {
            if (!Array.isArray(info.driverCapabilities) || !info.driverCapabilities.includes(HEARTBEAT_PROFILE) || info.timing?.clock !== 'virtual') throw new IncompleteHeartbeat('Driver lacks virtual server-heartbeat-v1 instrumentation');
            if (Object.entries(settings).some(([key, value]) => info.timing[key] !== value)) throw new Error('Driver timing configuration mismatch');
          }
          if (profile === INPUT_PROFILE && (!Array.isArray(info.driverCapabilities) || !info.driverCapabilities.every((token: unknown) => typeof token === 'string') || !info.driverCapabilities.includes(INPUT_PROFILE))) throw new IncompleteInput('Driver lacks server-input-validation-v1 instrumentation');
          if (profile === PRINCIPAL_PROFILE && (!Array.isArray(info.driverCapabilities) || !info.driverCapabilities.every((token: unknown) => typeof token === 'string') || !info.driverCapabilities.includes(PRINCIPAL_PROFILE))) throw new IncompletePrincipal('Driver lacks server-resume-principal-v1 instrumentation');
          url = info.url;
        }
        if (typeof url !== 'string' || !/^wss?:\/\//.test(url)) throw new Error('Server mode needs --url or driver ready.url');
        if (credentials && (url.includes(credentials.token) || url.includes(credentials.wrongToken))) throw new Error('Driver URL must not contain a test credential');
        if (principalSecrets?.contains(url)) throw new Error('Driver URL must not contain test credentials');
        peer = await dial(url, end);
        if (principalSecrets) {
          result.actual = await serverPrincipal(scenario.id, peer, url, driver!, oracle, baselineHello, principalSecrets, end, value => { stage = value; });
        } else if (profile === INPUT_PROFILE) {
          result.actual = await serverInput(scenario.id, peer, driver!, oracle, baselineHello, options.assets, end, value => { stage = value; });
        } else if (profile === HEARTBEAT_PROFILE) {
          result.actual = await serverHeartbeat(scenario.id, peer, extraPeers, driver!, oracle, baselineHello, url, settings, end, value => { stage = value; }, heartbeatEvidence);
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
      if (error instanceof IncompletePrincipal || error instanceof IncompleteControl || error instanceof IncompleteInput || error instanceof IncompleteHeartbeat || error instanceof IncompleteStream || error instanceof IncompleteAuthDriver || error instanceof IncompleteDriver) result.status = 'incomplete';
      result.actual = { error: error instanceof Error ? error.message : String(error), trace: peer?.messages ?? [], close: peer?.closeInfo, ...(error instanceof PrincipalFailure ? { connections: error.connections } : {}), ...(profile === HEARTBEAT_PROFILE ? { heartbeat: heartbeatEvidence } : {}) };
    }
    finally {
      // Stop untrusted processes even when their protocol is broken, then close sockets.
      const cleanup = await Promise.allSettled([driver?.stop(), peer?.dispose(), ...extraPeers.map(extra => extra.dispose())]);
      try { await host?.close(); } catch (error) { cleanup.push({ status: 'rejected', reason: error }); }
      const failed = cleanup.find(c => c.status === 'rejected');
      if (failed?.status === 'rejected') { result.status = 'fail'; result.actual = { previous: result.actual, cleanup: String(failed.reason) }; }
      if (credentials) result.actual = credentials.redact(result.actual);
      if (principalSecrets) result.actual = principalSecrets.redact(result.actual);
      result.stage = stage; result.durationMs = performance.now() - start; report.cases.push(result);
    }
  }
  return report;
}
