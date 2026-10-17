export type Wire = Record<string, any>;
export type Status = 'pass' | 'fail' | 'skip' | 'incomplete';
export interface CaseResult {
  id: string; status: Status; durationMs: number;
  expected: string; actual: unknown; stage: string;
}
export type Profile = 'handshake-interrupt-v1' | 'tool-cancellation-v1' | 'server-auth-v1' | 'server-tool-stream-v1' | 'server-heartbeat-v1' | 'client-control-validation-v1';
export interface Report {
  protocol: 1; profile: Profile; fullSuite: 'incomplete';
  mode: 'client' | 'server'; capabilities: string[];
  cases: CaseResult[]; remaining: string[];
}
export interface Scenario { profile?: Profile; id: string; expected: string }
