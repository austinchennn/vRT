---
title: Authentication
description: Send credentials in the first message, authenticate every connection, and configure sessions per user.
sidebar:
  order: 6
---

Credentials travel in the first message, `hello`, and never in the connection URL, where proxies and logs would record them.

## Client

```js
connect(url, {
  auth: () => fetch('/api/voice-token').then((r) => r.text()), // called on every connect and reconnect
  context: { docId },
});
```

`auth` is a string or a function. A function is called again on each reconnect, so short-lived tokens rotate. If it throws, the connection fails with `AUTH_FAILED`. After `UNAUTHORIZED` from the server, a client with a fixed token stops reconnecting; one with a token function tries again with a fresh token.

## Server

```js
serve(agent, {
  authenticate: async ({ token, context, sessionId, headers }) => {
    const user = await verifyToken(token);       // your own verification
    if (!user || !(await user.canEdit(context.docId))) return undefined;
    return { id: user.id, docId: context.docId };
  },
  configure: (principal, { context }) => ({
    instructions: `You edit the document ${principal.docId} for ${principal.id}.`,
  }),
});
```

- `authenticate` runs for **every** `hello`, new or resuming. Return a principal (an object with an `id`) to accept the connection. Return nothing, `false`, or throw to refuse it: the client receives `UNAUTHORIZED` and the connection closes with code 4401. Without `authenticate`, every connection is accepted.
- `configure` returns a partial session config for new sessions, from the principal and `hello.context`: instructions, voice, turn detection, a recognition vocabulary.
- `headers` are those of the upgrade request, when the runtime has them, for cookies or the origin.

## Using the principal

The principal reaches your code wherever decisions are made:

```js
const exportDocument = tool({
  description: 'Export the open document as PDF.',
  parameters: { type: 'object' },
  risk: 'medium',
  run: async (_args, { data: principal }) => exporter.exportFor(principal.id, principal.docId),
});

hooks: {
  beforeToolCall: (call) => (call.data.readOnly && call.name !== 'read_document' ? { action: 'reject', message: 'Read-only access.' } : undefined),
}
```

## Resuming

A session belongs to the principal that opened it. A resume by any other principal fails exactly like a resume of an unknown session (`RESUME_FAILED`), so the answer never reveals whether a session exists.
