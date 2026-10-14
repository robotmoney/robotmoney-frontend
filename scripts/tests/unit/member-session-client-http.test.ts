// Hermetic HTTP-boundary guards for the in-container swarm member client.
// A member must never turn an API failure into fabricated context or locally
// reconstructed signing bytes: non-2xx context reads are loud, and the exact
// canonical string returned by RM is the string handed to the signer.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ROUTES } from "@robotmoney/contract";
import {
  fetchSigningPayload,
  resolveRequireWeights,
  reportSnapshotIdFromBrief,
  restJson,
  submitTake,
} from "../../agent/member-session-client.ts";

const originalFetch = globalThis.fetch;
const originalApiUrl = process.env.RM_API_URL;

function mockFetch(fn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): void {
  globalThis.fetch = fn as typeof fetch;
}

beforeEach(() => {
  process.env.RM_API_URL = "http://member-api";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalApiUrl === undefined) delete process.env.RM_API_URL;
  else process.env.RM_API_URL = originalApiUrl;
});

describe("member-session REST reads fail loudly", () => {
  for (const route of [
    `${ROUTES.dashboards.regimeSnapshots}?range=1`,
    `${ROUTES.swarm.brief}?date=2026-07-30&subject=woon`,
    ROUTES.swarm.signingPayload,
  ]) {
    test(`${route} rejects a non-2xx JSON response`, async () => {
      mockFetch(async () => new Response(JSON.stringify({ error: "planted upstream failure" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }));
      await expect(restJson(route)).rejects.toThrow(
        `${route} failed with HTTP 503: planted upstream failure`,
      );
    });
  }

  test("token verification can explicitly observe a non-2xx response as invalid", async () => {
    mockFetch(async () => new Response(JSON.stringify({ error: "unknown member token" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    }));
    const result = await restJson(ROUTES.swarm.verifyToken, undefined, { allowStatuses: [401] });
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: "unknown member token" });
  });

  test("token verification still fails loudly on an unexpected server error", async () => {
    mockFetch(async () => new Response(JSON.stringify({ error: "database unavailable" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    }));
    await expect(
      restJson(ROUTES.swarm.verifyToken, undefined, { allowStatuses: [401] }),
    ).rejects.toThrow(/HTTP 503: database unavailable/);
  });
});

describe("fetchSigningPayload", () => {
  test("returns the API-provided canonical string byte-for-byte", async () => {
    const exact = 'swarm-submission-v1|{"body":"keeps trailing space "}\n';
    const draft = { memberId: "athena", stance: "constructive", confidence: 0.73 };
    mockFetch(async (input, init) => {
      expect(String(input)).toBe(`http://member-api${ROUTES.swarm.signingPayload}`);
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual({ "Content-Type": "application/json" });
      expect(init?.body).toBe(JSON.stringify(draft));
      return new Response(JSON.stringify({ canonical: exact }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    expect(await fetchSigningPayload(draft)).toBe(exact);
  });

  test("rejects a nominal 200 response without canonical bytes", async () => {
    mockFetch(async () => new Response(JSON.stringify({ canonical: null }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    await expect(fetchSigningPayload({ memberId: "athena" })).rejects.toThrow(
      /without a non-empty \.canonical string/,
    );
  });
});

// T17 / D4 — THE MEMBER CLIENT ALWAYS LEARNS THE ASK. A weightless take is now
// a 400 for a `bucket_weights` subject, so "the brief 404'd, therefore prose
// only" is no longer a survivable guess: it would render the member absent on
// every session whose brief this client outran. The subject endpoint is the
// second witness, and it exists long before any brief does.
describe("the allocation ask is resolved from the brief, and from the subject when there is no brief", () => {
  const briefRoute = (sessionId: string) => `${ROUTES.swarm.brief}?session=${encodeURIComponent(sessionId)}`;
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  test("the brief is the primary source", async () => {
    const seen: string[] = [];
    mockFetch(async (input) => {
      const url = String(input);
      seen.push(url);
      if (url.includes(briefRoute("s1").split("?")[0]!)) {
        return json(200, { body: { subject: { recommendationType: "bucket_weights" } } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    expect(await resolveRequireWeights("s1", "vault")).toBe(true);
    // The subject endpoint is NOT read when the brief already answered.
    expect(seen.some((u) => u.includes("/subjects/"))).toBe(false);
  });

  test("a 404 brief falls back to the subject rather than assuming prose only", async () => {
    mockFetch(async (input) => {
      const url = String(input);
      if (url.includes("/briefs") || url.includes(ROUTES.swarm.brief)) return json(404, { error: "no brief yet" });
      if (url.includes("/subjects/")) return json(200, { id: "vault", recommendationType: "bucket_weights" });
      throw new Error(`unexpected fetch: ${url}`);
    });
    expect(await resolveRequireWeights("s2", "vault")).toBe(true);
  });

  test("a position_actions subject still asks for prose only", async () => {
    mockFetch(async (input) => {
      const url = String(input);
      if (url.includes(ROUTES.swarm.brief)) return json(404, { error: "no brief yet" });
      if (url.includes("/subjects/")) return json(200, { id: "woon", recommendationType: "position_actions" });
      throw new Error(`unexpected fetch: ${url}`);
    });
    expect(await resolveRequireWeights("s3", "woon")).toBe(false);
  });

  test("an upstream FAILURE on either read is still loud — it is never read as \"no allocation asked for\"", async () => {
    mockFetch(async () => json(503, { error: "planted upstream failure" }));
    await expect(resolveRequireWeights("s4", "vault")).rejects.toThrow("HTTP 503");
  });
});

test("a member carries the brief's report binding into its signed draft", () => {
  expect(reportSnapshotIdFromBrief({ reportSnapshotId: "42" })).toBe("42");
  expect(reportSnapshotIdFromBrief({ reportSnapshotId: null })).toBeUndefined();
  expect(reportSnapshotIdFromBrief(undefined)).toBeUndefined();
});

test("the submit body names the session the take was authored from: sessionId equals RM_SESSION_ID (issue #1249)", async () => {
  const original = process.env.RM_SESSION_ID;
  process.env.RM_SESSION_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
  try {
    let sent: Record<string, unknown> | undefined;
    mockFetch(async (input, init) => {
      expect(String(input)).toBe(`http://member-api${ROUTES.swarm.submit}`);
      sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ ok: true, verified: true }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    });
    const draft = { memberId: "athena", subjectId: "woon", nonce: "n1" };
    const res = await submitTake("tok", draft, "sig");
    expect(res.status).toBe(201);
    expect(sent).toEqual({ ...draft, sessionId: "0f8fad5b-d9cb-469f-a165-70867728950e", signature: "sig" });
  } finally {
    if (original === undefined) delete process.env.RM_SESSION_ID;
    else process.env.RM_SESSION_ID = original;
  }
});
