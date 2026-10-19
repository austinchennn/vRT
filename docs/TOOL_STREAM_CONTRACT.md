# Tool-stream contract and evidence

Scope: #49 audits the existing TypeScript implementation of draft `tool-stream-v1`.
The normative sources remain [protocol §7.5](../spec/protocol.md#75-tool-streams-tool-stream-v1),
[schemas](../spec/schema/server/tool.stream.json) and the [registry](../spec/capabilities.json).
This index distinguishes evidence levels; it is not a complete compatibility certificate.

## Ownership

- `core/src/tool-stream.ts` owns server-side per-call lifecycle transitions;
  `core/src/session.ts` owns responses, epochs, invocation and settlement.
- `server/src/tool-stream.ts` maps these events to negotiated wire streams or legacy previews.
- `client/src/tool-streams.ts` tracks local display cancellation and recently ended calls;
  `client/src/session.ts` owns sequence dispatch and the existing tool executor/gate.
- Display subscribers never execute tools. Applications own validation at their actual
  side-effect boundary, authorization, persistence, idempotency and transactions.
  `AbortSignal` is cooperative cancellation, not forced termination or rollback.

Paths in the table below are relative to the repository root. A test title or stable
case ID identifies the assertion to review, rather than a run-dependent test count.

## Coverage

| Contract / classification | Implementation | Specific evidence | Level / remaining boundary |
|---|---|---|---|
| §3.3/§3.4: only negotiated gated traffic (MUST) | `packages/server/src/capabilities.ts`, `packages/server/src/index.ts` | `packages/server/test/server.test.ts`: “negotiates capabilities once per session and omits them while none apply”; `server/tool-stream/baseline` | Fake-socket integration + independent real-WebSocket black box; registry remains draft |
| §7.4/§7.5: negotiated stream replaces legacy wire preview (MUST) | `packages/server/src/tool-stream.ts` | server test “reports each call as tool.stream, from start to its terminal phase, and never as tool.call.delta”; “keeps the 1.0 preview for a client that does not offer it” | Fake-socket integration + `server/tool-stream/lifecycle`; application `tool.preview` derived by the client is not a second wire message |
| §7.5: no-delta complete call still has a lifecycle | `packages/core/src/session.ts`, `packages/core/src/tool-stream.ts` | `packages/core/test/tool-stream.test.ts`: “gives a model without argument streaming start, complete and a terminal phase”; `server/tool-stream/no-delta` | Session integration + black box; argument streaming is a provider property, not a prerequisite to negotiate the lifecycle |
| §7.5: start, delta before complete, at most one complete, progress before terminal, one terminal (server MUST) | `packages/core/src/tool-stream.ts` | core “orders a streamed call: start, fragments, complete, progress, one terminal”; `server/tool-stream/lifecycle` | Module unit + independent black box; interleaved fixture calls keep callId/name/turnId/epoch identity |
| §7.5: an incomplete response ends failed, issued work is not automatically successful | `packages/core/src/session.ts` response-end handler; `packages/core/src/tool-stream.ts` | core “fails calls a response started but never issued when it ends”; “fails a call whose response ends before its arguments are complete”; `server/tool-stream/failed` | Unit + session integration + black box; response.end does not replace a tool outcome |
| §7.5: no server-tool result output in stream | `packages/server/src/tool-stream.ts` settled mapping | server “reports a server tool's progress and outcome, but never its output”; lifecycle oracle and `output-leak` fault | Fake-socket integration + black box; application-supplied progress remains application data, not an automatic secret sanitizer |
| §6.2/§7.5: collecting interruption and old-epoch events | core session live-epoch check and ToolStreams.interrupted | core “cancels a call interrupted while its arguments stream, and ignores the call when it arrives late”; `server/tool-stream/cancelled` | Session integration + black box; server-owned async tool policy is not a wire cancellation MUST |
| Public server API: issued cancellation and async exception | core session interrupt/settle | core “cancels an issued call when its turn is interrupted, and ignores its late result”; “keeps an async server tool open across an interruption until it settles” | Session integration; running async:true server tools can finish after the interrupt |
| §7.5: no message after terminal (server MUST), including tombstone eviction | core session tool.call.delta handler + retained invocation record | core “drops late fragments of issued calls after stream tombstones are evicted” | Public session/fake-model integration: 257 completed calls in one still-live response, late c0 delta suppressed, distinct collecting call accepted; not an unlimited global-ID/reuse guarantee |
| §7.5 client SHOULD + SDK local cancellation guarantee | `packages/client/src/tool-streams.ts`, session closeEpoch | `packages/client/test/tool-streams.test.ts`: “cancels open calls the moment the app interrupts, before reporting the interruption, and ignores the server echo” | Fake-socket public API integration; independent client observation profile is #50, not already delivered here |
| Public API: derived preview cannot outlive reentrant interrupt/close | client session onToolStream | client parameterized “does not emit a derived %s preview after a stream listener calls interrupt()/close()” | Four public API regression cases for delta/progress; synchronous dispatch itself is not retroactively cancelled for other listeners |
| §7.4/§7.5: display is not tool execution | client stream dispatch separate from onToolCall/tool host | `examples/minimal/test/e2e.test.ts`: “streams a tool call to the app with tool-stream-v1 and cancels it the moment the app interrupts”; black-box partial effect checks | Real-WebSocket SDK e2e + server black box; broader client effect observations belong to #50 |
| §4.3: identical seq replay handled once | client sequence acceptance before dispatch | client session “dedupes server messages and acks in batches”; `conformance/test/server-tool-stream.test.mjs`: “same-seq terminal retransmission passes, without double counting” | Session unit/integration + independent oracle control; conflicting same seq is a conformance violation, not automatically detected by every SDK receiver |
| §7.5: session ends before terminal is permitted | core streams.clear; client tracker.clear/final close | core “emits nothing more once the session closes”; client “does not report open calls as cancelled when the session closes”; conformance “early connection close is incomplete rather than a false missing-terminal violation” | Session integration + black box; connection loss may park a session, so close alone cannot prove the session ended |

The five server cases live in [server-tool-stream.json](../conformance/scenarios/server-tool-stream.json).
Their independent checks are in [tool-stream-oracle.ts](../conformance/src/tool-stream-oracle.ts)
and [oracle.ts](../conformance/src/oracle.ts); the public-API driver is
[server-tool-stream.ts](../conformance/src/node/drivers/server-tool-stream.ts).
Fault tests in [server-tool-stream.test.mjs](../conformance/test/server-tool-stream.test.mjs)
exercise wrong ordering/identity, duplicate terminal, missing terminal at a live
completion fence, output leakage, capability gates and conflicts over real sockets.
Finite driver counters/drain are trusted instrumentation, not a dishonest-driver or
process-tree sandbox proof. Optional-capability refusal is incomplete for this profile,
not global protocol nonconformance. Full-suite coverage remains incomplete.

## State ownership and limits

Core and client stream trackers each retain the latest 256 terminal call IDs. That
number is an implementation policy, not a wire constant or a bound on all session
memory. Terminal transitions remove open stream records; clear on final shutdown
releases both collections. Client local epoch cancellation also removes open records.
The open-call Maps have no independent size cap; a long/incomplete response can retain
many collecting calls until response end, cancellation or shutdown. Tools still running
(including async:true tools) can keep their invocation state until settlement/close.
This audit does not claim a total byte limit or add a new rejection/eviction policy.

While a response is live, core retains its issued CallRecords separately from recent
stream tombstones. The delta handler now consults those records, so eviction of a
terminal stream ID cannot reopen an already-issued call in that response. Once the
response is forgotten, its deltas fail the existing live-response check. Collecting
calls still enter the lifecycle normally. No additional cache or public setter is added.

Client seq deduplication suppresses repeated numbered frames across resume. It is
independent of the 256 terminal-ID window and the epoch gate. A nonconforming sender
that sends a different-seq old call after its tombstone is evicted is not covered by
that bounded ID window; §7.1 does not require clients to detect callId reuse. This is
not durable side-effect deduplication. Neither ACK nor the tombstone limit establishes
a universal safe point for discarding application idempotency records.

## Review decisions and follow-ups

- [#57](https://github.com/austinchennn/vRT/issues/57): §3.3's final “no capabilities”
  paragraph contradicts §7.5 and the registry. This audit follows the explicit gates
  and reports the conflict; it does not silently amend normative text or shared vectors.
- [#56](https://github.com/austinchennn/vRT/issues/56) cross-session identifiers are a
  separate contract: the draft `global-tool-ids-v1` capability and provider-ID mapping
  ([GLOBAL_IDENTIFIERS.md](GLOBAL_IDENTIFIERS.md)). Tool streams carry the public `callId`;
  this audit does not depend on that capability being negotiated.
- [#50](https://github.com/austinchennn/vRT/issues/50) owns additional independent client
  observation/cancellation/replay testing. The existing SDK e2e is not a replacement.
- `tool-stream-v1` stays **draft**. [The promotion process](../spec/README.md#adding-a-capability)
  requires two implementations to interoperate; source-level Python codecs and more
  tests of the TypeScript pair do not establish that milestone.
- Open-call resource limits, late-event trust boundaries and any stronger cross-session
  guarantees need explicit policy/compatibility review; increasing or removing the
  tombstone bound is not a general solution. This review adds no such new guarantee.

No application schema, document revision, editor transaction, undo or persistence
interface belongs to this contract. Consumers own those policies in their application.
