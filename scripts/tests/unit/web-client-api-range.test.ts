// D54 (issue #1026 W7, criteria 160 and 163): the site declares the API range it
// accepts, publishes it in /version.json, and CI fails when that range excludes
// the contract version built from the same tree. The browser half of the rule —
// lib/api-compat.js, which the page runs at load — is graded here too, row by
// row against Bun.semver.satisfies, so the page and the Bun-side tools
// (scripts/lib/api-range.ts: CI now, `bun smoke` / `bun smoke:web` in wave 4)
// cannot disagree about what a range admits.
//
// Listed in frontend/test/unit.list (it executes client JS), so the web-client
// gate runs it as well as the root unit tier.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  apiVersionInRange,
  isValidApiRange,
  readContractVersion,
  readFrontendApiRange,
  readSiteApiRange,
} from "../../lib/api-range.ts";
import { checkApiRange } from "../../web-client/api-range.ts";
import { webClientVersion } from "../../web-client/version.ts";
import {
  apiVersionSatisfies,
  checkApiCompat,
} from "../../../frontend/public/assets/js/app/lib/api-compat.js";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const CLI = join(repoRoot, "scripts/web-client/api-range.ts");

const scratch: string[] = [];
afterAll(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });

/** A throwaway tree with just the two manifests the rule reads. */
function tree(contractVersion: string, frontend: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "web-client-api-range-"));
  scratch.push(dir);
  mkdirSync(join(dir, "contract"));
  mkdirSync(join(dir, "frontend"));
  writeFileSync(join(dir, "contract/package.json"), JSON.stringify({ name: "@robotmoney/contract", version: contractVersion }));
  writeFileSync(join(dir, "frontend/package.json"), JSON.stringify({ name: "@robotmoney/web-client", version: "0.1.0", ...frontend }));
  return dir;
}

function runCli(root: string): { code: number; out: string } {
  const r = Bun.spawnSync(["bun", CLI, "--root", root], { stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}

// ── The declaration and the CI check (criterion 160) ────────────────────────
describe("frontend/package.json declares an API range that admits this tree's contract", () => {
  test("the repo's own range is declared, readable, and admits contract/package.json's version", () => {
    const range = readFrontendApiRange();
    expect(range).not.toBeNull();
    expect(isValidApiRange(range)).toBe(true);
    const version = readContractVersion();
    expect(apiVersionInRange(version, range)).toBe(true);
    expect(runCli(repoRoot)).toEqual({ code: 0, out: `apiRange "${range}" admits contract version ${version}.\n` });
  });

  test("in range passes", () => {
    const root = tree("0.2.3", { apiRange: "^0.2.0" });
    expect(checkApiRange(root).ok).toBe(true);
    expect(runCli(root).code).toBe(0);
  });

  test("out of range fails, naming both the range and the version", () => {
    const root = tree("0.3.0", { apiRange: "^0.2.0" });
    const result = checkApiRange(root);
    expect(result.ok).toBe(false);
    const { code, out } = runCli(root);
    expect(code).toBe(1);
    expect(out).toContain("^0.2.0");
    expect(out).toContain("0.3.0");
  });

  test("a missing range fails, naming the contract version", () => {
    const root = tree("0.2.0", {});
    expect(checkApiRange(root)).toMatchObject({ ok: false, apiRange: null, apiVersion: "0.2.0" });
    const { code, out } = runCli(root);
    expect(code).toBe(1);
    expect(out).toContain("no apiRange");
    expect(out).toContain("0.2.0");
  });

  test("a range the site cannot read fails rather than admitting everything", () => {
    // Bun.semver.satisfies("0.2.0", "garbage") is TRUE. That is the reason the
    // grammar check sits in front of it; this row is its red control.
    expect(Bun.semver.satisfies("0.2.0", "garbage")).toBe(true);
    for (const apiRange of ["garbage", "", "  ", "^0.2", "0.2.x", "^0.2.0 || ^0.3.0", "v0.2.0"]) {
      const root = tree("0.2.0", { apiRange });
      expect({ apiRange, ok: checkApiRange(root).ok }).toEqual({ apiRange, ok: false });
      expect({ apiRange, code: runCli(root).code }).toEqual({ apiRange, code: 1 });
    }
  });

  test("a lowered or excluded contract version is caught the same way", () => {
    expect(checkApiRange(tree("0.1.9", { apiRange: "^0.2.0" })).ok).toBe(false);
    expect(checkApiRange(tree("1.0.0", { apiRange: ">=0.2.0 <1.0.0" })).ok).toBe(false);
    expect(checkApiRange(tree("0.9.9", { apiRange: ">=0.2.0 <1.0.0" })).ok).toBe(true);
  });
});

describe("/version.json carries apiRange", () => {
  test("webClientVersion() publishes frontend/package.json's range", async () => {
    const v = await webClientVersion();
    expect(v.apiRange).toBe(readFrontendApiRange());
    expect(Object.keys(v).sort()).toEqual(["apiRange", "commit", "name", "version"]);
  });

  test("a manifest with no range publishes null, never a default", async () => {
    const root = tree("0.2.0", {});
    expect((await webClientVersion(root)).apiRange).toBeNull();
  });

  test("the CLI static-assembly.sh writes /version.json from prints the range", () => {
    const r = Bun.spawnSync(["bun", join(repoRoot, "scripts/web-client/version.ts")], { stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout.toString()).apiRange).toBe(readFrontendApiRange());
    expect(readFileSync(join(repoRoot, "scripts/static-assembly.sh"), "utf8")).toContain(
      'bun scripts/web-client/version.ts > "$OUT/version.json"',
    );
  });

  test("the preview server answers /version.json with the range", async () => {
    const proc = Bun.spawn(["bun", join(repoRoot, "scripts/preview-server.ts")], {
      cwd: repoRoot,
      env: { ...process.env, PORT: "0" },
      stdout: "pipe",
      stderr: "ignore",
    });
    try {
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
      let out = "";
      let url: string | null = null;
      const deadline = Date.now() + 15_000;
      while (!url && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        out += new TextDecoder().decode(value);
        url = out.match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0] ?? null;
      }
      expect(url).not.toBeNull();
      const res = await fetch(`${url}version.json`);
      expect(res.headers.get("content-type")).toContain("application/json");
      const body = await res.json();
      expect(readSiteApiRange(body)).toBe(readFrontendApiRange());
    } finally {
      proc.kill();
    }
  });

  test("readSiteApiRange: a body with no range, or no body, declares none", () => {
    expect(readSiteApiRange({ apiRange: "^0.2.0" })).toBe("^0.2.0");
    expect(readSiteApiRange({ name: "x" })).toBeNull();
    expect(readSiteApiRange({ apiRange: "" })).toBeNull();
    expect(readSiteApiRange(null)).toBeNull();
    expect(readSiteApiRange("^0.2.0")).toBeNull();
    // …and no declared range is outside every range.
    expect(apiVersionInRange("0.2.0", readSiteApiRange({}))).toBe(false);
  });
});

describe("web-client.yml runs the check and re-runs on a contract bump", () => {
  const wf = readFileSync(join(repoRoot, ".github/workflows/web-client.yml"), "utf8");

  test("a blocking step runs the CLI", () => {
    const line = wf.split("\n").find((l) => l.includes("bun scripts/web-client/api-range.ts"));
    expect(line).toBeDefined();
    // Blocking: the step that runs it is not continue-on-error.
    const at = wf.indexOf("bun scripts/web-client/api-range.ts");
    const stepStart = wf.lastIndexOf("- name:", at);
    expect(wf.slice(stepStart, at)).not.toContain("continue-on-error");
  });

  test("the paths filter selects the files the check reads", () => {
    for (const p of ["'contract/package.json'", "'scripts/web-client/**'", "'scripts/lib/api-range.ts'", "'frontend/**'"]) {
      expect(wf).toContain(p);
    }
  });
});

// ── The browser matcher (criterion 163) ─────────────────────────────────────
// Every VALID row must agree with Bun.semver.satisfies exactly. Rows are chosen
// around each operator's edges: the lower bound, just under it, the exclusive
// upper bound, and just under that — for ^ on each of its three 0.x shapes.
const VALID: Array<[string, string]> = [
  ["0.2.0", "^0.2.0"], ["0.2.9", "^0.2.0"], ["0.3.0", "^0.2.0"], ["0.1.9", "^0.2.0"], ["1.0.0", "^0.2.0"],
  ["0.2.3", "^0.2.3"], ["0.2.2", "^0.2.3"], ["0.2.99", "^0.2.3"],
  ["0.0.3", "^0.0.3"], ["0.0.4", "^0.0.3"], ["0.0.2", "^0.0.3"],
  ["1.2.3", "^1.2.3"], ["1.9.0", "^1.2.3"], ["2.0.0", "^1.2.3"], ["1.2.2", "^1.2.3"],
  ["0.2.0", "~0.2.0"], ["0.2.7", "~0.2.0"], ["0.3.0", "~0.2.0"],
  ["1.2.3", "~1.2.3"], ["1.2.9", "~1.2.3"], ["1.3.0", "~1.2.3"], ["1.2.2", "~1.2.3"],
  ["0.2.0", ">=0.2.0"], ["0.1.9", ">=0.2.0"], ["5.0.0", ">=0.2.0"],
  ["0.2.0", ">0.2.0"], ["0.2.1", ">0.2.0"],
  ["0.2.0", "<=0.2.0"], ["0.2.1", "<=0.2.0"],
  ["0.2.9", "<0.3.0"], ["0.3.0", "<0.3.0"],
  ["0.2.0", "0.2.0"], ["0.2.1", "0.2.0"], ["0.2.0", "=0.2.0"], ["0.2.1", "=0.2.0"],
  ["0.5.0", ">=0.2.0 <1.0.0"], ["1.0.0", ">=0.2.0 <1.0.0"], ["0.1.0", ">=0.2.0 <1.0.0"],
  ["0.2.5", "^0.2.0 >=0.2.4"], ["0.2.3", "^0.2.0 >=0.2.4"],
  ["10.20.30", "^10.20.0"], ["10.21.0", "~10.20.0"],
  // Prerelease versions satisfy none of these: no comparator carries a tag.
  ["0.2.1-rc.1", "^0.2.0"], ["0.2.0-rc.1", ">=0.1.0"], ["0.3.0-alpha", "<1.0.0"], ["0.2.0-rc.1", "0.2.0"],
];

// Outside the grammar on one side or the other: the browser says "don't know"
// (null, which never blocks the page) and the Bun side says "outside every
// range" (false, which fails CI and refuses a deploy).
const INVALID: Array<[unknown, unknown]> = [
  ["0.2.0", "garbage"], ["0.2.0", ""], ["0.2.0", "^0.2"], ["0.2.0", "0.2.x"], ["0.2.0", "^0.2.0 || ^0.3.0"],
  ["0.2.0", ">= 0.2.0"], ["0.2.0", "v0.2.0"], ["0.2.0", "^01.2.0"], ["0.2.0", null], ["0.2.0", 2],
  ["v0.2.0", "^0.2.0"], ["0.2", "^0.2.0"], ["01.2.0", "^1.0.0"], ["", "^0.2.0"], [null, "^0.2.0"], ["0.2.0+build", "^0.2.0"],
];

describe("lib/api-compat.js matches Bun.semver.satisfies", () => {
  test("the table is not vacuous: both outcomes occur", () => {
    const outcomes = new Set(VALID.map(([v, r]) => Bun.semver.satisfies(v, r)));
    expect(outcomes).toEqual(new Set([true, false]));
  });

  for (const [version, range] of VALID) {
    test(`${version} vs "${range}"`, () => {
      const bun = Bun.semver.satisfies(version, range);
      expect(apiVersionSatisfies(version, range)).toBe(bun);
      expect(apiVersionInRange(version, range)).toBe(bun);
    });
  }

  test("inputs outside the grammar: the browser does not know, the Bun side refuses", () => {
    for (const [version, range] of INVALID) {
      expect({ version, range, browser: apiVersionSatisfies(version, range) }).toEqual({ version, range, browser: null });
      expect({ version, range, bun: apiVersionInRange(version as string, range as string) }).toEqual({ version, range, bun: false });
    }
  });

  test("red control: a matcher that ignored ^'s 0.x rule would disagree with Bun on this table", () => {
    // ^0.2.0 read as >=0.2.0 <1.0.0 (the 1.x rule applied to 0.x) admits 0.3.0.
    const naive = (v: string) => Bun.semver.satisfies(v, ">=0.2.0 <1.0.0");
    const disagreements = VALID.filter(([v, r]) => r === "^0.2.0" && naive(v) !== Bun.semver.satisfies(v, r));
    expect(disagreements.length).toBeGreaterThan(0);
  });
});

describe("checkApiCompat reads both sides and blocks only on a readable mismatch", () => {
  type Answer = { status?: number; type?: string; body?: unknown; throws?: boolean; hang?: boolean };
  function fakeFetch(answers: Record<string, Answer>) {
    const calls: string[] = [];
    const impl = async (url: string, init?: RequestInit): Promise<Response> => {
      calls.push(url);
      const a = answers[url];
      if (!a || a.throws) throw new TypeError("Failed to fetch");
      if (a.hang) {
        return new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      }
      return new Response(typeof a.body === "string" ? a.body : JSON.stringify(a.body), {
        status: a.status ?? 200,
        headers: { "content-type": a.type ?? "application/json" },
      });
    };
    return { impl, calls };
  }
  const SITE = "/version.json";
  const API = "/api/version";
  const site = (apiRange?: string): Answer => ({ body: { name: "@robotmoney/web-client", version: "0.1.0", commit: "abc", ...(apiRange ? { apiRange } : {}) } });
  const check = (answers: Record<string, Answer>, timeoutMs?: number) => {
    const f = fakeFetch(answers);
    return checkApiCompat({ siteVersionUrl: SITE, apiVersionUrl: API, fetch: f.impl, timeoutMs }).then((r) => ({ ...r, calls: f.calls }));
  };

  test("in range: compatible", async () => {
    const r = await check({ [SITE]: site("^0.2.0"), [API]: { body: { api: "0.2.4", commit: null } } });
    expect(r).toMatchObject({ status: "compatible", api: "0.2.4", range: "^0.2.0" });
    expect(r.calls.sort()).toEqual([API, SITE]);
  });

  test("outside the range: incompatible, carrying both values", async () => {
    const r = await check({ [SITE]: site("^0.2.0"), [API]: { body: { api: "0.3.0", commit: "x" } } });
    expect(r).toMatchObject({ status: "incompatible", api: "0.3.0", range: "^0.2.0" });
  });

  test("an API that cannot answer is unknown, never incompatible", async () => {
    for (const apiAnswer of [
      { throws: true },
      { status: 404, body: { error: "not found" } },
      { status: 503, body: { error: "database unavailable" } },
      { status: 200, type: "text/html", body: "<!doctype html><html></html>" },
      { status: 200, body: { commit: "x" } },
    ] as Answer[]) {
      const r = await check({ [SITE]: site("^0.2.0"), [API]: apiAnswer });
      expect({ apiAnswer, status: r.status }).toEqual({ apiAnswer, status: "unknown" });
    }
  });

  test("a site with no readable range is unknown", async () => {
    expect((await check({ [SITE]: site(), [API]: { body: { api: "9.0.0" } } })).status).toBe("unknown");
    expect((await check({ [SITE]: { status: 404, body: {} }, [API]: { body: { api: "9.0.0" } } })).status).toBe("unknown");
    expect((await check({ [SITE]: site("garbage"), [API]: { body: { api: "9.0.0" } } })).status).toBe("unknown");
  });

  test("a hung request is bounded and reads as unknown", async () => {
    const started = Date.now();
    const r = await check({ [SITE]: site("^0.2.0"), [API]: { hang: true } }, 50);
    expect(r.status).toBe("unknown");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("no API base configured: unknown, and nothing fetched", async () => {
    const f = fakeFetch({});
    const r = await checkApiCompat({ siteVersionUrl: SITE, apiVersionUrl: null, fetch: f.impl });
    expect(r.status).toBe("unknown");
    expect(f.calls).toEqual([]);
  });
});

describe("the preview golden stays inside the declared range", () => {
  test("goldens/api-goldens.json answers /api/version with an API this site accepts", () => {
    const goldens = JSON.parse(readFileSync(join(repoRoot, "goldens/api-goldens.json"), "utf8")) as {
      routes: Record<string, { api?: string; commit?: string | null }>;
    };
    const golden = goldens.routes["/api/version"];
    expect(golden).toBeDefined();
    expect(Object.keys(golden!).sort()).toEqual(["api", "commit"]);
    expect(apiVersionSatisfies(golden!.api, readFrontendApiRange())).toBe(true);
  });
});
