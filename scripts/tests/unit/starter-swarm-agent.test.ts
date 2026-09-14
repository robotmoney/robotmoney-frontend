import { describe, expect, test } from "bun:test";
import { canonicalizeSubmission, RECEIPT_CANONICAL_BUCKET_ORDER } from "@robotmoney/contract";
import type { SwarmBrief } from "@robotmoney/contract";
import {
  briefRequiresWeights,
  canonicalizeDraftForTransport,
  deterministicAuthorTake,
  evenCanonicalWeights,
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
