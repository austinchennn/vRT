import json
from decimal import Decimal

import pytest

from vrealtime import (
    MAX_JSON_DEPTH,
    MAX_JSON_NUMBER_CHARS,
    MAX_UINT32,
    PROTOCOL_VERSION,
    SPEC_REVISION,
    ProtocolError,
    decode_audio,
    decode_message,
    encode_audio,
    encode_message,
    validate_message,
)


@pytest.mark.parametrize(
    'raw',
    [
        '',
        '{',
        '[]',
        'null',
        '1',
        '"ping"',
        '{} trailing',
        '{"v":1,"seq":0,"type":"ping",}',
        '{"v":1,"seq":0,"type":"ping","future":NaN}',
        '{"v":1,"seq":0,"type":"ping","future":Infinity}',
        '{"v":1,"seq":0,"type":"ping","future":-Infinity}',
        '{"v":2,"v":1,"seq":0,"type":"ping"}',
        '{"v":1,"seq":0,"type":"ping","future":{"a":1,"a":2}}',
        b'{"v":1,"seq":0,"type":"ping"}',
        None,
    ],
)
def test_malformed_text(raw):
    result = decode_message(raw, 'client')
    assert not result.ok
    assert result.error.code == 'MALFORMED'


@pytest.mark.parametrize(
    'message,code',
    [
        ({'v': True, 'type': 'ping', 'seq': 0}, 'UNSUPPORTED_VERSION'),
        ({'v': 2, 'type': 'unknown', 'seq': -1}, 'UNSUPPORTED_VERSION'),
        ({'v': 1, 'type': 'unknown', 'seq': -1}, 'UNKNOWN_TYPE'),
        ({'v': 1, 'type': '__proto__', 'seq': 0}, 'UNKNOWN_TYPE'),
        ({'v': 1, 'type': [], 'seq': 0}, 'UNKNOWN_TYPE'),
        ({'v': 1, 'type': 'pong', 'seq': 0}, 'UNKNOWN_TYPE'),
        ({'v': 1, 'type': 'ping', 'seq': False}, 'INVALID_FIELD'),
    ],
)
def test_error_precedence(message, code):
    assert decode_message(json.dumps(message), 'client').error.code == code
    with pytest.raises(ProtocolError) as error:
        encode_message(message, 'client')
    assert error.value.code == code


@pytest.mark.parametrize(
    'value,valid',
    [
        (0, False),
        (1, True),
        (MAX_UINT32, True),
        (MAX_UINT32 + 1, False),
        (-1, False),
        (True, False),
        (False, False),
        (1.5, False),
        (1.0, True),
        (None, False),
    ],
)
def test_control_integer_boundaries(value, valid):
    message = {'v': 1, 'seq': value, 'type': 'text', 'text': ''}
    assert validate_message(message, 'client').ok == valid


@pytest.mark.parametrize('field', ['epoch', 'resumeFrom', 'sampleRate'])
@pytest.mark.parametrize('value', [True, False, -1, 4294967296, 1.5, None])
def test_nested_integer_fields(field, value):
    if field == 'epoch':
        message = {'v': 1, 'seq': 1, 'type': 'interrupt', 'epoch': value, 'reason': 'user'}
    else:
        message = {'v': 1, 'seq': 0, 'type': 'hello', 'tools': []}
        if field == 'sampleRate':
            message['input'] = {'encoding': 'pcm16', 'sampleRate': value}
        else:
            message[field] = value
    assert validate_message(message, 'client').error.code == 'INVALID_FIELD'


@pytest.mark.parametrize(
    'value', [float('nan'), float('inf'), float('-inf'), {1: 'bad key'}, (1, 2), b'x', object()]
)
def test_non_json_values_rejected_even_in_unknown_fields(value):
    message = {'v': 1, 'seq': 0, 'type': 'ping', 'future': value}
    assert validate_message(message, 'client').error.code == 'INVALID_FIELD'
    with pytest.raises(ProtocolError) as error:
        encode_message(message, 'client')
    assert error.value.code == 'INVALID_FIELD'


def test_null_is_not_missing_and_optional_null_is_validated():
    message = {
        'v': 1,
        'seq': 1,
        'type': 'tool.result',
        'callId': 'c',
        'epoch': 0,
        'ok': True,
        'output': None,
    }
    assert validate_message(message, 'client').ok
    del message['output']
    assert validate_message(message, 'client').error.code == 'INVALID_FIELD'
    hello = {'v': 1, 'seq': 0, 'type': 'hello', 'tools': [], 'context': None}
    assert validate_message(hello, 'client').ok
    hello['auth'] = None
    assert validate_message(hello, 'client').error.code == 'INVALID_FIELD'


def test_numeric_schema_semantics_and_sender_integer_spelling():
    raw = '{"v":1.0,"seq":1e0,"type":"interrupt","epoch":2.0,"reason":"user"}'
    result = decode_message(raw, 'client')
    assert result.ok
    assert (
        encode_message(result.value, 'client')
        == '{"v":1,"seq":1,"type":"interrupt","epoch":2,"reason":"user"}'
    )
    assert PROTOCOL_VERSION == 1
    assert SPEC_REVISION == '1.2'


def test_unicode_and_number_values_preserved():
    message = {'v': 1, 'seq': 1, 'type': 'context', 'context': {'你好': ['🎤', None, 1.25, 2**70]}}
    assert json.loads(encode_message(message, 'client')) == message
    assert decode_message(encode_message(message, 'client'), 'client').value == message


@pytest.mark.parametrize('token', ['UPPER', 'a' * 65, '', 'a..b', 'é'])
def test_capability_token_constraints(token):
    assert not validate_message(
        {'v': 1, 'seq': 0, 'type': 'hello', 'tools': [], 'capabilities': [token]}, 'client'
    ).ok


def test_unknown_capability_is_preserved_not_advertised():
    message = {
        'v': 1,
        'seq': 0,
        'type': 'hello',
        'tools': [],
        'capabilities': ['future-v9', 'x-device.v1'],
    }
    assert decode_message(json.dumps(message), 'client').value == message


def test_open_error_codes_and_ascii_pattern():
    message = {
        'v': 1,
        'seq': 0,
        'type': 'error',
        'code': 'FUTURE_ERROR_2',
        'message': '',
        'recoverable': True,
    }
    assert validate_message(message, 'server').ok
    for code in ['é', '', 'bad', '2BAD']:
        assert not validate_message({**message, 'code': code}, 'server').ok


def test_depth_limit_and_cycles():
    message = {'v': 1, 'seq': 1, 'type': 'context', 'context': []}
    node = message['context']
    for _ in range(MAX_JSON_DEPTH):
        child = []
        node.append(child)
        node = child
    assert validate_message(message, 'client').error.code == 'INVALID_FIELD'
    assert decode_message(json.dumps(message), 'client').error.code == 'INVALID_FIELD'
    message['context'] = message
    with pytest.raises(ProtocolError):
        encode_message(message, 'client')
    assert decode_message('[' * 2000, 'client').error.code == 'MALFORMED'


@pytest.mark.parametrize('length', range(5))
def test_short_audio(length):
    assert decode_audio(b'\x01' * length).error.code == 'MALFORMED'


@pytest.mark.parametrize('seq', [0, 1, 0x01020304, MAX_UINT32])
def test_audio_big_endian_and_sequence_boundaries(seq):
    expected = b'\x01' + seq.to_bytes(4, 'big') + b'\xfe\xff'
    assert encode_audio(1, seq, b'\xfe\xff') == expected
    result = decode_audio(expected, 'client')
    assert result.ok
    assert result.value.seq == seq
    assert result.value.payload == b'\xfe\xff'
    assert decode_audio(expected, 'server').error.code == 'MALFORMED'


@pytest.mark.parametrize('kind', [0, 3, 255, True, False, 1.0, None])
def test_invalid_audio_kind(kind):
    with pytest.raises(ProtocolError) as error:
        encode_audio(kind, 0, b'')
    assert error.value.code == 'MALFORMED'


@pytest.mark.parametrize('seq', [-1, MAX_UINT32 + 1, True, False, 1.0, 1.5, None])
def test_audio_seq_does_not_coerce_or_wrap(seq):
    with pytest.raises(ProtocolError) as error:
        encode_audio(1, seq, b'')
    assert error.value.code == 'MALFORMED'


def test_audio_empty_payload_and_arbitrary_payload_bytes():
    assert encode_audio(2, 0, b'') == b'\x02\x00\x00\x00\x00'
    assert decode_audio(b'\x02\x00\x00\x00\x00', 'server').value.payload == b''
    assert encode_audio(1, 0, b'\xff')[-1:] == b'\xff'  # Whole PCM samples are SHOULD, not MUST.


def test_audio_ownership_offsets_and_invalid_buffers():
    source = bytearray(b'pad\x02\x01\x02\x03\x04\xaa\xbb')
    frame = decode_audio(memoryview(source)[3:], 'server').value
    assert frame.payload.readonly
    assert frame.payload.obj is source
    source[-1] = 0xCC
    assert frame.payload.hex() == 'aacc'  # Borrowed storage, not an immutable snapshot.
    owned = encode_audio(frame.kind, frame.seq, frame.payload)
    source[-1] = 0xDD
    assert owned == b'\x02\x01\x02\x03\x04\xaa\xcc'
    for value in ['text', None, memoryview(b'123456')[::2]]:
        assert decode_audio(value).error.code == 'MALFORMED'
        with pytest.raises(ProtocolError):
            encode_audio(1, 0, value)


def test_invalid_direction_is_a_caller_error():
    with pytest.raises(ValueError, match='direction'):
        decode_message('{}', 'receiver')
    with pytest.raises(ValueError, match='direction'):
        decode_audio(b'', 'receiver')


def test_unique_tool_names_are_a_normative_rule_beyond_the_schema(validators):
    tool = {'name': 'lamp', 'description': '', 'parameters': {}}
    message = {'v': 1, 'seq': 0, 'type': 'hello', 'tools': [tool, tool.copy()]}
    assert validators['client'].is_valid(message)  # Known gap, not a changed expectation.
    assert validate_message(message, 'client').error.code == 'INVALID_FIELD'


def test_schema_regex_final_newline_tolerance_is_explicit(validators):
    # Prose describes ASCII tokens/words; current schema regexes use `$`, which
    # also matches before a final newline. §1 gives schemas structural precedence.
    messages = {
        'client': {'v': 1, 'seq': 0, 'type': 'hello', 'tools': [], 'capabilities': ['future-v9\n']},
        'server': {
            'v': 1,
            'seq': 0,
            'type': 'error',
            'code': 'FUTURE_ERROR\n',
            'message': '',
            'recoverable': True,
        },
    }
    for direction, message in messages.items():
        assert validators[direction].is_valid(message)
        assert validate_message(message, direction).ok


@pytest.mark.parametrize(
    'raw,code',
    [
        ('{"v":1.0000000000000000001,"seq":0,"type":"ping"}', 'UNSUPPORTED_VERSION'),
        ('{"v":1,"seq":4294967295.00000001,"type":"text","text":""}', 'INVALID_FIELD'),
        ('{"v":1,"seq":1e-400,"type":"text","text":""}', 'INVALID_FIELD'),
        ('{"v":1,"seq":1,"type":"interrupt","epoch":-1e-400,"reason":"user"}', 'INVALID_FIELD'),
        ('{"v":1,"seq":1,"type":"playback","itemId":"a","playedMs":-1e-400}', 'INVALID_FIELD'),
    ],
)
def test_decimal_tokens_do_not_round_into_valid_fields(raw, code):
    assert decode_message(raw, 'client').error.code == code


def test_exact_decimal_values_and_standard_json_encoding():
    raw = '{"v":1,"seq":1,"type":"context","context":[0.1,1e-400,1e400]}'
    result = decode_message(raw, 'client')
    assert result.ok
    assert result.value['context'] == [Decimal('0.1'), Decimal('1e-400'), Decimal('1e400')]
    encoded = encode_message(result.value, 'client')
    assert 'NaN' not in encoded and 'Infinity' not in encoded
    assert json.loads(encoded, parse_float=Decimal)['context'] == result.value['context']
    assert encode_message(
        {'v': 1, 'seq': 1, 'type': 'context', 'context': Decimal('12.50')}, 'client'
    ).endswith('12.50}')


def test_numeric_resource_limits():
    raw = '{"v":1,"seq":1,"type":"context","context":' + '1' * (MAX_JSON_NUMBER_CHARS + 1) + '}'
    assert decode_message(raw, 'client').error.code == 'MALFORMED'
    # Short exponent input must not trigger an unbounded integer expansion later.
    raw = '{"v":1,"seq":1,"type":"context","context":1e1000000}'
    assert decode_message(raw, 'client').error.code == 'INVALID_FIELD'
    message = {'v': 1, 'seq': 1, 'type': 'context', 'context': 10**MAX_JSON_NUMBER_CHARS}
    with pytest.raises(ProtocolError):
        encode_message(message, 'client')
    for value in [Decimal('NaN'), Decimal('Infinity'), Decimal('-Infinity')]:
        assert (
            validate_message({**message, 'context': value}, 'client').error.code == 'INVALID_FIELD'
        )
