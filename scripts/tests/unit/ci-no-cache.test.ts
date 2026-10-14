// Issue #1040 (docs/decisions.md, the no-cache policy): CI caches nothing. A
// cache hit hides a change in the dependency universe, and CI exists to catch
// that change. The checker takes YAML text so planted fixtures can prove each
// rule goes red; the real workflows are then run through the same checker.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const wfDir = join(import.meta.dir, "../../../.github/workflows");

interface Step {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}

/** Every violation of the no-cache policy in one workflow's YAML text. */
function noCacheViolations(text: string): string[] {
  const wf = Bun.YAML.parse(text) as { jobs?: Record<string, { steps?: Step[] }> };
  const bad: string[] = [];
  for (const [job, def] of Object.entries(wf.jobs ?? {})) {
    for (const [i, step] of (def.steps ?? []).entries()) {
      const at = `${job}[${i}]`;
      const uses = step.uses ?? "";
      if (uses.startsWith("actions/cache")) bad.push(`${at}: uses actions/cache`);
      const withText = JSON.stringify(step.with ?? {});
      if (/cache-(from|to)/.test(withText) || /cache-(from|to)/.test(step.run ?? "")) bad.push(`${at}: sets cache-from or cache-to`);
      if (uses.startsWith("oven-sh/setup-bun@") && step.with?.["no-cache"] !== true) bad.push(`${at}: setup-bun without no-cache: true`);
      if (uses.startsWith("docker/setup-buildx-action@") && step.with?.["cache-binary"] !== false) bad.push(`${at}: setup-buildx without cache-binary: false`);
      if (uses.startsWith("actions/setup-node@") && step.with && "cache" in step.with) bad.push(`${at}: setup-node sets a cache input`);
    }
  }
  return bad;
}

const wrap = (step: string) => `on: push\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n${step}\n`;

describe("CI caches nothing", () => {
  test("every real workflow passes", () => {
    const files = readdirSync(wfDir).filter((f) => f.endsWith(".yml"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(noCacheViolations(readFileSync(join(wfDir, f), "utf8")), f).toEqual([]);
  });

  test("the composite e2e-setup action passes the same setup rules", () => {
    const text = readFileSync(join(import.meta.dir, "../../../.github/actions/e2e-setup/action.yml"), "utf8");
    const action = Bun.YAML.parse(text) as { runs: { steps: Step[] } };
    const asWorkflow = `on: push\njobs:\n  j:\n    runs-on: x\n    steps: ${JSON.stringify(action.runs.steps)}\n`;
    expect(noCacheViolations(asWorkflow)).toEqual([]);
  });

  const planted: Array<[string, string]> = [
    ["actions/cache", "      - uses: actions/cache@v4\n        with:\n          path: x\n          key: y"],
    ["cache-from in with", "      - uses: docker/build-push-action@v6\n        with:\n          cache-from: type=gha"],
    ["cache-to in run", "      - run: docker buildx build --cache-to type=gha ."],
    ["setup-bun default", "      - uses: oven-sh/setup-bun@v2\n        with:\n          bun-version: '1.3.5'"],
    ["setup-bun no-cache false", "      - uses: oven-sh/setup-bun@v2\n        with:\n          no-cache: false"],
    ["setup-buildx default", "      - uses: docker/setup-buildx-action@v3"],
    ["setup-node cache input", "      - uses: actions/setup-node@v4\n        with:\n          node-version: '20'\n          cache: npm"],
  ];
  for (const [name, step] of planted) {
    test(`planted violation goes red: ${name}`, () => {
      expect(noCacheViolations(wrap(step)).length).toBeGreaterThan(0);
    });
  }

  test("compliant steps stay green", () => {
    const ok = [
      "      - uses: oven-sh/setup-bun@v2\n        with:\n          no-cache: true",
      "      - uses: docker/setup-buildx-action@v3\n        with:\n          cache-binary: false",
      "      - uses: actions/setup-node@v4\n        with:\n          node-version: '20'",
    ].join("\n");
    expect(noCacheViolations(wrap(ok))).toEqual([]);
  });
});
