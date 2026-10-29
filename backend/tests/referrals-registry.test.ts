// The referral code registry: lifecycle states, revision validation, history
// against the previous accepted revision, admin selection, and the committed
// configuration itself (issue 1371, docs/technical/referrals-spec.md §5, §9
// "Draft activation; scheduled disable/replacement; rejoin"). Offline.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeReferralCode } from "@robotmoney/contract";
import { loadReferralConfig, validateAcceptedRevisions, validateWorkingConfig } from "../src/referrals/config-files.ts";
import { manifestCoverageGaps, validateManifest, validateManifestHistory } from "../src/referrals/manifest.ts";
import { codeStateAt, emptyRegistry, isoToSeconds, selectAdminRecord, validateRegistry, validateRegistryHistory, type ReferralRegistry } from "../src/referrals/registry.ts";
import { channelCode, memberCode, testManifest, testRegistry } from "./support/referral-fixtures.ts";

const S = (iso: string) => isoToSeconds(iso)!;
const DAY = 86_400;
const NOW = S("2026-11-01T00:00:00Z");
const at = (secs: number) => new Date(secs * 1000).toISOString().replace(".000Z", "Z");

describe("lifecycle states (half-open intervals)", () => {
  const r = memberCode("rm_alice", "m-a", "alice", { enabledAt: "2026-11-10T00:00:00Z", disabledAt: "2026-12-10T00:00:00Z" });
  test("draft, scheduled, active, disabled, with exact boundaries", () => {
    expect(codeStateAt({ ...r, enabledAt: null, disabledAt: null }, NOW)).toBe("draft");
    expect(codeStateAt(r, S("2026-11-09T23:59:59Z"))).toBe("scheduled");
    expect(codeStateAt(r, S("2026-11-10T00:00:00Z"))).toBe("active");
    expect(codeStateAt(r, S("2026-12-09T23:59:59Z"))).toBe("active");
    expect(codeStateAt(r, S("2026-12-10T00:00:00Z"))).toBe("disabled");
  });
  test("a cancelled scheduled activation is scheduled until cancelled, then disabled forever", () => {
    const c = { ...r, disabledAt: null, cancelledAt: "2026-11-05T00:00:00Z" };
    expect(codeStateAt(c, S("2026-11-04T00:00:00Z"))).toBe("scheduled");
    expect(codeStateAt(c, S("2026-11-05T00:00:00Z"))).toBe("disabled");
    expect(codeStateAt(c, S("2026-11-20T00:00:00Z"))).toBe("disabled");
  });
  test("times are strict ISO 8601 UTC", () => {
    expect(isoToSeconds("2026-11-01T00:00:00Z")).toBe(NOW);
    for (const bad of ["2026-11-01", "2026-11-01T00:00:00.000Z", "2026-11-01T00:00:00+00:00", "2026-02-30T00:00:00Z", "nope"]) expect(isoToSeconds(bad)).toBeNull();
  });
});

describe("validateRegistry (one revision)", () => {
  test("a sound registry has no problems", () => {
    expect(validateRegistry(testRegistry([memberCode("rm_alice", "m-a", "alice"), channelCode("rm_site", "site")]))).toEqual([]);
  });
  test("refuses unnormalized, duplicate, mis-derived, termless and malformed records", () => {
    const errs = validateRegistry(
      testRegistry([
        memberCode("RM_alice", "m-a", "alice"),
        memberCode("rm_bob", "m-b", "bob"),
        memberCode("rm_bob", "m-c", "bob"),
        memberCode("rm_carl", "m-d", "carol"),
        memberCode("rm_dan", "m-e", "dan", { termsVersion: null }),
        channelCode("rm_ch", "ch", { termsVersion: "1" }),
        memberCode("rm_eve", "m-f", "eve", { enabledAt: "2026-11-02T00:00:00Z", disabledAt: "2026-11-01T00:00:00Z" }),
        memberCode("rm_fay", "m-g", "fay", { enabledAt: null, disabledAt: "2026-11-01T00:00:00Z" }),
      ]),
    ).join("\n");
    for (const s of ["not a normalized code", "listed more than once", "handle at issue time", "terms version before activation", "has no terms version", "after enabledAt", "a draft has no disable"]) expect(errs).toContain(s);
  });
  test("intervals may not overlap for one beneficiary; a replacement may start exactly when the old one stops", () => {
    const old = memberCode("rm_alice", "m-a", "alice", { enabledAt: "2026-11-01T00:00:00Z", disabledAt: "2026-12-01T00:00:00Z" });
    // Rejoining uses a new code: the handle is unchanged, so the code takes a suffix.
    const rejoin = { ...memberCode("rm_alice-2", "m-a", "alice"), enabledAt: "2026-12-01T00:00:00Z" };
    expect(validateRegistry(testRegistry([old, rejoin]))).toEqual([]);
    const overlap = { ...rejoin, enabledAt: "2026-11-30T23:59:59Z" };
    expect(validateRegistry(testRegistry([old, overlap])).join()).toContain("overlaps");
  });
});

describe("validateRegistryHistory (against the previous accepted revision)", () => {
  const base = (codes = [memberCode("rm_alice", "m-a", "alice", { enabledAt: at(NOW - 10 * DAY) })]): ReferralRegistry => testRegistry(codes, null);

  test("a draft acquires its first prospective activation through review", () => {
    const prev = base([memberCode("rm_new", "m-n", "new", { enabledAt: null, termsVersion: null })]);
    const next = base([memberCode("rm_new", "m-n", "new", { enabledAt: at(NOW + DAY) })]);
    expect(validateRegistryHistory(prev, next, NOW)).toEqual([]);
    const retro = base([memberCode("rm_new", "m-n", "new", { enabledAt: at(NOW - 1) })]);
    expect(validateRegistryHistory(prev, retro, NOW).join()).toContain("earlier than this revision's deployment");
  });

  test("deployment time, not approval time, decides: an activation approved in time but deployed late is rejected", () => {
    const next = base([...base().codes, memberCode("rm_bob", "m-b", "bob", { enabledAt: at(NOW + 3600) })]);
    expect(validateRegistryHistory(base(), next, NOW)).toEqual([]);
    expect(validateRegistryHistory(base(), next, NOW + 7200).join()).toContain("reschedule it through review");
  });

  test("deletion, reassignment, snapshot edits and edits to an active record are rejected", () => {
    expect(validateRegistryHistory(base(), base([]), NOW).join()).toContain("deleted");
    const reassigned = base([{ ...base().codes[0]!, beneficiary: { kind: "member", memberId: "m-z" } }]);
    expect(validateRegistryHistory(base(), reassigned, NOW).join()).toContain("reassigned");
    const renamed = base([{ ...base().codes[0]!, display: { handle: "alice", name: "Renamed" } }]);
    expect(validateRegistryHistory(base(), renamed, NOW).join()).toContain("display snapshot");
    const moved = base([{ ...base().codes[0]!, enabledAt: at(NOW - 5 * DAY) }]);
    expect(validateRegistryHistory(base(), moved, NOW).join()).toContain("activation is immutable");
    const terms = base([{ ...base().codes[0]!, termsVersion: "other" }]);
    expect(validateRegistryHistory(base(), terms, NOW).join()).toContain("terms are immutable");
  });

  test("disabling must be prospective; a scheduled disable may move, a taken-effect one may not", () => {
    const disabled = base([{ ...base().codes[0]!, disabledAt: at(NOW + DAY) }]);
    expect(validateRegistryHistory(base(), disabled, NOW)).toEqual([]);
    const retro = base([{ ...base().codes[0]!, disabledAt: at(NOW - DAY) }]);
    expect(validateRegistryHistory(base(), retro, NOW).join()).toContain("earlier than this revision's deployment");
    const moved = base([{ ...base().codes[0]!, disabledAt: at(NOW + 2 * DAY) }]);
    expect(validateRegistryHistory(disabled, moved, NOW)).toEqual([]);
    expect(validateRegistryHistory(disabled, moved, NOW + 3 * DAY).join()).toContain("immutable");
    expect(validateRegistryHistory(disabled, base(), NOW).join()).toContain("cannot be removed");
  });

  test("a scheduled record may be cancelled before activation, with its history kept", () => {
    const prev = base([memberCode("rm_s", "m-s", "s", { enabledAt: at(NOW + 5 * DAY) })]);
    const cancelled = base([{ ...prev.codes[0]!, cancelledAt: at(NOW + DAY) }]);
    expect(validateRegistryHistory(prev, cancelled, NOW)).toEqual([]);
    expect(validateRegistryHistory(prev, base([{ ...prev.codes[0]!, enabledAt: null }]), NOW).join()).toContain("cancelledAt, not removed");
    const tooLate = base([{ ...prev.codes[0]!, cancelledAt: at(NOW + 4 * DAY) }]);
    expect(validateRegistryHistory(prev, tooLate, NOW + 6 * DAY).join()).toContain("only a scheduled activation can be cancelled");
  });

  test("rejoining uses a new code and accepted terms; a scheduled replacement starts exactly at the disable", () => {
    const prev = base();
    const next = base([
      { ...prev.codes[0]!, disabledAt: at(NOW + DAY) },
      { ...memberCode("rm_alice-2", "m-a", "alice"), enabledAt: at(NOW + DAY), termsVersion: "2027-01" },
    ]);
    expect(validateRegistryHistory(prev, next, NOW)).toEqual([]);
  });

  test("the launch block is immutable once accepted", () => {
    expect(validateRegistryHistory(testRegistry([], 100), testRegistry([], 200), NOW).join()).toContain("launch block is immutable");
    expect(validateRegistryHistory(testRegistry([], null), testRegistry([], 200), NOW)).toEqual([]);
  });
});

describe("admin projection selection", () => {
  const old = memberCode("rm_a", "m", "a", { enabledAt: at(NOW - 30 * DAY), disabledAt: at(NOW + DAY) });
  const future = { ...memberCode("rm_a-2", "m", "a-2"), enabledAt: at(NOW + DAY) };
  test("the active code wins over its future replacement; a future code cannot masquerade as active", () => {
    expect(selectAdminRecord([future, old], NOW)!.code).toBe("rm_a");
    expect(selectAdminRecord([future, old], NOW + DAY)!.code).toBe("rm_a-2");
  });
  test("else the nearest scheduled, else the most recently disabled, else a draft; code order breaks ties", () => {
    const s1 = { ...memberCode("rm_x", "m", "x"), enabledAt: at(NOW + 5 * DAY) };
    const s2 = { ...memberCode("rm_y", "m", "y"), enabledAt: at(NOW + 2 * DAY) };
    expect(selectAdminRecord([s1, s2], NOW)!.code).toBe("rm_y");
    const d1 = memberCode("rm_d", "m", "d", { enabledAt: at(NOW - 9 * DAY), disabledAt: at(NOW - 5 * DAY) });
    const d2 = memberCode("rm_e", "m", "e", { enabledAt: at(NOW - 4 * DAY), disabledAt: at(NOW - 2 * DAY) });
    expect(selectAdminRecord([d1, d2], NOW)!.code).toBe("rm_e");
    const dr1 = memberCode("rm_q", "m", "q", { enabledAt: null });
    const dr2 = memberCode("rm_p", "m", "p", { enabledAt: null });
    expect(selectAdminRecord([dr1, dr2], NOW)!.code).toBe("rm_p");
    expect(selectAdminRecord([], NOW)).toBeNull();
  });
});

describe("manifest", () => {
  test("the test manifest is sound and complete; entries are never removed and their identity never changes", () => {
    const m = testManifest();
    expect(validateManifest(m)).toEqual([]);
    expect(manifestCoverageGaps(m)).toEqual([]);
    expect(validateManifestHistory(m, { ...m, entries: m.entries.slice(1) }).join()).toContain("removed");
    expect(validateManifestHistory(m, { ...m, entries: [{ ...m.entries[0]!, address: "0x" + "1".repeat(40) }, ...m.entries.slice(1)] }).join()).toContain("immutable");
  });
});

describe("the committed configuration", () => {
  const config = loadReferralConfig();

  test("validates against the previous accepted revision, deployed no earlier than now", () => {
    expect(validateWorkingConfig(config, Math.floor(Date.now() / 1000))).toEqual([]);
    expect(validateAcceptedRevisions(config.accepted)).toEqual([]);
  });

  test("ships with no active code and no launch block (spec §10: every code stays draft until owner acceptance)", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(config.registry.launch.blockNumber).toBeNull();
    for (const r of config.registry.codes) expect(codeStateAt(r, now)).toBe("draft");
  });

  test("the shipped manifest names v0 and every deployment-2 address, and admits its coverage is unresolved", () => {
    expect(validateManifest(config.manifest)).toEqual([]);
    expect(config.manifest.entries.map((e) => e.id)).toEqual(["v0-rmusdc", "d2-router", "d2-rmusdc", "d2-rmproto", "d2-rmagent", "d2-rmrwa"]);
    const v0 = readFileSync(join(import.meta.dir, "..", "src", "config.ts"), "utf8").match(/VAULT_ADDRESS \|\| "(0x[0-9a-f]{40})"/)![1];
    expect(config.manifest.entries[0]!.address).toBe(v0!);
    expect(manifestCoverageGaps(config.manifest).length).toBeGreaterThan(0);
  });

  test("an empty registry is the predecessor before any release carried one", () => {
    expect(validateRegistry(emptyRegistry())).toEqual([]);
    expect(normalizeReferralCode(" RM_ALICE ")).toBe("rm_alice");
  });
});
