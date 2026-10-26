// The template's SDK soak steps (issue 1476, SV.8): S10-archive-routes,
// S11-sdk-quickstart, S12-sdk-tests (scripts/release/sdk-check.ts, sdk-lib.ts).
// Each check's decision has a passing case and a red control. The checks that
// run the SDK use a local export of the working tree for the sparse clone, a
// fake API for the target and the real `bun`, `bash`, `curl` and `jq`.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { latestReport, noRunMessage, retryAfterMs, sha256Hex, getWithRetry } from "../../release/public-analytics-read.ts";
import {
  acquireBlocks, archiveRouteProblems, archiveRoutesCheck, copyDifferences, fillScript, homeScratch, packageTestsCheck, quickstartCheck, reportDifferences,
  spawnRunner, sparseCloneSdk, text, type SdkDeps,
} from "../../release/sdk-lib.ts";
import { exportPackage } from "./support/analyst-sdk-export.ts";
import { COMMIT, fakeNet, fakeServer, RECORDING, RUN_KEY } from "./support/fake-public-api.ts";

setDefaultTimeout(240_000);
const repoRoot = join(import.meta.dir, "../../..");
const README = readFileSync(join(repoRoot, "packages/analyst-sdk/README.md"), "utf8");
const cleanup: string[] = [];
afterAll(() => { for (const d of cleanup) rmSync(d, { recursive: true, force: true }); });

describe("the public read helpers", () => {
  test("the latest report is the highest id; none is none; a 429 is waited out as Retry-After says", async () => {
    const row = (id: number) => ({ report_id: id, run_key: `k${id}`, asof: "2026-01-01", checksum: "c", byte_length: 1 });
    expect(latestReport([row(2), row(9), row(4)])?.run_key).toBe("k9");
    expect(latestReport([])).toBeUndefined();
    expect(retryAfterMs("3")).toBe(3000);
    expect(retryAfterMs(null)).toBe(1000);
    expect(retryAfterMs("999999")).toBe(70_000);
    let calls = 0;
    const slept: number[] = [];
    const net = { origin: "http://x", sleep: async (ms: number) => { slept.push(ms); }, fetch: async () => (++calls < 3 ? new Response("{}", { status: 429, headers: { "Retry-After": "2" } }) : new Response("{}", { status: 200 })) };
    expect((await getWithRetry(net, "/p")).status).toBe(200);
    expect(slept).toEqual([2000, 2000]);
    // red: a target that never stops refusing ends in the 429, not in a loop.
    const stuck = { ...net, fetch: async () => new Response("{}", { status: 429 }) };
    expect((await getWithRetry(stuck, "/p", undefined, 3)).status).toBe(429);
  });
});

describe("S10-archive-routes", () => {
  test("passes against the recorded archive routes", async () => {
    const r = await archiveRoutesCheck(fakeNet());
    expect(r.problems).toEqual([]);
    expect(r.found.firstRecord).toBe("csv/2001-01-02T000000Z/backup.json");
  });

  test("red: a 404 route, a record of another format and an empty listing each fail", async () => {
    expect((await archiveRoutesCheck(fakeNet({ archiveStatus: 404 }))).problems.join()).toContain("answered 404, not 200");
    expect(archiveRouteProblems({ status: 200, body: { format: 2, backups: [{}] } }, null).join()).toContain("format 2, not 1");
    expect(archiveRouteProblems({ status: 200, body: { format: 1, backups: [] } }, null).join()).toContain("lists no sealed backup");
    expect(archiveRouteProblems({ status: 200, body: { format: 1, backups: [{}] } }, { status: 404, body: null }).join()).toContain("record answered 404");
    expect(archiveRouteProblems({ status: 200, body: { format: 1, backups: [{}] } }, { status: 200, body: { format: 1 } })).toEqual([]);
  });
});

describe("the README fill the checks run", () => {
  test("the API-only block is found, aimed at a folder, and a README without it is refused", () => {
    expect(acquireBlocks(README).length).toBe(2);
    expect(fillScript(README, "copy-x")).toMatch(/^fill copy-x$/m);
    expect(fillScript(README, "copy-x")).not.toMatch(/^fill api-copy$/m);
    expect(fillScript("no blocks here", "copy-x")).toBeUndefined();
    expect(fillScript(README.replace(/^fill api-copy$/m, "echo changed"), "copy-x")).toBeUndefined();
  });

  test("copy and report differences: the same pass; an extra file, a changed byte and a changed report each fail", () => {
    expect(copyDifferences({ a: "1", b: "2" }, { a: "1", b: "2" })).toEqual([]);
    expect(copyDifferences({ a: "1" }, { a: "1", b: "2" }).join()).toContain("b is only in the copy that started");
    expect(copyDifferences({ a: "1", b: "2" }, { a: "1" }).join()).toContain("b is only in the API-only copy");
    expect(copyDifferences({ a: "1" }, { a: "9" }).join()).toContain("a differs");
    expect(copyDifferences({}, {}).join()).toContain("empty copy");
    const bytes = new TextEncoder().encode('{"a":1}');
    expect(reportDifferences(bytes, bytes)).toEqual([]);
    expect(reportDifferences(new TextEncoder().encode('{"a":1}\n'), bytes).join()).toContain("differ only by the printed report's final newline");
    expect(reportDifferences(new TextEncoder().encode('{"a":2}'), bytes).join()).toContain("is not the published one");
  });
});

// A dependency set whose "sparse clone" is a fresh export of the working tree's package.
const localDeps = (net: SdkDeps["net"], run: SdkDeps["run"] = spawnRunner): SdkDeps => ({
  net, run,
  scratch: () => homeScratch("sdk-check-test-"),
  prepareSdk: async () => { const dir = exportPackage("rm-sdk-check-"); cleanup.push(dir); return { sdkDir: dir }; },
});

describe("S11-sdk-quickstart", () => {
  // The published report is whatever the SDK prints for the recorded run: made once with the same commands the check runs.
  let printed: Uint8Array;
  test("setup: the SDK prints a report for the recorded run", async () => {
    const dir = exportPackage("rm-sdk-check-ref-");
    cleanup.push(dir);
    cpSync(RECORDING, join(dir, "api-copy"), { recursive: true });
    const inputs = await spawnRunner(["bun", "run", "inputs", "--archive", "api-copy", "--run", RUN_KEY, "--out", join(dir, "api-fill")], { cwd: dir });
    expect(inputs.code, inputs.stderr).toBe(0);
    const regime = await spawnRunner(["bun", "run", "regime", join(dir, "api-fill/inputs.csv"), "--replay", "--asof", "2026-08-15"], { cwd: dir });
    expect(regime.code, regime.stderr).toBe(0);
    printed = regime.stdout;
    expect(printed.length).toBeGreaterThan(100);
  });

  test("passes: the quickstart's printed report is the published report byte for byte", async () => {
    const api = fakeServer({ reports: [{ run_key: RUN_KEY, asof: "2026-08-15", bytes: printed }] });
    try {
      const net = { ...fakeNet(), origin: api.origin, fetch: (u: string, i?: RequestInit) => fetch(u, i) };
      const r = await quickstartCheck(localDeps(net), COMMIT);
      expect(r.problems).toEqual([]);
      expect(r.found.printed_sha256).toBe(sha256Hex(printed));
      expect(r.found.printed_sha256).toBe(r.found.published_sha256);
    } finally {
      api.server.stop(true);
    }
  });

  test("red: a published report that differs by one byte fails and names both hashes", async () => {
    const planted = new Uint8Array([...printed, 32]);
    const api = fakeServer({ reports: [{ run_key: RUN_KEY, asof: "2026-08-15", bytes: planted }] });
    try {
      const net = { ...fakeNet(), origin: api.origin, fetch: (u: string, i?: RequestInit) => fetch(u, i) };
      const r = await quickstartCheck(localDeps(net), COMMIT);
      expect(r.problems.join()).toContain("is not the published one");
      expect(r.problems.join()).toContain(sha256Hex(planted));
    } finally {
      api.server.stop(true);
    }
  });

  test("red: a target with no published run fails with a message that says so, never skips", async () => {
    const r = await quickstartCheck(localDeps(fakeNet({ reports: [] })), COMMIT);
    expect(r.problems).toEqual([noRunMessage("the SDK quickstart")]);
    expect(r.problems[0]).toContain("no published run");
  });

  test("red: a fill that fails (the API answers 404 for the archive) fails the check", async () => {
    const api = fakeServer({ reports: [{ run_key: RUN_KEY, asof: "2026-08-15", bytes: printed }], archiveStatus: 404 });
    try {
      const net = { ...fakeNet(), origin: api.origin, fetch: (u: string, i?: RequestInit) => fetch(u, i) };
      const r = await quickstartCheck(localDeps(net), COMMIT);
      expect(r.problems.join()).toContain("fill api-copy exited");
    } finally {
      api.server.stop(true);
    }
  });
});

describe("S12-sdk-tests", () => {
  const fakeRun = (code: number): SdkDeps["run"] => async () => ({ code, stdout: new Uint8Array(), stderr: code === 0 ? "" : "1 fail" });
  test("passes when the package tests exit 0 and fails, naming the exit, when they do not", async () => {
    expect((await packageTestsCheck(localDeps(fakeNet(), fakeRun(0)), COMMIT)).problems).toEqual([]);
    const red = await packageTestsCheck(localDeps(fakeNet(), fakeRun(1)), COMMIT);
    expect(red.problems.join()).toContain("bun test in packages/analyst-sdk exited 1");
  });

  test("the sparse clone checks out the named commit with only the SDK, and refuses a commit that is not one", async () => {
    // A small repository of its own (the checkout under test may be shallow): the SDK package plus a folder that must not come along.
    const repo = homeScratch("sdk-origin-test-");
    cleanup.push(repo);
    const src = exportPackage("rm-sdk-origin-src-");
    cleanup.push(src);
    mkdirSync(join(repo, "packages"), { recursive: true });
    cpSync(src, join(repo, "packages", "analyst-sdk"), { recursive: true });
    mkdirSync(join(repo, "backend"), { recursive: true });
    writeFileSync(join(repo, "backend", "only.txt"), "not the SDK\n");
    const git = async (...a: string[]) => {
      const r = await spawnRunner(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], {});
      expect(r.code, r.stderr).toBe(0);
      return text(r.stdout).trim();
    };
    await git("init", "-q", "-b", "main");
    await git("add", "-A");
    await git("commit", "-q", "-m", "sdk");
    const head = await git("rev-parse", "HEAD");
    const prepare = sparseCloneSdk(`file://${repo}`, spawnRunner);
    const scratch = homeScratch("sdk-clone-test-");
    cleanup.push(scratch);
    const ok = await prepare(head, scratch);
    expect("sdkDir" in ok, JSON.stringify(ok)).toBe(true);
    if ("sdkDir" in ok) {
      expect(existsSync(join(ok.sdkDir, "package.json"))).toBe(true);
      expect(existsSync(join(scratch, "clone", "backend"))).toBe(false);
    }
    // red: not a sha, and a sha the repository does not have.
    expect("problem" in (await prepare("not-a-sha", homeScratch("sdk-clone-test-")))).toBe(true);
    expect(JSON.stringify(await prepare("0".repeat(40), homeScratch("sdk-clone-test-")))).toContain("problem");
  });
});

describe("the template carries the SDK steps from v0.7.0", () => {
  test("S10 to S12 are control-machine soak steps with a since, and the sdk-check usage refuses a missing argument", async () => {
    const { loadTemplate } = await import("../../release/runbook.ts");
    const t = loadTemplate();
    for (const id of ["S10-archive-routes", "S11-sdk-quickstart", "S12-sdk-tests"]) {
      const s = t.steps.find((x) => x.id === id)!;
      expect([s.host, s.phase, s.since, s.standing]).toEqual(["control", "soak", "v0.7.0", ["SV.8"]]);
    }
    const r = await spawnRunner(["bun", join(repoRoot, "scripts/release/sdk-check.ts"), "--check", "quickstart", "--origin", "http://x"], {});
    expect(r.code).toBe(2);
  });
});
