import { describe, expect, test } from "bun:test";
import { canonicalizeSubmission } from "@robotmoney/contract";
import type { SwarmBrief } from "@robotmoney/contract";
import {
  canonicalizeDraftForTransport,
  deterministicAuthorTake,
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
      body: null,
      createdAt: "2026-07-21T00:00:00.000Z",
    };
    const first = await deterministicAuthorTake({ session, brief });
    const second = await deterministicAuthorTake({ session, brief });
    expect(first).toEqual(second);
    expect(first.body).toContain("replace deterministicAuthorTake with your model callback");
  });
});
