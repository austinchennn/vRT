"""Message-level vectors and an independent schema oracle, not session conformance."""

import json
from copy import deepcopy

import pytest
from conftest import AUDIO, CONTROLS, SPEC, VALID

from vrealtime import (
    CLIENT_MESSAGE_TYPES,
    SERVER_MESSAGE_TYPES,
    decode_audio,
    decode_message,
    encode_audio,
    encode_message,
    validate_message,
)


@pytest.mark.parametrize('case', CONTROLS, ids=lambda case: case['id'])
def test_control_vector(case):
    text = case['raw'] if 'raw' in case else json.dumps(case['message'])
    result = decode_message(text, case['direction'])
    assert result.ok == case['valid']
    if case['valid']:
        assert result.value == case['message']
        # Independent JSON parser checks encoder output against the vector.
        assert json.loads(encode_message(result.value, case['direction'])) == case['message']
    else:
        assert result.error.code == case['error']


@pytest.mark.parametrize('case', AUDIO, ids=lambda case: case['id'])
def test_audio_vector(case):
    data = bytes.fromhex(case['bytes'])
    result = decode_audio(memoryview(b'pad' + data)[3:])
    assert result.ok == case['valid']
    if case['valid']:
        frame = result.value
        assert (frame.kind, frame.seq, frame.payload.hex()) == (
            case['frame']['kind'],
            case['frame']['seq'],
            case['frame']['payload'],
        )
        assert (
            encode_audio(frame.kind, frame.seq, bytes.fromhex(case['frame']['payload'])).hex()
            == case['bytes']
        )
    else:
        assert result.error.code == 'MALFORMED'


@pytest.mark.parametrize(
    'direction,types', [('client', CLIENT_MESSAGE_TYPES), ('server', SERVER_MESSAGE_TYPES)]
)
def test_message_inventory(direction, types):
    schemas = [
        json.loads(path.read_text(encoding='utf-8'))
        for path in (SPEC / 'schema' / direction).glob('*.json')
    ]
    assert set(types) == {schema['properties']['type']['const'] for schema in schemas}
    registry = json.loads((SPEC / 'capabilities.json').read_text(encoding='utf-8'))
    gated = {
        kind
        for capability in registry['capabilities']
        for kind in capability.get('messages', {}).get(direction, [])
    }
    assert gated <= set(types)  # Structure support does not advertise a capability.


REPLACEMENTS = [
    None,
    True,
    False,
    0,
    1,
    1.0,
    -1,
    1.5,
    4294967295,
    4294967296,
    '',
    'x',
    'UPPER_CASE',
    [],
    {},
]
MISSING = object()


def mutations(root):
    """Remove/replace every field and array element recursively; no codec rules."""

    def walk(node, path):
        if not isinstance(node, (dict, list)):
            return
        for key in node.keys() if isinstance(node, dict) else range(len(node)):
            current = path + [key]
            for replacement in ([MISSING] if isinstance(node, dict) else []) + REPLACEMENTS:
                copy = deepcopy(root)
                parent = copy
                for part in current[:-1]:
                    parent = parent[part]
                if replacement is MISSING:
                    del parent[key]
                else:
                    parent[key] = deepcopy(replacement)
                yield current, copy
            yield from walk(node[key], current)

    yield from walk(root, [])


@pytest.mark.parametrize('case', VALID, ids=lambda case: case['id'])
def test_field_mutations_against_schema(case, validators):
    oracle = validators[case['direction']]
    count = 0
    for path, value in mutations(case['message']):
        result = validate_message(value, case['direction'])
        assert result.ok == oracle.is_valid(value), (path, value, result.error)
        if not result.ok:
            # Independent classification from §9.1, not the mutated field alone:
            # replacing v with 1 is still valid and may expose another condition.
            if not validators_version(value):
                expected = 'UNSUPPORTED_VERSION'
            elif not isinstance(value.get('type'), str) or value['type'] not in (
                CLIENT_MESSAGE_TYPES if case['direction'] == 'client' else SERVER_MESSAGE_TYPES
            ):
                expected = 'UNKNOWN_TYPE'
            else:
                expected = 'INVALID_FIELD'
            assert result.error.code == expected, (path, value)
        count += 1
    assert count > len(case['message'])


def validators_version(value):
    return not isinstance(value.get('v'), bool) and value.get('v') == 1


@pytest.mark.parametrize('case', VALID, ids=lambda case: case['id'])
def test_unknown_fields_preserved(case):
    message = deepcopy(case['message'])

    def extend(node):
        if isinstance(node, dict):
            for value in list(node.values()):
                extend(value)
            node['x-future-field'] = {'nested': [None, True, 7, '你好']}
        elif isinstance(node, list):
            for value in node:
                extend(value)

    extend(message)
    result = decode_message(json.dumps(message), case['direction'])
    assert result.ok, result.error
    assert result.value == message
    assert json.loads(encode_message(message, case['direction'])) == message
