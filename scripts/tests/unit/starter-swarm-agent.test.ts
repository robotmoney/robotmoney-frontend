import { afterEach, describe, expect, test } from "bun:test";
import { canonicalizeSubmission, RECEIPT_CANONICAL_BUCKET_ORDER, ROUTES } from "@robotmoney/contract";
import type { SwarmBrief } from "@robotmoney/contract";
import {
  briefRequiresWeights,
  collectingSessionFor,
  e2eSubject,
  canonicalizeDraftForTransport,
  deterministicAuthorTake,
  evenCanonicalWeights,
  runStarterSwarmAgent,
  signDraft,
  type StarterSession,
  type SubmissionDraft,
} from "../../starter-swarm-agent.ts";

const draft: SubmissionDraft = {
  memberId: "starter-test",
  date: "2026-07-21",
  subjectId: "starter-agent",
  nonce: "fixed-test-nonce",
  stance: "neutral",
  confidence: 0.5,
  body: "A deterministic test take.",
  memoUrl: "/api/swarm/memos/42",
};

describe("starter swarm agent canonical signing", () => {
  test("REST submission uses @robotmoney/contract canonicalization (the only transport, D21)", () => {
    const expected = canonicalizeSubmission(draft);
    expect(canonicalizeDraftForTransport("rest", draft)).toBe(expected);
  });

  test("Web Crypto signature verifies independently and rejects a tampered field", async () => {
    const keys = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
    const { canonical, signature } = await signDraft("rest", draft, keys.privateKey);
    const signatureBytes = Buffer.from(signature, "base64");
    const encoder = new TextEncoder();

    expect(
      await crypto.subtle.verify("Ed25519", keys.publicKey, signatureBytes, encoder.encode(canonical)),
    ).toBe(true);

    const tampered = canonicalizeSubmission({ ...draft, confidence: 0.9 });
    expect(
      await crypto.subtle.verify("Ed25519", keys.publicKey, signatureBytes, encoder.encode(tampered)),
    ).toBe(false);
  });

  test("default authoring callback is typed, deterministic, and model-free", async () => {
    const session = {
      id: "7",
      date: "2026-07-21",
      subjectId: "starter-agent",
      subjectName: "Starter Agent Exercise",
    } as StarterSession;
    const brief: SwarmBrief = {
      id: "11",
      date: session.date,
      subjectId: session.subjectId,
      // A brief belongs to the session that published it (migration 0028), and
      // this fixture models a LIVE brief — so it carries the session's own id
      // rather than the null reserved for pre-0028 archived rows. Stringified
      // because StarterSession deliberately widens `id` to `string | number`
      // (it tolerates a loose client's numeric id) while the brief's
      // `sessionId` is the contract's `string | null`.
      sessionId: String(session.id),
      reportSnapshotId: null,
      body: null,
      createdAt: "2026-07-21T00:00:00.000Z",
    };
    const first = await deterministicAuthorTake({ session, brief });
    const second = await deterministicAuthorTake({ session, brief });
    expect(first).toEqual(second);
    expect(first.body).toContain("replace deterministicAuthorTake with your model callback");
  });

  // T17 / D4 — THE API CLIENT NOW CARRIES THE VECTOR. A weightless take on a
  // `bucket_weights` session is a 400 (`weights_required_for_bucket_weights_subject`),
  // and before that refusal existed it was a 201 that permanently blocked the
  // session's consensus receipt. The starter is the reference member client, so
  // it has to demonstrate the correct shape, not merely avoid the failure.
  test("a bucket_weights brief makes the default callback author the canonical four", async () => {
    const session = { id: "9", date: "2026-07-21", subjectId: "vault" } as StarterSession;
    const allocationBrief = {
      id: "12", date: session.date, subjectId: session.subjectId, sessionId: "9",
      createdAt: "2026-07-21T00:00:00.000Z",
      body: {
        subject: { recommendationType: "bucket_weights" },
        takeSchema: { weights: { optional: false, buckets: [...RECEIPT_CANONICAL_BUCKET_ORDER] } },
      },
    } as unknown as SwarmBrief;
    const proseBrief = {
      ...allocationBrief,
      body: {
        subject: { recommendationType: "position_actions" },
        takeSchema: { weights: { optional: true, buckets: [...RECEIPT_CANONICAL_BUCKET_ORDER] } },
      },
    } as unknown as SwarmBrief;

    expect(briefRequiresWeights(allocationBrief)).toBe(true);
    expect(briefRequiresWeights(proseBrief)).toBe(false);

    const authored = await deterministicAuthorTake({ session, brief: allocationBrief });
    expect(authored.weights?.map((w) => w.bucket)).toEqual([...RECEIPT_CANONICAL_BUCKET_ORDER]);
    expect(authored.weights!.reduce((sum, w) => sum + w.weight, 0)).toBeCloseTo(1, 12);
    // …and a prose session is untouched: no vector is invented for it.
    expect((await deterministicAuthorTake({ session, brief: proseBrief })).weights).toBeUndefined();

    // The vector reaches the SIGNED BYTES, which is the half that matters: the
    // server verifies the signature over a payload that includes `weights`.
    const signed = canonicalizeSubmission({ ...draft, weights: evenCanonicalWeights() });
    expect(signed).toContain("agent_tokens");
  });
});

// ── Issue #978 AC6 regression: the starter agent must carry the brief's
// report binding (the exact defect CI hit) ───────────────────────────────────
//
// #978 taught the SERVER to refuse any take whose `reportSnapshotId` does not
// equal the one its session's brief is bound to (backend/src/swarm/domain.ts),
// and taught the in-container member client to send it
// (scripts/agent/member-session-client.ts). The repo-native starter agent was
// never taught, so its submission omitted the field entirely and the live
// stack's last smoke step died with
//
//   submit REST recommendation failed with HTTP 409:
//   {"ok":false,...,"error":"reportSnapshotId does not match this session's
//    brief (expected 8)"}
//
// The fake backend below enforces the SAME rule as the real one — bound brief
// ⇒ the submission must name that id — so this test reproduces that failure
// against the real runStarterSwarmAgent code path, with no database, no
// container, and no live smoke.
const BOUND_REPORT_SNAPSHOT_ID = "8";

interface FakeBackendCall {
  submitted?: Record<string, unknown>;
  briefUrls: string[];
}

function fakeLiveStack(
  boundReportSnapshotId: string | null,
): { fetch: typeof fetch; calls: FakeBackendCall } {
  const calls: FakeBackendCall = { briefUrls: [] };
  const session = {
    id: 12,
    date: "2026-09-16",
    subjectId: "starter-agent",
    subjectName: "Starter Agent Exercise",
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const p = url.pathname;
    const method = (init?.method ?? "GET").toUpperCase();

    if (method === "GET" && p === ROUTES.swarm.openSession) return json(session);

    if (method === "GET" && p === ROUTES.swarm.brief) {
      calls.briefUrls.push(`${url.pathname}${url.search}`);
      // The real route serves `?session=` and `?date=&subject=` alike; both
      // resolve to this one session here, and both carry its binding.
      return json({
        id: "31",
        date: session.date,
        subjectId: session.subjectId,
        sessionId: String(session.id),
        reportSnapshotId: boundReportSnapshotId,
        body: null,
        createdAt: "2026-09-16T00:00:00.000Z",
      });
    }

    if (method === "POST" && p === ROUTES.swarm.memos) {
      return json({ ok: true, url: "/api/swarm/memos/77" });
    }

    if (method === "POST" && p === ROUTES.swarm.submit) {
      const submitted = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.submitted = submitted;
      // Verbatim transcription of backend/src/swarm/domain.ts's binding gate.
      if (boundReportSnapshotId !== null && submitted.reportSnapshotId !== boundReportSnapshotId) {
        return json({
          ok: false,
          status: 409,
          error: `reportSnapshotId does not match this session's brief (expected ${boundReportSnapshotId})`,
        }, 409);
      }
      return json({ ok: true, verified: true });
    }

    if (method === "GET" && p.startsWith("/api/swarm/sessions/")) {
      return json({ takes: [{ id: "take-1", memberId: "starter-rest", verified: true }] });
    }

    return json({ error: `unexpected ${method} ${p}` }, 404);
  };
  return { fetch: impl as typeof fetch, calls };
}

describe("starter swarm agent honours a brief's report-snapshot binding (issue #978 AC6)", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  async function runAgainst(bound: string | null) {
    const stack = fakeLiveStack(bound);
    globalThis.fetch = stack.fetch;
    const keys = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
    const result = await runStarterSwarmAgent({
      memberId: "starter-rest",
      memberToken: "starter-token",
      privateKey: keys.privateKey,
      transport: "rest",
      backendUrl: "http://backend.test",
    });
    return { result, calls: stack.calls };
  }

  test("a bound brief's reportSnapshotId reaches the submission (no HTTP 409)", async () => {
    const { result, calls } = await runAgainst(BOUND_REPORT_SNAPSHOT_ID);
    expect(calls.submitted?.reportSnapshotId).toBe(BOUND_REPORT_SNAPSHOT_ID);
    expect(result.take.verified).toBe(true);
  });

  test("the bound id is inside the SIGNED canonical bytes, not merely the envelope", async () => {
    const { result } = await runAgainst(BOUND_REPORT_SNAPSHOT_ID);
    expect(result.draft.reportSnapshotId).toBe(BOUND_REPORT_SNAPSHOT_ID);
    expect(result.canonical).toBe(canonicalizeSubmission(result.draft));
    expect(result.canonical).toContain(BOUND_REPORT_SNAPSHOT_ID);
  });

  test("an UNBOUND brief (report_snapshot_id NULL) still submits schema-1.0, field omitted", async () => {
    const { result, calls } = await runAgainst(null);
    expect("reportSnapshotId" in (calls.submitted ?? {})).toBe(false);
    expect(result.take.verified).toBe(true);
  });

  test("the brief is read for THIS session id, not merely its date and subject", async () => {
    const { calls } = await runAgainst(BOUND_REPORT_SNAPSHOT_ID);
    expect(calls.briefUrls.some((u) => u.includes("session=12"))).toBe(true);
  });
});

// ── The scheduler-owned lifecycle: the e2e exercise must be seated ───────────
//
// CI's last run died with `HTTP 403: member is not on this session's expected
// roster`. The exercise found the swarm-session step's collecting epoch (its
// roster already frozen), registered afterwards, and signed into that epoch.
// It now registers first, creates its OWN subject, and takes part in the epoch
// the scheduler opens for that subject only.
describe("starter swarm agent e2e is seated in its own scheduler-opened epoch", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("collectingSessionFor asks for the subject's own collecting epoch and ignores others", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ sessions: [
        { id: "1", date: "2026-09-30", subjectId: "other", state: "collecting" },
        { id: "2", date: "2026-09-30", subjectId: "starter-agent-ab", state: "window_closed" },
        { id: "3", date: "2026-09-30", subjectId: "starter-agent-ab", state: "collecting" },
      ] }), { status: 200 });
    }) as typeof fetch;
    const found = await collectingSessionFor("http://backend.test", "starter-agent-ab");
    expect(String(found?.id)).toBe("3");
    expect(urls[0]).toContain("state=collecting");
    expect(urls[0]).toContain("subject=starter-agent-ab");
  });

  test("with a subjectId the agent joins that subject's session, not the newest open one", async () => {
    const seen: string[] = [];
    const stack = fakeLiveStack(null);
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      seen.push(url.pathname);
      if (url.pathname === ROUTES.swarm.sessions) {
        return new Response(JSON.stringify({ sessions: [
          { id: 12, date: "2026-09-16", subjectId: "starter-agent", subjectName: "S", state: "collecting" },
        ] }), { status: 200 });
      }
      return stack.fetch(input, init);
    }) as typeof fetch;
    const keys = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
    await runStarterSwarmAgent({
      memberId: "starter-rest", memberToken: "t", privateKey: keys.privateKey,
      transport: "rest", backendUrl: "http://backend.test", subjectId: "starter-agent",
    });
    expect(seen).toContain(ROUTES.swarm.sessions);
    expect(seen).not.toContain(ROUTES.swarm.openSession);
  });

  test("e2e subjects are unique per run, so a frozen roster is never reused", () => {
    expect(e2eSubject("aaaa").id).not.toBe(e2eSubject("bbbb").id);
  });

  test("main registers the member BEFORE it creates the subject the scheduler opens", async () => {
    const src = await Bun.file(new URL("../../starter-swarm-agent.ts", import.meta.url)).text();
    const main = src.slice(src.indexOf("async function main()"));
    expect(main.indexOf("await e2eCredentials(")).toBeGreaterThan(0);
    expect(main.indexOf("await e2eCredentials(")).toBeLessThan(main.indexOf("await openE2eEpoch("));
  });
});
