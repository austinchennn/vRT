"""Per-direction in-memory control-stream state (spec §§4.1–4.3, 5.4)."""

from collections import OrderedDict
from copy import deepcopy

from .protocol import (
    MAX_UINT32,
    PROTOCOL_VERSION,
    TRANSIENT_MESSAGE_TYPES,
    Direction,
    validate_message,
)

# Local message-count policy, not a negotiated protocol value or byte limit.
DEFAULT_REPLAY_LIMIT = 1024


def _uint32(value: int) -> None:
    if type(value) is not int or not 0 <= value <= MAX_UINT32:
        raise ValueError('Expected a uint32 Python int (not bool)')


def _direction(value: Direction) -> None:
    if type(value) is not str or value not in ('client', 'server'):
        raise ValueError('direction must identify the sender: client or server')


class Outbox:
    """Assign envelopes and retain owned snapshots until ACK or bounded eviction.

    Reuse this object across connections of the same session. No transport,
    session lifecycle, durable storage or synchronization is provided.
    """

    def __init__(self, direction: Direction, limit: int = DEFAULT_REPLAY_LIMIT) -> None:
        _direction(direction)
        if type(limit) is not int or limit < 1:
            raise ValueError('limit must be a positive Python int')
        self._direction = direction
        self._limit = limit
        self._last_seq = 0
        self._removed_through = 0
        self._pending: OrderedDict[int, dict] = OrderedDict()

    @property
    def last_seq(self) -> int:
        return self._last_seq

    @property
    def pending(self) -> int:
        return len(self._pending)

    def stamp(self, message: dict, *, sessionless: bool | None = None) -> dict:
        """Validate, snapshot and number; commit state only after copies succeed.

        v/seq must be absent. For error messages only, explicitly pass
        sessionless=True (seq 0) or False (numbered). No wire error is invented
        for caller mistakes or exhaustion (ValueError / OverflowError).
        """
        if type(message) is not dict or 'v' in message or 'seq' in message:
            raise ValueError('Expected an unsequenced dict without v or seq')
        kind = message.get('type')
        if type(kind) is str and kind == 'error':
            if type(sessionless) is not bool:
                raise ValueError('error requires explicit sessionless=True or False')
        elif sessionless is not None:
            raise ValueError('sessionless is only applicable to error messages')
        # Reject non-string types through the existing codec, not set membership.
        transient = type(kind) is str and kind in TRANSIENT_MESSAGE_TYPES
        numbered = not transient and sessionless is not True
        seq = self._last_seq + 1 if numbered else 0
        if seq > MAX_UINT32:
            raise OverflowError('Control seq exhausted; open a new session (§4.1)')
        candidate = {'v': PROTOCOL_VERSION, 'seq': seq, **message}
        result = validate_message(candidate, self._direction)
        if result.error is not None:
            raise result.error
        full = deepcopy(candidate)
        if numbered:
            snapshot = deepcopy(full)
            self._pending[seq] = snapshot
            self._last_seq = seq
            if len(self._pending) > self._limit:
                self._removed_through = self._pending.popitem(last=False)[0]
        return full

    def ack(self, up_to: int) -> None:
        """Discard retained seq <= up_to. Receipt is not tool completion (§4.2).

        A uint32 ACK beyond last_seq clears only currently sent messages; no
        future ACK credit is stored. Malformed local parameters raise ValueError.
        """
        _uint32(up_to)
        while self._pending and next(iter(self._pending)) <= up_to:
            self._removed_through = self._pending.popitem(last=False)[0]

    def resend_from(self, last_seen: int) -> list[dict] | None:
        """Owned ordered copies, [] if current, None if a complete replay is lost.

        Acknowledged data removed from memory matters just like evicted data.
        Invalid Python cursors raise ValueError; unavailable valid cursors return
        None for the future session layer to translate into resume failure.
        """
        _uint32(last_seen)
        if not self._removed_through <= last_seen <= self._last_seq:
            return None
        return [deepcopy(message) for seq, message in self._pending.items() if seq > last_seen]


class Inbox:
    """Validate and accept into the receive cursor, not into application effects.

    Gaps advance the cursor per §4.3; no gap recovery is specified. Retain this
    object over reconnects. Callers still own dispatch, ACK scheduling and tools.
    """

    def __init__(self, direction: Direction) -> None:
        _direction(direction)
        self._direction = direction
        self._last_seq = 0

    @property
    def last_seq(self) -> int:
        return self._last_seq

    def accept(self, message: dict) -> bool:
        """True for seq 0 or a new valid message; False for sequenced duplicates.

        Structural failures raise the existing ProtocolError without advancing
        state. Integral JSON numbers accepted by the codec normalize to int here.
        """
        result = validate_message(message, self._direction)
        if result.error is not None:
            raise result.error
        seq = int(message['seq'])
        if seq == 0:
            return True
        if seq <= self._last_seq:
            return False
        self._last_seq = seq
        return True
