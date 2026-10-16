# Python protocol foundation

This is the stateless foundation for [#18](https://github.com/austinchennn/vRT/issues/18),
not yet a Python client SDK. Python 3.10 or later; standard library only at runtime.
No WebSocket connection, session state, reliability/ACK queue, tool executor,
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
  epochs, sequencing, authentication, ACK bounds and tool execution rules.
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
core budget; this foundation uses only part of it, with the rest of the SDK pending.
