# vRT protocol, version 1

Revision 1.2, 2026-10-16. Status: draft until the conformance suite (`conformance/`) ships.

This document defines the vRealTime (vRT) wire protocol between a **client** (an app or device that hosts tools and, optionally, audio input and output) and a **server** (which runs the agent and talks to the model). It is normative together with the JSON Schemas in [`schema/`](schema/). Where this document and a schema disagree about the structure of a message, the schema wins; this document defines everything a schema cannot: ordering, state and behaviour.

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, RECOMMENDED, MAY and OPTIONAL are to be interpreted as described in BCP 14 (RFC 2119, RFC 8174) when, and only when, they appear in all capitals.

## Contents

1. [Overview](#1-overview)
2. [Transport and framing](#2-transport-and-framing)
3. [Versioning and capabilities](#3-versioning-and-capabilities)
4. [Reliability](#4-reliability)
5. [Sessions](#5-sessions)
6. [Turns, epochs and interruption](#6-turns-epochs-and-interruption)
7. [Tools](#7-tools)
8. [Audio](#8-audio)
9. [Errors](#9-errors)
10. [Security considerations](#10-security-considerations)
11. [Implementation limits](#11-implementation-limits)
- [Appendix A. Message summary](#appendix-a-message-summary)
- [Appendix B. Revision history](#appendix-b-revision-history)

## 1. Overview

A client opens one WebSocket to a server and sends `hello`; the server answers `ready`, and a **session** exists. Inside a session the server streams agent state, transcripts, text and audio, and asks the client to run **tools**; the client streams user audio or text, runs the tools it declared and reports what the user actually heard.

Three properties shape the protocol:

- **Interruptible.** Every turn has an **epoch**. Once an epoch is closed, nothing from it takes effect: its tool calls never start and its audio is never played (§6).
- **Resumable.** Control messages are numbered per direction. After a dropped connection the client resumes the session and both sides resend what the other missed, exactly once (§4, §5.4).
- **Thin clients.** Clients do no orchestration and no model adaptation. A device without a microphone or speaker implements sessions, reliability, tools and the epoch gate, and nothing else.

## 2. Transport and framing

### 2.1 WebSocket

The transport is a WebSocket (RFC 6455). Deployments other than local development MUST use TLS (`wss:`).

- A **text frame** carries exactly one **control message**: a UTF-8 JSON (RFC 8259) object.
- A **binary frame** carries exactly one **audio frame** (§8.1).

The protocol defines no WebSocket subprotocol name and no meaning for the connection URL beyond what the server operator chooses. Credentials MUST NOT be placed in the URL (§5.3).

### 2.2 Control messages

Every control message has these members:

| Member | Type | Meaning |
|---|---|---|
| `v` | the number `1` | Major protocol version (§3.1). |
| `seq` | unsigned 32-bit integer | Position in the sender's resumable stream, or `0` (§4.1). |
| `type` | string | Selects the message; the set differs per direction (Appendix A). |

The remaining members depend on `type` and are defined by the schemas in [`schema/client/`](schema/client/) and [`schema/server/`](schema/server/).

- Senders MUST NOT emit two members with the same name in one object.
- Integers MUST be written without a fraction or exponent.
- A member that a schema marks as required MUST be present even when its value is `null`. A sender whose value is "nothing" sends `null`.
- Receivers MUST ignore members they do not recognise, at any depth, and MUST preserve them when passing a message through. This is what lets a minor revision add members (§3.2).

### 2.3 Directions

The client and server each have their own message set. A message type defined for one direction is an unknown type when the other direction sends it (for example a `pong` from a client). Both directions define `text` and `ack`, with different members.

## 3. Versioning and capabilities

### 3.1 Major version

`v` is the major version and is always `1` in this document. A receiver MUST reject a control message whose `v` is absent or is not exactly the number `1` with `UNSUPPORTED_VERSION` (§9.1). A server that rejects a `hello` this way MUST NOT open a session for it. The `error` itself carries the server's own `v`, which tells the client which major version the server speaks.

Breaking changes (removing or renaming members or messages, changing the meaning or type of a member, tightening a rule that a conforming sender could previously violate) require a new major version.

### 3.2 Revisions

A minor revision (1.x) of this document MAY only:

1. add OPTIONAL members to existing messages;
2. add new message types, sent only to a peer that negotiated a capability for them (§3.3);
3. add capabilities;
4. add error codes (§9.2) and close codes (§9.3).

A minor revision MUST NOT add values to an existing enumeration (for example a new turn state or failure code) unless a capability gates them, because receivers validate enumerations. A revision MAY clarify behaviour that was previously unspecified. Revisions are not signalled on the wire; capabilities are.

### 3.3 Capabilities

A capability names an optional feature. Tokens are lowercase ASCII words separated by `.` or `-`, at most 64 characters (`common.json#/$defs/capability`). Tokens starting with `x-` are reserved for private experiments and are never standardised.

1. A client offers the capabilities it supports in `hello.capabilities`. Absent means none.
2. A server opening a new session computes the capabilities in effect: the offered tokens it supports, each once. It sends them in `ready.capabilities`; absent means none.
3. Capabilities are fixed for the session's lifetime. A resumed `ready` repeats the session's set; capabilities offered in a resuming `hello` are ignored.
4. A peer MUST NOT send any message, member value or behaviour that a capability gates unless that capability is in effect.
5. Receivers MUST ignore capability tokens they do not recognise.

The registry (§3.4) lists no capabilities in this revision: every behaviour in this document is baseline and always in effect.

### 3.4 Capability registry

[`capabilities.json`](capabilities.json) lists every standard capability, in the format of [`capabilities.schema.json`](capabilities.schema.json). Each entry gives:

- the `token`;
- its `status`: `draft` (may still change incompatibly), `stable` (frozen) or `deprecated` (still honoured, no longer offered by new implementations);
- the revision that added it (`since`);
- the section of this document that specifies it;
- the message types that exist only while it is in effect (`messages`).

A message type listed under a capability MUST NOT be sent unless that capability is in effect. Every other message type is baseline. Implementations MUST NOT offer an unregistered token other than a private `x-` token. A capability's token never changes meaning: an incompatible change to a `stable` capability is a new token (by convention `<name>-v<N+1>`), and peers may support both during a transition.

## 4. Reliability

### 4.1 Sequence numbers

Each control message type belongs to one of three classes (Appendix A lists every type):

| Class | Types | `seq` |
|---|---|---|
| **transient** | `hello`, `ready`, `audio.start`, `ack`, `ping`, `pong` | always `0` |
| **sequenced** | all other types except `error` | `1` to `4294967295` |
| **sessionless** | `error` | `0` when no session is bound to the connection; otherwise sequenced |

Transient messages concern only the current connection. They are never stored for resending, never acknowledged and never deduplicated.

Sequenced messages form the session's resumable stream, one per direction:

- The first sequenced message a side sends in a session has `seq` 1; each later one has the previous value plus one. The counter belongs to the session, not the connection, and continues across resumes.
- A sender MUST keep every sequenced message it has sent until the peer acknowledges it (§4.2). It MAY bound how many it keeps; a resume that would need a discarded message then fails (§5.4).
- `seq` MUST NOT wrap. A side that has sent sequenced message 4294967295 MUST NOT send another in that session and SHOULD close the session; the client then opens a new one.

A server sends an `error` with `seq` 0 when no session is bound to the connection: before `ready`, or when it refuses a `hello` (for example `UNAUTHORIZED` or `RESUME_FAILED`). Once a session is bound, its errors are sequenced like any other server message.

### 4.2 Acknowledgements

The receiving side of a stream tracks `lastSeq`, the highest `seq` it has handled, starting at 0.

- A receiver SHOULD send `ack { upTo: lastSeq }` within a bounded delay after handling sequenced messages. RECOMMENDED: no later than 250 ms after the first unacknowledged message, or after every 32 messages, whichever comes first. A receiver MAY acknowledge after every message.
- `upTo` MUST NOT exceed the highest `seq` received. On `ack`, the sender MAY discard every kept message with `seq <= upTo`. An `ack` with a value at or beyond the sender's last `seq` acknowledges everything sent.
- An `ack` acknowledges receipt into the receiver's state, not completion of any work the messages started (a tool call, for example).

### 4.3 Duplicates and order

For each received message:

1. If `seq` is `0`, handle it. Messages with `seq` 0 are never deduplicated.
2. Otherwise, if `seq <= lastSeq`, it is a duplicate: the receiver MUST NOT handle it again and SHOULD acknowledge again.
3. Otherwise handle it and set `lastSeq` to `seq`.

Senders MUST NOT skip sequence numbers; a WebSocket delivers frames in order, and a resume resends from `resumeFrom + 1` (§5.4), so a conforming stream has no gaps. A receiver MUST NOT crash on a gap; this version defines no recovery for one.

### 4.4 Heartbeat

- A client SHOULD send `ping` whenever it has sent nothing for its ping interval (RECOMMENDED 15 s). It MAY send `ping` before `ready`.
- A server MUST answer every `ping` with `pong`, in any state.
- A server MUST close a connection on which it has received no frame of any kind for its heartbeat timeout (RECOMMENDED 45 s), with close code 4408. The session stays resumable (§5.4).
- A client SHOULD treat a connection on which it has received nothing for 2.5 ping intervals as dead, close it and resume.

Intervals and timeouts are configuration and are not negotiated in this version. A client's ping interval SHOULD be at most a third of the server's heartbeat timeout.

## 5. Sessions

### 5.1 State

A **session** outlives connections: it holds both sequence streams, the epoch, pending tool calls and the negotiated formats and capabilities. A **connection** is one WebSocket, bound to at most one session.

A server-side session is **connected** (bound to a connection), **parked** (its connection ended; it waits for a resume for the resume window, RECOMMENDED 30 s) or **closed**. A parked session whose window expires is closed. A newer connection resuming a connected session replaces the older connection (§5.4).

Server behaviour per connection:

| Connection state | Input | Server action | Next state |
|---|---|---|---|
| awaiting hello | `hello` | authenticate (§5.3) | opening |
| awaiting hello | `ping` | `pong` | awaiting hello |
| awaiting hello | any other valid control message | `error NO_SESSION` (not recoverable, `seq` 0) | awaiting hello |
| awaiting hello | valid input audio frame | ignore | awaiting hello |
| opening | control message other than `hello` or `ping` | keep it, in order; handle it after `ready` | opening |
| opening | `hello` | `error DUPLICATE_HELLO` (recoverable) | opening |
| opening | authentication refused | `error UNAUTHORIZED` (`seq` 0), close 4401 | closed |
| opening | resume of an unknown, expired or foreign session | `error RESUME_FAILED` (`seq` 0), close 4404 | closed |
| opening | the session cannot start | `error START_FAILED`, close 1011 | closed |
| opening | session opened or resumed | `ready`, resend (§5.4), handle kept messages | open |
| open | `hello` | `error DUPLICATE_HELLO` (recoverable) | open |
| open | sequenced message | deduplicate (§4.3), handle, acknowledge | open |
| open | input audio frame | pass to the session | open |
| any | invalid control message or audio frame | `error` with its code (§9.1), recoverable | unchanged |
| any | heartbeat timeout (§4.4) | close 4408 | closed |
| open | connection closed | park the session | closed |

Client behaviour:

| Client state | Input | Client action | Next state |
|---|---|---|---|
| connecting | connection opened | send `hello` (with `sessionId` and `resumeFrom` when resuming) | waiting |
| waiting | `ready` | on a resume, resend (§5.4); start audio | open |
| waiting | `error` that is not recoverable | report it; stop, unless a retry can succeed (a fresh credential, §5.3) | closed |
| open | sequenced message | deduplicate (§4.3), handle, acknowledge | open |
| open | connection lost | reconnect with backoff, then resume | connecting |
| any | `error RESUME_FAILED` | stop resuming; never replay old messages into a new session | closed |

Until it has received `ready` on a connection, a client MUST NOT send sequenced messages or audio frames on it.

### 5.2 Opening a session

The first message on a connection MUST be `hello`. A `hello` without `sessionId` asks for a new session.

- `tools` lists the tools the client hosts (§7). Names MUST be unique within the list. A server MAY decline tools, for example when a name collides with a tool of its own; it then never calls them.
- `input` and `output` state the audio formats the client prefers to send and to play (§8.2). Absent means no preference.
- `capabilities` offers optional features (§3.3).
- `context` is the session's initial application data (§5.5).
- `auth` carries a credential (§5.3).

The server answers with `ready`:

- `sessionId` identifies the session for resumes. It MUST be unguessable (RECOMMENDED: at least 122 random bits, as in a version 4 UUID).
- `input` and `output` are the formats in effect: the client MUST send audio in `input`, and the server sends audio in `output`.
- `resumedFrom` is present if and only if this `ready` resumes an existing session.
- `capabilities` lists the capabilities in effect.

A server MAY send sequenced messages the session produced before `ready` immediately after it.

### 5.3 Authentication

- A client sends its credential (for example a short-lived token) in `hello.auth`, never in the connection URL, where proxies and logs would record it.
- A server that requires authentication MUST authenticate every `hello`, new or resuming. If it refuses, it sends `error UNAUTHORIZED` (`seq` 0, not recoverable) and closes the connection with 4401. A server that does not use authentication ignores `auth`.
- A session belongs to the principal that opened it. A resume by any other principal MUST fail exactly like a resume of an unknown session (`RESUME_FAILED`), so that the answer does not reveal whether the session exists.
- A client whose credential cannot change SHOULD NOT reconnect after `UNAUTHORIZED`. A client that can obtain a fresh credential MAY retry with it.

### 5.4 Resuming a session

The client keeps `sessionId` and its `lastSeq` of the server stream. After losing a connection it reconnects and sends `hello` with `sessionId` and `resumeFrom` set to that `lastSeq` (absent means 0).

The server:

1. authenticates as in §5.3;
2. if the session is unknown, closed or belongs to another principal, sends `error RESUME_FAILED` (`seq` 0, not recoverable) and closes the connection with 4404;
3. otherwise binds the session to the new connection, closing an older connection with 4000;
4. sends `ready` with `resumedFrom` set to its own `lastSeq` of the client stream;
5. resends, in order, every server sequenced message with `seq > resumeFrom`. If it no longer holds all of them, or if `resumeFrom` is greater than the last `seq` it sent, it sends `error RESUME_FAILED` (not recoverable) and closes the session.

On a `ready` with `resumedFrom`, the client resends, in order and before any new sequenced message, every client sequenced message with `seq > resumedFrom`. If it no longer holds all of them, or if `resumedFrom` is greater than the last `seq` it sent, the resume has failed: it closes the connection and reports `RESUME_FAILED` to the application.

- Duplicates that both sides resend are discarded by §4.3, so each sequenced message is handled exactly once.
- Transient messages and audio are never resent. Audio that was in flight is lost; any further output audio is announced by a new `audio.start` (§8.3).
- The epoch, pending tool calls, formats and capabilities carry over unchanged. Tools are those declared when the session opened.
- After `RESUME_FAILED` a client MUST NOT resend old sequenced messages, into this or any other session. It MAY open a new session if the application chooses.

### 5.5 Application context

`hello.context` and the `context` message carry application data, for example the document open in an editor. Each `context` message replaces the previous value; `null` clears it. The server delivers context to the application in the order of the client stream.

Context is data. Servers MUST NOT treat it as instructions to the model, and SHOULD pass it to models, if at all, in a way that keeps it distinguishable from instructions. A client SHOULD send `hello.context` only when opening a new session.

### 5.6 Ending a session

There is no message that ends a session. A session ends when the server closes it (after an unrecoverable error, at the end of the resume window, or on shutdown) or when its resume window expires after its last connection closed. A client that is done simply closes its connection (code 1000).

## 6. Turns, epochs and interruption

### 6.1 Turns and epochs

The server keeps a session **epoch**, an unsigned integer that starts at 0 and never decreases. It increases when a turn starts and when a turn is interrupted. Every server message that belongs to a turn carries the epoch it belongs to: `turn.state`, `audio.start`, `tool.call.delta`, `tool.call` and `interrupted`.

`turn.state` reports the turn's state: `listening` (the user is speaking), `thinking`, `speaking`, `acting` (tools are running) and finally `idle`. `turnId` identifies the turn; clients use it to group effects, for example to undo all edits of one turn.

A client tracks two values:

- **observed epoch**: the highest epoch seen in `turn.state`, `audio.start` or `tool.call`;
- **closed epoch**: the highest epoch it has closed, initially none. An epoch at or below the closed epoch is **closed**.

### 6.2 Interruption and the epoch gate

**Client-initiated.** When the user interrupts (speaks over the agent, presses a stop button or key), the client MUST, before it sends anything and without waiting for the server:

1. raise its closed epoch to its observed epoch;
2. stop playback and discard buffered output audio (§8.4);
3. signal cancellation to a running tool call whose epoch is now closed;
4. answer every queued tool call of a closed epoch with `INTERRUPTED`, without running it (§7.2);

and then send `interrupt` with that epoch and a `reason`: `speech` (local voice activity detection), `user` (an interface control) or `keyboard`.

**Server side.** On `interrupt`, or when the server itself detects that the user started speaking, the server interrupts the response in flight, if any: it stops the model, closes the response's epoch, settles the epoch's pending client tool calls as `INTERRUPTED`, truncates the conversation to what was played (§8.4) and sends `interrupted` with the closed epoch. How the server cancels its own tools is outside this protocol. When no response is in flight, an interruption has no effect and the server sends nothing.

**On `interrupted`**, a client raises its closed epoch to the message's epoch, with the same local effects as above. `interrupted` for an epoch the client already closed has no further effect.

**The epoch gate.** These rules are the protocol's central guarantee:

1. A client MUST NOT start a tool call whose epoch is closed. It MUST answer it with `tool.result` `{ ok: false, code: "INTERRUPTED" }`. This applies to calls already queued, calls that arrive later and calls resent after a resume.
2. A client MUST NOT play output audio of a closed epoch.
3. A client SHOULD discard `tool.call.delta` previews of a closed epoch.

### 6.3 Text input

A client `text` message is user input, like speech. If a response is in flight, the server first interrupts it as in §6.2 (reason `user`), then responds to the text.

## 7. Tools

### 7.1 Calls

A server sends `tool.call` to run a tool the client declared when the session opened.

- `callId` identifies the call. A server MUST NOT reuse a `callId` within a session. Clients are not required to detect reuse.
- `arguments` is the JSON value the model produced. A client SHOULD validate it against the tool's declared `parameters` and answer `INVALID` when it does not match.
- `epoch` and `turnId` identify the turn that issued the call.

A client MUST run calls one at a time, in the order received: a call starts only after the previous call has its result. A client SHOULD give the tool the call's `callId`, `turnId`, `epoch` and a cancellation signal.

### 7.2 Results

A client MUST answer every `tool.call` with exactly one `tool.result` carrying the same `callId` and `epoch`, including calls it did not run (closed epoch, unknown tool). A result is either `{ ok: true, output }`, where a tool that returned nothing has `output` `null`, or `{ ok: false, code, message }`.

- When a running call's epoch closes, the client signals cancellation to the tool and answers `INTERRUPTED`. It MAY answer immediately, before the tool finishes; a later outcome of that call is then discarded. Cancellation is cooperative: it cannot undo an effect that already happened, so each tool MUST be atomic (it takes full effect or none) and SHOULD check for cancellation before committing.
- A server MAY settle a call that gets no result within its timeout as `TIMEOUT`.
- A server MUST ignore a `tool.result` whose `callId` is unknown or already settled (interrupted, timed out or answered). Duplicates and late results therefore have no effect.

### 7.3 Failure codes

| Code | Meaning |
|---|---|
| `INTERRUPTED` | The call's epoch was closed before or while it ran. |
| `REJECTED` | The call was declined, for example by the user or by policy. |
| `INVALID` | The arguments are not valid for the tool. |
| `TIMEOUT` | No result arrived in time. |
| `FAILED` | Anything else: the tool failed, or the client does not host a tool of that name. |

### 7.4 Previews

`tool.call.delta` reports progress of a call for display only: the model generating its arguments (by convention `{ "argumentsDelta": "<text fragment>" }`) or progress a server-side tool emits. `preview` is any JSON value; this version does not standardise its shape further.

A receiver MUST NOT run, commit or decide anything because of a preview. A preview does not imply that the matching `tool.call` will ever be sent.

When `tool-stream-v1` is in effect (§7.5), the server reports this progress with `tool.stream` instead, and MUST NOT send `tool.call.delta`.

### 7.5 Tool streams (`tool-stream-v1`)

This section applies only when the capability `tool-stream-v1` is in effect (§3.3). It gives every tool call, server or client, an explicit lifecycle the client can display: the arguments as the model generates them, progress while the call runs, and how it ended.

The server sends `tool.stream` messages. Each names the call (`callId`, `name`), the turn that issued it (`turnId`, `epoch`), and a `phase`:

| Phase | Member | Meaning |
|---|---|---|
| `start` | none | The first message about the call |
| `arguments-delta` | `delta` (string) | The next fragment of the arguments' JSON text, as the model generates it |
| `arguments-complete` | `arguments` (JSON) | The model finished the arguments; the call is issued |
| `progress` | `progress` (JSON) | Progress a running server tool reported |
| `settled` | `ok`, and `code` when not ok | The call has its one result |
| `cancelled` | none | The call ended because its turn was interrupted, before or after its arguments completed |
| `failed` | `message` | The model stopped before completing the arguments, so the call was never issued |

`settled`, `cancelled` and `failed` are **terminal**. For every call, the server MUST send:

1. `start` first, before any other phase of that call;
2. any `arguments-delta` messages before `arguments-complete`, which it sends at most once;
3. `progress` only after `arguments-complete` and before the terminal phase;
4. exactly one terminal phase, after which nothing about the call is sent. The only exception is a session that ends first.

A model that does not stream arguments produces `start`, `arguments-complete` and a terminal phase only, so a client can show a waiting state until the call ends.

Rules for receivers:

- `tool.stream` is display information, like a preview (§7.4). `arguments-complete` does not run anything: a client tool still runs only on `tool.call`, under §7.1 and the epoch gate (§6.2).
- A client SHOULD discard `tool.stream` messages of closed epochs. When it closes an epoch locally (§6.2), it SHOULD treat every call of that epoch that has not reached a terminal phase as cancelled at once, and ignore the server's later terminal message for it.
- `settled` reports only whether the call succeeded and, if not, its failure code (§7.3). The output of a server tool is never included.

## 8. Audio

### 8.1 Audio frames

A binary frame is:

| Offset | Size | Field |
|---|---|---|
| 0 | 1 byte | `kind`: `1` input audio (client to server), `2` output audio (server to client) |
| 1 | 4 bytes | `seq`: unsigned 32-bit, big-endian |
| 5 | rest | payload, in the negotiated format (§8.2) |

- A frame shorter than 5 bytes or with any other `kind` is malformed. A frame of a kind the receiver does not accept (a server receiving `kind` 2) is malformed too. A server answers a malformed frame with `error MALFORMED` (recoverable) and drops it; a client drops it.
- A frame with an empty payload is valid and MAY be ignored.
- Audio `seq` counts frames per direction, starting at 0 and increasing by one per frame, wrapping modulo 2^32. It is independent of the control `seq`. It is informational (for detecting loss); audio is never acknowledged or resent.
- A server ignores input audio before `ready`.

The vectors in [`examples/binary/`](examples/binary/) define the layout byte for byte.

### 8.2 Formats

| `encoding` | Payload |
|---|---|
| `pcm16` | Signed 16-bit little-endian mono PCM at `sampleRate` Hz (24000 when absent). A payload SHOULD hold whole samples. |
| `pcmu` | G.711 µ-law, 8000 Hz, mono. |
| `opus` | One Opus packet per frame. |

A client states preferences in `hello.input` and `hello.output`; the server chooses and reports the formats in `ready` (§5.2). A server SHOULD accept a preference that the model can take unchanged, so that audio passes through without transcoding, and SHOULD otherwise choose `pcm16` at 24000 Hz. A client that sends or plays audio MUST support `pcm16` at 24000 Hz.

### 8.3 Output items

The server sends `audio.start` before the first output frame of each audio item. Output frames belong to the item of the most recent `audio.start`. A client discards output frames that arrive before any `audio.start`, and frames whose item's epoch is closed.

Because `audio.start` is transient, a resumed connection starts without a current item; further output audio follows a new `audio.start`.

### 8.4 Playback

A client SHOULD stop playback and discard buffered output audio as soon as the user starts speaking, either detected locally or reported by `turn.state` `listening`, and on any interruption.

When playback of an item stops before its end, the client SHOULD send `playback` with the item's `itemId` and `playedMs`, the milliseconds of that item actually played, for each item it played in part. The server uses it to truncate the conversation to what the user heard.

## 9. Errors

### 9.1 Invalid messages

A receiver classifies an invalid control message by the first rule it breaks, in this order:

1. `MALFORMED`: the text frame is not JSON, or its value is not an object.
2. `UNSUPPORTED_VERSION`: `v` is absent or is not the number `1`.
3. `UNKNOWN_TYPE`: `type` is absent, is not a string, or is not a type defined for the sender's direction.
4. `INVALID_FIELD`: anything else the message's schema forbids, including the `seq` rules of §4.1.

`type` is compared as an exact string; implementations MUST NOT resolve it through inherited object properties (`toString`, `__proto__`).

A receiver MUST NOT act on an invalid message and MUST NOT crash or stall because of one. A server answers it with an `error` carrying the code above and `recoverable: true`, and keeps the connection open. A client reports it to the application and continues.

The vectors in [`examples/`](examples/) define the classification of many invalid messages.

### 9.2 Error codes

`error.code` is upper-case ASCII words separated by `_`. The set is open: a receiver MUST handle a code it does not know by its `recoverable` flag. `recoverable: false` means the session or connection cannot continue; a client SHOULD NOT repeat the same request unchanged.

| Code | Recoverable | Sent when |
|---|---|---|
| `MALFORMED`, `UNSUPPORTED_VERSION`, `UNKNOWN_TYPE`, `INVALID_FIELD` | yes | An invalid message or audio frame was received (§9.1). |
| `NO_SESSION` | no | A message other than `hello` or `ping` arrived before `hello`. |
| `DUPLICATE_HELLO` | yes | A second `hello` arrived on a connection. |
| `UNAUTHORIZED` | no | Authentication failed (§5.3). Followed by close 4401. |
| `RESUME_FAILED` | no | The session cannot be resumed (§5.4). |
| `START_FAILED` | no | The server could not start the session. Followed by close 1011. |
| `AGENT_ERROR` | as flagged | The session hit an error, for example in the model connection. |

### 9.3 Close codes

| Code | Meaning |
|---|---|
| 1000 | Normal closure. |
| 1011 | The server could not start the session. |
| 4000 | Replaced by a newer connection to the same session; also used by clients that close a dead connection. |
| 4401 | Authentication failed. |
| 4404 | Unknown, expired or foreign session. |
| 4408 | Heartbeat timeout. |

Close codes are advisory: proxies may replace them. A peer MUST NOT rely on a close code alone; the `error` sent before the close is authoritative.

## 10. Security considerations

- **Transport.** Use `wss:` outside local development. Credentials go in `hello.auth`, never in URLs (§5.3).
- **Session ids** are capabilities to resume: generate them unguessably (§5.2). With authentication, a resume additionally requires the same principal, and failures do not reveal whether a session exists.
- **Data is not instructions.** Context (§5.5), tool arguments and tool outputs are untrusted data. Servers keep them separate from model instructions; clients validate tool arguments (§7.1).
- **Effects in the physical world.** The epoch gate (§6.2) prevents tool calls of an interrupted turn from starting, but cannot undo a call that already took effect. Tools with irreversible or dangerous effects (unlocking a door, paying) SHOULD require confirmation and SHOULD be idempotent by `callId`.
- **Resource exhaustion.** See §11.

## 11. Implementation limits

This version sets no maximum message size, tool count or queue length. Implementations SHOULD bound, and document, at least: the size of a control message and of an audio frame, the number of tools in `hello`, the number of kept unacknowledged messages (the reference implementation keeps 1024 per direction), the number of queued tool calls, the resume window and the JSON nesting depth they accept. A receiver that exceeds a limit SHOULD answer with a recoverable `error`, or close the session with a non-recoverable one, rather than fail silently.

## Appendix A. Message summary

| Direction | `type` | Class | Purpose | Schema |
|---|---|---|---|---|
| client | `hello` | transient | Open or resume a session | [hello](schema/client/hello.json) |
| client | `text` | sequenced | User text input | [text](schema/client/text.json) |
| client | `interrupt` | sequenced | The client closed an epoch | [interrupt](schema/client/interrupt.json) |
| client | `playback` | sequenced | How much of an audio item was heard | [playback](schema/client/playback.json) |
| client | `tool.result` | sequenced | The one result of a tool call | [tool.result](schema/client/tool.result.json) |
| client | `context` | sequenced | Replace the application context | [context](schema/client/context.json) |
| client | `ack` | transient | Acknowledge server messages | [ack](schema/client/ack.json) |
| client | `ping` | transient | Heartbeat | [ping](schema/client/ping.json) |
| server | `ready` | transient | The session is open | [ready](schema/server/ready.json) |
| server | `audio.start` | transient | Output audio item begins | [audio.start](schema/server/audio.start.json) |
| server | `turn.state` | sequenced | Turn state changed | [turn.state](schema/server/turn.state.json) |
| server | `transcript` | sequenced | User or agent transcript | [transcript](schema/server/transcript.json) |
| server | `text` | sequenced | Agent text response chunk | [text](schema/server/text.json) |
| server | `tool.call.delta` | sequenced | Display-only progress of a call | [tool.call.delta](schema/server/tool.call.delta.json) |
| server | `tool.call` | sequenced | Run a client tool | [tool.call](schema/server/tool.call.json) |
| server | `tool.stream` | sequenced, `tool-stream-v1` | Lifecycle of a tool call | [tool.stream](schema/server/tool.stream.json) |
| server | `interrupted` | sequenced | An epoch was closed | [interrupted](schema/server/interrupted.json) |
| server | `ack` | transient | Acknowledge client messages | [ack](schema/server/ack.json) |
| server | `pong` | transient | Heartbeat answer | [pong](schema/server/pong.json) |
| server | `error` | sessionless | Something went wrong | [error](schema/server/error.json) |

## Appendix B. Revision history

**1.2** (2026-10-16)

- Added the capability `tool-stream-v1` and the `tool.stream` message: an explicit lifecycle for every tool call (§7.5).

**1.1** (2026-10-16)

- First normative, language-neutral edition: this document, the JSON Schemas and the test vectors.
- Added `hello.auth` (§5.3) and `seq` 0 for errors sent before a session exists (§4.1).
- Added capability negotiation: `hello.capabilities`, `ready.capabilities` (§3.3), and the capability registry (§3.4).
- Made explicit what 1.0 senders already did: transient messages carry `seq` 0 and sequenced ones start at 1; required members are present even when `null`; identifiers are non-empty; `playedMs` is non-negative; `sampleRate` is positive; error codes are upper-case; a resume from a `seq` the peer never sent fails.

**1.0** (2026-10-15): initial protocol, defined by the TypeScript reference implementation.
