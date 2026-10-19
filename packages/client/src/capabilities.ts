import { GLOBAL_TOOL_IDS_V1, TOOL_STREAM_V1 } from '@vrealtime/protocol';

/** Protocol capabilities (spec/capabilities.json) this client implements and offers in `hello`. */
export const CLIENT_CAPABILITIES: readonly string[] = [TOOL_STREAM_V1, GLOBAL_TOOL_IDS_V1];
