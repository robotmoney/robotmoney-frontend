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

    if (!payload.to || !payload.subject || !payload.text) {
      return new Response("Missing required fields", { status: 400 });
    }

    const inboxId = "swarm@notify.robotmoney.net";

    const agentMailEndpoint = "https://api.agentmail.to/v1/messages";
    const agentMailRes = await fetch(agentMailEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.AGENTMAIL_API_TOKEN}`,
      },
      body: JSON.stringify({
        inbox_id: inboxId,
        to: [payload.to],
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
