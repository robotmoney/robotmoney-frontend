// Hermetic HTTP-boundary guards for the in-container swarm member client.
// A member must never turn an API failure into fabricated context or locally
// reconstructed signing bytes: non-2xx context reads are loud, and the exact
// canonical string returned by RM is the string handed to the signer.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ROUTES } from "@robotmoney/contract";
import {
  fetchSigningPayload,
  restJson,
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
