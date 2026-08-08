import { afterEach, describe, expect, test, mock } from "bun:test";
import worker from "../../agentmail-adapter/src/index";

// Recorded fixture of AgentMail's documented 200 response for
// POST https://api.agentmail.to/v0/inboxes/{inbox_id}/messages/send
// (https://docs.agentmail.to/api-reference/inboxes/messages/send.md,
// fetched 2026-08-08). Both fields are documented as required strings; the
// values below are the docs' own example response verbatim.
const AGENTMAIL_SEND_200_FIXTURE = {
  message_id: "message_id",
  thread_id: "thread_id",
};

// The documented send endpoint takes inbox_id as a PATH parameter (URL-encoded),
// not a body field. docs/decisions.md D30 maps this repo's from address
// swarm@robotmoney.net to the AgentMail inbox swarm@notify.robotmoney.net on
// the delegated sending subdomain.
const DOCUMENTED_SEND_URL =
  "https://api.agentmail.to/v0/inboxes/swarm%40notify.robotmoney.net/messages/send";

const ENV = {
  ADAPTER_SECRET: "test-secret",
  AGENTMAIL_API_TOKEN: "unit-fake-tok",
};

const WORKER_CTX = { waitUntil() {}, passThroughOnException() {} };

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function contractRequest(body: Record<string, unknown>): Request {
  // This repo's existing transport contract, unchanged:
  // {from,to,subject,text} JSON + Bearer (backend/src/swarm/notifications.ts).
  return new Request("http://localhost", {
    method: "POST",
    headers: {
      "Authorization": "Bearer test-secret",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("AgentMail Adapter Worker", () => {
  test("maps from to the D30 inbox_id and calls the documented v0 send endpoint", async () => {
    let fetchCallArgs: { input: RequestInfo | URL; init?: RequestInit } | undefined;

    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCallArgs = { input, init };
      return new Response(JSON.stringify(AGENTMAIL_SEND_200_FIXTURE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const res = await worker.fetch(
      contractRequest({
        from: "swarm@robotmoney.net",
        to: "applicant@example.com",
        subject: "Test Subject",
        text: "Test Body",
      }),
      ENV,
      WORKER_CTX,
    );

    // 2xx so deploymentSwarmEmailTransport's response.ok check passes unchanged.
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);

    // The AgentMail call is the DOCUMENTED one: inbox_id as an encoded path
    // parameter on /v0/inboxes/{inbox_id}/messages/send, never a body field.
    expect(fetchCallArgs).toBeDefined();
    expect(fetchCallArgs!.input).toBe(DOCUMENTED_SEND_URL);
    expect(fetchCallArgs!.init!.method).toBe("POST");

    const headers = fetchCallArgs!.init!.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer unit-fake-tok");
    expect(headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(fetchCallArgs!.init!.body as string);
    expect(body).toEqual({
      to: "applicant@example.com",
      subject: "Test Subject",
      text: "Test Body",
    });
    expect(body.inbox_id).toBeUndefined();
  });

  test("a from address with no inbox_id mapping fails loudly and never reaches AgentMail", async () => {
    const agentMailFetch = mock(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = agentMailFetch as unknown as typeof fetch;

    const res = await worker.fetch(
      contractRequest({
        from: "noreply@robotmoney.net",
        to: "applicant@example.com",
        subject: "Test Subject",
        text: "Test Body",
      }),
      ENV,
      WORKER_CTX,
    );

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("noreply@robotmoney.net");
    // Silently sending from the wrong inbox is the failure mode under test:
    // the upstream API must not have been called at all.
    expect(agentMailFetch.mock.calls.length).toBe(0);
  });

  test("rejects unauthorized", async () => {
    const agentMailFetch = mock(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = agentMailFetch as unknown as typeof fetch;

    const req = new Request("http://localhost", {
      method: "POST",
      headers: {
        "Authorization": "Bearer wrong-secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "swarm@robotmoney.net",
        to: "applicant@example.com",
        subject: "Test Subject",
        text: "Test Body",
      }),
    });

    const res = await worker.fetch(req, ENV, WORKER_CTX);
    expect(res.status).toBe(401);
    expect(agentMailFetch.mock.calls.length).toBe(0);
  });
});
