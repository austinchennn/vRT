"""Run with a fresh venv's Python after installing a wheel or sdist, without dev extras."""

import importlib.metadata
import json
import sys

from vrealtime import Inbox, Outbox, decode_audio, decode_message, encode_audio, encode_message

message = {'v': 1, 'seq': 1, 'type': 'context', 'context': None}
assert json.loads(encode_message(message, 'client')) == message
assert decode_message('{"v":1,"seq":0,"type":"pong"}', 'server').ok
assert encode_audio(1, 0x01020304, b'\xff') == bytes.fromhex('0101020304ff')
assert decode_audio(bytes.fromhex('02ffffffff'), 'server').value.seq == 0xFFFFFFFF
outbox = Outbox('client', limit=1)
assert outbox.stamp({'type': 'text', 'text': 'hello'}) == {
    'v': 1,
    'seq': 1,
    'type': 'text',
    'text': 'hello',
}
outbox.ack(1)
assert outbox.resend_from(0) is None and outbox.resend_from(1) == []
inbox = Inbox('client')
assert inbox.accept({'v': 1, 'seq': 2, 'type': 'text', 'text': 'received'})
assert inbox.last_seq == 2
requirements = importlib.metadata.requires('vrealtime') or []
assert all('extra == "dev"' in requirement for requirement in requirements), requirements
installed = {dist.metadata['Name'].lower() for dist in importlib.metadata.distributions()}
assert installed <= {'vrealtime', 'pip', 'setuptools', 'wheel'}, installed
assert (
    not {'websockets', 'aiohttp', 'sounddevice', 'numpy', 'pytest', 'jsonschema'}
    & sys.modules.keys()
)
print(
    'Installed artifact: codecs and control-stream state work without development, network or audio dependencies'
)
