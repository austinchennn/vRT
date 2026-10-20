# vRT protocol specification

This directory is the single source of truth for the vRT wire protocol. Every implementation, in any language, is built from it, including the TypeScript packages in this repository, which are its reference implementation rather than its definition.

| Path | What it is |
|---|---|
| [`protocol.md`](protocol.md) | The normative specification: transport, reliability, sessions, epochs, tools, audio, errors. |
| [`schema/`](schema/) | JSON Schemas (draft 2020-12) for every control message. |
| [`examples/`](examples/) | Test vectors: valid and invalid control messages, and binary audio frames, with expected outcomes. |
| [`capabilities.json`](capabilities.json) | The capability registry: every standard optional feature and the messages it gates. |

Protocol version 1, revision 1.4. See [Appendix B](protocol.md#appendix-b-revision-history) for the history.

## Versioning in one paragraph

Every control message carries `v: 1`, the major version. Minor revisions only add things: optional members, capabilities, and new message types or enumeration values that are sent only after a capability is negotiated. Receivers ignore members and capabilities they do not know, so an older peer keeps working with a newer one. Capabilities are offered in `hello.capabilities` and confirmed in `ready.capabilities`. Breaking changes need a new major version. Details: [protocol.md §3](protocol.md#3-versioning-and-capabilities).

## Schemas

- [`schema/client-message.json`](schema/client-message.json) and [`schema/server-message.json`](schema/server-message.json) validate any message sent by a client or a server. Each dispatches on `type` to one schema per message under [`schema/client/`](schema/client/) or [`schema/server/`](schema/server/).
- [`schema/common.json`](schema/common.json) holds the shared definitions: envelopes and their `seq` rules, identifiers, audio formats, tool specs, enumerations.
- Schemas allow members they do not list, because receivers must ignore unknown members (protocol.md §2.2).
- A schema checks one message. Rules that span messages (sequence numbers in order, one result per call, the epoch gate) are in protocol.md and are checked by the conformance suite, not by the schemas.

To use them from another language, load every file under `schema/` into a draft 2020-12 validator; files reference each other by relative `$ref`, resolved against their `$id`. You can also generate types from them; keep the rule that unknown members are allowed.

## Test vectors

Vector files follow [`examples/vectors.schema.json`](examples/vectors.schema.json). There are two kinds of suite.

A **control** suite lists JSON control frames sent in one `direction`:

```json
{
  "suite": "control",
  "direction": "client",
  "description": "The client text message.",
  "cases": [
    { "id": "client/text/basic", "description": "User text input.", "valid": true, "message": { "v": 1, "seq": 1, "type": "text", "text": "hi" } },
    { "id": "client/text/seq-zero", "description": "...", "valid": false, "error": "INVALID_FIELD", "message": { "v": 1, "seq": 0, "type": "text", "text": "hi" } }
  ]
}
```

- `message` is the JSON value sent as one text frame. `raw` replaces it when the frame is not JSON at all.
- A valid case must be accepted unchanged, unknown members included.
- An invalid case must be rejected with `error`, the code a receiver reports under the classification order of [protocol.md §9.1](protocol.md#91-invalid-messages).

An **audio** suite lists binary frames as lowercase hex in `bytes`; a valid case gives the decoded `frame` (`kind`, `seq`, `payload` hex), and an invalid case must be rejected.

Case `id`s are stable and unique across all files; the conformance suite reports results by id. Vectors check single frames. Behaviour across messages (handshake, resume, interruption) is the conformance suite's job.

An implementation is consistent with this spec when, for every case in `examples/`, it accepts exactly the valid cases and reports the expected `error` for each invalid one. For the TypeScript implementation that check is [`packages/protocol/test/spec.test.ts`](../packages/protocol/test/spec.test.ts). It also mutates every valid case one member at a time and requires the TypeScript guards to agree with the schemas on each mutant.

## Changing the protocol

A protocol change is a change to this directory first:

1. Edit `protocol.md`. Add a revision entry to Appendix B, and decide whether the change is additive (a minor revision, possibly behind a new capability) or breaking (a new major version).
2. Update the schemas and add vectors: at least one valid and one invalid case for every message type, including the members you changed.
3. Update the implementations to match.

### Adding a capability

Optional features are added as capabilities, so that peers without them keep working:

1. Pick a token, by convention `<name>-v1`, and add an entry to `capabilities.json` with `status` `draft`, the next revision in `since`, and the message types it gates.
2. Specify it in a new subsection of `protocol.md` and point the entry's `specification` at that subsection.
3. Add schemas for its new message types to `schema/client/` or `schema/server/` and to the direction's message schema, with valid and invalid vectors. New optional members of existing messages need no registry entry, because receivers ignore unknown members.
4. Implementations offer the token only once they implement it in full. Their tests check that they only claim registered tokens.
5. Mark it `stable` once two implementations interoperate on it (for example the reference server and a second client SDK, checked by the conformance suite). After that the token is frozen.

### Checks

`npm run check:spec` checks that the spec is self-consistent: every schema compiles in strict mode, the two message schemas dispatch to every per-message schema, the capability registry is well-formed and every message type it gates exists, every link between spec documents resolves, every vector file is well-formed, every vector agrees with the schemas, every invalid vector's `error` follows the classification order, and every message type has both valid and invalid vectors. `npm test` checks the TypeScript implementation against the vectors and the schemas. CI runs both.

Nothing in this directory may depend on a particular implementation's types or APIs.
