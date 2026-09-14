import { expect, test } from "bun:test";
import { RECEIPT_DOMAIN_SEPARATOR } from "@robotmoney/contract";
import { waitForVerifiedFusionReceipt, type ReceiptFetcher } from "../scripts/upgrades/0.4.0-to-0.5.0/stage-rehearsal.ts";

// THE REHEARSAL NOW POLLS TWO ROUTES (decision D10): the read-time envelope at
// `/consensus-receipt/verified`, and the ANCHORED `/consensus-receipt`, which
// serves the bare canonical JSON — the keccak256 preimage minus its pinned
// domain prefix. The gate has to check both together, because an envelope that
// says `verified: true` while the anchored URL serves something else is exactly
// the state phase3/3.1-FINDING-… found a green rehearsal sitting on.
const BARE = '{"schema_version":"1.0"}\n';
const CANONICAL = RECEIPT_DOMAIN_SEPARATOR + BARE;

/** A double for that pair. `anchored: null` makes the anchored route 404. */
const routes = (envelope: Record<string, unknown>, anchored: string | null = BARE): ReceiptFetcher =>
  async (url) => {
    if (String(url).endsWith("/verified")) return Response.json(envelope);
    return anchored === null ? Response.json({ error: "none" }, { status: 404 }) : new Response(anchored);
  };

test("stage rehearsal waits for and verifies an enforce-mode model receipt", async () => {
  let reads = 0;
  const result = await waitForVerifiedFusionReceipt({
    backendUrl: "http://stage.invalid",
    pollMs: 1,
    timeoutMs: 100,
    latest: async () => ++reads < 2 ? null : { sessionId: "session-1", source: "model", mode: "enforce" },
    fetcher: async (url) => {
      expect(String(url)).toContain("/api/swarm/sessions/session-1/consensus-receipt");
      return String(url).endsWith("/verified")
        ? Response.json({ verified: true, canonicalBytes: CANONICAL, signatures: [{ verified: true }] })
        : new Response(BARE);
    },
  });
  expect(result.source).toBe("model");
});

test("stage rehearsal accepts explicit deterministic fallback provenance", async () => {
  const result = await waitForVerifiedFusionReceipt({
    backendUrl: "http://stage.invalid",
    latest: async () => ({ sessionId: "session-fallback", source: "fallback", mode: "enforce" }),
    fetcher: routes({ verified: true, canonicalBytes: CANONICAL, signatures: [{ verified: true }] }),
  });
  expect(result.source).toBe("fallback");
});

test("stage rehearsal refuses a shadow-mode receipt", async () => {
  await expect(waitForVerifiedFusionReceipt({
    backendUrl: "http://stage.invalid",
    latest: async () => ({ sessionId: "shadow", source: "model", mode: "shadow" }),
    fetcher: routes({ verified: true, canonicalBytes: CANONICAL, signatures: [{}] }),
  })).rejects.toThrow(/expected enforce/);
});

// EACH FACT ON ITS OWN TERMS. The first cut of this case falsified `verified`,
// `canonicalBytes` and `signatures` together and asserted only that the poll
// timed out — so a bug that ignored the `verified` flag entirely would still
// have passed, and the timeout message could not say which fact was missing.
// Now the poll reports them apart, and each is driven alone.
test("stage rehearsal never returns a receipt that is not verified/complete, and says which", async () => {
  const verified = { verified: true, canonicalBytes: CANONICAL, signatures: [{ verified: true }] };
  const cases: [string, Record<string, unknown>, string | null][] = [
    ["not verified", { ...verified, verified: false }, BARE],
    ["no canonical bytes", { ...verified, canonicalBytes: "" }, BARE],
    ["no signatures", { ...verified, signatures: [] }, BARE],
    // D10's own failure mode, which every other case above would miss: the
    // envelope is perfect and the ANCHORED url serves other bytes, so the
    // digest a release would anchor is not the digest of what that URL returns.
    ["anchored URL does not serve the anchored bytes", verified, '{"schema_version":"1.0","drifted":true}\n'],
    // And the anchored route simply missing — a 404 there is not a slow publish.
    ["anchored URL returned 404", verified, null],
  ];
  for (const [missing, body, anchored] of cases) {
    let thrown: unknown;
    try {
      await waitForVerifiedFusionReceipt({
        backendUrl: "http://stage.invalid",
        timeoutMs: 5,
        pollMs: 1,
        latest: async () => ({ sessionId: "bad", source: "fallback", mode: "enforce" }),
        fetcher: routes(body, anchored),
      });
    } catch (err) { thrown = err; }
    const message = String((thrown as Error)?.message ?? "");
    // It never RETURNED — the receipt was refused, not accepted late.
    expect(message, missing).toContain("timed out");
    // …and the poll's own classification names the missing fact, so a bug that
    // ignored one of the five is distinguishable from a slow publish.
    expect(message, missing).toContain("was not verified/complete");
    expect(message, missing).toContain(missing);
  }
});

test("stage rehearsal refuses a receipt whose fallback is a CREDIT/CREDENTIAL refusal", async () => {
  // checklist §4.1: an exhausted account's template prose is signed, complete
  // and byte-stable — and is not evidence. It must not pass the staging gate as
  // a legitimate AC-FE-05 fallback. judge.ts fails closed on these now, so this
  // is the belt to that braces: a database with history cannot hand the gate one.
  for (const reason of ["credit_exhausted", "credential_rejected", "credential_unconfigured", "model_unconfigured", "model_not_supported"]) {
    await expect(waitForVerifiedFusionReceipt({
      backendUrl: "http://stage.invalid",
      timeoutMs: 50,
      pollMs: 1,
      latest: async () => ({ sessionId: "poisoned", source: "fallback", mode: "enforce", fallbackReason: reason }),
      fetcher: routes({ verified: true, canonicalBytes: CANONICAL, signatures: [{ verified: true }] }),
    })).rejects.toThrow(/not a survivable model failure/);
  }

  // THE CONTROL: a survivable runtime failure is still accepted, reason and all
  // — otherwise this refusal would have quietly repealed AC-FE-05.
  //
  // The control used to be `model_timeout`, which decision D15 moved onto the
  // disqualifying list for this gate: a timeout is a BUDGET misconfiguration
  // masquerading as an outage (the 60 s default against a model measured at
  // 58-175 s), and a receipt no model contributed to cannot be the evidence the
  // RC tag is cut on. `response_unparseable` is the genuine article — the model
  // WAS reached, it answered, and its answer could not be trusted whole.
  const ok = await waitForVerifiedFusionReceipt({
    backendUrl: "http://stage.invalid",
    latest: async () => ({ sessionId: "survivable", source: "fallback", mode: "enforce", fallbackReason: "response_unparseable" }),
    fetcher: routes({ verified: true, canonicalBytes: CANONICAL, signatures: [{ verified: true }] }),
  });
  expect(ok.sessionId).toBe("survivable");
});
