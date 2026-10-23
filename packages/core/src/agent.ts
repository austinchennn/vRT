import type { StopReason, Usage } from './events.js';
import type { RealtimeModel } from './model.js';
import type { Tool, ToolResult, ToolRisk } from './tool.js';
import type { VadFactory } from './vad.js';

export type TurnState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'acting';

/** One user→agent exchange. `epoch` increases on every turn and every interruption. */
export interface Turn {
  id: string;
  epoch: number;
  state: TurnState;
  interrupted: boolean;
  startedAt: number;
}

export interface TurnMetrics {
  /** User speech end → first agent audio. */
  timeToFirstAudioMs?: number;
  /** User speech end → first tool call. */
  timeToFirstToolCallMs?: number;
  /** Interrupt signal → playback stopped and gate closed. */
  interruptLatencyMs?: number;
  toolCalls: number;
  stopReason?: StopReason | 'continuation_limit';
  continuations?: number;
  /** What the provider reported for the responses that ended during the turn, cancelled ones included. */
  usage?: Usage;
}

export interface ToolCallInfo {
  callId: string;
  name: string;
  arguments: unknown;
  where: 'server' | 'client';
  risk: ToolRisk;
  turn: Turn;
  /** Data the edge attached to the session, e.g. the authenticated principal. */
  data: unknown;
}

export type BeforeToolCall = (call: ToolCallInfo) =>
  | void
  | { action: 'allow' }
  | { action: 'reject'; message: string }
  | { action: 'rewrite'; arguments: unknown }
  | Promise<void | { action: 'allow' } | { action: 'reject'; message: string } | { action: 'rewrite'; arguments: unknown }>;

export interface Hooks {
  beforeToolCall?: BeforeToolCall;
  afterToolCall?: (call: ToolCallInfo, result: ToolResult) => void;
  onTurnStart?: (turn: Turn) => void;
  onTurnEnd?: (turn: Turn, metrics: TurnMetrics) => void;
  onTranscript?: (text: string, final: boolean, turn: Turn) => void;
  onError?: (error: Error, recoverable: boolean) => void;
}

export interface AgentDefinition {
  model: RealtimeModel;
  instructions: string;
  tools?: Record<string, Tool<never, unknown>>;
  /** Whether tools declared by a connecting client are offered to the model. */
  clientTools?: 'accept' | 'ignore';
  hooks?: Hooks;
  voice?: string;
  turnDetection?: 'server' | 'semantic' | null;
  /** Client tool calls that get no result within this time resolve as TIMEOUT. */
  clientToolTimeoutMs?: number;
  /** Subsequent generations per user turn, including tool feedback. Default 16. */
  maxContinuations?: number;
  /**
   * Turn detection for models without server VAD: the runtime runs it on incoming
   * audio, interrupts on speech start and commits + asks for a reply on speech end.
   * Ignored when the model detects turns itself or `turnDetection` is `null`.
   */
  vad?: VadFactory;
}

export function defineAgent(definition: AgentDefinition): AgentDefinition {
  return definition;
}
