"""Stateless vRT v1 codecs. Structural rules: spec/schema; errors: §9.1."""

from __future__ import annotations

import json
import math
import re
import struct
from collections.abc import Callable
from dataclasses import dataclass
from decimal import Decimal, DecimalException
from typing import Any, Generic, Literal, TypeVar

# Wire constants: spec/protocol.md §§3.1, 4.1, 8.1. Revision is not a wire field.
PROTOCOL_VERSION = 1
SPEC_REVISION = '1.2'
MAX_UINT32 = 0xFFFFFFFF
AUDIO_HEADER_BYTES = 5
INPUT_AUDIO = 1
OUTPUT_AUDIO = 2
# Local implementation limit permitted by §11, not a protocol constant.
MAX_JSON_DEPTH = 64
MAX_JSON_NUMBER_CHARS = 4096
_INTEGER_LIMIT = 10**MAX_JSON_NUMBER_CHARS
Direction = Literal['client', 'server']  # The sender, not the receiver.
ErrorCode = Literal['MALFORMED', 'UNSUPPORTED_VERSION', 'UNKNOWN_TYPE', 'INVALID_FIELD']
T = TypeVar('T')


class ProtocolError(ValueError):
    """An invalid frame or message; `code` follows spec §9.1."""

    def __init__(self, code: ErrorCode, message: str):
        self.code = code
        super().__init__(message)


@dataclass(frozen=True)
class DecodeResult(Generic[T]):
    """Decoders return a value or an error; encoders raise ProtocolError."""

    value: T | None = None
    error: ProtocolError | None = None

    @property
    def ok(self) -> bool:
        return self.error is None


@dataclass(frozen=True)
class AudioFrame:
    kind: int
    seq: int
    # Read-only borrowed view. The owner must not mutate/reuse the backing buffer.
    payload: memoryview


Check = Callable[[Any], bool]
Shape = dict[str, Check]


def _integer(value: Any) -> bool:
    # Preserve exact decimal-token semantics before checking uint32 boundaries.
    if type(value) is Decimal:
        return value.is_finite() and value == value.to_integral_value()
    return type(value) is int or (
        type(value) is float and math.isfinite(value) and value.is_integer()
    )


def _uint32(value: Any) -> bool:
    return _integer(value) and 0 <= value <= MAX_UINT32


def _positive(value: Any) -> bool:
    return _uint32(value) and value > 0


def _string(value: Any) -> bool:
    return type(value) is str


def _identifier(value: Any) -> bool:
    return _string(value) and len(value) > 0


def _boolean(value: Any) -> bool:
    return type(value) is bool


def _nonnegative(value: Any) -> bool:
    if type(value) is int:
        return value >= 0
    if type(value) is Decimal:
        return value.is_finite() and value >= 0
    return type(value) is float and math.isfinite(value) and value >= 0


def _enum(*values: Any) -> Check:
    return lambda value: any(type(value) is type(option) and value == option for option in values)


def _pattern(pattern: str, max_length: int | None = None) -> Check:
    # Keep JSON Schema's anchored-regex behavior, including its final-newline
    # tolerance. See README's contract discrepancies before tightening this.
    compiled = re.compile(pattern, re.ASCII)
    return lambda value: (
        _string(value)
        and (max_length is None or len(value) <= max_length)
        and compiled.search(value) is not None
    )


def _array(check: Check) -> Check:
    return lambda value: type(value) is list and all(check(item) for item in value)


def _object(required: Shape, optional: Shape | None = None) -> Check:
    return lambda value: type(value) is dict and _bad_field(value, required, optional or {}) is None


def _bad_field(message: dict, required: Shape, optional: Shape) -> str | None:
    for key, check in required.items():
        if key not in message or not check(message[key]):
            return key
    for key, check in optional.items():
        if key in message and not check(message[key]):
            return key
    return None


# Any JSON member must be present; its value (including null) is checked later.
def _any(value: Any) -> bool:
    return True


_FORMAT = _object({'encoding': _enum('pcm16', 'opus', 'pcmu')}, {'sampleRate': _positive})
_TOOL = _object(
    {'name': _identifier, 'description': _string, 'parameters': lambda value: type(value) is dict}
)
_CAPABILITIES = _array(_pattern(r'^[a-z0-9]+(?:[.-][a-z0-9]+)*$', 64))
_FAILURE = _enum('INTERRUPTED', 'REJECTED', 'INVALID', 'TIMEOUT', 'FAILED')

# (Required fields, optional fields). Unknown fields are preserved at every depth.
_CLIENT: dict[str, tuple[Shape, Shape]] = {
    'hello': (
        {'tools': _array(_TOOL)},
        {
            'input': _FORMAT,
            'output': _FORMAT,
            'sessionId': _identifier,
            'resumeFrom': _uint32,
            'capabilities': _CAPABILITIES,
            'context': _any,
            'auth': _string,
        },
    ),
    'text': ({'text': _string}, {}),
    'interrupt': ({'epoch': _uint32, 'reason': _enum('speech', 'user', 'keyboard')}, {}),
    'playback': ({'itemId': _identifier, 'playedMs': _nonnegative}, {}),
    'tool.result': ({'callId': _identifier, 'epoch': _uint32, 'ok': _boolean}, {}),
    'context': ({'context': _any}, {}),
    'ack': ({'upTo': _uint32}, {}),
    'ping': ({}, {}),
}
_SERVER: dict[str, tuple[Shape, Shape]] = {
    'ready': (
        {'sessionId': _identifier, 'input': _FORMAT, 'output': _FORMAT},
        {
            'resumedFrom': _uint32,
            'capabilities': _CAPABILITIES,
        },
    ),
    'audio.start': ({'itemId': _identifier, 'responseId': _identifier, 'epoch': _uint32}, {}),
    'turn.state': (
        {
            'turnId': _identifier,
            'epoch': _uint32,
            'state': _enum('idle', 'listening', 'thinking', 'speaking', 'acting'),
        },
        {},
    ),
    'transcript': (
        {'role': _enum('user', 'agent'), 'itemId': _identifier, 'text': _string, 'final': _boolean},
        {},
    ),
    'text': ({'responseId': _identifier, 'delta': _string}, {}),
    'tool.call.delta': (
        {'callId': _identifier, 'epoch': _uint32, 'name': _identifier, 'preview': _any},
        {},
    ),
    'tool.call': (
        {
            'callId': _identifier,
            'epoch': _uint32,
            'turnId': _identifier,
            'name': _identifier,
            'arguments': _any,
        },
        {},
    ),
    'tool.stream': (
        {
            'callId': _identifier,
            'epoch': _uint32,
            'turnId': _identifier,
            'name': _identifier,
            'phase': _enum(
                'start',
                'arguments-delta',
                'arguments-complete',
                'progress',
                'settled',
                'cancelled',
                'failed',
            ),
        },
        {},
    ),
    'interrupted': ({'epoch': _uint32}, {}),
    'ack': ({'upTo': _uint32}, {}),
    'pong': ({}, {}),
    'error': (
        {'code': _pattern(r'^[A-Z][A-Z0-9_]*$'), 'message': _string, 'recoverable': _boolean},
        {},
    ),
}
CLIENT_MESSAGE_TYPES = tuple(_CLIENT)
SERVER_MESSAGE_TYPES = tuple(_SERVER)
_TRANSIENT = frozenset({'hello', 'ready', 'audio.start', 'ack', 'ping', 'pong'})
_STREAM_FIELDS: dict[str, Shape] = {
    'start': {},
    'cancelled': {},
    'arguments-delta': {'delta': _string},
    'arguments-complete': {'arguments': _any},
    'progress': {'progress': _any},
    'failed': {'message': _string},
}


def _shapes(direction: Direction) -> dict[str, tuple[Shape, Shape]]:
    if direction not in ('client', 'server'):
        raise ValueError('direction must identify the sender: client or server')
    return _CLIENT if direction == 'client' else _SERVER


def _json_value(value: Any, depth: int = 0) -> None:
    """Validate JSON values, including exact decimals, without copying the tree."""
    if value is None or type(value) in (bool, str):
        return
    if type(value) is int and -_INTEGER_LIMIT < value < _INTEGER_LIMIT:
        if len(str(value)) <= MAX_JSON_NUMBER_CHARS:
            return
    if type(value) is float and math.isfinite(value):
        return
    if type(value) is Decimal and value.is_finite():
        integer_chars = value.adjusted() + 1 + int(value.is_signed())
        if _integer(value) and integer_chars > MAX_JSON_NUMBER_CHARS:
            raise ValueError('Integer expansion exceeds MAX_JSON_NUMBER_CHARS')
        if len(str(value)) > MAX_JSON_NUMBER_CHARS:
            raise ValueError('Decimal exceeds MAX_JSON_NUMBER_CHARS')
        return
    if type(value) in (dict, list):
        if depth >= MAX_JSON_DEPTH:
            raise ValueError('JSON nesting exceeds MAX_JSON_DEPTH')
        if type(value) is dict and any(type(key) is not str for key in value):
            raise ValueError('JSON object keys must be strings')
        for item in value.values() if type(value) is dict else value:
            _json_value(item, depth + 1)
        return
    raise ValueError('Expected a finite JSON value within numeric limits')


def validate_message(value: Any, direction: Direction) -> DecodeResult[dict]:
    """Validate one parsed message, without dropping unknown members or copying it.

    Only structure is checked: no negotiation, ordering, epoch or session state.
    Integral floats are accepted as JSON Schema integers; encoders emit integers.
    """
    shapes = _shapes(direction)
    if type(value) is not dict:
        return DecodeResult(error=ProtocolError('MALFORMED', 'Message must be a JSON object'))
    if not _integer(value.get('v')) or value['v'] != PROTOCOL_VERSION:
        return DecodeResult(
            error=ProtocolError('UNSUPPORTED_VERSION', 'Expected protocol major version 1')
        )
    kind = value.get('type')
    if type(kind) is not str or kind not in shapes:
        return DecodeResult(error=ProtocolError('UNKNOWN_TYPE', 'Unknown message type for sender'))
    seq = value.get('seq')
    valid_seq = _uint32(seq) and (seq == 0 if kind in _TRANSIENT else kind == 'error' or seq > 0)
    required, optional = shapes[kind]
    bad = 'seq' if not valid_seq else _bad_field(value, required, optional)
    if bad is None and kind == 'tool.result':
        fields = {'output': _any} if value['ok'] else {'code': _FAILURE, 'message': _string}
        bad = _bad_field(value, fields, {})
    if bad is None and kind == 'tool.stream':
        fields = _STREAM_FIELDS.get(value['phase'], {})
        if value['phase'] == 'settled':
            fields = {'ok': _boolean}
            if value.get('ok') is False:
                fields = {**fields, 'code': _FAILURE}
        bad = _bad_field(value, fields, {})
    if bad is not None:
        return DecodeResult(
            error=ProtocolError('INVALID_FIELD', f'Invalid field for {kind}: {bad}')
        )
    if kind == 'hello':
        names = [tool['name'] for tool in value['tools']]
        if len(set(names)) != len(names):
            return DecodeResult(
                error=ProtocolError('INVALID_FIELD', 'Tool names must be unique (§5.2)')
            )
    try:
        _json_value(value)
    except (ValueError, DecimalException, RecursionError) as error:
        return DecodeResult(error=ProtocolError('INVALID_FIELD', str(error)))
    return DecodeResult(value=value)


def _parse_number(text: str) -> int | Decimal:
    if len(text) > MAX_JSON_NUMBER_CHARS:
        raise ValueError('JSON number token exceeds MAX_JSON_NUMBER_CHARS')
    return Decimal(text) if any(char in text for char in '.eE') else int(text)


def _reject_constant(text: str) -> None:
    raise ValueError(f'Non-JSON constant: {text}')


def _unique_object(pairs: list[tuple[str, Any]]) -> dict:
    result: dict = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate JSON object member')
        result[key] = value
    return result


def decode_message(text: str, direction: Direction) -> DecodeResult[dict]:
    """Decode a JSON text frame. Invalid wire input is returned as ProtocolError."""
    _shapes(direction)
    if type(text) is not str:
        return DecodeResult(error=ProtocolError('MALFORMED', 'Control frames must be text'))
    try:
        value = json.loads(
            text,
            parse_float=_parse_number,
            parse_int=_parse_number,
            parse_constant=_reject_constant,
            object_pairs_hook=_unique_object,
        )
    except (ValueError, DecimalException, RecursionError) as error:
        return DecodeResult(error=ProtocolError('MALFORMED', f'Invalid JSON: {error}'))
    return validate_message(value, direction)


def _encode_json(value: Any) -> str:
    # Values were validated first. stdlib json handles strings/escapes; Decimal
    # supplies exact JSON number tokens without a float conversion or a marker hack.
    if type(value) is dict:
        return (
            '{'
            + ','.join(json.dumps(key) + ':' + _encode_json(item) for key, item in value.items())
            + '}'
        )
    if type(value) is list:
        return '[' + ','.join(_encode_json(item) for item in value) + ']'
    if type(value) is Decimal:
        return str(int(value)) if _integer(value) else str(value)
    if type(value) is float and value.is_integer():
        return str(int(value))
    return json.dumps(value, ensure_ascii=True, allow_nan=False)


def encode_message(message: dict, direction: Direction) -> str:
    """Validate and encode; never emit non-finite numbers or non-string keys."""
    result = validate_message(message, direction)
    if result.error is not None:
        raise result.error
    return _encode_json(message)


def _bytes_view(data: bytes | bytearray | memoryview) -> memoryview:
    if not isinstance(data, (bytes, bytearray, memoryview)):
        raise TypeError('Expected bytes, bytearray or a contiguous memoryview')
    return memoryview(data).cast('B')


def decode_audio(
    data: bytes | bytearray | memoryview, direction: Direction | None = None
) -> DecodeResult[AudioFrame]:
    """Decode §8.1; direction optionally checks the sender's allowed kind.

    Payload is a read-only borrowed view retaining the input buffer, including
    nonzero offsets. Mutable backing storage must remain unchanged while in use.
    """
    if direction is not None:
        _shapes(direction)
    try:
        view = _bytes_view(data)
        if len(view) < AUDIO_HEADER_BYTES or view[0] not in (INPUT_AUDIO, OUTPUT_AUDIO):
            raise ValueError('Invalid audio header')
        if direction is not None and view[0] != (
            INPUT_AUDIO if direction == 'client' else OUTPUT_AUDIO
        ):
            raise ValueError('Wrong audio kind for sender')
        kind, seq = struct.unpack_from('>BI', view)
        return DecodeResult(value=AudioFrame(kind, seq, view[AUDIO_HEADER_BYTES:].toreadonly()))
    except (TypeError, ValueError) as error:
        return DecodeResult(error=ProtocolError('MALFORMED', str(error)))


def encode_audio(kind: int, seq: int, payload: bytes | bytearray | memoryview) -> bytes:
    """Build owned bytes; reject out-of-range sequence numbers instead of wrapping."""
    if type(kind) is not int or kind not in (INPUT_AUDIO, OUTPUT_AUDIO):
        raise ProtocolError('MALFORMED', 'Audio kind must be 1 or 2')
    if type(seq) is not int or not _uint32(seq):
        raise ProtocolError('MALFORMED', 'Audio seq must be a uint32 integer')
    try:
        return struct.pack('>BI', kind, seq) + _bytes_view(payload)
    except (TypeError, ValueError) as error:
        raise ProtocolError('MALFORMED', str(error)) from error
