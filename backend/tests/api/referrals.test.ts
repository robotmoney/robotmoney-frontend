// GET /api/referrals/codes/:code (issue 1358, Linear RM-174), against the REAL
// ephemeral Postgres tests/preload.ts provisions. No skip, no env gate.
//
// Most cases drive handleReferrals, the exact handler api/index.ts hands every
// /api/referrals/ request to, with fixture codes injected through the test seam
// (REFERRAL_CODES is empty in config). The member lookup runs as rm_app, the
// shared pool's session role, against real swarm_members rows. The last describe
// boots the real api process and goes over HTTP, because routing and CORS live
// in index.ts and the handler cannot prove them.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { ROUTES } from "@robotmoney/contract";
import { sql } from "../../src/db/client.ts";
import { _resetReferralRateLimitForTests, handleReferrals, REFERRAL_RATE_MAX } from "../../src/api/routes/referrals.ts";
import { _setReferralCodesForTests } from "../../src/referrals/check.ts";
import type { ReferralCodeEntry } from "../../src/referrals/codes.ts";
import { useCleanDatabase } from "../support/clean-db.ts";
import { bootApi, type ApiProcess } from "../support/automation-auth.ts";

useCleanDatabase(import.meta.file);

const MEMBER_ID = `ref_member_${crypto.randomUUID().slice(0, 8)}`;
const MEMBER_HANDLE = `refhandle-${crypto.randomUUID().slice(0, 6)}`;
const MEMBER_NAME = "Referral Member";
const GONE_ID = `ref_gone_${crypto.randomUUID().slice(0, 8)}`;

const PAST = "2026-01-01T00:00:00Z";
const FUTURE = "2999-01-01T00:00:00Z";

function entry(code: string, over: Partial<ReferralCodeEntry>): ReferralCodeEntry {
  return { code, memberId: null, channel: null, termsVersion: null, enabledAt: null, disabledAt: null, ...over };
}

const CODES: ReferralCodeEntry[] = [
  entry("rm_member-on", { memberId: MEMBER_ID, termsVersion: "v1", enabledAt: PAST }),
  entry("rm_site", { channel: "site", enabledAt: PAST }),
  entry("rm_never-on", { memberId: MEMBER_ID, termsVersion: "v1" }),
  entry("rm_not-yet", { channel: "x", enabledAt: FUTURE }),
  entry("rm_switched-off", { channel: "y", enabledAt: PAST, disabledAt: "2026-02-01T00:00:00Z" }),
  entry("rm_member-gone", { memberId: GONE_ID, termsVersion: "v1", enabledAt: PAST }),
];

beforeAll(async () => {
  await sql`INSERT INTO swarm_members (id, handle, name, status) VALUES (${MEMBER_ID}, ${MEMBER_HANDLE}, ${MEMBER_NAME}, 'active')`;
});
beforeEach(() => {
  _setReferralCodesForTests(CODES);
  _resetReferralRateLimitForTests();
});
afterEach(() => {
  _setReferralCodesForTests(null);
  _resetReferralRateLimitForTests();
});

let ipCounter = 0;
/** One request through the handler, from a fresh ip unless one is named. */
async function get(path: string, ip = `198.51.100.${++ipCounter % 250}`, method = "GET"): Promise<Response> {
  const req = new Request(`http://api.test${path}`, { method });
  return handleReferrals(req, new URL(req.url), ip);
}
const codePath = (code: string) => `/api/referrals/codes/${code}`;

describe("an on code answers 200 with exactly one code", () => {
  test("a member code names the member's handle and name, read from swarm_members", async () => {
    const res = await get(codePath("rm_member-on"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ code: "rm_member-on", member: { handle: MEMBER_HANDLE, name: MEMBER_NAME } });
  });

  test("a team code names its channel", async () => {
    const res = await get(codePath("rm_site"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ code: "rm_site", channel: "site" });
  });

  test("the code is matched case-insensitively and answered lowercase", async () => {
    const res = await get(codePath("RM_Member-ON"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { code: string }).code).toBe("rm_member-on");
  });

  test("ROUTES.referrals.code is the path the handler serves", async () => {
    const res = await get(ROUTES.referrals.code.replace(":code", "rm_site"));
    expect(res.status).toBe(200);
  });
});

describe("every code that is not on answers the same 404", () => {
  const NOT_ON = [
    "rm_unknown",          // not listed
    "rm_never-on",         // enabledAt null
    "rm_not-yet",          // enabledAt in the future
    "rm_switched-off",     // disabledAt in the past
    "rm_member-gone",      // member row missing
    "not-a-code",          // malformed: no rm_ prefix
    "rm_bad!code",         // malformed: character outside the slug
    "rm_" + "a".repeat(40), // malformed: over 32 characters
    "%E0%A4%A",            // malformed percent-encoding
  ];

  test("unknown, off, malformed and member-row-missing codes are byte-identical 404s", async () => {
    const reference = await get(codePath("rm_unknown"));
    const refBody = await reference.text();
    expect(reference.status).toBe(404);
    expect(JSON.parse(refBody)).toEqual({ error: "not found" });
    for (const code of NOT_ON) {
      const res = await get(codePath(code));
      expect(res.status, code).toBe(404);
      expect(await res.text(), code).toBe(refBody);
      expect(res.headers.get("Content-Type"), code).toBe(reference.headers.get("Content-Type"));
      expect(res.headers.get("Cache-Control"), code).toBe(reference.headers.get("Cache-Control"));
    }
  });
});

describe("the route never lists codes or members", () => {
  test("bare, trailing-slash, prefix, wildcard and nested paths answer the same 404", async () => {
    const refBody = await (await get(codePath("rm_unknown"))).text();
    for (const path of [
      "/api/referrals/codes",
      "/api/referrals/codes/",
      "/api/referrals/",
      "/api/referrals/members",
      codePath("rm_"),
      codePath("rm_%25"),
      codePath("rm_%"),
      codePath("rm_*"),
      codePath("rm_member-on/extra"),
      codePath("rm_member-on,rm_site"),
    ]) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).toBe(refBody);
    }
  });

  test("no 200 body carries more than one code or member", async () => {
    for (const code of ["rm_member-on", "rm_site"]) {
      const body = (await (await get(codePath(code))).json()) as Record<string, unknown>;
      const keys = Object.keys(body).sort();
      expect(keys).toEqual(code === "rm_site" ? ["channel", "code"] : ["code", "member"]);
      const text = JSON.stringify(body);
      expect(text.match(/rm_/g)?.length).toBe(1);
      if ("member" in body) expect(Object.keys(body.member as object).sort()).toEqual(["handle", "name"]);
    }
  });
});

describe("cache and rate limit", () => {
  test("200 and 404 carry Cache-Control: public, max-age=60", async () => {
    expect((await get(codePath("rm_site"))).headers.get("Cache-Control")).toBe("public, max-age=60");
    expect((await get(codePath("rm_unknown"))).headers.get("Cache-Control")).toBe("public, max-age=60");
    expect((await get("/api/referrals/codes")).headers.get("Cache-Control")).toBe("public, max-age=60");
  });

  test("request 101 from one ip inside 60 s answers 429 with Retry-After; another ip is unaffected", async () => {
    expect(REFERRAL_RATE_MAX).toBe(100);
    const ip = "203.0.113.77";
    for (let i = 0; i < 100; i++) expect((await get(codePath("rm_unknown"), ip)).status).toBe(404);
    const limited = await get(codePath("rm_site"), ip);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    expect(limited.headers.get("Cache-Control")).toBe("no-store");
    expect((await get(codePath("rm_site"), "203.0.113.78")).status).toBe(200);
  });

  test("a write method is refused 405 and never reads a code", async () => {
    const res = await get(codePath("rm_site"), undefined, "POST");
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET");
  });
});

describe("check.ts holds one check: PR 1370's helpers and no pattern of its own", () => {
  const source = readFileSync(join(import.meta.dir, "..", "..", "src", "referrals", "check.ts"), "utf8");
  const sf = ts.createSourceFile("check.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  test("imports isReferralCodeFormat and normalizeReferralCode from suffix.ts, findReferralCode and referralCodeState from codes.ts", () => {
    const imported = new Map<string, string[]>();
    for (const s of sf.statements) {
      if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier)) continue;
      const named = s.importClause?.namedBindings;
      if (named && ts.isNamedImports(named)) imported.set(s.moduleSpecifier.text, named.elements.map((e) => e.name.text));
    }
    expect(imported.get("./suffix.ts")).toEqual(expect.arrayContaining(["isReferralCodeFormat", "normalizeReferralCode"]));
    expect(imported.get("./codes.ts")).toEqual(expect.arrayContaining(["findReferralCode", "referralCodeState"]));
  });

  test("contains no regex literal and no RegExp", () => {
    const found: string[] = [];
    const visit = (n: ts.Node): void => {
      if (n.kind === ts.SyntaxKind.RegularExpressionLiteral) found.push(n.getText(sf));
      if (ts.isIdentifier(n) && n.text === "RegExp") found.push("RegExp");
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(found).toEqual([]);
    // Non-vacuous: the walk does see a regex when one is there.
    const planted = ts.createSourceFile("p.ts", "const r = /^rm_/; new RegExp('x');", ts.ScriptTarget.Latest, true);
    const seen: string[] = [];
    const v2 = (n: ts.Node): void => {
      if (n.kind === ts.SyntaxKind.RegularExpressionLiteral) seen.push("lit");
      if (ts.isIdentifier(n) && n.text === "RegExp") seen.push("ctor");
      ts.forEachChild(n, v2);
    };
    v2(planted);
    expect(seen).toEqual(["lit", "ctor"]);
  });
});

describe("over HTTP through the real api process", () => {
  let api: ApiProcess;
  beforeAll(async () => {
    api = await bootApi();
  }, 90_000);
  afterAll(() => api?.stop());

  test("index.ts routes /api/referrals/ to the handler: a 404 with the cache header, readable cross-origin", async () => {
    // REFERRAL_CODES is empty in config, so every code is not on in this process.
    for (const path of [codePath("rm_site"), "/api/referrals/codes"]) {
      const res = await fetch(`${api.base}${path}`, { headers: { Origin: "https://elsewhere.example" } });
      expect(res.status, path).toBe(404);
      expect(await res.json()).toEqual({ error: "not found" });
      expect(res.headers.get("Cache-Control"), path).toBe("public, max-age=60");
      expect(res.headers.get("Access-Control-Allow-Origin"), path).toBe("*");
    }
  }, 30_000);
});
