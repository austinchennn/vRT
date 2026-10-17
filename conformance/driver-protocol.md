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

## Optional tool-cancellation-v1 instrumentation

Revision 1 has an additive optional extension. `ready` may include `driverCapabilities: ["tool-cancellation-v1"]`. This is test-driver instrumentation, **not** a vRT capability and never appears in hello/ready wire negotiation. The original profile and commands remain usable without this field. A cancellation-profile runner checks it before issuing new commands; missing support produces incomplete, not pass or a forced upgrade of legacy drivers.

The probe's original synchronous behavior is unchanged unless explicitly prepared:

| Command | Data | Confirmation contract |
|---|---|---|
| `prepareCancellation` | `{callIds: [A,B,C], blockedCallId: A}` | Initialize per-call effects before any calls arrive; A will wait on an application-owned deferred task. |
| `waitForCall` | `{callId, phase: "received" \| "started" \| "aborted"}` | Await the SDK's public call event, probe entry, or A's actual cancellation signal respectively. No private SDK queue inspection. |
| `releaseCall` | `{callId: A, outcome: "resolve" \| "reject"}` | Release the prepared task once; await its completion/rejection and attached SDK promise continuations via an event-loop fence. No time-based sleep. |
| `readEffects` | `{}` | Original aggregate fields plus `calls: {[callId]: {received, started, committed, aborted, completed}}`. |
| `finish` | `{callIds: [A,B,C]}` | Await public results for all calls, drain all owned tasks/continuations, close normally and await closed; return final aggregate and per-call effects. Legacy `{callId}`/`{}` forms remain supported. |

`received` and `aborted` are booleans; other per-call fields are counters. `started` increments immediately on probe entry, before any cancellation check. A registers the supplied AbortSignal, waits for explicit release, then checks the signal before committing. Its finally block increments completed even on rejection. B/C are normal synchronous probes: if wrongly entered they increment started/committed, exposing a failed SDK gate rather than hiding it through a second application cancellation check.

Sequence: observe epoch → send A → wait started → send B → wait received → inspect blocked/queued effects → local interrupt confirmation → wait A aborted → send C → wait received → release A → finish → wire close → oracle. B's receive event is not itself a queue-depth API: A is deliberately held, and independent start counters show B has not entered. Returning from release must not hide task rejection or leave application work queued beyond finish.

A running call may send INTERRUPTED immediately **or after completion** (§7.2). The runner must release A without waiting for its result, then require exactly one logical INTERRUPTED result. A fake wire driver with deferred settlement proves this allowed behavior is not rejected. If a released task rejects, all instrumentation drain handlers must observe the rejection so it does not escape as an unhandled process error.

`close` must remain idempotent and release owned blocked work after closing/aborting the SDK during cleanup. If a command cannot complete, the runner retains its existing bounded direct-child termination policy. These fixtures do not promise forced cancellation, rollback, process-tree supervision or protection against dishonest effect reporting.

## Server driver

`ready {}` starts an anonymous test server with deterministic model fixture and returns `{url: "ws://127.0.0.1:<dynamic-port>"}`. No startup URL is printed separately. `close {}` is idempotent and releases server/session resources. stdin EOF must also clean up.

Only baseline handshake cases need the default server driver. No private model-state query, effect query or emitScenario operation is required until future server behavior scenarios are implemented. A supplied `--url` skips driver startup and runs the same handshake profile on an existing appropriately configured test endpoint.

## Opt-in `server-auth-v1` instrumentation

The runner selects this profile explicitly; the default `ready {}` behavior is preserved. Each case has its own process and test token. Request shape (the placeholder below is illustrative, never a real credential):

```json
{"requestId":"1","command":"ready","data":{"profile":"server-auth-v1","authToken":"<ephemeral-test-token>"}}
```

Before acknowledging, the driver starts a server on an OS-assigned loopback port. Its **public authenticate hook** must accept exactly that token and return a deterministic test principal; absent or different tokens are refused. The official driver uses `serve(..., {authenticate})`, not private session fields. The driver replies only when the listener is ready:

```json
{"requestId":"1","ok":true,"data":{"url":"ws://127.0.0.1:<dynamic-port>","driverCapabilities":["server-auth-v1"]}}
```

`driverCapabilities` declares supported **test instrumentation**, not vRT negotiated capabilities. `authToken` configures only this isolated test server. No new wire capability or public wire field is introduced. Missing support yields incomplete/nonzero status. An instrumented driver that cannot configure authentication must return a control error; it must not fall back to anonymous service. `close {}` and stdin EOF release server/session/socket resources idempotently, including after rejected authentication or a timed-out case. Request IDs, errors, timeout and process-exit rules above remain unchanged.

The control token stays out of argv, URLs and normal reports; stdout contains only JSONL replies. Logs on stderr must omit tokens too. The runner redacts the literal generated good and wrong token values if an erroneous driver/peer echoes them in a failure trace, close reason or captured error. Drivers are trusted and this does not sanitize arbitrarily encoded secrets or change their own logging obligations. There is no production identity provider or language-specific contract requirement.

## Opt-in `server-tool-stream-v1` instrumentation

This is a separate server-only test profile, not a wire capability. All old ready/finish forms and profiles keep their existing meaning. Each case owns one process/server/model and uses the following additive operations:

| Command | Data | Successful confirmation |
|---|---|---|
| `ready` | `{profile: "server-tool-stream-v1", argumentStreaming: boolean}` | Start an anonymous loopback server on a dynamic port with deterministic model and server tool `probe`; configure the public model capability accordingly. Return `{url, driverCapabilities: ["server-tool-stream-v1"]}` only once listening. |
| `beginStream` | `{kind: "baseline" or "lifecycle" or "no-delta" or "failed" or "cancelled", callIds: string[]}` | Initialize effects/fences once, start one model response, inject two argument fragments for each call (interleaved across the two lifecycle calls); no full calls yet. no-delta emits only response start. Return after events are injected, without closing. |
| `readStreamEffects` | `{}` | Return `{calls: {[callId]: {started: number, committed: number}}}`; entry counts before application checks. |
| `completeStream` | `{}` | Once, issue full model calls with `{value: 1}` and end the response normally; valid only for baseline/lifecycle/no-delta. Do not wait for held tool completion. |
| `waitStreamTool` | `{}` | After complete, acknowledge the first public tool entry. The tool has emitted progress (except no-delta) and remains blocked before commit. |
| `finishStream` | `{}` | Once: release and await owned tools/result submission for executing cases; end the partial response for failed; for cancelled, after wire interruption confirmation, inject old delta/full-call events. Drain all owned work and attached continuations, return final effects, **keep connection open**. |
| `close` | `{}` | Abort/close the server and release/drain any held application work; repeat/EOF safe. |

The runner chooses one call ID except lifecycle, which uses two. It sends hello with no capability for baseline and offers only tool-stream-v1 otherwise. The driver configures model support but must not force negotiated wire capabilities. Unsupported instrumentation or declined required capability is incomplete/nonzero, not a claim that the optional feature is mandatory for all servers.

Control replies do not substitute for wire evidence. After begin and finish, the runner sends a ping and waits for its new pong, fencing wire frames previously enqueued by the confirmed model/application work. Finish must not leave future writes scheduled. It must not close to avoid producing a missing terminal: the oracle checks required terminals while the connection is live and then checks the complete trace through close. An early-ending session is incomplete when its valid prefix cannot finish this scenario, respecting §7.5's exception. Faulty peers with visible wire violations still fail.

Official instrumentation uses only public model events/clock, tool context, server configuration and lifecycle APIs. The cancelled case advances the public fake clock to deliver its scheduled response.end before late model events. No private queue/gate/state is read. Request IDs, stdout/stderr rules, monotonic deadlines and bounded direct-child shutdown remain unchanged. Drivers are trusted fixtures; this is not an arbitrary-work drain guarantee, process-tree supervision or rollback of effects.

## Opt-in `server-heartbeat-v1` instrumentation

This server-only profile requires explicit virtual-clock support. Its instrumentation token is separate from vRT capability negotiation. Each case owns a fresh process/clock starting at 0, no production credentials, dynamic loopback port, and at most two successive WebSocket connections. Foreign implementations may expose equivalent public edge/clock hooks; implementations without them are incomplete for this selected profile, not globally nonconformant.

| Command | Data | Confirmation contract |
|---|---|---|
| `ready` | `{profile: "server-heartbeat-v1", timeoutMs: T, resumeWindowMs: 6T, holdOpening: boolean}` | Start fixture with these public server options. Return `{url, driverCapabilities: ["server-heartbeat-v1"], timing: {clock: "virtual", timeoutMs: T, delayAllowanceMs: ceil(T/2), resumeWindowMs: 6T}}`. T is a local integer policy, 100..60000. |
| `waitHeartbeat` | `{connection: 1 or 2, event: "connected" or "opening" or "closed" or "audio" or "context:<marker>"}` | Await the named public observation for that connection, returning `{now}`. Connected means edge attachment/listeners installed; opening means the public auth hook entered; context/audio confirm actual SDK handling, not merely socket receipt. Markers use lowercase letters/digits/hyphens. No new wire probe. |
| `releaseHeartbeatOpening` | `{}` | Resolve the owned auth barrier; drain its immediate continuations. Runner still independently waits for wire ready. Repeat release is harmless. |
| `advanceHeartbeat` | `{ms: integer}` | Advance only the injected clock. Each step <=2T, total <=resumeWindow+3T. Drain close handshakes initiated by this advance, then return `{now, connections: [{open: boolean, closeRequestedAt?: number}]}` in attachment order. `open` is the public WebSocket state; closeRequestedAt observes the public outbound close request, not private timeout state. |
| `close` | `{}` | Idempotently close sockets, release held hook, drain owned continuations, close Hub/model, cancel owned clock resources and listener. EOF repeats cleanup. |

Virtual time does not advance autonomously. Runner real deadlines independently bound control and network waits, including a driver clock that hangs. A clock acknowledgement must match the requested target; receipt acknowledgements must match current virtual time. No clock commands are sent until a connection/receipt barrier or actual wire response establishes the relevant input has been handled.

The runner independently records received-input times and checks early liveness/late closure with a finite allowance. It never asks for SDK lastSeen, session maps, private timers or a computed heartbeat verdict. Time/counters from instrumentation are trusted evidence; actual pong/ready/error/close and minimal resume still travel over real WebSockets.

The official fixture uses public Hub.attach rather than adding an inspection API to serve(). It converts real text/binary socket data into public Connection.receive calls and records transport events around attachment/close. The public Clock adapter owns its scheduled handles only for cleanup. The fake model exposes sendAudio receipt without a sound device. The optional opening hook accepts a fixed test principal; this is not production authentication.

For minimal resume the client application stream is empty, so resumedFrom must be 0; resumeFrom uses the latest independently observed server cursor. The probe runs before the configured resume window expires. Connection parking/retention is established by successful same-session wire ready, not Hub.size or private lookups. There is no automatic client reconnect or replay orchestration claim.

Missing instrumentation/virtual clock is incomplete/nonzero; mismatched configuration/clock replies fail the driver contract. Malformed output, exit, deadline and bounded direct-child shutdown rules from revision 1 continue to apply. WebSocket control Ping/Pong activity remains an explicitly untested specification interpretation; vRT ping/pong are JSON messages here.

## Ownership and completeness

The driver owns its SDK, listeners, application tasks, timers and any child resources. It must report errors rather than fabricate success. The official drivers run directly as Node processes; foreign drivers can be Python, Java, C or another implementation with this contract. No Python network SDK is included in this phase.

The runner cannot prove a dishonest driver accurately reports effects or has drained arbitrary future work. Review external drivers as trusted instrumentation, and report unsupported operations as incomplete/failure rather than pretending the implementation passed. This contract does not provide full session conformance or certification.


## Opt-in `server-input-validation-v1` instrumentation

This is a test profile identifier, not a negotiated vRT capability. Old `ready {}` and all existing profiles retain their meaning. Every case owns one process and isolated anonymous server/model. New operations use the same requestId/error/EOF/deadline rules above:

| Command | Data | Confirmation |
|---|---|---|
| `ready` | `{profile: "server-input-validation-v1"}` | Start an OS-assigned loopback listener with a deterministic, inert model supporting PCM16/24000 mono. Return `{url, driverCapabilities:["server-input-validation-v1"]}` only when listening. No scripts, tools, automatic model responses or background input producers. |
| `readInputs` | `{}` | Return a public model snapshot: `{sessions, texts:string[], audio:[{hex,format:{encoding,sampleRate,channels}}]}`. sessions counts all model connections since startup, including closed ones. Model command observations must include invalid input if the SDK incorrectly forwards it; do not filter it away. |
| `finishInputs` | `{}` | Once: after the runner's ordered network receipt fence, drain the fixture's owned work and attached SDK continuations, emit one public model input.transcript event (`itemId:"input-finish-marker", text:"input-observation-marker", final:true`), return the final snapshot and keep the connection open. No later scenario effects may be scheduled. |
| `close` | `{}` | Close server, sessions, listeners and owned work; repeat and stdin EOF safe. |

The official driver uses public `fakeModel({onCommand})`, its public sessions collection and `serve`; it never sends expected error frames itself. Audio snapshots contain actual bytes (lowercase hex) and model-facing formats; do not omit empty observations when forwarded by the SDK. A legal empty frame may instead be ignored by an implementation. Limits: 64 observed texts of at most 1024 characters, 64 audio chunks of at most 1024 bytes; overflow errors instead of truncating to a passing subset. The runner sends far fewer/smaller inputs. Missing snapshot fields are failures.

A pong receipt fence establishes that preceding frames reached the server; it does not alone prove all asynchronous application work completed. finish must honor the bounded, inert-fixture drain promise. The official driver drains attached continuations through an event-loop fence. Runner then fences the live wire and closes before final trace validation. This is trusted finite instrumentation, not arbitrary-task scheduling control, OS isolation, process-tree supervision or full compatibility certification. Unsupported instrumentation yields incomplete/nonzero. Errors, early connection close, command timeout and process exit retain bounded direct-child cleanup.

## Opt-in `client-control-validation-v1` instrumentation

This client-only profile is a test contract, not a wire capability. The runner starts a dynamic loopback WebSocket server and supplies VRT_CONFORMANCE_URL. All commands use the existing requestId, stdout-only-JSONL, stderr logging, deadline, error and EOF rules. Each case owns a fresh process and SDK.

| Command | Data | Confirmation |
|---|---|---|
| `ready` | `{profile:"client-control-validation-v1"}` | Public connect with audio/reconnect disabled, declare synchronous probe tool, await baseline ready, **install public observation listeners before replying** `{capabilities:[],driverCapabilities:["client-control-validation-v1"]}`. |
| `prepareControl` | `{}` | Once, confirm empty observation window and return snapshot. Do not erase prior effects/errors to conceal them. |
| `waitControlErrors` | `{count:integer 1..64}` | Wait for that many application error notifications; return complete bounded snapshot. Do not classify frames inside the official driver. |
| `waitControlMarker` | `{itemId:string}` | Wait for public transcript notification with this ID; return snapshot. |
| `interrupt` | `{}` | Call SDK public interrupt(), confirm after its synchronous local effects; runner inspects actual wire epoch. |
| `finishControl` | `{}` | Drain probe-owned work/attached continuations; close SDK, await public closed notification; return final snapshot. No later scenario work remains. Repeated calls may return the same final state. |
| `close` | `{}` | Idempotent close/EOF cleanup, including partial or failed runs. |

Snapshot: `{errors:[{code,recoverable}],events:[...],started,committed,closed:boolean}`. Record each local invalid-input diagnostic once with its SDK-provided classification and recoverability. Normalize public state, tool.call/tool.result identity, transcript fields, text, tool.preview and interrupted events into `events`; do not filter business events caused by invalid inputs. Tool entry increments started before any application guard, then the synchronous probe commits and increments committed. No asynchronous tool, device, model or background producer is used. This is an observation interface, not a second decoder/gate/dispatcher.

Official errors/events are bounded to 64/128 entries; overflow fails, never silently drops records. Existing 64-KiB JSONL buffer and bounded wire trace remain. A pending wait rejects on observed close; no response/exit/timeout triggers runner's bounded direct-child stop escalation. Close explicitly waits for the public closed event: SDK close() returning alone is not assumed to be socket completion. These controls do not promise process-tree supervision or arbitrary asynchronous-work draining.

The profile starts after ready; it does not require a new SDK API to observe handshake-before-ready errors. Error wording is opaque. Wire field validation is distinct from optional validation of tool arguments against application JSON Schema. Valid callId reuse detection with a different seq is not required (§7.1); this scenario only checks an invalid call cannot reserve the ID of its first valid use.

## Opt-in `server-resume-replay-v1` instrumentation

This server-only test profile is not a wire capability. Each case owns one anonymous inert model, up to two real WebSocket connections and a fresh process. Old ready/finish operations and other profiles retain their meaning. All commands use the existing requestId, stdout/stderr, error, EOF and bounded direct-child termination rules.

| Command | Data | Confirmation |
|---|---|---|
| `ready` | `{profile:"server-resume-replay-v1"}` | Start an OS-assigned loopback listener around the public server SDK and an inert model (no scripts, tools or background producers). Return `{url,driverCapabilities:["server-resume-replay-v1"]}` only when listening. |
| `waitResumeContext` | `{count:1 or 2}` | Await that many public onContext callbacks; return complete bounded snapshot, including duplicates if incorrectly delivered. Do not deduplicate in the instrumentation. |
| `emitResume` | `{markers:string[]}` | One/two markers per request. Emit each through the public model as input.transcript with itemId=`resume-<marker>`, text=marker, final=true; acknowledge only after synchronous injection, with snapshot. Never generate wire seq/frames in the official driver. |
| `waitResumeClosed` | `{connection:1 or 2}` | Physical connection number in acceptance order. Acknowledge only after its public WebSocket close callback has delivered Connection.closed() to the SDK; return snapshot. |
| `finishResume` | `{}` | Drain the controlled model/context continuations, return final snapshot; do not invent extra model events or end the session to excuse missing replay. Runner has already closed both physical peers and confirmed their SDK callbacks. |
| `close` | `{}` | Idempotently terminate remaining physical peers, await public close delivery, close SDK Hub/model/listener and clear owned resources. Repeat/EOF safe. |

Snapshot: `{sessions,connections,contexts:JSON[],emitted:string[],closedConnections:number[]}`. sessions is the public model's total connection count (including closed model sessions), not merely currently active sessions. contexts contains actual callback values in order. emitted records injections, never their desired wire results. closedConnections lists physically closed/SDK-notified acceptance IDs in acceptance order. Missing fields fail; count bounds are two connections, eight contexts (each at most 1024 JSON characters) and eight markers (1–24 lowercase ASCII/hyphen characters). Overflow fails rather than hiding data. Wire/control buffers retain their existing limits.

The public edge confirmation does not inspect parked state. Application cursor is separate from bytes captured by transport: the from-zero case deliberately leaves application processing at 0 and sends no ACK. Other cases process the captured prefix. Context seq-1 replay exercises server dedup; seq 2 proves continued handling. This contract is server instrumentation for a raw test client, not a Python/Java/C reconnect implementation.

The official driver uses normal public Hub defaults with no virtual time control. Its injections/context callbacks are synchronous and have no producers left scheduled; finish drains attached continuations. Deadlines are local bounded test policy, not protocol latency requirements. Driver effects/drain confirmations are trusted, not dishonest-driver detection, process-tree supervision or general guarantees about arbitrary asynchronous work.
