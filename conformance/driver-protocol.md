# Driver protocol, revision 1 (test-only)

This JSONL control interface is **not part of the vRT wire protocol** and does not change its version. It makes a test instrumentable without sharing its SDK internals or language. One UTF-8 JSON object per line, one request at a time; logs go to stderr, never stdout. No unsolicited stdout events.

Request:

```json
{"requestId":"1","command":"ready","data":{}}
```

Success/failure responses carry the exact same string requestId:

```json
{"requestId":"1","ok":true,"data":{"capabilities":[]}}
{"requestId":"1","ok":false,"error":"failed to connect"}
```

No responses after an error may silently reuse another requestId. Malformed output, oversized output, unmatched replies and premature process exits fail the case. A request exceeding the runner deadline fails the case; shutdown escalates from close + stdin EOF to SIGTERM and, if necessary, SIGKILL, and awaits process exit. Arguments are passed without a shell. Do not use this mechanism to execute untrusted programs.

## Client driver

Each case starts a fresh process with `VRT_CONFORMANCE_URL` set to the loopback test server.

| Command | Data | Successful response / contract |
|---|---|---|
| `ready` | `{}` | Connect through public SDK API in text-only/no-reconnect mode, declare tool `probe` with object parameters, await ready, return `{capabilities: string[]}` from public API. Install observation listeners before replying. |
| `observe` | `{epoch: number}` | Await a public state event showing this epoch, then acknowledge; do not infer from private fields. |
| `interrupt` | `{}` | Invoke the public synchronous local interrupt method; acknowledge only after its local gate has taken effect. |
| `readEffects` | `{}` | Return `{started: number, committed: number}`. |
| `finish` | `{callId?: string}` | If callId is present, await that call's public result notification. Drain application-owned work, close the SDK/socket normally, await its public closed event. Return final `{started, committed}`; no scenario work or wire output may remain scheduled. |
| `close` | `{}` | Idempotent resource cleanup, including after finish; return `{}`. |

Probe increments started immediately on entry, committed at its synchronous test side-effect, and returns null. It must not independently reject a closed epoch or suppress counters because a signal is aborted. Result receipt is not inferred from the wire by the official client driver; it uses public tool.result events. A different SDK driver may implement equivalent public notifications but must preserve the documented fence.

The runner sends turn.state, waits for observe, requests interrupt, verifies its wire interrupt, then sends stale tool.call. It sends no server interrupted echo. The control channel alone is insufficient evidence: the runner checks actual vRT wire traffic plus final observable effects through WebSocket close.

## Server driver

`ready {}` starts an anonymous test server with deterministic model fixture and returns `{url: "ws://127.0.0.1:<dynamic-port>"}`. No startup URL is printed separately. `close {}` is idempotent and releases server/session resources. stdin EOF must also clean up.

Only handshake cases need a server driver in this phase. No private model-state query, effect query or emitScenario operation is required until future server behavior scenarios are implemented. A supplied `--url` skips driver startup and runs the same handshake profile on an existing appropriately configured test endpoint.

## Ownership and completeness

The driver owns its SDK, listeners, application tasks, timers and any child resources. It must report errors rather than fabricate success. The official drivers run directly as Node processes; foreign drivers can be Python, Java, C or another implementation with this contract. No Python network SDK is included in this phase.

The runner cannot prove a dishonest driver accurately reports effects or has drained arbitrary future work. Review external drivers as trusted instrumentation, and report unsupported operations as incomplete/failure rather than pretending the implementation passed. This contract does not provide full session conformance or certification.
