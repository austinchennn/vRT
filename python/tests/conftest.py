"""Read the shared contract from the checkout, never from the installed package."""

import json
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator
from referencing import Registry, Resource

SPEC = Path(__file__).resolve().parents[2] / 'spec'


def load_cases(suite):
    cases = []
    for path in sorted((SPEC / 'examples').glob('*/*.json')):
        document = json.loads(path.read_text(encoding='utf-8'))
        if document['suite'] == suite:
            for case in document['cases']:
                cases.append({**case, 'direction': document.get('direction')})
    assert cases, f'No {suite} vectors found in {SPEC}'
    assert len({case['id'] for case in cases}) == len(cases)
    return cases


CONTROLS = load_cases('control')
AUDIO = load_cases('audio')
VALID = [case for case in CONTROLS if case['valid']]


@pytest.fixture(scope='session')
def validators():
    schemas = [
        json.loads(path.read_text(encoding='utf-8')) for path in (SPEC / 'schema').rglob('*.json')
    ]
    registry = Registry().with_resources(
        (schema['$id'], Resource.from_contents(schema)) for schema in schemas
    )
    return {
        direction: Draft202012Validator(
            json.loads((SPEC / 'schema' / f'{direction}-message.json').read_text(encoding='utf-8')),
            registry=registry,
        )
        for direction in ('client', 'server')
    }
