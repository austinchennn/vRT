/** Plain JSON Schema object; core does not depend on any schema library. */
export type JsonSchema = { readonly [key: string]: unknown };

/** Minimal Standard Schema v1 surface (https://standardschema.dev), copied by design to stay dependency-free. */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>;
    readonly types?: { readonly input: Input; readonly output: Output };
  };
}
export type StandardResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<{ readonly message: string; readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> }> };

export interface ToolContext {
  /** Aborted when the turn that issued the call is interrupted (unless the tool is `async`). */
  signal: AbortSignal;
  callId: string;
  turnId: string;
  epoch: number;
  /** Streams a progress/preview payload to the client while the tool runs. */
  emit(preview: unknown): void;
}

export type ToolRisk = 'low' | 'medium' | 'high';

/** A server-side tool. Client-side tools are declared by the client at connect time with the same `ToolSpec` shape. */
export interface Tool<Args = unknown, Result = unknown> {
  description: string;
  parameters: JsonSchema;
  validate?: StandardSchemaV1<unknown, Args>;
  run(args: Args, context: ToolContext): Result | Promise<Result>;
  /** Passed to `beforeToolCall` so apps can require confirmation. */
  risk?: ToolRisk;
  /** Keep running after an interruption and deliver the result later. */
  async?: boolean;
}

export type ToolResult =
  | { ok: true; output: unknown }
  | { ok: false; code: 'INTERRUPTED' | 'REJECTED' | 'INVALID' | 'TIMEOUT' | 'FAILED'; message: string };

export function tool<Args, Result>(definition: Tool<Args, Result>): Tool<Args, Result> {
  return definition;
}
