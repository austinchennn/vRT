import { DurableObject } from 'cloudflare:workers';
import { defineAgent } from '@vrealtime/core';
import { boson, fetchSocket } from '@vrealtime/boson';
import { upgrade } from '@vrealtime/server/workers';

/** One object per document: sessions live in its memory, so reconnects to the same document resume. */
export class AgentObject extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.agent = defineAgent({
      // Workers' WebSocket cannot send auth headers; fetchSocket() upgrades through fetch() instead.
      model: boson({ apiKey: env.BOSON_API_KEY, socket: fetchSocket(), ...(env.BOSON_URL ? { url: env.BOSON_URL } : {}) }),
      instructions: 'You edit documents. When asked to change colors, call set_accent_color.',
      clientTools: 'accept',
    });
    this.options = {
      // Replace with real token verification (e.g. a signed, short-lived JWT scoped to the document).
      authenticate: ({ token, context }) => (token && token === env.DEMO_TOKEN ? { id: 'demo-user', docId: context?.docId } : undefined),
      configure: (principal) => ({ instructions: `You edit document ${principal?.docId ?? 'unknown'}. When asked to change colors, call set_accent_color.` }),
    };
  }

  fetch(request) {
    return upgrade(this.agent, request, this.options);
  }
}

export default {
  fetch(request, env) {
    const doc = new URL(request.url).searchParams.get('doc') ?? 'default';
    return env.AGENT.get(env.AGENT.idFromName(doc)).fetch(request);
  },
};
