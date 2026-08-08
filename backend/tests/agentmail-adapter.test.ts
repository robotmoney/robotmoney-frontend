import { describe, expect, test, mock } from "bun:test";
import worker from "../../agentmail-adapter/src/index";

describe("AgentMail Adapter Worker", () => {
  test("successful send", async () => {
    const env = {
      ADAPTER_SECRET: "test-secret",
      AGENTMAIL_API_TOKEN: "unit-fake-tok",
    };

    let fetchCallArgs: any;

    // Mock global fetch to capture the request to AgentMail
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCallArgs = { input, init };
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as any;

    try {
      const req = new Request("http://localhost", {
        method: "POST",
        headers: {
          "Authorization": "Bearer test-secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "noreply@robotmoney.net",
          to: "applicant@example.com",
          subject: "Test Subject",
          text: "Test Body",
        }),
      });

      const res = await worker.fetch(req, env as any, {} as any);
      
      expect(res.status).toBe(200);

      // Verify the AgentMail API call
      expect(fetchCallArgs).toBeDefined();
      expect(fetchCallArgs.input).toBe("https://api.agentmail.to/v1/messages");
      expect(fetchCallArgs.init.method).toBe("POST");
      expect(fetchCallArgs.init.headers["Authorization"]).toBe("Bearer unit-fake-tok");

      const body = JSON.parse(fetchCallArgs.init.body);
      expect(body.inbox_id).toBe("swarm@notify.robotmoney.net");
      expect(body.to).toEqual(["applicant@example.com"]);
      expect(body.subject).toBe("Test Subject");
      expect(body.text).toBe("Test Body");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects unauthorized", async () => {
    const env = {
      ADAPTER_SECRET: "test-secret",
      AGENTMAIL_API_TOKEN: "unit-fake-tok",
    };

    const req = new Request("http://localhost", {
      method: "POST",
      headers: {
        "Authorization": "Bearer wrong-secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "noreply@robotmoney.net",
        to: "applicant@example.com",
        subject: "Test Subject",
        text: "Test Body",
      }),
    });

    const res = await worker.fetch(req, env as any, {} as any);
    expect(res.status).toBe(401);
  });
});
