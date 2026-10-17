import type { Wire } from './report.js';
export interface HeartbeatSettings { timeoutMs: number; delayAllowanceMs: number; resumeWindowMs: number }
export function heartbeatAlive(point: Wire): void {
  if (point.serverOpen !== true || point.peerOpen !== true) throw new Error(`Connection closed before inactivity timeout: ${JSON.stringify(point)}`);
}
export function heartbeatExpired(settings: HeartbeatSettings, lastReceived: number, point: Wire, code: number | undefined): void {
  if (code !== 4408) throw new Error(`Expected heartbeat close 4408, received ${code}`);
  if (typeof point.closeRequestedAt !== 'number' || point.closeRequestedAt < lastReceived + settings.timeoutMs || point.closeRequestedAt > lastReceived + settings.timeoutMs + settings.delayAllowanceMs) {
    throw new Error(`Close outside configured observation window: ${JSON.stringify({ lastReceived, point, settings })}`);
  }
}
