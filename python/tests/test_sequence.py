"""Control-stream trajectories independent of the outgoing/incoming pair."""

from copy import deepcopy
from decimal import Decimal

import pytest

import vrealtime.sequence as sequence
from vrealtime import MAX_UINT32, Inbox, Outbox, ProtocolError


def text(value='hello'):
    return {'type': 'text', 'text': value}


def client_message(seq, **fields):
    return {'v': 1, 'seq': seq, 'type': 'text', 'text': 'hello', **fields}


def view(outbox):
    return outbox.last_seq, outbox.pending, outbox.resend_from(outbox.last_seq)


def test_contiguous_numbers_ignore_transient_interleaving():
    out = Outbox('client')
    assert out.stamp({'type': 'hello', 'tools': []}) == {
        'v': 1,
        'seq': 0,
        'type': 'hello',
        'tools': [],
    }
    first = out.stamp(text('one'))
    assert first == {'v': 1, 'seq': 1, 'type': 'text', 'text': 'one'}
    assert out.stamp({'type': 'ping'}) == {'v': 1, 'seq': 0, 'type': 'ping'}
    assert out.stamp({'type': 'ack', 'upTo': 0})['seq'] == 0
    second = out.stamp(text('two'))
    assert second == {'v': 1, 'seq': 2, 'type': 'text', 'text': 'two'}
    assert (out.last_seq, out.pending) == (2, 2)
    assert out.resend_from(0) == [first, second]
    assert out.resend_from(1) == [second]
    assert out.resend_from(2) == []


@pytest.mark.parametrize(
    'message',
    [
        {
            'type': 'ready',
            'sessionId': 's',
            'input': {'encoding': 'pcm16'},
            'output': {'encoding': 'pcm16'},
        },
        {'type': 'audio.start', 'itemId': 'i', 'responseId': 'r', 'epoch': 0},
        {'type': 'ack', 'upTo': 0},
        {'type': 'pong'},
    ],
)
def test_server_transient_inventory(message):
    out = Outbox('server')
    assert out.stamp(message) == {'v': 1, 'seq': 0, **message}
    assert view(out) == (0, 0, [])


def test_cumulative_ack_and_old_recovery_cursors():
    out = Outbox('client')
    sent = [out.stamp(text(str(i))) for i in range(4)]
    out.ack(2)
    assert out.pending == 2
    assert out.resend_from(0) is None  # §5.4: cannot supply all requested messages.
    assert out.resend_from(1) is None
    assert out.resend_from(2) == sent[2:]
    for repeated in [2, 1, 0, 2]:
        out.ack(repeated)
        assert out.resend_from(2) == sent[2:]
    out.ack(4)
    assert view(out) == (4, 0, [])
    assert out.resend_from(3) is None
    fifth = out.stamp(text('fifth'))
    assert out.resend_from(4) == [fifth]


def test_ahead_ack_discards_only_current_messages_without_future_credit():
    # §4.2 forbids peers from sending ahead ACKs, but explicitly describes their
    # sender-side effect: acknowledge everything currently sent.
    out = Outbox('client')
    out.ack(MAX_UINT32)
    first = out.stamp(text())
    assert out.resend_from(0) == [first]
    out.ack(MAX_UINT32)
    assert out.resend_from(0) is None
    second = out.stamp(text('next'))
    assert out.resend_from(1) == [second]
    assert (out.last_seq, out.pending) == (2, 1)


@pytest.mark.parametrize('capacity', [1, 2, 3])
def test_eviction_boundary_is_exact(capacity):
    out = Outbox('client', limit=capacity)
    history = [out.stamp(text(str(i))) for i in range(6)]
    floor = 6 - capacity
    assert out.pending == capacity
    for cursor in range(7):
        expected = None if cursor < floor else history[cursor:]
        assert out.resend_from(cursor) == expected
    assert out.resend_from(7) is None
    # ACK removes data too; it must not reset the earlier loss boundary.
    out.ack(5)
    assert out.resend_from(4) is None
    assert out.resend_from(5) == history[5:]
    out.stamp(text('seven'))
    assert out.pending <= capacity
    expected = None if capacity == 1 else history[5:] + [client_message(7, text='seven')]
    assert out.resend_from(5) == expected
    assert out.resend_from(6) == [client_message(7, text='seven')]


def test_snapshot_ownership_preserves_unknown_nested_values():
    source = {
        'type': 'context',
        'context': {'items': [Decimal('0.1'), {'x': 1}]},
        'future': {'nested': []},
    }
    original = deepcopy(source)
    out = Outbox('client')
    returned = out.stamp(source)
    assert source == original  # No envelope insertion into input.
    source['context']['items'][1]['x'] = 9
    returned['context']['items'].append('changed')
    returned['future']['nested'].append(True)
    expected = {'v': 1, 'seq': 1, **original}
    replay = out.resend_from(0)
    assert replay == [expected]
    replay[0]['context']['items'][1]['x'] = 99
    replay.clear()
    assert out.resend_from(0) == [expected]
    transient = {'type': 'hello', 'tools': [], 'context': {'x': []}}
    unnumbered = out.stamp(transient)
    unnumbered['context']['x'].append(1)
    assert transient['context']['x'] == []
    assert out.pending == 1


@pytest.mark.parametrize(
    'message',
    [
        {'v': 1, 'type': 'text', 'text': ''},
        {'seq': 9, 'type': 'text', 'text': ''},
        {'v': 2, 'seq': 999, 'type': 'ping'},
        {'type': []},
        {'type': Decimal('sNaN')},
        {'type': 'missing'},
        {'type': 'text'},
        {'type': 'pong'},
        {'type': 'hello', 'tools': [], 'resumeFrom': True},
        {'type': 'context', 'context': float('nan')},
        None,
        [],
    ],
)
def test_bad_stamp_is_atomic(message):
    out = Outbox('client', limit=1)
    retained = out.stamp(text())
    with pytest.raises(ValueError):
        out.stamp(message)
    assert (out.last_seq, out.pending, out.resend_from(0)) == (1, 1, [retained])
    assert out.stamp(text('next'))['seq'] == 2


@pytest.mark.parametrize(
    'value', [True, False, -1, MAX_UINT32 + 1, 1.0, 1.5, Decimal(1), None, '1', []]
)
def test_invalid_ack_and_replay_parameters_are_atomic(value):
    out = Outbox('client')
    retained = out.stamp(text())
    for operation in [out.ack, out.resend_from]:
        with pytest.raises(ValueError):
            operation(value)
        assert (out.last_seq, out.pending, out.resend_from(0)) == (1, 1, [retained])


@pytest.mark.parametrize('value', [True, False, 0, -1, 1.5, '1', None])
def test_invalid_capacity(value):
    with pytest.raises(ValueError):
        Outbox('client', value)


@pytest.mark.parametrize('direction', ['receiver', '', None, True, []])
def test_invalid_sender_direction(direction):
    with pytest.raises(ValueError):
        Outbox(direction)
    with pytest.raises(ValueError):
        Inbox(direction)


def test_sessionless_error_requires_explicit_context():
    out = Outbox('server')
    error = {'type': 'error', 'code': 'FAILED', 'message': 'failed', 'recoverable': False}
    with pytest.raises(ValueError, match='explicit'):
        out.stamp(error)
    assert view(out) == (0, 0, [])
    assert out.stamp(error, sessionless=True) == {'v': 1, 'seq': 0, **error}
    assert view(out) == (0, 0, [])
    numbered = out.stamp(error, sessionless=False)
    assert numbered == {'v': 1, 'seq': 1, **error}
    assert out.resend_from(0) == [numbered]
    assert out.stamp(error, sessionless=True)['seq'] == 0
    assert out.last_seq == 1
    with pytest.raises(ValueError):
        Outbox('client').stamp(error, sessionless=True)


@pytest.mark.parametrize('context', [0, 1, 'yes', [], None])
def test_error_context_is_not_truthiness(context):
    out = Outbox('server')
    with pytest.raises(ValueError):
        out.stamp(
            {'type': 'error', 'code': 'FAILED', 'message': '', 'recoverable': True},
            sessionless=context,
        )
    assert view(out) == (0, 0, [])


@pytest.mark.parametrize('context', [True, False, 1])
def test_error_context_not_accepted_for_other_message_types(context):
    out = Outbox('client')
    with pytest.raises(ValueError):
        out.stamp(text(), sessionless=context)
    assert view(out) == (0, 0, [])


def test_sequence_exhaustion_and_transients_at_limit(monkeypatch):
    out = Outbox('client')
    # Private test fixture only: a consistent state with all earlier messages
    # removed. No production setter/restore API exists just to reach this bound.
    monkeypatch.setattr(out, '_last_seq', MAX_UINT32 - 1)
    monkeypatch.setattr(out, '_removed_through', MAX_UINT32 - 1)
    final = out.stamp(text('last'))
    assert final == client_message(MAX_UINT32, text='last')
    before = out.resend_from(MAX_UINT32 - 1)
    with pytest.raises(OverflowError):
        out.stamp(text('must not wrap'))
    assert out.last_seq == MAX_UINT32
    assert out.resend_from(MAX_UINT32 - 1) == before
    assert out.stamp({'type': 'ping'})['seq'] == 0
    out.ack(MAX_UINT32)
    with pytest.raises(OverflowError):
        out.stamp(text('still exhausted'))
    assert view(out) == (MAX_UINT32, 0, [])
    server = Outbox('server')
    monkeypatch.setattr(server, '_last_seq', MAX_UINT32)
    monkeypatch.setattr(server, '_removed_through', MAX_UINT32)
    assert (
        server.stamp(
            {'type': 'error', 'code': 'FAILED', 'message': '', 'recoverable': False},
            sessionless=True,
        )['seq']
        == 0
    )


def test_copy_failure_does_not_consume_sequence_or_evict(monkeypatch):
    out = Outbox('client', limit=1)
    retained = out.stamp(text())
    copy = sequence.deepcopy
    calls = 0

    def fail_second(value):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise MemoryError('simulated snapshot failure')
        return copy(value)

    with monkeypatch.context() as patch:
        patch.setattr(sequence, 'deepcopy', fail_second)
        with pytest.raises(MemoryError):
            out.stamp(text('not retained'))
    assert (out.last_seq, out.pending, out.resend_from(0)) == (1, 1, [retained])
    assert out.stamp(text('next'))['seq'] == 2


def test_inbox_independent_receive_trajectory_and_gap_behavior():
    incoming = Inbox('client')
    trajectory = [
        (1, True, 1),
        (1, False, 1),
        (3, True, 3),
        (2, False, 3),
        (3, False, 3),
        (4, True, 4),
    ]
    for seq, expected, cursor in trajectory:
        assert incoming.accept(client_message(seq)) is expected
        assert incoming.last_seq == cursor
        for transient in [
            {'v': 1, 'seq': 0, 'type': 'ping'},
            {'v': 1, 'seq': 0, 'type': 'ack', 'upTo': cursor},
        ]:
            assert incoming.accept(transient) is True
            assert incoming.last_seq == cursor


@pytest.mark.parametrize('seq', [True, False, -1, 0, MAX_UINT32 + 1, 1.5, None, '2'])
def test_invalid_inbox_message_does_not_advance(seq):
    incoming = Inbox('client')
    incoming.accept(client_message(1))
    with pytest.raises(ProtocolError):
        incoming.accept(client_message(seq))
    assert incoming.last_seq == 1


@pytest.mark.parametrize(
    'value',
    [
        None,
        [],
        {'v': 1, 'seq': 2, 'type': 'text'},
        {'v': 2, 'seq': 2, 'type': 'text', 'text': ''},
        {'v': 1, 'seq': 1, 'type': 'ping'},
    ],
)
def test_invalid_shape_and_transient_positive_seq_do_not_bypass_validation(value):
    incoming = Inbox('client')
    with pytest.raises(ProtocolError):
        incoming.accept(value)
    assert incoming.last_seq == 0


def test_inbox_normalizes_schema_integer_numbers_and_reaches_uint32_limit():
    incoming = Inbox('client')
    assert incoming.accept(client_message(Decimal('1.0')))
    assert type(incoming.last_seq) is int
    assert not incoming.accept(client_message(1.0))
    assert incoming.accept(client_message(MAX_UINT32))  # §4.3 handles a gap, no recovery.
    assert not incoming.accept(client_message(MAX_UINT32))
    assert incoming.last_seq == MAX_UINT32
    assert incoming.accept({'v': 1, 'seq': 0, 'type': 'ping'})
    assert incoming.last_seq == MAX_UINT32


def test_server_inbox_sessionless_error_does_not_advance_or_deduplicate():
    incoming = Inbox('server')
    error = {
        'v': 1,
        'seq': 0,
        'type': 'error',
        'code': 'FAILED',
        'message': '',
        'recoverable': True,
    }
    for _ in range(2):
        assert incoming.accept(error)
        assert incoming.last_seq == 0
    assert incoming.accept({**error, 'seq': 1})
    assert incoming.accept(error)
    assert incoming.last_seq == 1
    # Session binding is a future layer's job, not guessed from earlier ready/error.


def test_instances_are_independent_and_public_cursors_are_read_only():
    first, second = Outbox('client'), Outbox('client')
    first.stamp(text())
    assert view(second) == (0, 0, [])
    left, right = Inbox('client'), Inbox('client')
    left.accept(client_message(2))
    assert right.last_seq == 0
    for state in [first, left]:
        with pytest.raises(AttributeError):
            state.last_seq = 5
