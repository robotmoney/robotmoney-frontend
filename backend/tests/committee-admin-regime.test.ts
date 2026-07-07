// Placeholder for the Demo readiness gate phase (issue #63, dev-scout). Reserves
// the CI seam for the POST /api/committee/admin/regime handler's dedicated test
// file so #59 can land its tools-array scoping assertion without also owning
// file creation. #59 extends this file; it does not need to build the harness.
//
// Dispatches through handleCommittee in-process (the same pattern authz.test.ts
// uses) rather than over HTTP, and pins ANALYTICS_SOURCE=hermetic so the run
// never touches the network (mirrors hermetic-source.test.ts).
import { test, expect, afterEach } from "bun:test";
import { config } from "../src/config.ts";
import { handleCommittee } from "../src/api/routes/committee.ts";

const origConfig = { adminToken: config.adminToken, allowInsecure: config.allowInsecure };
const origSource = process.env.ANALYTICS_SOURCE;
afterEach(() => {
  config.adminToken = origConfig.adminToken;
  config.allowInsecure = origConfig.allowInsecure;
  if (origSource === undefined) delete process.env.ANALYTICS_SOURCE;
  else process.env.ANALYTICS_SOURCE = origSource;
});

// runAnalytics computes the full indicator + backtest suite even in hermetic
// mode, so this mirrors the extended timeouts other suites use around it
// (hermetic-source.test.ts, analytics-suite.test.ts) rather than the 5s default.
test(
  "POST /api/committee/admin/regime recomputes ONLY the regime composite (tools === ['regime'])",
  async () => {
    config.adminToken = null;
    config.allowInsecure = true;
    process.env.ANALYTICS_SOURCE = "hermetic";

    const req = new Request("http://x/api/committee/admin/regime", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ asof: "2026-06-29" }),
    });
    const res = await handleCommittee(req, new URL(req.url));

    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    // The scoping fix (issue #59): this admin route must NOT recompute the full
    // suite (regime + both research signals) — only the regime composite, so it
    // never triggers the multi-minute live SEC EDGAR research crawl that hung
    // `bun demo`. Object.keys of the scoped runAnalytics result is exactly ["regime"].
    expect((res!.body as { tools: string[] }).tools).toEqual(["regime"]);
  },
  { timeout: 120_000 },
);
