// The referral attribution rules over OFFLINE FIXTURES (issue 1371,
// docs/technical/referrals-spec.md §9 adversarial matrix). Every case feeds full
// transaction/receipt/block evidence through the real decoder (evidence.ts),
// the placeholder carrier adapter (carrier.ts, core conformance pending) and the
// rules (attribution.ts), via the report builder. Synthetic codes and wallets.
// Not live evidence of robotmoney-core's contracts or of a wallet execution.
import { describe, expect, test } from "bun:test";
import { ATTRIBUTION_WINDOW_SECONDS } from "../src/referrals/attribution.ts";
import type { CollectedEvidence } from "../src/referrals/collect.ts";
import type { CorrectionLog } from "../src/referrals/corrections.ts";
import type { TransactionEvidence } from "../src/referrals/evidence.ts";
import type { ReferralManifest } from "../src/referrals/manifest.ts";
import type { ReferralRegistry } from "../src/referrals/registry.ts";
import { buildReport, explainTransaction, explainWallet, type ReportPayload } from "../src/referrals/report.ts";
import {
  ALICE, BOB, CAROL, DAVE, KEYS, RMAGENT, RMPROTO, RMRWA, RMUSDC, ROUTER, SAFE, UNRELATED, V0,
  TxFixture, blockHash, blockTime, channelCode, iso, log, memberCode, overrideCorrection, testManifest, testRegistry, verifiedCorrection,
} from "./support/referral-fixtures.ts";

const W_BLOCKS = ATTRIBUTION_WINDOW_SECONDS / 2; // fixture blocks are 2 s apart
const CUTOFF = 5_000_000;

const REGISTRY = testRegistry([
  memberCode("rm_ref1", "m-ref1", "ref1"),
  memberCode("rm_ref2", "m-ref2", "ref2"),
  channelCode("rm_site", "site"),
  memberCode("rm_off", "m-off", "off", { disabledAt: iso(blockTime(20_000)) }),
]);

function evidenceOf(txs: TransactionEvidence[], cutoff = CUTOFF, manifest: ReferralManifest = testManifest()): CollectedEvidence {
  return {
    chainId: 8453,
    cutoff: { number: cutoff, hash: blockHash(cutoff), timestamp: blockTime(cutoff) },
    finalizedHead: { number: cutoff, hash: blockHash(cutoff) },
    ranges: manifest.entries
      .filter((e) => e.startBlock !== null)
      .map((e) => ({ entryId: e.id, fromBlock: e.startBlock!, toBlock: Math.min(e.endBlock ?? cutoff, cutoff), status: "complete" as const, logCount: 0, error: null })),
    transactions: txs,
    errors: [],
    stoppedByBudget: false,
    invalidated: null,
    stats: { rpcCalls: 0, elapsedMs: 0, peakRssBytes: 0, resumedRanges: 0 },
  };
}

function run(txs: TransactionEvidence[], opts: { registry?: ReferralRegistry; corrections?: CorrectionLog; cutoff?: number; manifest?: ReferralManifest; evidence?: CollectedEvidence } = {}): ReportPayload {
  const manifest = opts.manifest ?? testManifest();
  return buildReport({
    evidence: opts.evidence ?? evidenceOf(txs, opts.cutoff, manifest),
    registry: opts.registry ?? REGISTRY,
    corrections: opts.corrections ?? log(),
    manifest,
    revisions: { rules: "test", config: "test", configAccepted: true },
  }).payload;
}
const row = (p: ReportPayload, w: string) => p.rows.find((r) => r.wallet === w);
const reasons = (p: ReportPayload, w: string) => row(p, w)?.candidates.map((c) => c.reason);

describe("§9 bundles, foreign code bytes and conflicting codes", () => {
  test("Alice coded, Bob uncoded in one bundle: Alice binds, Bob stays uncoded, in either order", () => {
    for (const bobFirst of [false, true]) {
      const t = new TxFixture(`bundle-${bobFirst}`, 6000);
      if (bobFirst) t.direct(BOB, BOB, RMUSDC, 50n);
      t.direct(ALICE, ALICE, RMUSDC, 100n).carrier(RMUSDC, ALICE, ALICE, 100n, "rm_ref1");
      if (!bobFirst) t.direct(BOB, BOB, RMUSDC, 50n);
      const p = run([t.build()]);
      expect(row(p, ALICE)!.binding?.code).toBe("rm_ref1");
      expect(row(p, ALICE)!.bindingStatus).toBe("final");
      expect(row(p, BOB)!.binding).toBeNull();
      expect(row(p, BOB)!.bindingStatus).toBe("unbound");
      expect(reasons(p, BOB)).toEqual(["uncoded"]);
    }
  });

  test("code bytes elsewhere in the transaction count for nothing: only the carrier from a manifest address does", () => {
    const t = new TxFixture("foreign", 6000).carrier(UNRELATED, ALICE, ALICE, 100n, "rm_ref1").direct(ALICE, ALICE, RMUSDC, 100n);
    const p = run([t.build()]);
    expect(reasons(p, ALICE)).toEqual(["uncoded"]);
    expect(row(p, ALICE)!.binding).toBeNull();
  });

  test("conflicting codes for one deposit: no award, explained", () => {
    const t = new TxFixture("conflict", 6000).direct(ALICE, ALICE, RMUSDC, 100n).carrier(RMUSDC, ALICE, ALICE, 100n, "rm_ref1").carrier(RMUSDC, ALICE, ALICE, 100n, "rm_ref2");
    const p = run([t.build()]);
    const r = row(p, ALICE)!;
    expect(r.binding).toBeNull();
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]!.reason).toBe("conflicting_codes");
    expect(r.candidates[0]!.detail).toContain("rm_ref2");
  });
});

describe("§9 signers and router legs", () => {
  test("the same coded router deposit from an EOA, a Safe, a 4337 account and a 7702 EOA attributes identically", () => {
    const legs = [{ vault: RMUSDC, assets: 70n }, { vault: RMPROTO, assets: 30n }];
    // The signer is tx.from (an EOA, a Safe owner executing, a 4337 bundler, a
    // 7702-delegated EOA). The wallet that funds and receives is the same SAFE.
    const signers = [SAFE, ALICE, "0x0000000071727de22e5e9d8baf0edac6f37da032", SAFE];
    const rows = signers.map((from) => {
      const t = new TxFixture("signer", 6000, 0, from).router(SAFE, SAFE, legs).carrier(ROUTER, SAFE, SAFE, 100n, "rm_ref1");
      return row(run([t.build()]), SAFE);
    });
    expect(rows[0]!.binding?.code).toBe("rm_ref1");
    for (const r of rows) expect(r).toEqual(rows[0]!);
  });

  test("a router deposit across four legs is one authorization and one candidate", () => {
    const t = new TxFixture("four-legs", 6000).router(ALICE, ALICE, [RMUSDC, RMPROTO, RMAGENT, RMRWA].map((vault) => ({ vault, assets: 25n }))).carrier(ROUTER, ALICE, ALICE, 100n, "rm_ref1");
    const p = run([t.build()]);
    expect(p.authorizations).toHaveLength(1);
    expect(p.authorizations[0]!.legs).toHaveLength(4);
    expect(p.authorizations[0]!.id).toBe(`8453:${t.hash}:${p.authorizations[0]!.keyLogIndex}`);
    expect(p.authorizations[0]!.keySource).toBe("carrier");
    expect(reasons(p, ALICE)).toEqual(["bound"]);
  });

  test("a router deposit with no carrier event has no proven payer: unknown, never self-funded", () => {
    const t = new TxFixture("router-uncoded", 6000).router(ALICE, ALICE, [{ vault: RMUSDC, assets: 10n }]);
    const p = run([t.build()]);
    expect(reasons(p, ALICE)).toEqual(["evidence_unavailable"]);
    expect(row(p, ALICE)!.bindingStatus).toBe("unknown");
  });

  test("a carrier whose amount disagrees with its legs is unknown evidence", () => {
    const t = new TxFixture("amount", 6000).router(ALICE, ALICE, [{ vault: RMUSDC, assets: 10n }]).carrier(ROUTER, ALICE, ALICE, 11n, "rm_ref1");
    const p = run([t.build()]);
    expect(reasons(p, ALICE)).toEqual(["evidence_unavailable"]);
  });
});

describe("§9 gifts and the 30-day clock", () => {
  test("router depositFor paid by Bob for Alice is a gift: no clock, Bob's code never binds to Alice", () => {
    const t = new TxFixture("gift", 6000, 0, BOB).router(BOB, ALICE, [{ vault: RMUSDC, assets: 100n }]).carrier(ROUTER, BOB, ALICE, 100n, "rm_ref2");
    const p = run([t.build()]);
    const r = row(p, ALICE)!;
    expect(r.binding).toBeNull();
    expect(r.firstQualifyingDeposit).toBeNull();
    expect(reasons(p, ALICE)).toEqual(["gift"]);
    expect(row(p, BOB)).toBeUndefined();
  });

  test("gift to Alice, 31 days later her own coded deposit binds (coded and uncoded gift evidence)", () => {
    const gifts = [
      new TxFixture("gift-uncoded", 6000, 0, BOB).direct(BOB, ALICE, RMUSDC, 100n).build(),
      new TxFixture("gift-coded", 6001, 0, BOB).router(BOB, ALICE, [{ vault: RMUSDC, assets: 5n }]).carrier(ROUTER, BOB, ALICE, 5n, "rm_ref2").build(),
    ];
    const own = new TxFixture("own", 6000 + Math.ceil((31 * 86400) / 2)).direct(ALICE, ALICE, RMUSDC, 10n).carrier(RMUSDC, ALICE, ALICE, 10n, "rm_ref1").build();
    const p = run([...gifts, own]);
    const r = row(p, ALICE)!;
    expect(reasons(p, ALICE)).toEqual(["gift", "gift", "bound"]);
    expect(r.binding?.code).toBe("rm_ref1");
    expect(r.firstQualifyingDeposit?.transactionHash).toBe(own.transactionHash);
  });

  test("uncoded self-funded deposit starts the clock; exactly +30 days is late, one second earlier binds", () => {
    const start = new TxFixture("start", 6000).direct(ALICE, ALICE, RMUSDC, 1n).build();
    const t0 = blockTime(6000);
    const at = (label: string, secs: number) => new TxFixture(label, 6000 + Math.floor(secs / 2) + 1, 0, ALICE, t0 + secs).direct(ALICE, ALICE, RMUSDC, 1n).carrier(RMUSDC, ALICE, ALICE, 1n, "rm_ref1").build();
    const late = run([start, at("late", ATTRIBUTION_WINDOW_SECONDS)]);
    expect(reasons(late, ALICE)).toEqual(["uncoded", "late"]);
    expect(row(late, ALICE)!.windowEndsAt).toBe(iso(t0 + ATTRIBUTION_WINDOW_SECONDS));
    const inTime = run([start, at("in-time", ATTRIBUTION_WINDOW_SECONDS - 1)]);
    expect(reasons(inTime, ALICE)).toEqual(["uncoded", "bound"]);
  });

  test("zero-asset calls and reverted transactions do not start the clock", () => {
    const zero = new TxFixture("zero", 6000).direct(ALICE, ALICE, RMUSDC, 0n).build();
    const reverted = new TxFixture("reverted", 6001).build({ status: "0x0" });
    const coded = new TxFixture("coded", 6000 + W_BLOCKS + 10).direct(ALICE, ALICE, RMUSDC, 5n).carrier(RMUSDC, ALICE, ALICE, 5n, "rm_ref1").build();
    const p = run([zero, reverted, coded]);
    expect(reasons(p, ALICE)).toEqual(["zero_assets", "bound"]);
  });
});

describe("§9 corrections", () => {
  const dep = new TxFixture("dep", 6000).direct(ALICE, ALICE, RMUSDC, 100n).build();
  const recorded = iso(blockTime(7000));

  test("a verified correction binds from its recording time", () => {
    const c = verifiedCorrection("c-1", ALICE, KEYS.alice, "rm_ref1", dep.transactionHash, 2, recorded);
    const p = run([dep], { corrections: log([c]) });
    const r = row(p, ALICE)!;
    expect(r.binding).toMatchObject({ code: "rm_ref1", source: "correction", correctionKind: "verified", correctionId: "c-1", effectiveAt: recorded });
    expect(r.bindingStatus).toBe("final");
  });

  test("a 0x00 signature, a replayed nonce or an unrelated deposit hash is rejected; no binding", () => {
    const zero = verifiedCorrection("c-zero", ALICE, null, "rm_ref1", dep.transactionHash, 2, recorded, { signature: "0x00" });
    expect(reasons(run([dep], { corrections: log([zero]) }), ALICE)).toEqual(["uncoded", "correction_rejected"]);

    const first = verifiedCorrection("c-a", BOB, KEYS.bob, "rm_ref1", "0x" + "ab".repeat(32), 1, recorded, { nonce: "same" });
    const replay = verifiedCorrection("c-b", ALICE, KEYS.alice, "rm_ref1", dep.transactionHash, 2, iso(blockTime(7001)), { nonce: "same" });
    const p = run([dep], { corrections: log([first, replay]) });
    expect(row(p, ALICE)!.binding).toBeNull();
    expect(row(p, ALICE)!.candidates.find((c) => c.id === "c-b")!.detail).toContain("already used");

    const unrelated = verifiedCorrection("c-u", ALICE, KEYS.alice, "rm_ref1", "0x" + "cd".repeat(32), 0, recorded);
    const q = run([dep], { corrections: log([unrelated]) });
    expect(row(q, ALICE)!.binding).toBeNull();
    expect(row(q, ALICE)!.candidates.find((c) => c.id === "c-u")!.detail).toContain("names no deposit");

    const signedByOther = verifiedCorrection("c-o", ALICE, KEYS.bob, "rm_ref1", dep.transactionHash, 2, recorded);
    expect(row(run([dep], { corrections: log([signedByOther]) }), ALICE)!.binding).toBeNull();
  });

  test("an override for a wallet already bound, or naming a gift, is rejected; the binding stands", () => {
    const coded = new TxFixture("coded", 6000).direct(ALICE, ALICE, RMUSDC, 100n).carrier(RMUSDC, ALICE, ALICE, 100n, "rm_ref1").build();
    const o = overrideCorrection("o-1", ALICE, "rm_ref2", coded.transactionHash, 2, recorded);
    const p = run([coded], { corrections: log([o]) });
    expect(row(p, ALICE)!.binding?.code).toBe("rm_ref1");
    expect(row(p, ALICE)!.candidates.find((c) => c.id === "o-1")!.reason).toBe("correction_rejected");

    const gift = new TxFixture("gift", 6000, 0, BOB).direct(BOB, CAROL, RMUSDC, 100n).build();
    const og = overrideCorrection("o-2", CAROL, "rm_ref2", gift.transactionHash, 2, recorded);
    const q = run([gift], { corrections: log([og]) });
    expect(row(q, CAROL)!.binding).toBeNull();
    expect(row(q, CAROL)!.candidates.find((c) => c.id === "o-2")!.detail).toContain("gift");
  });

  test("correction A then chain B: A binds, B is already_bound; a cutoff before A shows neither A nor a change", () => {
    const a = overrideCorrection("o-a", ALICE, "rm_ref2", dep.transactionHash, 2, recorded);
    const b = new TxFixture("b", 8000).direct(ALICE, ALICE, RMUSDC, 5n).carrier(RMUSDC, ALICE, ALICE, 5n, "rm_ref1").build();
    const p = run([dep, b], { corrections: log([a]) });
    expect(row(p, ALICE)!.binding).toMatchObject({ code: "rm_ref2", source: "correction", correctionKind: "override" });
    expect(reasons(p, ALICE)).toEqual(["uncoded", "bound", "already_bound"]);

    const early = run([dep], { corrections: log([a]), cutoff: 6500 });
    const without = run([dep], { corrections: log([]), cutoff: 6500 });
    expect(early.rows).toEqual(without.rows);
  });

  test("a revoked correction ends forward only; earlier reports are unchanged; the log names who, when, why", () => {
    const a = overrideCorrection("o-r", ALICE, "rm_ref2", dep.transactionHash, 2, recorded);
    const rev = { type: "revocation" as const, id: "r-1", revokes: "o-r", recordedAt: iso(blockTime(9000)), recordedBy: "ops@robotmoney", reason: "depositor withdrew consent" };
    const before = run([dep], { corrections: log([a, rev]), cutoff: 8000 });
    const withoutRevocation = run([dep], { corrections: log([a]), cutoff: 8000 });
    expect(before.rows).toEqual(withoutRevocation.rows);
    const after = run([dep], { corrections: log([a, rev]), cutoff: 10_000 });
    const r = row(after, ALICE)!;
    expect(r.binding).toBeNull();
    const revoked = r.candidates.find((c) => c.reason === "correction_revoked")!;
    expect(revoked.time).toBe(rev.recordedAt);
    expect(revoked.detail).toContain("ops@robotmoney");
    expect(revoked.detail).toContain("depositor withdrew consent");
  });
});

describe("§9 missing evidence, lifecycle and launch", () => {
  test("a missing receipt followed by valid code B: incomplete history, B provisional, never 'no code'", () => {
    const missing = new TxFixture("missing", 6000).direct(ALICE, ALICE, RMUSDC, 1n).build();
    missing.receipt = null;
    const b = new TxFixture("b", 6100).direct(ALICE, ALICE, RMUSDC, 1n).carrier(RMUSDC, ALICE, ALICE, 1n, "rm_ref1").build();
    const p = run([missing, b]);
    const r = row(p, ALICE)!;
    expect(r.candidates[0]).toMatchObject({ reason: "evidence_unavailable", detail: "receipt unavailable" });
    expect(r.binding?.code).toBe("rm_ref1");
    expect(r.bindingStatus).toBe("provisional");
    expect(r.firstQualifyingDeposit?.tentative).toBe(true);
    expect(p.completeness.attribution).toBe(false);
    expect(p.final).toBe(false);
  });

  test("inconsistent block evidence is unknown", () => {
    const t = new TxFixture("inconsistent", 6000).direct(ALICE, ALICE, RMUSDC, 1n).build();
    t.block = { ...t.block!, hash: blockHash(6000, "-fork") };
    expect(reasons(run([t]), ALICE)).toEqual(["evidence_unavailable"]);
  });

  test("a code disabled after lookup or signing: the deposit executes, attribution fails as inactive", () => {
    const t = new TxFixture("late-disable", 20_000).direct(ALICE, ALICE, RMUSDC, 1n).carrier(RMUSDC, ALICE, ALICE, 1n, "rm_off").build();
    expect(reasons(run([t]), ALICE)).toEqual(["code_inactive"]);
    const before = new TxFixture("before-disable", 19_999).direct(ALICE, ALICE, RMUSDC, 1n).carrier(RMUSDC, ALICE, ALICE, 1n, "rm_off").build();
    expect(reasons(run([before]), ALICE)).toEqual(["bound"]);
  });

  test("` RM_ALICE ` recorded on chain is invalid_code (never repaired); an unregistered well-formed code is unknown_code", () => {
    const bad = new TxFixture("bad", 6000).direct(ALICE, ALICE, RMUSDC, 1n).carrier(RMUSDC, ALICE, ALICE, 1n, " RM_REF1 ").build();
    expect(reasons(run([bad]), ALICE)).toEqual(["invalid_code"]);
    const notUtf8 = new TxFixture("bytes", 6000).direct(BOB, BOB, RMUSDC, 1n).carrier(RMUSDC, BOB, BOB, 1n, new Uint8Array([0xff, 0xfe])).build();
    expect(reasons(run([notUtf8]), BOB)).toEqual(["invalid_code"]);
    const unknown = new TxFixture("unknown", 6000).direct(CAROL, CAROL, RMUSDC, 1n).carrier(RMUSDC, CAROL, CAROL, 1n, "rm_nobody").build();
    expect(reasons(run([unknown]), CAROL)).toEqual(["unknown_code"]);
  });

  test("an active code but pre-launch, late, or already bound: each explained, the binding persists", () => {
    const pre = new TxFixture("pre", 5500).direct(ALICE, ALICE, RMUSDC, 1n).carrier(RMUSDC, ALICE, ALICE, 1n, "rm_ref1").build();
    const p = run([pre], { registry: testRegistry(REGISTRY.codes, 6000) });
    expect(reasons(p, ALICE)).toEqual(["before_launch"]);
    expect(reasons(run([pre], { registry: testRegistry(REGISTRY.codes, null) }), ALICE)).toEqual(["before_launch"]);

    const one = new TxFixture("one", 6000).direct(ALICE, ALICE, RMUSDC, 1n).carrier(RMUSDC, ALICE, ALICE, 1n, "rm_ref1").build();
    const two = new TxFixture("two", 6010).direct(ALICE, ALICE, RMUSDC, 1n).carrier(RMUSDC, ALICE, ALICE, 1n, "rm_ref2").build();
    const q = run([one, two]);
    expect(reasons(q, ALICE)).toEqual(["bound", "already_bound"]);
    expect(row(q, ALICE)!.binding?.code).toBe("rm_ref1");
  });

  test("the historical binding keeps the registry's beneficiary snapshot, whatever happened to the member since", () => {
    const t = new TxFixture("snap", 6000).direct(ALICE, ALICE, RMUSDC, 1n).carrier(RMUSDC, ALICE, ALICE, 1n, "rm_ref1").build();
    const b = row(run([t]), ALICE)!.binding!;
    expect(b.beneficiary).toEqual({ kind: "member", memberId: "m-ref1" });
    expect(b.display).toEqual({ handle: "ref1", name: "REF1" });
  });
});

describe("§9 legacy history, own wallet, team channel", () => {
  test("a legacy v0 holder keeps the first historical deposit: no new clock on migration", () => {
    const legacy = new TxFixture("legacy", 200).direct(DAVE, DAVE, V0, 1n).build();
    const migrated = new TxFixture("migrated", 200 + W_BLOCKS + 5000).direct(DAVE, DAVE, RMUSDC, 1n).carrier(RMUSDC, DAVE, DAVE, 1n, "rm_ref1").build();
    const p = run([legacy, migrated]);
    expect(reasons(p, DAVE)).toEqual(["uncoded", "late"]);
    expect(row(p, DAVE)!.firstQualifyingDeposit?.transactionHash).toBe(legacy.transactionHash);
    expect(row(p, DAVE)!.bindingStatus).toBe("unbound");
  });

  test("missing legacy coverage blocks a final report: rows provisional or unknown", () => {
    const m = testManifest();
    m.entries[0] = { ...m.entries[0]!, status: "candidate", startBlock: null, deploymentBlock: null };
    const t = new TxFixture("d2", 6000).direct(DAVE, DAVE, RMUSDC, 1n).carrier(RMUSDC, DAVE, DAVE, 1n, "rm_ref1").build();
    const p = run([t], { manifest: m });
    expect(p.manifestGaps.join(" ")).toContain("v0-rmusdc");
    expect(row(p, DAVE)!.bindingStatus).toBe("provisional");
    expect(p.final).toBe(false);
  });

  test("a member's own wallet may bind to that member's code; a team channel code binds", () => {
    const own = new TxFixture("own", 6000).direct(ALICE, ALICE, RMUSDC, 1n).carrier(RMUSDC, ALICE, ALICE, 1n, "rm_ref1").build();
    const site = new TxFixture("site", 6000, 1).direct(BOB, BOB, RMUSDC, 1n).carrier(RMUSDC, BOB, BOB, 1n, "rm_site").build();
    const p = run([own, site], { registry: testRegistry([...REGISTRY.codes, memberCode("rm_self", "m-self", "self")]) });
    expect(row(p, ALICE)!.binding?.code).toBe("rm_ref1");
    expect(row(p, BOB)!.binding).toMatchObject({ code: "rm_site", beneficiary: { kind: "channel", channel: "site" } });
  });
});

describe("determinism and explain modes", () => {
  test("input order does not change the payload or its digest", () => {
    const txs = [
      new TxFixture("x1", 6000).direct(ALICE, ALICE, RMUSDC, 1n).carrier(RMUSDC, ALICE, ALICE, 1n, "rm_ref1").build(),
      new TxFixture("x2", 6001).direct(BOB, BOB, RMUSDC, 1n).build(),
      new TxFixture("x3", 6002).direct(CAROL, CAROL, RMUSDC, 1n).carrier(RMUSDC, CAROL, CAROL, 1n, "rm_site").build(),
    ];
    const build = (list: TransactionEvidence[]) => buildReport({ evidence: { ...evidenceOf(list), transactions: list }, registry: REGISTRY, corrections: log(), manifest: testManifest(), revisions: { rules: "r", config: "c", configAccepted: true } });
    const a = build(txs);
    const b = build([...txs].reverse());
    expect(a.payload.rows).toEqual(b.payload.rows);
    expect(a.payload.authorizations).toEqual(b.payload.authorizations);
  });

  test("per-wallet and per-transaction explain name the outcome and the reason", () => {
    const t = new TxFixture("explain", 6000).direct(ALICE, ALICE, RMUSDC, 1n).carrier(RMUSDC, ALICE, ALICE, 1n, "rm_ref1").build();
    const report = buildReport({ evidence: evidenceOf([t]), registry: REGISTRY, corrections: log(), manifest: testManifest(), revisions: { rules: "r", config: "c", configAccepted: true } });
    expect(explainWallet(report, ALICE)).toContain("final to rm_ref1");
    expect(explainWallet(report, DAVE)).toContain("no deposit or correction");
    const tx = explainTransaction(report, t.transactionHash);
    expect(tx).toContain('code "rm_ref1"');
    expect(tx).toContain(`outcome for ${ALICE}: bound`);
  });
});
