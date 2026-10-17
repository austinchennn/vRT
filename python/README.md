# Python protocol foundation

This is the protocol foundation for [#18](https://github.com/austinchennn/vRT/issues/18),
not yet a Python client SDK. Python 3.10 or later; standard library only at runtime.
Includes stateless codecs and in-memory control-stream state. No WebSocket connection,
session lifecycle, tool executor,
reconnects, device audio or provider adapters. Nothing is published to PyPI here.

## Use from a checkout

```sh
python -m pip install ./python
```

```python
from vrealtime import decode_message, encode_message, decode_audio, encode_audio

result = decode_message('{"v":1,"seq":1,"type":"text","text":"hello"}', 'client')
if result.ok:
    print(result.value)  # dict; unknown fields remain intact
else:
    print(result.error.code, str(result.error))

text = encode_message({'v': 1, 'seq': 1, 'type': 'context', 'context': None}, 'client')
frame = encode_audio(1, 0, b'\x00\x00')
audio = decode_audio(frame, 'client')
assert audio.ok and audio.value.payload == b'\x00\x00'
```

`direction` always identifies the **sender**, for both encode and decode.
`validate_message(value, direction)` checks an already-parsed dict. Decoders and
validation return `DecodeResult` with `.ok`, `.value` or `.error`. Encoding invalid
input raises `ProtocolError`; its `.code` is one of `MALFORMED`,
`UNSUPPORTED_VERSION`, `UNKNOWN_TYPE`, `INVALID_FIELD`. An invalid direction is a
caller error (`ValueError`). Audio errors use `MALFORMED` (§8.1).

## Contract and boundaries

- The contract is [spec/protocol.md](../spec/protocol.md), [schemas](../spec/schema/),
  [vectors](../spec/examples/) and [capability registry](../spec/capabilities.json).
  Wire major `PROTOCOL_VERSION = 1` differs from document `SPEC_REVISION = '1.2'`.
  Revision is not serialized as `v`.
- Both directions' current message structures are supported, including every
  `tool.stream` phase. This does **not** advertise `tool-stream-v1`, negotiate it,
  or validate phase ordering. A future session layer must enforce capabilities,
  epochs, authentication and tool execution rules. The new sequence helpers handle
  only their own direction-local control-stream state, not complete resume orchestration.
- Unknown members at every depth and syntactically valid unknown capability
  tokens are preserved. Direction-specific unknown message types are rejected.
  Errors follow §9.1's framing → version → type → fields order.
- Missing and null differ. Boolean values never satisfy numeric fields. Schema
  integers include integral JSON numbers (`1.0`, `1e0`); receivers accept those,
  while the encoder normalizes integral numeric values to integer spelling, as senders
  must do under §2.2. Non-integral numbers use Python's JSON float representation.
- Values use dict/list/str/bool/int/finite-float/None and standard-library
  `Decimal` for decimal/exponent tokens. Keys must be strings. NaN, Infinity and
  duplicate JSON member names (at any depth) are rejected. Duplicate members are
  treated as malformed rather than silently using the last value. The specification
  forbids senders to duplicate members but does not explicitly assign a receiver
  error code for them; this parser policy is an explicit review point.
- Decimal/exponent tokens decode to exact `Decimal` values, avoiding binary64
  rounding before integer/range checks (for example `-1e-400` must not become 0).
  The encoder writes finite decimals directly as JSON numbers, not quoted strings
  or floats. Caller-provided Python floats retain their existing binary64 precision;
  exact decimal values should use `Decimal` or decode from text.
- `MAX_JSON_DEPTH = 64` and `MAX_JSON_NUMBER_CHARS = 4096` are local limits (§11),
  not wire constants. The latter bounds numeric tokens and integer expansion, so a
  short exponent cannot cause unbounded output allocation. An excessive token or
  parser recursion failure returns `MALFORMED`; other value/depth limits return
  `INVALID_FIELD`. Python's own integer parsing limits can additionally apply.
  Validation does not copy the message; encoding creates serialized strings.
  The stdlib parser allocates before depth validation; callers handling untrusted
  traffic should bound frame bytes before decoding. There is no claim of bounded
  memory for unbounded input or measured latency.
- Audio has a 5-byte `kind u8` / `seq u32 big-endian` header. Empty payloads are
  valid. Payload bytes are opaque: no PCM conversion or whole-sample requirement
  is added. Encoding rejects invalid kinds and sequence values, rather than
  silently wrapping; a future sender owns the modulo-2^32 audio counter.
- `decode_audio` accepts contiguous bytes/bytearray/memoryview buffers and returns
  a **read-only borrowed view**, retaining the backing buffer and honoring its
  offset. Read-only does not freeze a bytearray: the caller must not mutate/reuse
  it while the frame is in use. Use `bytes(frame.payload)` for an owned snapshot.
  `encode_audio` returns owned bytes. Optional `direction` on decoding checks kind
  1 from clients / kind 2 from servers; omitted checks structure only.

## Reliable control-stream state

`Outbox` owns one sender's stream; `Inbox` owns one sender's receive cursor.
Direction always identifies the **sender**. Keep the same objects over reconnects
of one session. Do not reuse them for another session or share them across threads
without application synchronization. They are synchronous, with no network/timer
or device behavior and no durable persistence/restore API.

```python
from vrealtime import Inbox, Outbox

outgoing = Outbox('client', limit=1024)  # local message-count policy
first = outgoing.stamp({'type': 'text', 'text': 'hello'})
assert first == {'v': 1, 'seq': 1, 'type': 'text', 'text': 'hello'}
assert outgoing.stamp({'type': 'ping'})['seq'] == 0
assert outgoing.resend_from(0) == [first]
outgoing.ack(1)
assert outgoing.resend_from(0) is None  # old data was actually discarded
assert outgoing.resend_from(1) == []  # no messages need replay

incoming = Inbox('server')
message = {'v': 1, 'seq': 1, 'type': 'text', 'responseId': 'r', 'delta': 'hello'}
assert incoming.accept(message)
assert not incoming.accept(message)
assert incoming.last_seq == 1
```

- `Outbox(direction, limit=DEFAULT_REPLAY_LIMIT)` starts at zero with a positive
  Python-int message capacity (default 1024). `last_seq` and `pending` are read-only
  properties. `stamp(message)` takes an unenveloped dict (no `v` or `seq`), validates
  it using the existing direction-specific codec and returns an owned dict. The
  exported immutable `TRANSIENT_MESSAGE_TYPES` keeps codec/classification in step.
- For **server error messages**, `stamp(error, sessionless=True)` emits seq 0;
  `sessionless=False` assigns the next session seq. The boolean is mandatory for
  errors and rejected for other message types; the helper cannot infer session
  binding from a message name or earlier `ready`. Whether a connection is allowed
  to send now remains the future session layer's responsibility.
- Transient messages never consume seq or cache space (§4.1). Sequenced messages
  are cached until cumulative ACK or oldest-first capacity eviction. `last_seq`
  never decreases or wraps; further numbered stamps after uint32 exhaustion raise
  `OverflowError`. Transients/sessionless errors can still be emitted. No new wire
  error code is introduced and the helper cannot open/close a session itself.
- `ack(up_to)` accepts uint32 Python ints (excluding bool). Repeated/stale ACKs are
  harmless. §4.2 says a peer MUST NOT ACK beyond what it received, but also defines
  an ACK at/beyond the sender's last seq as acknowledging everything sent. This
  helper tolerates such **uint32** ahead ACKs, clears only existing entries, and
  never grants credit for future sends. It does not silently accept malformed or
  out-of-range Python arguments. A future session may separately report invalid
  peer behavior; this API does not invent a wire response.
- `resend_from(last_seen)` accepts a uint32 Python int and returns ordered owned
  message copies, `[]` when already current, or `None` when ahead of `last_seq` or
  below the highest removed seq. **ACK deletion counts as loss of stored data,
  just like eviction** (§5.4 requires every requested message). The TypeScript
  Outbox follows the same replay-availability rule: a cursor behind removed
  history fails instead of returning an incomplete replay. ACK permits deletion;
  it does not make a later request for that deleted history satisfiable.
- Input, stamped result and replay results are isolated by deep copies. Validation
  and snapshot copies complete before a stamp consumes seq or evicts prior data.
  This costs time/memory proportional to message size; ACK/oldest eviction use an
  ordered queue rather than repeatedly shifting a list. Capacity bounds message
  **count**, not bytes. The codec's local JSON limits still apply; a future transport
  needs a frame-byte limit. No audio hot path or measured latency claim is involved.
- `Inbox(direction).accept(message)` validates the full message first. Invalid
  structure raises the existing `ProtocolError` without changing the cursor.
  Seq 0 is always accepted without cursor changes; seq <= cursor is a duplicate;
  higher seq advances it (§4.3). A gap is accepted and advances the cursor by those
  rules; the sender violated contiguity, but no recovery is defined. This does not
  mean missing messages were delivered. Duplicate invalid messages still fail
  structural validation rather than bypassing it.
- Integral JSON numbers accepted by the codec normalize to Python int inside
  `Inbox`. Local `ack`/`resend_from` parameters are stricter Python ints: a future
  reader should normalize validated wire cursors, never blindly coerce bool or
  fractional/unvalidated values. Acceptance/ACK means receipt into state, not tool
  completion or exactly-once side effects; application dispatch and sequencing of
  replay before new sends are outside this module.

Malformed local arguments raise `ValueError`; structural failures use the existing
`ProtocolError` (a ValueError subtype); valid but unsatisfiable replay returns None.
The caller must translate that outcome into the appropriate session failure and
must not silently open a new session and replay old effects.

Boundary tests use private test-only state injection to reach uint32 exhaustion,
with a consistent already-discarded prefix. There is no public arbitrary cursor
setter added for testing. No full reconnect or #17 network conformance claim is made.

## Existing contract discrepancies

No wire definitions or vector expectations were changed by this implementation.

- `spec/protocol.md` §3.3's last paragraph still says the registry lists no
  capabilities. The actual registry, §7.5, schemas and vectors define
  `tool-stream-v1`. This codec follows those current structural definitions;
  it claims no session-level capability support.
- §5.2 requires unique tool names in `hello.tools`. The schema's `items` check and
  TypeScript `codec.ts` do not enforce uniqueness. Python checks the explicit
  normative rule and reports `INVALID_FIELD`; a test records both the schema's
  acceptance and Python's rejection. This is a semantic constraint on one message,
  not a change to its shape or to a vector expectation.
- `spec/schema/common.json` capability/errorCode patterns end in `$`, which
  permits a final newline; the TypeScript regex checks and schema oracle agree.
  This contradicts the token/word descriptions in §§3.3 and 9.2. Under §1's
  schema precedence this layer retains that acceptance, with an explicit test.
  Tightening the shared patterns needs a maintainer decision, not a Python-only
  contract change.
- §2.2's integer spelling rule is a sender requirement. JSON Schema treats
  integral numeric values as integers regardless of original spelling; both
  decoders accept them and this encoder emits canonical integer spelling.
- TypeScript's `writeAudioHeader` coerces/wraps sequence input using `>>> 0`;
  this encoder instead rejects caller values outside the specified uint32 range.
  Existing wire bytes and wrapping semantics for a session counter are unchanged.

## Development and verification

From the repository root (use the desired Python interpreter):

```sh
python -m venv python/.venv
. python/.venv/bin/activate
python -m pip install -e './python[dev]'
python -m ruff check python
python -m ruff format --check python
python -m pytest python/tests
python -m compileall -q python/src
python -m build python
```

Only development extras install pytest, a JSON Schema oracle, Ruff for lint/format checks and the build tool.
The runtime does not read schemas from the checkout or import those dependencies.
Tests locate `spec/` from their own file location, not the working directory.
They must run from a repository checkout; wheel/sdist consumers need no spec files.

The tests run **all** current shared control/audio vectors by stable case ID,
compare every valid vector's recursive field mutations with draft 2020-12 schemas,
and cover parser, numeric, variant, unknown-field, audio-layout and ownership
boundaries independently of codec round trips. This is message-level evidence,
**not** a pass of #17's session-level black-box conformance suite.

Check each artifact in a separate clean environment, without extras:

```sh
python -m venv /tmp/vrt-wheel-check
/tmp/vrt-wheel-check/bin/python -m pip install python/dist/*.whl
/tmp/vrt-wheel-check/bin/python python/tests/check_install.py
python -m venv /tmp/vrt-sdist-check
/tmp/vrt-sdist-check/bin/python -m pip install python/dist/*.tar.gz
/tmp/vrt-sdist-check/bin/python python/tests/check_install.py
```

CI runs Python 3.10 and 3.14 when Python, shared spec or this workflow changes,
including wheel and sdist install smoke checks. Packaging does not publish anything.
The production Python line count is printed and checked against #18's 800-line
core budget. The current core totals 619 lines (149 added in this reliability step),
leaving 181 lines for the remaining non-audio SDK. Whether connection/session, tools
and cancellation can fit that remainder has not been established; review the full
budget with maintainers before claiming the complete SDK can meet it.
