# vRT black-box conformance: first-phase profile

This is the **partial** `handshake-interrupt-v1` profile for [#17](https://github.com/austinchennn/vRT/issues/17), not certification of a complete vRT implementation. It tests real WebSocket traffic and controls public SDK APIs through independent JSONL driver processes. No model account, device, browser or API key is needed.

## Run from a checkout

Requires Node 22+ and a clean `npm ci` at the repository root:

```sh
npm run test:conformance
node conformance/dist/node/cli.js client --exec node --json -- conformance/dist/node/drivers/typescript-client.js
node conformance/dist/node/cli.js server --exec node --json -- conformance/dist/node/drivers/typescript-server.js
```

`--exec` is a single executable; everything after `--` is passed as its argument array without a shell. The runner starts a new process/session for each case. Client mode starts a test server on an OS-assigned loopback port and passes `VRT_CONFORMANCE_URL` to the driver. Server mode gets its URL from the driver's `ready` response. For a server already running, use:

```sh
node conformance/dist/node/cli.js server --url ws://localhost:8790 --json
```

Use a test server that accepts the baseline anonymous `hello`; authentication profiles are not part of this phase. External production endpoints may need other profiles and must not be reported as globally nonconformant solely for lacking this fixture configuration.

`--timeout-ms` is a per-case monotonic deadline, default 5000 ms, configurable from 1 to 60000 ms. Cleanup has separate short bounded deadlines so expired cases can still terminate their resources. The timeout is a harness policy, not a normative vRT timing requirement. Omit `--json` for a human-readable report. Exit 0 means **all selected profile cases passed**; 1 means a case failed/missing; 2 means invalid invocation or setup/assets failure. Every report still says `fullSuite: incomplete`.

## Coverage and evidence

| Stable case ID | Assertion |
|---|---|
| `client/handshake/baseline` | Schema-valid hello, ready without confirmed capabilities, public SDK capabilities empty, no gated wire messages through close. |
| `client/interrupt/stale-call` | After observing epoch 1 and completing local interrupt, an old-epoch probe never starts/commits and has exactly one logical INTERRUPTED result with matching call/epoch. |
| `server/handshake/baseline` | Minimal hello without capabilities receives schema-valid ready with no capabilities enabled. |
| `server/handshake/version` | Wrong-major hello gets recoverable sessionless UNSUPPORTED_VERSION without opening a session; valid hello on the same connection then succeeds (§9.1). |

The baseline hello and wrong major value are loaded from shared vector IDs (`client/hello/minimal`, `client/envelope/version-2`). Packaged schemas validate incoming frames; the independent oracle handles contiguous new sequence numbers, same-sequence replay and logical result uniqueness. The capability registry identifies gated message types. No SDK codec, Inbox/Outbox or epoch gate is used as an oracle.

This profile does not inject a server `interrupted` message into the client test: the local gate must suffice. `observe` confirms the SDK exposed the epoch through its public state event; `interrupt` confirms the public synchronous method returned. Only afterwards is the stale call sent. Probe `started` and `committed` counters are separate; the probe does not inspect cancellation to hide a failed gate.

**End fence:** `finish` waits for the call's public result event, drains application-owned work, initiates normal close and waits for the SDK's public closed event. The runner waits for the WebSocket close event and examines the entire received trace before judging. Correctly implemented drivers must not leave scenario work queued beyond this fence. This is a finite test contract, not proof against an arbitrary malicious driver or arbitrary future delayed work. Same-sequence retransmission is not a second logical result; two result messages with different sequences are.

Tests include a stale-executing client (returns INTERRUPTED but increments effects), a double-result client, a duplicate deferred to a later event-loop callback, and a same-sequence replay that must pass. Failure handling covers no response, process exit, malformed/oversized stdout, a refused handshake, stalled hello and forced termination. Cleanup tests verify that the spawned PIDs no longer exist. Driver shutdown is idempotent after a successful finish.

Not implemented: complete message-vector conformance, reconnect/replay scenarios, ACK bounds, heartbeat, audio, queued/running cancellation, server interruption routing, capability-enabled scenarios and Python/network drivers. A bare server URL cannot establish tool-internal effects; only the listed handshake cases run in server mode.

## Build, install and packaging

```sh
npm run build:conformance
npm run typecheck:conformance
npm run pack:conformance
npm run test:conformance:consumer
```

The consumer check packs and installs the actual tarball into an unrelated temporary directory, then invokes its installed `vrt-conformance` executable for both reference modes. It requires registry access or a populated npm cache for existing runtime dependencies. The package is marked private to prevent accidental registry publication; `npm pack` and local installation still work. Package-name availability and public release are not claimed.

Build copies current schema, shared vectors, capability registry and scenarios into `dist/assets` and includes LICENSE. Installed CLI asset paths are relative to the executable, never the checkout/current directory. Official reference drivers are bundled from the locally built SDK; they therefore test that build, not whichever SDK an external user happens to have installed. To test a different implementation, supply its own executable following [driver-protocol.md](driver-protocol.md).

The root workspace includes this package, but production `scripts/packages.mjs` still scans only `packages/`. Production SDK pack/publish/version/size workflows do not pick up this test CLI. Build/test/pack commands and CI are explicit. No dependency is added to core, protocol or client. Tests use Node's built-in runner. Runtime dependencies reuse existing versions of **ws** (MIT, maintained WebSocket transport) and **Ajv** (MIT, draft-2020-12 schema validation); Ajv's transitive dependencies belong to the test CLI, not SDK hot paths. There is no new framework or real-time performance claim.

## Known limits and review points

- The spec's §3.3 still says there are no capabilities, while §7.5 and the actual registry define tool-stream-v1. This harness follows the registry and exercises no negotiated optional capabilities; no normative file is changed.
- Drivers are trusted test instrumentation. The runner bounds its own incoming WebSocket payload (64 KiB), frame trace (256), JSONL buffer (64 KiB), stderr tail (8 KiB), waits and direct-child termination. It is not an OS sandbox; an external driver must own/clean up any descendants it spawns. Shipped drivers spawn no descendants.
- Public SDK events plus driver effects provide evidence under the documented fence, not introspection into private SDK state. An implementation that cannot expose equivalent driver operations needs an explicit incomplete profile, not invented success.
- The small phase-1 scenario inventory selects fixed implementations rather than exposing a general-purpose workflow language. Adding scenarios requires explicit runner support and independent oracle review.
