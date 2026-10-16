export type Wire = Record<string, any>;
export type Status = 'pass' | 'fail' | 'skip' | 'incomplete';
export interface CaseResult {
  id: string; status: Status; durationMs: number;
  expected: string; actual: unknown; stage: string;
}
export interface Report {
  protocol: 1; profile: 'handshake-interrupt-v1'; fullSuite: 'incomplete';
  mode: 'client' | 'server'; capabilities: string[];
  cases: CaseResult[]; remaining: string[];
}
export interface Scenario { id: string; expected: string }
