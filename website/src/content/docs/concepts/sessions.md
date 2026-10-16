---
title: Sessions and connections
description: Handshake, reliable delivery, reconnects, heartbeats and capabilities.
sidebar:
  order: 4
---

A **session** is one conversation. It outlives connections: when the network drops, the client reconnects and resumes the same session, and both sides resend what the other missed, exactly once.

## Handshake

1. The client opens a WebSocket and sends `hello`: its tools, preferred audio formats, optional application context and an optional credential.
2. The server authenticates it, starts the session and answers `ready`: the session id and the audio formats it chose.

From then on, control messages are JSON text frames and audio travels in binary frames, never base64.

## Reliable delivery

Control messages are numbered per direction (`seq`). Each side acknowledges what it has handled (`ack`) and keeps what is not acknowledged yet. Messages that only concern the current connection, such as the handshake, heartbeats and acknowledgements, are not numbered and never resent.

## Reconnects

The client keeps the session id and the last server message it handled. After a dropped connection it reconnects with backoff and sends `hello` with that session id and position:

- the server answers `ready` with the last client message *it* handled, then resends what the client missed;
- the client resends what the server missed;
- duplicates are discarded by sequence number, so every message takes effect once.

A session waits for a resume for a while (30 seconds by default) after its last connection closes. If a resume is no longer possible, the server answers `RESUME_FAILED` and the client stops; it never replays old messages into a new session.

Audio is never resent: audio that was in flight during a drop is lost, and the agent's next audio starts a new item.

## Heartbeats

The client pings every 15 seconds and treats a silent connection as dead after 2.5 intervals. The server closes a connection that sent nothing for 45 seconds. Both are configurable.

## Authentication and context

Credentials go in `hello`, never in the URL. The server authenticates every handshake, including resumes, and only the principal that opened a session can resume it. See [Authentication](/guides/authentication/).

Application context, such as the document that is open, travels in `hello` and later in `context` messages. It is data for your server code, never instructions to the model.

## Capabilities

Optional protocol features are negotiated: the client lists the ones it supports in `hello`, and the server answers with the ones in effect for the session, which stay fixed for its lifetime. Every standard capability is registered in the specification. See [protocol §3](/reference/protocol/#3-versioning-and-capabilities).
