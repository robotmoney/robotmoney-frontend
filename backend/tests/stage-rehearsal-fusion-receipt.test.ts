import { expect, test } from "bun:test";
import { waitForVerifiedFusionReceipt } from "../scripts/upgrades/0.4.0-to-0.5.0/stage-rehearsal.ts";

test("stage rehearsal waits for and verifies an enforce-mode model receipt", async () => {
  let reads = 0;
  const result = await waitForVerifiedFusionReceipt({
    backendUrl: "http://stage.invalid",
    pollMs: 1,
    timeoutMs: 100,
    latest: async () => ++reads < 2 ? null : { sessionId: "session-1", source: "model", mode: "enforce" },
    fetcher: async (url) => {
      expect(String(url)).toContain("/api/swarm/sessions/session-1/consensus-receipt");
      return Response.json({ verified: true, canonicalBytes: "bytes", signatures: [{ verified: true }] });
    },
  });
  expect(result.source).toBe("model");
});

test("stage rehearsal accepts explicit deterministic fallback provenance", async () => {
  const result = await waitForVerifiedFusionReceipt({
    backendUrl: "http://stage.invalid",
    latest: async () => ({ sessionId: "session-fallback", source: "fallback", mode: "enforce" }),
    fetcher: async () => Response.json({ verified: true, canonicalBytes: "bytes", signatures: [{ verified: true }] }),
  });
  expect(result.source).toBe("fallback");
});

test("stage rehearsal refuses a shadow-mode receipt", async () => {
  await expect(waitForVerifiedFusionReceipt({
    backendUrl: "http://stage.invalid",
    latest: async () => ({ sessionId: "shadow", source: "model", mode: "shadow" }),
    fetcher: async () => Response.json({ verified: true, canonicalBytes: "bytes", signatures: [{}] }),
  })).rejects.toThrow(/expected enforce/);
});

// EACH FACT ON ITS OWN TERMS. The first cut of this case falsified `verified`,
// `canonicalBytes` and `signatures` together and asserted only that the poll
// timed out — so a bug that ignored the `verified` flag entirely would still
// have passed, and the timeout message could not say which fact was missing.
// Now the poll reports them apart, and each is driven alone.
test("stage rehearsal never returns a receipt that is not verified/complete, and says which", async () => {
  const cases: [string, Record<string, unknown>][] = [
    ["not verified", { verified: false, canonicalBytes: "bytes", signatures: [{ verified: true }] }],
    ["no canonical bytes", { verified: true, canonicalBytes: "", signatures: [{ verified: true }] }],
    ["no signatures", { verified: true, canonicalBytes: "bytes", signatures: [] }],
  ];
  for (const [missing, body] of cases) {
    let thrown: unknown;
    try {
      await waitForVerifiedFusionReceipt({
        backendUrl: "http://stage.invalid",
        timeoutMs: 5,
        pollMs: 1,
        latest: async () => ({ sessionId: "bad", source: "fallback", mode: "enforce" }),
        fetcher: async () => Response.json(body),
      });
    } catch (err) { thrown = err; }
    const message = String((thrown as Error)?.message ?? "");
    // It never RETURNED — the receipt was refused, not accepted late.
    expect(message, missing).toContain("timed out");
    // …and the poll's own classification names the missing fact, so a bug that
    // ignored one of the three is distinguishable from a slow publish.
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
      fetcher: async () => Response.json({ verified: true, canonicalBytes: "bytes", signatures: [{ verified: true }] }),
    })).rejects.toThrow(/not a survivable model failure/);
  }

  // THE CONTROL: a survivable runtime failure is still accepted, reason and all
  // — otherwise this refusal would have quietly repealed AC-FE-05.
  const ok = await waitForVerifiedFusionReceipt({
    backendUrl: "http://stage.invalid",
    latest: async () => ({ sessionId: "survivable", source: "fallback", mode: "enforce", fallbackReason: "model_timeout" }),
    fetcher: async () => Response.json({ verified: true, canonicalBytes: "bytes", signatures: [{ verified: true }] }),
  });
  expect(ok.sessionId).toBe("survivable");
});
