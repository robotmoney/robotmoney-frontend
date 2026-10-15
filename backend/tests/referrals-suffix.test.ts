// The ERC-8021 referral suffix (Linear RM-174): encoder, parser, code search.
//
// WHAT THIS FILE PROTECTS. A deposit's referral code is only worth anything if
// the bytes the skill appends are the bytes the report reads back. So the
// encoder is pinned to a golden vector, the parser is pinned to the ERC-8021
// draft's own test cases (https://github.com/ethereum/ERCs/pull/1209), and the
// code search is checked where it matters in practice: a suffix in the MIDDLE
// of a transaction input (a Safe, a 4337 bundle, a 7702 batch put it there),
// a wallet's own code sitting next to ours, and inputs that merely look like a
// suffix.
//
// Pure functions: no database and no network, although the backend preload
// still starts the shared Postgres for every test file.
import { test, expect, describe } from "bun:test";
import {
  encodeReferralSuffix,
  findReferralCodes,
  isReferralCodeFormat,
  normalizeReferralCode,
  parseErc8021Suffixes,
  ERC8021_MARKER_HEX,
} from "../src/referrals/suffix.ts";

const MARKER = ERC8021_MARKER_HEX;

describe("encodeReferralSuffix", () => {
  test("matches the golden vector for rm_acme", () => {
    expect(encodeReferralSuffix("rm_acme")).toBe(
      "0xa1616da162726d67726d5f61636d65000f0280218021802180218021802180218021",
    );
  });

  test("normalizes case and spaces before encoding", () => {
    expect(encodeReferralSuffix("  RM_Acme ")).toBe(encodeReferralSuffix("rm_acme"));
  });

  test("uses the 1-byte length form for a code of 24 bytes or more", () => {
    const code = "rm_" + "a".repeat(29); // 32 characters, the maximum
    const suffix = encodeReferralSuffix(code);
    expect(suffix).toContain("7820" + Buffer.from(code).toString("hex"));
    expect(findReferralCodes(suffix)).toEqual([code]);
  });

  test("refuses anything that is not a referral code", () => {
    for (const bad of ["acme", "rm_", "rm_-acme", "rm_acme-", "rm_ac--me", "rm_acme!", "rm_" + "a".repeat(30)]) {
      expect(() => encodeReferralSuffix(bad)).toThrow();
    }
  });

  test("round-trips through the parser", () => {
    expect(findReferralCodes("0xdeadbeef" + encodeReferralSuffix("rm_noop-analyst").slice(2))).toEqual([
      "rm_noop-analyst",
    ]);
  });
});

describe("parseErc8021Suffixes: the ERC-8021 draft's test cases", () => {
  test("schema 0, a single code", () => {
    const [suffix] = parseErc8021Suffixes("0xdddddddd62617365617070070080218021802180218021802180218021");
    expect(suffix).toMatchObject({ schemaId: 0, codes: ["baseapp"] });
  });

  test("schema 1, two codes and a custom registry", () => {
    const [suffix] = parseErc8021Suffixes(
      "0xddddddddcccccccccccccccccccccccccccccccccccccccc210502626173656170702C6D6F7270686F0E0180218021802180218021802180218021",
    );
    expect(suffix).toMatchObject({
      schemaId: 1,
      codes: ["baseapp", "morpho"],
      registryChainId: "0x2105",
      registryAddress: "0xcccccccccccccccccccccccccccccccccccccccc",
    });
  });

  test("schema 2, a single application code", () => {
    const [suffix] = parseErc8021Suffixes("0xdddddddda161616762617365617070000b0280218021802180218021802180218021");
    expect(suffix?.schemaId).toBe(2);
    if (suffix?.schemaId !== 2) return;
    expect(suffix.data).toEqual(new Map([["a", "baseapp"]]));
  });

  test("schema 2, several entities with metadata", () => {
    const [suffix] = parseErc8021Suffixes(
      "0xdddddddda46161676261736561707061776570726976796172a16161a26163663078323130356161782a307842636632423935393845633037383165453439323330436141434630464233433838314235313935616da26c75746d5f63616d706169676e6c77696e7465722d70726f6d6f66736f7572636566776562617070007b0280218021802180218021802180218021",
    );
    expect(suffix?.schemaId).toBe(2);
    if (suffix?.schemaId !== 2) return;
    expect(suffix.data.get("w")).toBe("privy");
    expect(suffix.data.get("m")).toEqual(
      new Map([
        ["utm_campaign", "winter-promo"],
        ["source", "webapp"],
      ]),
    );
  });

  test("schema 2, a services array", () => {
    const [suffix] = parseErc8021Suffixes(
      "0xdddddddda361616762617365617070617765707269767961738269666c617368626f747365746974616e00260280218021802180218021802180218021",
    );
    expect(suffix?.schemaId).toBe(2);
    if (suffix?.schemaId !== 2) return;
    expect(suffix.data.get("s")).toEqual(["flashbots", "titan"]);
  });

  test("an unknown schema id stops parsing", () => {
    expect(parseErc8021Suffixes("0xddddddddff80218021802180218021802180218021")).toEqual([]);
  });

  test("none of the draft's codes is a referral code", () => {
    expect(findReferralCodes("0xdddddddd62617365617070070080218021802180218021802180218021")).toEqual([]);
  });
});

describe("findReferralCodes", () => {
  const depositCall =
    "6e553f65" + // deposit(uint256,address)
    "0000000000000000000000000000000000000000000000000000000005f5e100" +
    "000000000000000000000000c0ffee0000000000000000000000000000000001";

  test("finds the code at the end of a plain wallet's input", () => {
    expect(findReferralCodes("0x" + depositCall + encodeReferralSuffix("rm_acme").slice(2))).toEqual(["rm_acme"]);
  });

  test("finds the code in the middle of the input, where a Safe or a bundle puts it", () => {
    const inner = depositCall + encodeReferralSuffix("rm_acme").slice(2);
    // An outer call that wraps the inner call data and pads it to 32 bytes, as
    // execTransaction, handleOps and execute batches all do.
    const padding = "00".repeat(32 - ((inner.length / 2) % 32));
    const outer = "6a761202" + "00".repeat(64) + inner + padding + "00".repeat(96);
    expect(findReferralCodes("0x" + outer)).toEqual(["rm_acme"]);
  });

  test("returns every distinct code once, in order", () => {
    const one = depositCall + encodeReferralSuffix("rm_acme").slice(2);
    const two = depositCall + encodeReferralSuffix("rm_bolt").slice(2);
    expect(findReferralCodes("0x" + one + two + one)).toEqual(["rm_acme", "rm_bolt"]);
  });

  test("reads our code next to a wallet's own code in the same schema 2 map", () => {
    const suffix = "a261616762617365617070616da162726d67726d5f61636d6500190280218021802180218021802180218021";
    expect(findReferralCodes("0x" + depositCall + suffix)).toEqual(["rm_acme"]);
  });

  test("reads an rm_ code written as a schema 0 code", () => {
    expect(findReferralCodes("0x" + depositCall + "726d5f61636d65070080218021802180218021802180218021")).toEqual([
      "rm_acme",
    ]);
  });

  test("returns a malformed rm_ candidate as written, so the rules can report it", () => {
    const cbor = "a1616da162726d68726d5f61636d6521"; // {"m":{"rm":"rm_acme!"}}
    const suffix = cbor + "0010" + "02" + MARKER;
    expect(findReferralCodes("0x" + suffix)).toEqual(["rm_acme!"]);
  });

  test("ignores a marker with nothing parseable in front of it", () => {
    expect(findReferralCodes("0x02" + MARKER)).toEqual([]);
    expect(findReferralCodes("0x" + "ffff" + "02" + MARKER)).toEqual([]);
    expect(findReferralCodes("0x" + depositCall)).toEqual([]);
  });

  test("ignores a schema 2 map with no m.rm key", () => {
    expect(findReferralCodes("0xdddddddda161616762617365617070000b0280218021802180218021802180218021")).toEqual([]);
  });
});

describe("code format", () => {
  test("accepts rm_ plus a handle-shaped slug, 32 characters at most", () => {
    expect(isReferralCodeFormat("rm_acme")).toBe(true);
    expect(isReferralCodeFormat("rm_noop-analyst-2")).toBe(true);
    expect(isReferralCodeFormat("rm_" + "a".repeat(29))).toBe(true);
    expect(isReferralCodeFormat("rm_" + "a".repeat(30))).toBe(false);
    expect(isReferralCodeFormat("RM_ACME")).toBe(false);
  });

  test("normalizes to lowercase with no surrounding spaces", () => {
    expect(normalizeReferralCode("  RM_Acme\n")).toBe("rm_acme");
  });
});
