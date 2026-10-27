// The public referral-code lookup and the admin referral projections (issue 1371,
// docs/technical/referrals-spec.md §5, §6, §9 rows "Member deactivated, or row
// removed", "` RM_ALICE ` versus `rm_a lice`" and "Public lookup/admin/public
// member DTOs"), against the REAL ephemeral Postgres tests/preload.ts provisions.
// No skip, no env gate. Registry records are synthetic and installed through the
// test seam; the committed registry ships with no active code.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeReferralCode } from "@robotmoney/contract";
import { setDatabase } from "../../src/db/client.ts";
import { handleAdmin } from "../../src/api/routes/admin.ts";
import { _resetReferralRateLimitForTests, handleReferrals } from "../../src/api/routes/referrals.ts";
import { listMembersAdmin } from "../../src/swarm/admin.ts";
import { loadReferralConfig, type ReferralConfig } from "../../src/referrals/config-files.ts";
import { _setReferralConfigForTests, memberReferral } from "../../src/referrals/lookup.ts";
import { useCleanDatabase } from "../support/clean-db.ts";
import { fixtureDb } from "../support/fixture-db.ts";
import { provisionOperatorToken } from "../support/automation-auth.ts";
import { ALICE, KEYS, channelCode, log, memberCode, overrideCorrection, testRegistry, verifiedCorrection } from "../support/referral-fixtures.ts";

useCleanDatabase(import.meta.file);

const iso = (s: number) => new Date(s * 1000).toISOString().replace(".000Z", "Z");
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;

const REGISTRY = testRegistry([
  memberCode("rm_alice", "m-alice", "alice", { enabledAt: iso(NOW - DAY) }),
  memberCode("rm_gone", "m-gone", "gone", { enabledAt: iso(NOW - DAY) }),
  memberCode("rm_left", "m-left", "left", { enabledAt: iso(NOW - DAY) }),
  memberCode("rm_draft", "m-draft", "draft", { enabledAt: null, termsVersion: null }),
  memberCode("rm_soon", "m-soon", "soon", { enabledAt: iso(NOW + DAY) }),
  memberCode("rm_was", "m-was", "was", { enabledAt: iso(NOW - 3 * DAY), disabledAt: iso(NOW - DAY) }),
  channelCode("rm_team", "team", { enabledAt: iso(NOW - DAY) }),
]);

function install(over: Partial<ReferralConfig> = {}): void {
  _setReferralConfigForTests({ ...loadReferralConfig(), registry: REGISTRY, ...over });
}

let ipCounter = 0;
async function get(path: string, init: RequestInit = {}, ip = `203.0.113.${++ipCounter % 250}`): Promise<Response> {
  const req = new Request(`http://api.test${path}`, init);
  return handleReferrals(req, new URL(req.url), ip);
}

beforeAll(async () => {
  for (const [id, handle, name, status] of [
    ["m-alice", "alice", "Alice", "active"],
    ["m-left", "left", "Left", "inactive"],
    ["m-draft", "draft", "Draft", "active"],
    ["m-soon", "soon", "Soon", "active"],
    ["m-was", "was", "Was", "active"],
  ]) {
    await fixtureDb`INSERT INTO swarm_members (id, handle, name, status) VALUES (${id!}, ${handle!}, ${name!}, ${status!})`;
  }
});
beforeEach(() => {
  install();
  _resetReferralRateLimitForTests();
});
afterAll(() => _setReferralConfigForTests(null));

describe("GET /api/referrals/codes/:code", () => {
  test("an active member code answers exactly { code, member: { handle, name } }, cacheable 60 s", async () => {
    const res = await get("/api/referrals/codes/rm_alice");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    expect(await res.text()).toBe(JSON.stringify({ code: "rm_alice", member: { handle: "alice", name: "Alice" } }));
  });

  test("an active team channel code answers exactly { code, channel }", async () => {
    const res = await get("/api/referrals/codes/rm_team");
    expect(await res.json()).toEqual({ code: "rm_team", channel: "team" });
  });

  test("the shared normalizer: ` RM_ALICE ` resolves, `rm_a lice` fails unchanged (shared fixture file)", async () => {
    expect((await get(`/api/referrals/codes/${encodeURIComponent(" RM_ALICE ")}`)).status).toBe(200);
    expect((await get(`/api/referrals/codes/${encodeURIComponent("rm_a lice")}`)).status).toBe(404);
    const fixture = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "..", "contract", "src", "__fixtures__", "referral-codes.json"), "utf8")) as { cases: { input: string; normalized: string | null }[] };
    for (const c of fixture.cases) {
      expect(normalizeReferralCode(c.input)).toBe(c.normalized);
      const res = await get(`/api/referrals/codes/${encodeURIComponent(c.input)}`);
      expect(res.status, JSON.stringify(c.input)).toBe(c.normalized === "rm_alice" ? 200 : 404);
    }
  });

  test("unknown, malformed, draft, scheduled, disabled, deactivated-member and missing-member codes are one identical 404", async () => {
    const errors: string[] = [];
    const realError = console.error;
    console.error = (...a: unknown[]) => void errors.push(a.join(" "));
    try {
      const paths = ["rm_nobody", "nope", "rm_draft", "rm_soon", "rm_was", "rm_left", "rm_gone", "rm_", "rm_%25", "rm_*", "%E0%A4%A"].map((c) => `/api/referrals/codes/${c}`);
      paths.push("/api/referrals/codes", "/api/referrals/codes/", "/api/referrals/codes/rm_alice/x", "/api/referrals/", "/api/referrals/list");
      for (const p of paths) {
        const res = await get(p);
        expect(res.status, p).toBe(404);
        expect(res.headers.get("cache-control"), p).toBe("public, max-age=60");
        expect(await res.text(), p).toBe('{"error":"not found"}');
      }
    } finally {
      console.error = realError;
    }
    // The missing member row is also an operational integrity error.
    expect(errors.join("\n")).toContain("referral integrity error: active code rm_gone names member m-gone");
  });

  test("the answer does not depend on cookies or authorization", async () => {
    const plain = await (await get("/api/referrals/codes/rm_alice")).text();
    const withCreds = await (await get("/api/referrals/codes/rm_alice", { headers: { Cookie: "rm_admin=1", Authorization: "Bearer x", "X-Admin-Token": "x" } })).text();
    expect(withCreds).toBe(plain);
  });

  test("100 requests per 60 s per client ip, then 429 with integer Retry-After and no-store; another ip is unaffected", async () => {
    for (let i = 0; i < 100; i++) expect((await get("/api/referrals/codes/rm_nobody", {}, "198.51.100.7")).status).toBe(404);
    const limited = await get("/api/referrals/codes/rm_alice", {}, "198.51.100.7");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("cache-control")).toBe("no-store");
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(await limited.json()).toEqual({ error: "rate limit exceeded" });
    expect((await get("/api/referrals/codes/rm_alice", {}, "198.51.100.8")).status).toBe(200);
  });

  test("only GET", async () => {
    const res = await get("/api/referrals/codes/rm_alice", { method: "POST" });
    expect(res.status).toBe(405);
  });

  test("a dependency failure is 503 { error: \"service unavailable\" }, no-store", async () => {
    const original = process.env.DATABASE_URL!;
    const realError = console.error;
    console.error = () => {};
    await setDatabase("postgres://rm_app:x@127.0.0.1:9/unreachable");
    try {
      const res = await get("/api/referrals/codes/rm_alice");
      expect(res.status).toBe(503);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({ error: "service unavailable" });
      // A channel code needs no database: it still answers.
      expect((await get("/api/referrals/codes/rm_team")).status).toBe(200);
    } finally {
      console.error = realError;
      await setDatabase(original);
    }
  });
});

describe("admin projections", () => {
  test("AdminMember.referral carries code, state, enabled, terms and times; members without a code get null", async () => {
    const members = await listMembersAdmin();
    const by = (id: string) => members.find((m) => m.id === id)!;
    expect(by("m-alice").referral).toEqual({ code: "rm_alice", state: "active", enabled: true, termsVersion: "2026-10", enabledAt: iso(NOW - DAY), disabledAt: null });
    expect(by("m-soon").referral).toMatchObject({ state: "scheduled", enabled: false });
    expect(by("m-was").referral).toMatchObject({ state: "disabled", enabled: false, disabledAt: iso(NOW - DAY) });
    expect(by("m-draft").referral).toMatchObject({ state: "draft", enabled: false, enabledAt: null });
    expect(memberReferral("m-nobody")).toBeNull();
  });

  test("enabled is exactly state === 'active' for every record", () => {
    for (const r of REGISTRY.codes) {
      if (r.beneficiary.kind !== "member") continue;
      const p = memberReferral(r.beneficiary.memberId)!;
      expect(p.enabled).toBe(p.state === "active");
    }
  });

  test("public swarm member responses carry no referral field", async () => {
    const contract = readFileSync(join(import.meta.dir, "..", "..", "..", "contract", "src", "swarm.d.ts"), "utf8");
    expect(contract.toLowerCase()).not.toContain("referral");
  });

  test("GET /api/admin/referrals/corrections is privileged and shows the log read-only with its checks", async () => {
    const token = await provisionOperatorToken();
    const ok = verifiedCorrection("c-1", ALICE, KEYS.alice, "rm_alice", "0x" + "ab".repeat(32), 2, iso(NOW - 3600));
    const bad = verifiedCorrection("c-2", "0x" + "be".repeat(20), null, "rm_alice", "0x" + "cd".repeat(32), 2, iso(NOW - 60), { signature: "0x00" });
    const over = overrideCorrection("o-1", "0x" + "ce".repeat(20), "rm_team", "0x" + "ef".repeat(32), 4, iso(NOW - 30));
    const rev = { type: "revocation" as const, id: "r-1", revokes: "o-1", recordedAt: iso(NOW - 10), recordedBy: "ops", reason: "withdrawn" };
    install({ corrections: log([ok, bad, over, rev]) });
    const call = (headers: Record<string, string>) => {
      const req = new Request("http://x/api/admin/referrals/corrections", { headers });
      return handleAdmin(req, new URL(req.url));
    };
    expect((await call({}))?.status).toBe(403);
    const res = await call({ "X-Admin-Token": token });
    expect(res?.status).toBe(200);
    const body = res!.body as { corrections: any[]; logDigest: string };
    expect(body.logDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(body.corrections.map((c) => [c.id, c.check.status])).toEqual([["c-1", "accepted"], ["c-2", "rejected"], ["o-1", "accepted"]]);
    expect(body.corrections[0].signature.message).toContain("Robot Money referral correction");
    expect(body.corrections[2].revocation).toMatchObject({ id: "r-1", recordedBy: "ops", reason: "withdrawn" });
    const post = new Request("http://x/api/admin/referrals/corrections", { method: "POST", headers: { "X-Admin-Token": token } });
    const posted = await handleAdmin(post, new URL(post.url));
    expect(posted === null || posted.status === 404 || posted.status === 405).toBe(true);
  });
});
