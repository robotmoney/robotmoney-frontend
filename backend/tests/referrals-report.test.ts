// The referral report end to end over a FAKE Base RPC (issue 1371,
// docs/technical/referrals-spec.md §7, §9 rows on finality, reruns, missing data
// and interrupted scans). The collector runs the real shared transport
// (chain/base-rpc-client.ts) against an in-process endpoint serving OFFLINE
// FIXTURES; nothing here touches a real chain. Not live evidence.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetRpcRateLimiterForTests, encodeBalanceOfCall, encodeConvertToAssetsCall, toBlockTag } from "../src/chain/base-rpc-client.ts";
import { collectEvidence, collectHoldings, type CollectOptions } from "../src/referrals/collect.ts";
import { buildReport, payloadDigestOf, provenanceOf, toCsv, type Report } from "../src/referrals/report.ts";
import {
  ALICE, BOB, CAROL, RMUSDC, RMPROTO, ROUTER, RPC_ENV, TxFixture, blockHash, channelCode, fakeChain, installFakeChain, log, memberCode, testManifest, testRegistry, type FakeChain,
} from "./support/referral-fixtures.ts";

const REGISTRY = testRegistry([memberCode("rm_ref1", "m-ref1", "ref1"), channelCode("rm_site", "site")]);
const word = (v: bigint) => "0x" + v.toString(16).padStart(64, "0");

let restore: () => void = () => {};
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const [k, v] of Object.entries(RPC_ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  _resetRpcRateLimiterForTests();
});
afterEach(() => {
  restore();
  restore = () => {};
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function txs() {
  return [
    new TxFixture("r-alice", 6000).router(ALICE, ALICE, [{ vault: RMUSDC, assets: 60n }, { vault: RMPROTO, assets: 40n }]).carrier(ROUTER, ALICE, ALICE, 100n, "rm_ref1").build(),
    new TxFixture("r-bob", 7000).direct(BOB, BOB, RMUSDC, 10n).build(),
    new TxFixture("r-carol", 8000).direct(CAROL, CAROL, RMUSDC, 5n).carrier(RMUSDC, CAROL, CAROL, 5n, "rm_site").build(),
  ];
}

const opts = (over: Partial<CollectOptions> = {}): CollectOptions => ({ rpc: { rpcUrl: "http://fake-rpc" }, manifest: testManifest(), rangeBlocks: 5000, checkpointKey: "k1", cutoffBlock: 19_000, ...over });

async function report(chain: FakeChain, over: Partial<CollectOptions> = {}, holdings = false): Promise<Report> {
  restore();
  restore = installFakeChain(chain);
  const evidence = await collectEvidence(opts(over));
  const base = { evidence, registry: REGISTRY, corrections: log(), manifest: testManifest(), revisions: { rules: "abc", config: "v9.9.9", configAccepted: true } };
  let r = buildReport(base);
  if (holdings && evidence.cutoff) r = buildReport({ ...base, holdings: await collectHoldings({ rpcUrl: "http://fake-rpc" }, testManifest(), r.payload.rows.map((x) => x.wallet), evidence.cutoff) });
  return r;
}

describe("a complete scan", () => {
  test("pins finalized cutoff number and hash, scans every range, and binds", async () => {
    const r = await report(fakeChain(txs()));
    const p = r.payload;
    expect(p.cutoff).toMatchObject({ number: 19_000, hash: blockHash(19_000) });
    expect(r.finalizedHead).toEqual({ number: 19_000, hash: blockHash(19_000) });
    expect(p.coverage.every((c) => c.status === "complete")).toBe(true);
    expect(p.coverage).toHaveLength(16);
    expect(p.completeness).toEqual({ attribution: true, valuation: null, combined: true });
    expect(p.final).toBe(true);
    expect(p.rows.map((x) => [x.wallet, x.bindingStatus, x.binding?.code ?? null])).toEqual(
      [[ALICE, "final", "rm_ref1"], [BOB, "unbound", null], [CAROL, "final", "rm_site"]].sort((a, b) => (a[0]! < b[0]! ? -1 : 1)),
    );
    expect(r.diagnostics.rpcCalls).toBeGreaterThan(16);
  });

  test("duplicate logs from the provider never duplicate an authorization", async () => {
    const chain = fakeChain(txs());
    chain.duplicateLogs = true;
    const dup = await report(chain);
    const clean = await report(fakeChain(txs()));
    expect(dup.payload.authorizations).toEqual(clean.payload.authorizations);
    expect(dup.payload.rows).toEqual(clean.payload.rows);
  });

  test("CSV carries the manifest digest and the pinned block; provenance carries the digests and revisions", async () => {
    const r = await report(fakeChain(txs()));
    const csv = toCsv(r).trim().split("\n");
    expect(csv[0]).toStartWith("manifest_digest,cutoff_block,cutoff_hash,wallet");
    expect(csv).toHaveLength(4);
    for (const line of csv.slice(1)) expect(line).toStartWith(`${r.payload.digests.manifest},19000,${blockHash(19_000)},`);
    const prov = provenanceOf(r);
    expect(prov).toMatchObject({ payloadDigest: r.payloadDigest, revisions: { rules: "abc", config: "v9.9.9" }, rowCount: 3 });
    expect(prov).not.toHaveProperty("rows");
  });
});

describe("reproducibility", () => {
  test("an October cutoff rerun after a November withdrawal is byte-identical, holdings included", async () => {
    const tag = toBlockTag(19_000);
    const pinned = (chain: FakeChain, latestShares: bigint) => {
      chain.calls = new Map();
      for (const w of [ALICE, BOB, CAROL]) {
        for (const v of [RMUSDC, RMPROTO]) {
          chain.calls.set(`${v}:${encodeBalanceOfCall(w)}@${tag}`, word(7n));
          chain.calls.set(`${v}:${encodeBalanceOfCall(w)}@latest`, word(latestShares));
          chain.calls.set(`${v}:${encodeConvertToAssetsCall(7n)}@${tag}`, word(8n));
        }
        for (const v of testManifest().entries.filter((e) => e.kind === "vault" && e.address !== RMUSDC && e.address !== RMPROTO)) chain.calls.set(`${v.address}:${encodeBalanceOfCall(w)}@${tag}`, word(0n));
      }
      return chain;
    };
    const october = await report(pinned(fakeChain(txs(), 20_000, 19_500), 7n), {}, true);
    expect(october.payload.completeness).toEqual({ attribution: true, valuation: true, combined: true });
    expect(october.payload.holdings!.label).toContain("not referred or qualified capital");
    // November: a withdrawal and a new deposit after the cutoff; the head moved on.
    const later = [...txs(), new TxFixture("november", 30_000).direct(ALICE, ALICE, RMUSDC, 999n).carrier(RMUSDC, ALICE, ALICE, 999n, "rm_site").build()];
    const november = await report(pinned(fakeChain(later, 40_000, 39_000), 0n), {}, true);
    expect(november.payload).toEqual(october.payload);
    expect(november.payloadDigest).toBe(october.payloadDigest);
    expect(JSON.stringify(november.payload)).toBe(JSON.stringify(october.payload));
    expect(payloadDigestOf(JSON.parse(JSON.stringify(november.payload)))).toBe(october.payloadDigest);
  });

  test("an archive read that returns 0x is unavailable valuation, never zero", async () => {
    const r = await report(fakeChain(txs()), {}, true); // no eth_call answers: every read is 0x
    expect(r.payload.holdings!.rows).toEqual([]);
    expect(r.payload.holdings!.errors.join()).toContain("never zero");
    expect(r.payload.completeness).toEqual({ attribution: true, valuation: false, combined: false });
    expect(r.payload.final).toBe(false);
  });
});

describe("finality and canonicality", () => {
  test("a provider without a finalized head makes the report incomplete; depth is not finality", async () => {
    const r = await report(fakeChain(txs(), 20_000, null), { cutoffBlock: undefined });
    expect(r.payload.cutoff).toBeNull();
    expect(r.payload.rows).toEqual([]);
    expect(r.payload.errors.join()).toContain("32-block depth is not finality");
    expect(r.payload.final).toBe(false);
  });

  test("an explicit cutoff after the finalized head is refused", async () => {
    const r = await report(fakeChain(txs(), 20_000, 18_000));
    expect(r.payload.errors.join()).toContain("after the finalized head");
    expect(r.payload.final).toBe(false);
  });

  test("a changed cutoff hash invalidates publication", async () => {
    const chain = fakeChain(txs());
    let pinnedOnce = false;
    chain.fork = (n) => (n === 19_000 && pinnedOnce ? "-reorg" : "");
    const realFail = chain.fail;
    chain.fail = (m, p) => {
      if (m === "eth_getLogs") pinnedOnce = true;
      return realFail?.(m, p);
    };
    const r = await report(chain);
    expect(r.payload.invalidated).toContain("hash changed");
    expect(r.payload.completeness.attribution).toBe(false);
    expect(r.payload.final).toBe(false);
  });
});

describe("missing data is unknown, never 'no referral'", () => {
  test("a missing receipt makes that wallet's later binding provisional", async () => {
    const list = [new TxFixture("gone", 5500).direct(ALICE, ALICE, RMUSDC, 1n).build(), ...txs()];
    list[0]!.receipt = null;
    const r = await report(fakeChain(list));
    const alice = r.payload.rows.find((x) => x.wallet === ALICE)!;
    expect(alice.candidates[0]!.reason).toBe("evidence_unavailable");
    expect(alice.bindingStatus).toBe("provisional");
    expect(r.payload.final).toBe(false);
  });

  test("a failed log range makes every binding provisional: affected wallets cannot be named", async () => {
    const chain = fakeChain(txs());
    chain.fail = (m, p: any) => (m === "eth_getLogs" && p[0].address === RMUSDC && p[0].fromBlock === toBlockTag(15_000) ? "range too large" : undefined);
    const r = await report(chain);
    expect(r.payload.coverage.find((c) => c.status === "failed")).toBeDefined();
    expect(r.payload.rows.every((x) => x.bindingStatus === "provisional" || x.bindingStatus === "unknown")).toBe(true);
    expect(r.payload.unknowns.some((u) => u.wallets === null)).toBe(true);
  });
});

describe("interrupted scans resume from the checkpoint", () => {
  test("a budget stop writes an incomplete artifact; the resume rescans no completed range and matches a fresh run", async () => {
    const dir = mkdtempSync(join(process.env.HOME ? join(process.env.HOME, "tmp") : tmpdir(), "referral-cp-"));
    const checkpointPath = join(dir, "scan.checkpoint.json");
    const first = fakeChain(txs());
    const stopped = await report(first, { checkpointPath, budget: { maxRpcCalls: 8 } });
    expect(stopped.diagnostics.stoppedByBudget).toBe(true);
    expect(stopped.payload.final).toBe(false);
    expect(stopped.payload.coverage.some((c) => c.status === "pending")).toBe(true);
    expect(existsSync(checkpointPath)).toBe(true);
    const done = Object.keys(JSON.parse(readFileSync(checkpointPath, "utf8")).ranges).length;
    expect(done).toBeGreaterThan(0);

    const second = fakeChain(txs());
    const resumed = await report(second, { checkpointPath });
    expect(resumed.diagnostics.resumedRanges).toBe(done);
    expect(second.seen.eth_getLogs).toBe(16 - done);
    const fresh = await report(fakeChain(txs()));
    expect(resumed.payload).toEqual(fresh.payload);
    expect(resumed.payloadDigest).toBe(fresh.payloadDigest);
  });

  test("a checkpoint is never reused for other inputs or another cutoff", async () => {
    const dir = mkdtempSync(join(process.env.HOME ? join(process.env.HOME, "tmp") : tmpdir(), "referral-cp-"));
    const checkpointPath = join(dir, "scan.checkpoint.json");
    await report(fakeChain(txs()), { checkpointPath });
    restore();
    restore = installFakeChain(fakeChain(txs()));
    await expect(collectEvidence(opts({ checkpointPath, checkpointKey: "other" }))).rejects.toThrow("use a new checkpoint path");
    await expect(collectEvidence(opts({ checkpointPath, cutoffBlock: 18_999 }))).rejects.toThrow("use a new checkpoint path");
  });
});

describe("the committed CLI (backend/scripts/referrals-report.ts)", () => {
  test("scan over the working-tree config writes report, CSV, provenance and receipt (0600); verify and explain read them back", async () => {
    const { serveFakeChain } = await import("./support/referral-fixtures.ts");
    const served = serveFakeChain(fakeChain(txs()));
    try {
      const out = mkdtempSync(join(process.env.HOME ? join(process.env.HOME, "tmp") : tmpdir(), "referral-cli-"));
      const script = join(import.meta.dir, "..", "scripts", "referrals-report.ts");
      const env = { ...process.env, ...RPC_ENV };
      // Async spawn: the fake RPC is served from THIS process's event loop.
      const run = async (cmd: string[]) => {
        const p = Bun.spawn(cmd, { env, stdout: "pipe", stderr: "pipe" });
        const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
        return { exitCode: await p.exited, stdout, stderr };
      };
      const scan = await run(["bun", script, "scan", "--working-tree", "--out", out, "--rpc-url", served.url, "--cutoff-block", "19000", "--rules-revision", "test-rev"]);
      // The shipped manifest's entries are unconfirmed candidates, so the report is
      // incomplete and the CLI says so with exit 3, never a pass.
      expect(scan.exitCode, scan.stderr).toBe(3);
      for (const f of ["report.json", "report.csv", "provenance.json", "receipt.json"]) {
        expect(existsSync(join(out, f))).toBe(true);
        expect((Bun.file(join(out, f)) as unknown as { size: number }).size).toBeGreaterThan(0);
        const { statSync } = await import("node:fs");
        expect(statSync(join(out, f)).mode & 0o777).toBe(0o600);
      }
      const rep = JSON.parse(readFileSync(join(out, "report.json"), "utf8")) as Report;
      expect(rep.payload.final).toBe(false);
      expect(rep.payload.revisions).toEqual({ rules: "test-rev", config: "working-tree", configAccepted: false });
      expect(rep.payload.manifestGaps.join()).toContain("core conformance pending");
      const verify = await run(["bun", script, "verify", "--report", join(out, "report.json")]);
      expect(verify.exitCode).toBe(0);
      expect(JSON.parse(verify.stdout).match).toBe(true);
      const explain = await run(["bun", script, "explain", "--report", join(out, "report.json"), "--wallet", ALICE]);
      expect(explain.exitCode).toBe(0);
      expect(explain.stdout).toContain("coverage gaps");
    } finally {
      served.stop();
    }
  }, 60_000);
});

test("the fake RPC never outlives a test: the process's real fetch is back", () => {
  // bun runs every backend test file in one process; a leaked fake fetch would
  // answer every later file's HTTP call with JSON-RPC.
  restore();
  expect(String(globalThis.fetch)).not.toContain("jsonrpc");
});
