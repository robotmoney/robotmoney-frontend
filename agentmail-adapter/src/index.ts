export interface Env {
  ADAPTER_SECRET: string;
  AGENTMAIL_API_TOKEN: string;
}

// Minimal structural stand-in for Cloudflare Workers' `ExecutionContext`
// global. This module is typechecked by backend/tsconfig.json (bun-types, no
// Workers lib) via backend/tests/agentmail-adapter.test.ts, and the adapter's
// own node_modules is never installed in CI, so the global type is not
// available there. The adapter never uses the context; the structural type is
// assignment-compatible with the real one under `wrangler deploy`.
export interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Maps the `from` address of this repo's notification contract
// (SWARM_NOTIFICATION_EMAIL_FROM, see .env.example) to the AgentMail inbox_id
// that actually sends it, per docs/decisions.md D30: mail leaves from the
// dedicated delegated subdomain notify.robotmoney.net, never the live
// robotmoney.net root. A `from` with no entry here is a configuration error
// and MUST fail loudly (400, no send) — silently sending from a different
// inbox than the caller asked for is the failure mode this map exists to
// prevent.
const FROM_TO_INBOX_ID: Record<string, string> = {
  "swarm@robotmoney.net": "swarm@notify.robotmoney.net",
};

export default {
  async fetch(request: Request, env: Env, ctx: WorkerExecutionContext): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const authHeader = request.headers.get("Authorization");
    if (!authHeader || authHeader !== `Bearer ${env.ADAPTER_SECRET}`) {
      return new Response("Unauthorized", { status: 401 });
    }

    let payload: { from?: string; to?: string; subject?: string; text?: string };
    try {
      payload = await request.json();
    } catch {
      return new Response("Bad request", { status: 400 });
    }

    if (!payload.from || !payload.to || !payload.subject || !payload.text) {
      return new Response("Missing required fields", { status: 400 });
    }

    const inboxId = FROM_TO_INBOX_ID[payload.from];
    if (!inboxId) {
      return new Response(
        `Unknown from address ${JSON.stringify(payload.from)}: no AgentMail inbox_id mapping`,
        { status: 400 },
      );
    }

    // Documented send endpoint: POST /v0/inboxes/{inbox_id}/messages/send
    // with inbox_id as a PATH parameter and {to, subject, text} in the body
    // (https://docs.agentmail.to/api-reference/inboxes/messages/send).
    const agentMailEndpoint = `https://api.agentmail.to/v0/inboxes/${encodeURIComponent(inboxId)}/messages/send`;
    const agentMailRes = await fetch(agentMailEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.AGENTMAIL_API_TOKEN}`,
      },
      body: JSON.stringify({
        to: payload.to,
        subject: payload.subject,
        text: payload.text,
      }),
    });

    if (!agentMailRes.ok) {
      const err = await agentMailRes.text();
      return new Response(`AgentMail error: ${agentMailRes.status} ${err}`, { status: 502 });
    }

    return new Response("OK", { status: 200 });
  }
};
