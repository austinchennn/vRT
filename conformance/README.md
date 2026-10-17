# vRT black-box conformance profiles

These are **partial** `handshake-interrupt-v1` (default), `tool-cancellation-v1`, `server-auth-v1`, `server-tool-stream-v1`, `server-heartbeat-v1`, `server-input-validation-v1` and `client-control-validation-v1` profiles for [#17](https://github.com/austinchennn/vRT/issues/17), not certification of a complete vRT implementation. It tests real WebSocket traffic and controls public SDK APIs through independent JSONL driver processes. No model account, device, browser or API key is needed.

## Run from a checkout

Requires Node 22+ and a clean `npm ci` at the repository root:

```sh
npm run test:conformance
node conformance/dist/node/cli.js client --exec node --json -- conformance/dist/node/drivers/typescript-client.js
node conformance/dist/node/cli.js server --exec node --json -- conformance/dist/node/drivers/typescript-server.js
node conformance/dist/node/cli.js client --profile tool-cancellation-v1 --exec node --json -- conformance/dist/node/drivers/typescript-client.js
```

`--exec` is a single executable; everything after `--` is passed as its argument array without a shell. The runner starts a new process/session for each case. Client mode starts a test server on an OS-assigned loopback port and passes `VRT_CONFORMANCE_URL` to the driver. Server mode gets its URL from the driver's `ready` response. For a server already running, use:

```sh
node conformance/dist/node/cli.js server --url ws://localhost:8790 --json
```

The default profile needs a test server that accepts the baseline anonymous `hello`. Select `server-auth-v1` explicitly for the isolated authentication configuration below. External production endpoints may need other profiles and must not be reported as globally nonconformant solely for lacking this fixture configuration.

`--timeout-ms` is a per-case monotonic deadline, default 5000 ms, configurable from 1 to 60000 ms. Cleanup has separate short bounded deadlines so expired cases can still terminate their resources. The timeout is a harness policy, not a normative vRT timing requirement. Omit `--json` for a human-readable report. Exit 0 means **all selected profile cases passed**; 1 means a case failed/missing; 2 means invalid invocation or setup/assets failure. Every report still says `fullSuite: incomplete`.

## Coverage and evidence

The default remains `handshake-interrupt-v1`; it never silently adds requirements to an existing driver. `--profile tool-cancellation-v1` is client-only and selects the two additional cases below. The driver must advertise the **instrumentation** token in `ready.driverCapabilities`; this is separate from vRT wire capabilities (`ready.capabilities`, still empty in these profiles). Missing support reports incomplete and exits 1; unknown profiles or server/cancellation invocations are usage errors (exit 2).

| Stable case ID | Assertion |
|---|---|
| `client/handshake/baseline` | Schema-valid hello, ready without confirmed capabilities, public SDK capabilities empty, no gated wire messages through close. |
| `client/interrupt/stale-call` | After observing epoch 1 and completing local interrupt, an old-epoch probe never starts/commits and has exactly one logical INTERRUPTED result with matching call/epoch. |
| `server/handshake/baseline` | Minimal hello without capabilities receives schema-valid ready with no capabilities enabled. |
| `server/handshake/version` | Wrong-major hello gets recoverable sessionless UNSUPPORTED_VERSION without opening a session; valid hello on the same connection then succeeds (§9.1). |
| `client/cancellation/queued-running` | A runs and blocks; B is observed queued; local interrupt aborts A; C arrives closed; release A successfully; each result is INTERRUPTED once through close. |
| `client/cancellation/late-rejection` | Same sequence, but A's application task throws after release; its rejection cannot create a second logical result. |

The baseline hello and wrong major value are loaded from shared vector IDs (`client/hello/minimal`, `client/envelope/version-2`). Packaged schemas validate incoming frames; the independent oracle handles contiguous new sequence numbers, same-sequence replay and logical result uniqueness. The capability registry identifies gated message types. No SDK codec, Inbox/Outbox or epoch gate is used as an oracle.

This profile does not inject a server `interrupted` message into the client test: the local gate must suffice. `observe` confirms the SDK exposed the epoch through its public state event; `interrupt` confirms the public synchronous method returned. Only afterwards is the stale call sent. Probe `started` and `committed` counters are separate; the probe does not inspect cancellation to hide a failed gate.

**End fence:** `finish` waits for the call's public result event, drains application-owned work, initiates normal close and waits for the SDK's public closed event. The runner waits for the WebSocket close event and examines the entire received trace before judging. Correctly implemented drivers must not leave scenario work queued beyond this fence. This is a finite test contract, not proof against an arbitrary malicious driver or arbitrary future delayed work. Same-sequence retransmission is not a second logical result; two result messages with different sequences are.

In the cancellation profile, A/B/C have independent received/started/committed/aborted/completed observations. Before interrupt the oracle requires A started and blocked, B received but unstarted, and no commits. It then confirms A's AbortSignal, C receipt, releases A, drains the application task and SDK promise continuations via an event-loop fence, and checks all three results only after close. A's commit check is **cooperative application behavior**, not proof the SDK can undo prior effects. B/C must never enter the tool at all.

§7.2 permits an SDK to defer A's INTERRUPTED result until A finishes. The runner therefore does not wait for that result before releasing A. A separate deferred-result wire fixture must pass; the late-success and late-rejection official SDK cases test suppression when it settles early. Fault fixtures that start B during cancellation or send a new-seq A result after release fail at the new case IDs. Same-seq retransmission after release still passes. Held release, premature exit and held finish tests verify bounded failure and vanished child PIDs. Repeated close after finish remains idempotent.

Tests include a stale-executing client (returns INTERRUPTED but increments effects), a double-result client, a duplicate deferred to a later event-loop callback, and a same-sequence replay that must pass. Failure handling covers no response, process exit, malformed/oversized stdout, a refused handshake, stalled hello and forced termination. Cleanup tests verify that the spawned PIDs no longer exist. Driver shutdown is idempotent after a successful finish.

Not implemented: complete message-vector conformance, reconnect/replay scenarios, ACK bounds, heartbeat, audio, server interruption routing, capability-enabled scenarios and Python/network drivers. A bare server URL cannot establish tool-internal effects; only the listed handshake cases run in server mode.

## Authentication and session-error profile

```sh
node conformance/dist/node/cli.js server --profile server-auth-v1 --exec node --json -- conformance/dist/node/drivers/typescript-server.js
```

This profile requires a server driver; client mode and bare `--url` are rejected. The default profile and anonymous `ready {}` contract are unchanged. Each case starts a new server process with a fresh random test-only credential over JSONL. The driver must advertise `driverCapabilities: ["server-auth-v1"]`; missing instrumentation yields **incomplete** and exit 1, not a conformance verdict about a production authentication system. Driver instrumentation, test authentication configuration, and negotiated vRT capabilities are separate concepts.

| Stable case ID | Normative assertion |
|---|---|
| `server/auth/missing-token` | Legal hello without auth: UNAUTHORIZED, recoverable false, seq 0, no ready, then WebSocket close 4401 (§5.3). |
| `server/auth/wrong-token` | Structurally valid but incorrect credential: same refusal; not INVALID_FIELD (§5.3). |
| `server/auth/correct-token` | Correct credential: valid baseline ready with no unoffered capabilities (§3.3, §5.2). |
| `server/auth/error-sequence` | Raw malformed JSON before hello: MALFORMED/recoverable true/seq 0; authenticate on that same connection; raw malformed JSON after ready: sequenced positive error; ping/pong still works (§4.1, §9.1). |

The runner observes public close code/reason and the count of preceding frames. Rejection requires error-before-close; success uses a normal WebSocket close fence before the independent oracle checks the full bounded trace. The oracle derives binding from ready, checks schema separately, and enforces current-stream numbering without calling SDK codecs or sequence helpers. These scenarios establish no resumed session. Recoverability alone is not used to infer a generic close policy.

Wire fixtures deliberately accept wrong credentials, number sessionless errors positively or bound errors as 0, close with the wrong code, close without an error, or leave a refusal open. Each must fail its matching stable case. Tests also cover absent instrumentation, process exit, no control response, repeated cleanup and literal credential redaction in wire traces, close reasons, driver errors and captured stderr. The runner removes both generated credential strings from reports, including failure/cleanup paths. It never forwards driver stderr directly to the terminal. Drivers remain trusted local instrumentation: this is not a secret manager or protection against a malicious driver encoding credentials differently. Tokens must not be logged by a driver or put into a URL. No JWT/OAuth, real account, new dependency or SDK authentication implementation is added.

This profile does not include auth on resume, foreign-principal isolation, token refresh, optional tool streaming or the queued/running cancellation profile merged separately in #39. `fullSuite` remains incomplete. The existing CI invocation discovers all profile test files; production SDK publishing and dependency boundaries are unchanged.

## Server tool-stream profile

```sh
node conformance/dist/node/cli.js server --profile server-tool-stream-v1 --exec node --json -- conformance/dist/node/drivers/typescript-server.js
```

This explicit, driver-only profile checks server behavior under §§3.3, 7.4 and 7.5. It does not certify client display behavior or implement a document editor. Missing driver instrumentation or a declined optional wire capability yields incomplete/nonzero; enabling an unoffered capability is a failure. The actual per-case negotiated set is reported; the top-level capabilities field is their union.

| Stable case ID | Assertions |
|---|---|
| `server/tool-stream/baseline` | No capability offered/enabled, no tool.stream, deterministic server tool completes once; legacy preview shape stays opaque. |
| `server/tool-stream/lifecycle` | Two calls with interleaved parameter fragments each have consistent identity, start first, complete once, progress after complete and one settled terminal; no legacy preview or server result output. |
| `server/tool-stream/no-delta` | A model configured without argument streaming directly issues the call: start, complete and terminal, no fragments required. |
| `server/tool-stream/failed` | Response ends with incomplete arguments: failed terminal, no tool entry/commit; a late model delta cannot reopen it. |
| `server/tool-stream/cancelled` | Runner observes fragments before sending a valid wire interrupt for the observed epoch; cancelled terminal and no tool effects even after explicitly injected old model delta/full-call events. |

The reference driver uses public `fakeModel` events and `ToolContext.emit`, never handcrafted wire frames or private SDK state. It holds server tools on an application-owned deferred release, with separate started/committed counters. The two-call case checks state isolation; the SDK still owns actual tool scheduling. Tool output is a known test-only marker, which must not appear in tool.stream. The no-delta case suppresses tool progress too, preserving the literal start/complete/terminal path described in §7.5.

**Live completion fence:** begin acknowledges synchronous model event injection; a runner ping/pong then drains previously queued wire frames before examining the partial-arguments prefix and effects. After full calls, public tool entry is confirmed while commit remains held. Finish releases owned work, observes public model result submission and drains attached continuations with an event-loop fence. A second ping/pong proves the connection is still usable before the oracle requires all terminals. Finally the runner closes normally and checks the entire bounded transcript again. These fences are part of the trusted driver contract, not a universal proof about arbitrary delayed work.

§7.5 exempts sessions ending before a terminal. A valid prefix cut short by connection close is reported incomplete (connection loss alone does not prove the session ended), not falsely diagnosed as a missing-terminal protocol violation. A missing terminal at the **live** completion fence fails the fixture contract/required case. Already observable schema, capability, ordering or conflicting-replay violations remain failures even when the peer then closes.

The independent oracle validates schema and registry gating, contiguous new sequences, identical same-seq replay, and per-call lifecycle state. It rejects conflicting same-seq content and new-seq duplicate terminal steps. Baseline callers still negotiate nothing and reject gated messages. Fault fixtures also exercise unoffered capabilities, early progress, duplicate complete, changed identity, legacy/new double delivery, output leakage and reopening. Unresponsive/held/exiting/early-closing fixtures and an actual SDK tool whose release is withheld verify bounded cleanup and vanished direct-child PIDs. Close/EOF cleanup is idempotent; this adds no process-tree sandbox guarantee.

Known normative context: §3.3's final sentence still says the registry is empty, while §7.5 and the actual registry define draft tool-stream-v1. This profile follows those explicit definitions and reports the discrepancy without editing normative files. Schemas allow unknown members; server-result non-disclosure is checked semantically rather than inferred from additionalProperties. Other optional matrices, client UI/SHOULD behavior, reconnect/replay, binary/audio, heartbeat and VDoc context/transactions remain outside this profile. `fullSuite` remains incomplete.

## Server heartbeat profile

```sh
node conformance/dist/node/cli.js server --profile server-heartbeat-v1 --heartbeat-timeout-ms 1200 --exec node --json -- conformance/dist/node/drivers/typescript-server.js
```

This opt-in server/driver-only profile tests §4.4 server MUST behavior. It does not impose client SHOULD behavior. A driver without the virtual-clock instrumentation reports incomplete/nonzero. Existing anonymous, auth, cancellation and stream profiles keep their original ready forms. Timing is test configuration, **not** a negotiated wire capability.

| Stable case ID (`server/heartbeat/…`) | Evidence |
|---|---|
| `pong-awaiting-hello` | vRT ping before hello receives schema-valid seq-0 pong, no unsolicited ready, then legal hello succeeds. |
| `pong-opening` | Public authenticate hook is held; pong arrives before release and ready only after release. |
| `pong-ready` | Repeated seq-0 ping/pong after ready; subsequent MALFORMED uses the normal sequenced stream. |
| `idle-sessionless` | No input: live before configured timeout, then observed WebSocket close 4408; no session created. |
| `idle-resume` | Bound idle connection closes 4408; a new connection restores the same session within the resume window, with resumedFrom 0 because no client business messages were sent. Any observed server control cursor is supplied in resumeFrom. |
| `activity-context` | Public onContext receipt refreshes activity; no probe ping is sent. |
| `activity-malformed` | MALFORMED/recoverable error confirms receipt; invalid JSON also refreshes activity. |
| `activity-binary` | A raw legal input-audio frame reaches public model sendAudio; binary input refreshes activity without hardware or probe ping. |

`--heartbeat-timeout-ms` is local profile policy: an integer 100..60000, default 1200. The runner configures T, a resume window of 6T and a finite detection allowance of ceil(T/2). It checks live at T-1 after the last confirmed input and close by T+allowance. These are fixture/observation bounds, **not protocol timing constants** or a required polling algorithm. Activity is delivered at floor(3T/4); a live checkpoint at floor(5T/4) distinguishes refreshed input from the original deadline. Tests use multiple T values, including values not divisible by the SDK's polling fraction.

There are two time axes: the runner's real monotonic per-case deadline and the server's explicit virtual time starting at zero. Only confirmed transport connection/receipt or wire response precedes clock advancement. Context uses onContext, binary uses the public fake model command, and malformed JSON uses its error. No extra traffic is used to test liveness after these activities. Outgoing server frames are not credited as incoming activity.

The reference driver is a small real WebSocket edge calling public `Hub.attach`, with a public injected Clock and deterministic fake model. It owns transport attachment/close barriers, hook release and clock resources. It does not read private SDK sessions, lastSeen or timers. Close-request time is observed at the public edge adapter's close callback and checked alongside the actual remote WebSocket close code. Advancing the clock drains any close handshake it triggered before acknowledging; early-open checks combine public server socket state with the runner's socket state. Driver-owned timer handles are retained solely for resource disposal, never as a correctness oracle.

This profile exercises the server Hub through a custom edge, not `serve()` HTTP/static-file/upgrade behavior or real wall-clock scheduler performance. Existing default/e2e checks still exercise the Node serve path. The resume probe has no application replay and is not evidence for bidirectional replay, lost results, cache loss or automatic reconnect.

Wire faults buffer ping during opening, refresh activity only for ping, never close, close early/with the wrong code, count outgoing traffic as input, destroy timed-out sessions or number pong incorrectly. These must fail stable case IDs. Cleanup tests include control no-response, clock failure, process exit, held release, and an actual public SDK authenticate hook deliberately left blocked. Direct child PIDs vanish and repeat close/EOF is safe; no process-tree sandbox is promised.

§4.4's “frame of any kind” does not explicitly distinguish WebSocket control frames from application data frames. This profile covers text/binary **data** frames and vRT JSON ping/pong, leaving RFC WebSocket Ping/Pong activity interpretation for maintainer clarification. §4.4 does not mandate a new error message/code before heartbeat close; none is invented. §9.3 warns proxies can replace close codes: these controlled direct-loopback cases test the server's own 4408 plus timing/traffic evidence, not a proxy-transformed endpoint. Full heartbeat/session conformance remains incomplete.

## Build, install and packaging

```sh
npm run build:conformance
npm run typecheck:conformance
npm run pack:conformance
npm run test:conformance:consumer
```

The consumer check packs and installs the actual tarball into an unrelated temporary directory, then invokes its installed `vrt-conformance` executable for both original reference modes and the cancellation, authentication, server tool-stream and server heartbeat profiles, including missing-scenario detection. It requires registry access or a populated npm cache for existing runtime dependencies. The package is marked private to prevent accidental registry publication; `npm pack` and local installation still work. Package-name availability and public release are not claimed.

Build copies current schema, shared vectors, capability registry and scenarios into `dist/assets` and includes LICENSE. Installed CLI asset paths are relative to the executable, never the checkout/current directory. Official reference drivers are bundled from the locally built SDK; they therefore test that build, not whichever SDK an external user happens to have installed. To test a different implementation, supply its own executable following [driver-protocol.md](driver-protocol.md).

The root workspace includes this package, but production `scripts/packages.mjs` still scans only `packages/`. Production SDK pack/publish/version/size workflows do not pick up this test CLI. Build/test/pack commands and CI are explicit. No dependency is added to core, protocol or client. Tests use Node's built-in runner. Runtime dependencies reuse existing versions of **ws** (MIT, maintained WebSocket transport) and **Ajv** (MIT, draft-2020-12 schema validation); Ajv's transitive dependencies belong to the test CLI, not SDK hot paths. There is no new framework or real-time performance claim.

## Known limits and review points

- The spec's §3.3 still says there are no capabilities, while §7.5 and the actual registry define tool-stream-v1. This harness follows the registry and exercises no negotiated optional capabilities; no normative file is changed.
- Drivers are trusted test instrumentation. The runner bounds its own incoming WebSocket payload (64 KiB), frame trace (256), JSONL buffer (64 KiB), stderr tail (8 KiB), waits and direct-child termination. It is not an OS sandbox; an external driver must own/clean up any descendants it spawns. Shipped drivers spawn no descendants.
- Public SDK events plus driver effects provide evidence under the documented fence, not introspection into private SDK state. An implementation that cannot expose equivalent driver operations needs an explicit incomplete profile, not invented success.
- The small phase-1 scenario inventory selects fixed implementations rather than exposing a general-purpose workflow language. Adding scenarios requires explicit runner support and independent oracle review.

## Server input validation and binary input profile

```sh
node conformance/dist/node/cli.js server --profile server-input-validation-v1 --exec node --json -- conformance/dist/node/drivers/typescript-server.js
```

An explicit server/driver profile for §§4.1–4.3, 5.1, 8.1–8.2 and 9.1. It uses no wire capability, model credentials or audio hardware. Missing driver instrumentation is incomplete/nonzero; malformed or missing observations fail rather than silently counting as no effects. The existing default/other profiles and their instrumentation remain unchanged.

| Stable case ID | Assertions |
|---|---|
| `server/input/control-pre` | Shared invalid envelope vectors plus invalid text/ping fields; priority, recoverable/sessionless errors, no model session/effects, then successful hello. |
| `server/input/control-post` | Same classifications after ready; sequenced errors, no model side effects or receive-cursor advance; valid seq 1 text still executes once. |
| `server/input/types` | Exact `toString`/`__proto__` matching, missing/non-string/unknown types and wrong sender direction: UNKNOWN_TYPE precedes field validation. |
| `server/input/binary-pre` | All short lengths 0–4, undefined kinds 0/3/255 and server-received kind 2: recoverable seq-0 MALFORMED, no model audio/session, same connection later works. |
| `server/input/binary-post` | Same malformed frames after ready, errors sequenced and no model audio. |
| `server/input/audio-before-ready` | Valid pre-hello audio ignored, not queued into the eventual session; a distinct ready-after marker arrives once. |
| `server/input/audio-ready` | Nonempty PCM bytes/negotiated format preserved, empty payload ignored or forwarded empty once; audio does not advance the control ACK/sequence cursor; valid control seq 1 still works. |

The runner loads the unmodified client envelope and binary vectors from installed assets and constructs additional raw frames itself. The output-max-seq vector is structurally valid but explicitly invalid for a server receiver. Big-endian header values (including uint32 max) are independently checked against the golden bytes without SDK audio codecs. The server model API does not expose audio seq: this proves the harness layout and payload delivery, **not** black-box correctness of the receiver's informational seq decoding or a full 2^32-frame wrap. No packet-order/duplicate rejection rule is invented. Whole PCM samples remain a SHOULD; no new content validation is required.

Before inspecting absence of effects, each test obtains ordered ping/pong receipt fences, then a public model snapshot. Pre-hello checks require zero model sessions and inputs. After a valid seq-1 text counterexample, `finishInputs` drains the controlled fixture's attached continuations and emits one public model transcript marker while keeping the connection open. The resulting real sequenced wire event exposes hidden sequence gaps, including a counter incorrectly advanced by audio. Another pong and a normal WebSocket close provide final wire fences; the oracle checks the complete trace, error inventory and independently observed model inputs. Same-seq identical replay remains one logical message; conflicting replay still fails. The text counterexample contains an extra property allowed by schema.

Instrumentation is trusted: it observes the model's public command hook, uses an inert model with no scripts, tools or background producers, and reports bounded snapshots. This is a finite completion contract, not a guarantee against arbitrary delayed application work, dishonest drivers, process trees or physical effects. Trace/stdio and observation limits remain bounded. Early close, no response, process exit and missing data fail boundedly. Official close and EOF are idempotent; directly owned processes/sockets/timers are cleaned up.

Full suite remains incomplete. Output audio/playback, devices, resampling, opening-state audio races, full binary/error matrices, reconnect/replay and a Python network driver are outside this profile. Other conformance profiles must be selected separately.

An unsolicited control ACK with upTo 0 does not identify an audio frame and cannot by itself prove audio was acknowledged. The oracle permits it, rejects ACKs beyond the handled control cursor, and checks the final marker for hidden sequence consumption. A separate zero-ACK positive fixture prevents treating all ACK frames as violations.

## Client invalid-control profile

```sh
node conformance/dist/node/cli.js client --profile client-control-validation-v1 --exec node --json -- conformance/dist/node/drivers/typescript-client.js
```

This opt-in, client/driver-only profile checks **post-ready** text control inputs under §§4.1–4.3, 6, 7.1 and 9.1. Driver instrumentation is not a wire capability. The runner sends a normal baseline ready and awaits the driver's confirmation that public observations are installed before any invalid injection. Missing/malformed instrumentation is incomplete/nonzero; missing observations fail, never count as zero. Other profiles/default ready/finish keep their existing contracts.

| Stable case ID | Assertions |
|---|---|
| `client/control/framing` | Shared malformed JSON/nonobject vectors, plus null/array/bool/string; application reports MALFORMED and continues. |
| `client/control/version` | Wrong/missing/string versions, including combined type/field faults: UNSUPPORTED_VERSION takes precedence. |
| `client/control/types` | Wrong direction, exact `__proto__`/`toString`, missing/non-string/unknown types; UNKNOWN_TYPE precedes invalid fields. |
| `client/control/fields` | Missing seq, zero/negative/fraction/overflow/string/bool seq on sequenced text: INVALID_FIELD, no application effect/cursor advance. |
| `client/control/state-call` | Invalid high-epoch state and malformed calls with reused-invalid callId cannot run, reserve a call or poison epoch. |

The runner sends raw text and loads unmodified server-direction vectors from installed assets. It validates **target client output**, never demands that its deliberate invalid server injections pass the normal traffic schema. An independent observation oracle checks normalized application diagnostics/effects/events. No SDK codec, Inbox/Outbox or gate is used for judging behavior.

After every invalid input, the driver confirms the public error observation; no business event or tool entry/commit may have occurred. A valid turn.state seq 1 and tool.call seq 2 follow, including a schema-permitted extra property and identical same-seq call retransmission. The legal call executes/commits once. A server transcript seq 3 is the ordered application receipt fence; no server ping is invented. After that fence, one public interrupt() exposes the observed epoch on the real wire and must use 1, detecting hidden epoch pollution even if tool execution still worked. This is only an epoch probe after completed work, not another cancellation matrix.

Finish drains the inert, synchronous probe's attached continuations, closes the SDK and awaits its public closed event before returning final observations. Runner awaits WebSocket close, then checks the complete target trace: one successful logical tool result, correct identities, bounded ACK cursor, schema/capability/sequence validity and final application effects. Identical same-seq result replay passes; conflicting same-seq content and different-seq duplicate results fail. No claim is made that a client must detect valid callId reuse with a different seq: §7.1 explicitly does not require that. An invalid frame using a callId must not reserve it; the later call is its first **valid** use.

The driver uses only public connect/session/event/tool APIs, no private socket/sequence/epoch fields. Its JSONL protocol records at most 64 diagnostics and 128 business events, with existing bounded stdout/trace limits; overflow errors rather than truncating to a passing subset. Controls and real WebSocket data are separate. Bounded failures cover missing error notification, held legal result/finish, no ready, child exit and early close, with direct-child PID cleanup. Repeated close/EOF is safe. Instrumentation and finite drains are trusted, not process-tree isolation or proof against arbitrary delayed work/dishonest drivers.

Full suite remains incomplete. Binary/audio, pre-ready observation, automatic heartbeat/reconnect, full recovery, other exception matrices and Python network driver are not covered here. Arguments are checked as wire fields only: optional application schema validation is not promoted to a MUST.
