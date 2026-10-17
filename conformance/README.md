# vRT black-box conformance profiles

These are **partial** `handshake-interrupt-v1` (default), `tool-cancellation-v1`, `server-auth-v1`, `server-tool-stream-v1`, `server-heartbeat-v1` and `server-resume-replay-v1` profiles for [#17](https://github.com/austinchennn/vRT/issues/17), not certification of a complete vRT implementation. It tests real WebSocket traffic and controls public SDK APIs through independent JSONL driver processes. No model account, device, browser or API key is needed.

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


## Server normal-resume profile

```sh
node conformance/dist/node/cli.js server --profile server-resume-replay-v1 --exec node --json -- conformance/dist/node/drivers/typescript-server.js
```

An explicit server/driver profile for §§4.1–4.3 and 5.1–5.4, using a controllable raw client. It does **not** implement or certify the official client's automatic reconnect or full bidirectional recovery. No optional wire capability, model key, clock manipulation or device is needed. Missing/malformed instrumentation is incomplete/nonzero; missing observations fail. Other profile/default commands retain their meaning.

| Stable case ID | Assertions |
|---|---|
| `server/resume/suffix` | Application processes prefix, disconnects without ACK, two model transcripts are produced offline, same session resumes with the full ordered suffix and client receive cursor. |
| `server/resume/from-zero` | Transport captures prefix but application processing cursor stays 0; all retained prefix/offline messages replay with original content/seq. |
| `server/resume/caught-up` | Already-current cursor yields empty suffix; a new model marker follows at the next seq, checking the whole trace instead of waiting for silence. |
| `server/resume/replace` | New connection resumes an active session, old connection closes 4000; subsequent model marker arrives on new peer only. |

Every case sends context seq 1 before reconnect. Public onContext confirms processing; resumed ready must report resumedFrom 1. Sending context seq 1 again, followed by seq 2 with different data, yields exactly the two original context values, with one model connection across both sockets. Context revision/tag fields are application test data, not new protocol fields or instructions. Server outputs are intentionally never ACKed to exercise retention; the test client deliberately withholds the receiver's recommended ACK behavior.

The official driver uses **public Hub.attach** behind an ordinary WebSocket edge, public Connection.receive/closed, onContext and fakeModel events/sessions. This is the server SDK under test, not handcrafted expected frames. The edge's close confirmation happens after Connection.closed() returns, without inspecting private parked/session/inbox/outbox state. Shutdown terminates physical peers, delivers those close callbacks, then closes the Hub so parked expiry/heartbeat timers are cleared. It uses normal public SDK time defaults and tests no timeout policy.

The runner owns the second peer and disposes it in finally on every path; its normal cleanup separately owns the first peer/driver. Failure reports include both captured connection traces/close information when available. Wire trace/schema/capability/sequence checks operate on the combined session history, so a resumed suffix need not start at seq 1. Semantic checks independently require the entire requested suffix, original retained-message contents and expected offline markers with continuous numbering. Identical same-seq replay is one logical message; changed same-seq content fails. Each connection receives its own new ready; old transient ready is not replayed. Negotiated formats/capabilities stay unchanged (explicit/default PCM sample rate is normalized).

A prefix model marker and ordered pong establish the captured prefix; only the selected application cursor is sent as resumeFrom. The original physical close and SDK close confirmation precede offline model injection. After resume, context confirmation plus a new public model marker and live pong fence precede second-peer close, SDK close confirmation and finish. The final marker exposes missing last/intermediate cached messages; neither ready nor the first replay nor a quiet interval is considered completion. Pongs alone do not prove arbitrary asynchronous work drained. This deterministic instrumentation has only synchronous model injections/context observations and no scripts/tools/background producers.

Real-wire faults cover missing middle/last messages, changed content/seq, wrong resumedFrom, replacement session/model, duplicate context effects, missing/wrong old close, replayed transient ready, conflicting replay and missing observations. Correct independent servers and identical same-seq replay pass. Held close/context/finish/replay, startup/no response, exits and early second-peer closure are bounded with direct-child PID cleanup. Instrumentation and finite drain are trusted; this is not a process-tree sandbox or proof about arbitrary delayed work. Close code 4000 is checked on this direct loopback path alongside identity/model/effect/traffic evidence, not used as the sole evidence of recovery (§9.3).

Full suite remains incomplete. ACK-deleted or evicted history, resume expiry, principal isolation, lost tool results, full epoch/tool/capability matrices, automatic client/bidirectional recovery, heartbeat, binary/audio and Python driver are not covered. This profile does not test ACK-deleted-history or heartbeat-specific recovery paths.
