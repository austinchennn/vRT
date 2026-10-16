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
  /** Data the edge attached to the session, e.g. the authenticated principal. */
  data: unknown;
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

export type ToolFailure = Extract<ToolResult, { ok: false }>;

/** Runs a Standard Schema; issues (or a throwing validator) become an `INVALID` tool result. */
export async function validateToolArgs<Args>(
  schema: StandardSchemaV1<unknown, Args>,
  value: unknown,
): Promise<{ ok: true; value: Args } | ToolFailure> {
  let result: StandardResult<Args>;
  try {
    result = await schema['~standard'].validate(value);
  } catch (error) {
    return { ok: false, code: 'INVALID', message: error instanceof Error ? error.message : String(error) };
  }
  if (result.issues === undefined) return { ok: true, value: result.value };
  const message = result.issues
    .map((issue) => {
      const path = issue.path?.map((segment) => String(typeof segment === 'object' ? segment.key : segment)).join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
  return { ok: false, code: 'INVALID', message: message || 'Invalid arguments' };
}
