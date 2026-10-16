"""Run with a fresh venv's Python after installing a wheel or sdist, without dev extras."""

import importlib.metadata
import json
import sys

from vrealtime import decode_audio, decode_message, encode_audio, encode_message

message = {'v': 1, 'seq': 1, 'type': 'context', 'context': None}
assert json.loads(encode_message(message, 'client')) == message
assert decode_message('{"v":1,"seq":0,"type":"pong"}', 'server').ok
assert encode_audio(1, 0x01020304, b'\xff') == bytes.fromhex('0101020304ff')
assert decode_audio(bytes.fromhex('02ffffffff'), 'server').value.seq == 0xFFFFFFFF
requirements = importlib.metadata.requires('vrealtime') or []
assert all('extra == "dev"' in requirement for requirement in requirements), requirements
installed = {dist.metadata['Name'].lower() for dist in importlib.metadata.distributions()}
assert installed <= {'vrealtime', 'pip', 'setuptools', 'wheel'}, installed
assert (
    not {'websockets', 'aiohttp', 'sounddevice', 'numpy', 'pytest', 'jsonschema'}
    & sys.modules.keys()
)
print('Installed artifact: codecs work without development, network or audio dependencies')
