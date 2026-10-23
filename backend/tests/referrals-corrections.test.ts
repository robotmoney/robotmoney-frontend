// Admin referral corrections and the signature primitives they rest on (issue
// 1371, docs/technical/referrals-spec.md §4, §9 correction rows). Offline: the
// EIP-1271 read goes through the real RPC transport to a fake endpoint.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _resetRpcRateLimiterForTests } from "../src/chain/base-rpc-client.ts";
import { checkCorrectionLog, correctionMessage, validateCorrectionLogHistory, verifyContractSignature, type CorrectionEntry } from "../src/referrals/corrections.ts";
import { EIP1271_MAGIC_WORD, encodeIsValidSignatureCall, keccak256Hex, personalMessageHash, recoverAddress } from "../src/referrals/eth-crypto.ts";
import { ALICE, BOB, KEYS, SAFE, RPC_ENV, fakeChain, installFakeChain, iso, log, memberCode, overrideCorrection, signPersonal, testRegistry, verifiedCorrection } from "./support/referral-fixtures.ts";

const REG = testRegistry([memberCode("rm_ref1", "m-ref1", "ref1")]);
const TX = "0x" + "ab".repeat(32);
const AT = "2027-01-20T00:00:00Z";

describe("keccak-256 and secp256k1 recovery (published vectors)", () => {
  test("keccak-256 of the empty string and of the ERC-20 Transfer signature", () => {
    expect(keccak256Hex("")).toBe("0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
    expect(keccak256Hex("Transfer(address,address,uint256)")).toBe("0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef");
    expect(keccak256Hex("Deposit(address,address,uint256,uint256)")).toBe("0xdcbc1c05240f31ff3ad067ef1ee35ce4997762752e3a095284754544f4c709d7");
  });
  test("the web3.js personal_sign vector recovers its address", () => {
    const sig = "0xb91467e570a6466aa9e9876cbcd013baba02900b8979d43fe208a4a4f339f5fd6007e74cd82e037b800186422fc2da167c747ef045e5d18a5f5d4300f8e1a0291c";
    expect(recoverAddress(personalMessageHash("Some data"), sig)).toBe("0x2c7536e3605d9c16a7a3d7b1898e529396a65c23");
  });
  test("malformed signatures recover nothing and never throw", () => {
    const h = personalMessageHash("x");
    for (const s of ["0x00", "0x" + "00".repeat(65), "0x" + "ff".repeat(65), "nothex", "0x" + "11".repeat(64)]) expect(recoverAddress(h, s)).toBeNull();
  });
  test("a fixture signature round-trips to its signer", () => {
    expect(recoverAddress(personalMessageHash("hello"), signPersonal("hello", KEYS.alice))).toBe(ALICE);
  });
});

describe("checkCorrectionLog", () => {
  test("the signed payload names chain, wallet, code, deposit transaction and event, expiry and nonce", () => {
    const m = correctionMessage({ chainId: 8453, wallet: ALICE, code: "rm_ref1", deposit: { transactionHash: TX, logIndex: 3 }, signature: { expiresAt: AT, nonce: "n1" } });
    for (const part of ["8453", ALICE, "rm_ref1", TX, "log index: 3", AT, "n1"]) expect(m).toContain(part);
  });

  test("a sound EIP-191 correction and an override are accepted", () => {
    const r = checkCorrectionLog(log([verifiedCorrection("c-1", ALICE, KEYS.alice, "rm_ref1", TX, 2, AT), overrideCorrection("o-1", BOB, "rm_ref1", TX, 5, AT)]), REG);
    expect(r.logErrors).toEqual([]);
    expect(r.entries.map((e) => e.problems)).toEqual([[], []]);
  });

  test("rejects 0x00, all-zero and foreign signatures, replayed nonces, expiry and unknown codes", () => {
    const entries = [
      verifiedCorrection("c-zero", ALICE, null, "rm_ref1", TX, 2, AT, { signature: "0x00" }),
      verifiedCorrection("c-zeros", ALICE, null, "rm_ref1", TX, 2, AT, { signature: "0x" + "00".repeat(65), nonce: "z2" }),
      verifiedCorrection("c-foreign", ALICE, KEYS.bob, "rm_ref1", TX, 2, AT, { nonce: "z3" }),
      verifiedCorrection("c-ok", ALICE, KEYS.alice, "rm_ref1", TX, 2, AT, { nonce: "z4" }),
      verifiedCorrection("c-replay", BOB, KEYS.bob, "rm_ref1", TX, 2, AT, { nonce: "z4" }),
      verifiedCorrection("c-expired", BOB, KEYS.bob, "rm_ref1", TX, 2, AT, { nonce: "z5", expiresAt: "2027-01-19T00:00:00Z" }),
      verifiedCorrection("c-code", BOB, KEYS.bob, "rm_nobody", TX, 2, AT, { nonce: "z6" }),
    ];
    const r = checkCorrectionLog(log(entries), REG);
    const p = Object.fromEntries(r.entries.map((e) => [e.id, e.problems.join("; ")]));
    expect(p["c-zero"]).toContain("all zero");
    expect(p["c-zeros"]).toContain("all zero");
    expect(p["c-foreign"]).toContain(`by ${BOB}`);
    expect(p["c-ok"]).toBe("");
    expect(p["c-replay"]).toContain("never accepted twice");
    expect(p["c-expired"]).toContain("expired");
    expect(p["c-code"]).toContain("not in the registry");
  });

  test("one live correction per wallet; revocation names an earlier accepted correction; who and why are required", () => {
    const a = overrideCorrection("o-a", ALICE, "rm_ref1", TX, 2, AT);
    const b = overrideCorrection("o-b", ALICE, "rm_ref1", TX, 2, "2027-01-21T00:00:00Z");
    const rev = { type: "revocation" as const, id: "r-1", revokes: "o-a", recordedAt: "2027-01-22T00:00:00Z", recordedBy: "ops", reason: "withdrawn" };
    const c = overrideCorrection("o-c", ALICE, "rm_ref1", TX, 2, "2027-01-23T00:00:00Z");
    const bad = { type: "revocation" as const, id: "r-2", revokes: "o-zz", recordedAt: "2027-01-24T00:00:00Z", recordedBy: "", reason: "" };
    const r = checkCorrectionLog(log([a, b, rev, c, bad]), REG);
    const p = Object.fromEntries(r.entries.map((e) => [e.id, e.problems.join("; ")]));
    expect(p["o-b"]).toContain("already has correction o-a");
    expect(p["r-1"]).toBe("");
    expect(p["o-c"]).toBe("");
    expect(p["r-2"]).toContain("not an earlier correction");
    expect(p["r-2"]).toContain("who");
  });

  test("log structure: unique ids in recording order", () => {
    const a = overrideCorrection("o-a", ALICE, "rm_ref1", TX, 2, "2027-01-21T00:00:00Z");
    const b = overrideCorrection("o-a", BOB, "rm_ref1", TX, 2, AT);
    expect(checkCorrectionLog(log([a, b]), REG).logErrors.join()).toContain("used twice");
    expect(checkCorrectionLog(log([a, { ...b, id: "o-b" }]), REG).logErrors.join()).toContain("recording order");
  });
});

describe("validateCorrectionLogHistory (append-only against the previous accepted revision)", () => {
  const a = overrideCorrection("o-a", ALICE, "rm_ref1", TX, 2, AT);
  const deployed = Date.parse("2027-01-25T00:00:00Z") / 1000;
  test("appending a correction recorded after deployment is fine; editing, removing or backdating is not", () => {
    const later = overrideCorrection("o-b", BOB, "rm_ref1", TX, 3, "2027-01-26T00:00:00Z");
    expect(validateCorrectionLogHistory(log([a]), log([a, later]), deployed)).toEqual([]);
    expect(validateCorrectionLogHistory(log([a]), log([]), deployed).join()).toContain("removed");
    expect(validateCorrectionLogHistory(log([a]), log([{ ...a, reason: "edited" }]), deployed).join()).toContain("edited");
    const backdated = overrideCorrection("o-c", BOB, "rm_ref1", TX, 3, "2027-01-24T00:00:00Z");
    expect(validateCorrectionLogHistory(log([a]), log([a, backdated]), deployed).join()).toContain("never earlier");
  });
});

describe("EIP-1271 (smart-wallet) signatures, through the shared transport", () => {
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
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const entry = (): CorrectionEntry => verifiedCorrection("c-safe", SAFE, null, "rm_ref1", TX, 2, AT, { scheme: "eip1271", signature: "0x" + "12".repeat(70) });

  test("needs a contract read; accepted only on the magic value", async () => {
    const c = entry();
    expect(checkCorrectionLog(log([c]), REG).entries[0]).toMatchObject({ problems: [], needsContractSignatureCheck: true });
    const chain = fakeChain([]);
    const data = encodeIsValidSignatureCall(personalMessageHash(correctionMessage(c as CorrectionEntry & { signature: NonNullable<CorrectionEntry["signature"]> })), c.signature!.signature);
    chain.calls = new Map([[`${SAFE}:${data}`, EIP1271_MAGIC_WORD]]);
    restore = installFakeChain(chain);
    expect(await verifyContractSignature(c, { rpcUrl: "http://fake" })).toEqual({ status: "accepted", problem: null });
    chain.calls = new Map([[`${SAFE}:${data}`, "0x" + "00".repeat(32)]]);
    expect((await verifyContractSignature(c, { rpcUrl: "http://fake" })).status).toBe("rejected");
    chain.calls = new Map();
    expect((await verifyContractSignature(c, { rpcUrl: "http://fake" })).problem).toContain("no EIP-1271 contract");
    chain.fail = () => "boom";
    expect((await verifyContractSignature(c, { rpcUrl: "http://fake" })).status).toBe("unverifiable");
  });
});

test("fixture times are ISO", () => {
  expect(iso(0)).toBe("1970-01-01T00:00:00Z");
});
