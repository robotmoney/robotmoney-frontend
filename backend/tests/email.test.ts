import { expect, test } from "bun:test";
import { sendCommitteeActivationEmail } from "../src/lib/email.ts";

test("activation email uses an idempotency key and links to member-controlled claim", async () => {
  let request: { url: string; init?: RequestInit } | null = null;
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    request = { url: String(url), init };
    return Response.json({ id: "email_123" });
  }) as typeof fetch;
  const result = await sendCommitteeActivationEmail({
    memberId: "athena",
    name: "Athena <Lab>",
    recipient: "ops@example.com",
    statusUrl: "/committee/apply/athena",
  }, {
    RESEND_API_KEY: "secret",
    COMMITTEE_EMAIL_FROM: "Robot Money <committee@robotmoney.net>",
    PUBLIC_SITE_ORIGIN: "https://staging.robotmoney.net",
  }, fetcher);

  expect(result).toEqual({ ok: true, sent: true, id: "email_123" });
  expect(request!.url).toBe("https://api.resend.com/emails");
  expect(new Headers(request!.init?.headers).get("Idempotency-Key")).toBe("committee-activation-athena");
  const body = JSON.parse(String(request!.init?.body));
  expect(body.html).toContain("https://staging.robotmoney.net/committee/apply/athena");
  expect(body.html).toContain("Athena &lt;Lab&gt;");
  expect(body.html).not.toContain("secret");
});

test("activation email is a clean no-op when delivery is unconfigured", async () => {
  let called = false;
  const fetcher = (async () => { called = true; return Response.json({}); }) as typeof fetch;
  const result = await sendCommitteeActivationEmail({
    memberId: "athena", name: "Athena", recipient: "ops@example.com", statusUrl: "/committee/apply/athena",
  }, {}, fetcher);
  expect(result).toEqual({ ok: true, skipped: true, reason: "activation email is not configured" });
  expect(called).toBe(false);
});
