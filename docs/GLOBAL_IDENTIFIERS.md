# Turn and tool-call identifiers

The reference SDK generates a fresh random opaque identifier for every turn and distinct tool call. Opening another session, restarting a process or using another server instance does not restart a public counter. Identifiers use UUIDv4 randomness and remain well below the consumer-friendly 128-character limit; model identifiers may be longer or contain characters unsuitable for application keys.

The draft `global-tool-ids-v1` capability (protocol §6.3, revision 1.3) lets a client confirm this guarantee through `session.capabilities.has('global-tool-ids-v1')`. The SDK offers it independently of tool streams. Baseline peers still work and receive the same stronger opaque IDs, but an older server which does not negotiate the capability makes only the baseline session-scoped guarantee. No baseline rule, JSON message shape or failure enumeration was tightened.

All application-facing call surfaces use the public ID: argument fragments, tool streams, client invocations, server tool contexts, hooks, previews and results. Applications return that ID unchanged. Core keeps the provider's original ID on the invocation record and translates the settled result back before calling the model. Provider identifiers are never an alternative application result key.

The identity lookup is scoped to each model response and is discarded with that response, and all remaining lookup state is cleared on session close. An outstanding async invocation retains its original provider ID in its existing record even after the response is forgotten. Reusing the same raw provider ID in a later response allocates a fresh public ID; replaying a retained wire message preserves the existing ID and seq exactly. Open response/call state is not a new global cache or a promise to bound arbitrary unfinished provider work.

These IDs are correlation keys, not secrets or authorization. They do not provide persistent exactly-once execution after an application crash. Consumers remain responsible for permissions, transactional effects, durable deduplication where required, and lifecycle cleanup.

Validation includes SDK cross-session/reused-provider/long-ID/result-translation tests, negotiation and resume coverage, and a real WebSocket regression in `conformance/test/global-identifiers.test.mjs`. The latter checks a narrow guarantee with the official SDK as the driver; it does not claim a new standalone CLI profile, second-language interoperability or full conformance certification.
