// The template's SDK soak steps (issue 1476, SV.8): Q35-archive-routes/C23-archive-routes,
// Q36-sdk-quickstart/C24-sdk-quickstart, Q37-sdk-tests/C25-sdk-tests (scripts/release/sdk-check.ts, sdk-lib.ts).
// Each check's decision has a passing case and a red control. The checks that
// run the SDK use a local export of the working tree for the sparse clone, a
// fake API for the target and the real `bun`, `bash`, `curl` and `jq`.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { latestReport, noRunMessage, retryAfterMs, sha256Hex, getWithRetry } from "../../release/public-analytics-read.ts";
import {
  acquireBlocks, archiveRouteProblems, archiveRoutesCheck, copyDifferences, fillScript, homeScratch, packageTestsCheck, quickstartCheck,
  spawnRunner, sparseCloneSdk, text, type SdkDeps,
} from "../../release/sdk-lib.ts";
import { compareRows, comparisonProblems, publishedAsofRow } from "../../release/replay-row.ts";
import { gzipSync } from "node:zlib";
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

describe("Q35-archive-routes/C23-archive-routes", () => {
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

  test("copy differences: the same pass; an extra file and a changed byte each fail", () => {
    expect(copyDifferences({ a: "1", b: "2" }, { a: "1", b: "2" })).toEqual([]);
    expect(copyDifferences({ a: "1" }, { a: "1", b: "2" }).join()).toContain("b is only in the copy that started");
    expect(copyDifferences({ a: "1", b: "2" }, { a: "1" }).join()).toContain("b is only in the API-only copy");
    expect(copyDifferences({ a: "1" }, { a: "9" }).join()).toContain("a differs");
    expect(copyDifferences({}, {}).join()).toContain("empty copy");
  });
});

// A dependency set whose "sparse clone" is a fresh export of the working tree's package.
const localDeps = (net: SdkDeps["net"], run: SdkDeps["run"] = spawnRunner): SdkDeps => ({
  net, run,
  scratch: () => homeScratch("sdk-check-test-"),
  prepareSdk: async () => { const dir = exportPackage("rm-sdk-check-"); cleanup.push(dir); return { sdkDir: dir }; },
});

/**
 * A copy of the recording whose second backup also lists the run's published
 * `regime_snapshots` artifact (analytics_output_snapshots), holding `row` as the
 * as-of row. The backup record lists the file with its hash, as csvb writes it.
 */
function recordingWithArtifact(row: Record<string, unknown>): string {
  const dir = homeScratch("sdk-recording-");
  cleanup.push(dir);
  cpSync(RECORDING, dir, { recursive: true });
  const payload = JSON.stringify([row]);
  const csv = `id,run_id,artifact_kind,payload_json,payload_sha256,created_at\n1,2,regime_snapshots,"${payload.replaceAll('"', '""')}",${sha256Hex(payload)},2001-01-02 05:30:00+00\n`;
  const rel = "csv/2001-01-03T000000Z/data/analytics_output_snapshots.2001-01-02T053000Z_2001-01-02T053000Z.csv.gz";
  writeFileSync(join(dir, rel), gzipSync(csv));
  const recPath = join(dir, "csv/2001-01-03T000000Z/backup.json");
  const rec = JSON.parse(readFileSync(recPath, "utf8"));
  rec.append_only.analytics_output_snapshots = {
    time: { column: "created_at" }, watermark_before: null, watermark_after: "1", rows_added: 1,
    files: [{ path: rel, rows: 1, bytes_raw: Buffer.byteLength(csv), sha256_raw: sha256Hex(csv), id_min: "1", id_max: "1", sum_id: "1", time_min: "2001-01-02 05:30:00+00", time_max: "2001-01-02 05:30:00+00" }],
    db_rows_through_watermark: "1", db_sum_id_through_watermark: "1",
  };
  writeFileSync(recPath, JSON.stringify(rec, null, 2));
  return dir;
}

describe("Q36-sdk-quickstart/C24-sdk-quickstart", () => {
  let replayed: Record<string, unknown>;
  const withApi = async (recording: string, reports: boolean, body: (net: SdkDeps["net"]) => Promise<void>) => {
    const api = fakeServer({ recording, reports: reports ? [{ run_key: RUN_KEY, asof: "2026-08-15", bytes: new TextEncoder().encode("{}") }] : [] });
    try {
      await body({ ...fakeNet(), origin: api.origin, fetch: (u: string, i?: RequestInit) => fetch(u, i) });
    } finally {
      api.server.stop(true);
    }
  };

  test("setup: the SDK's as-of row for the recorded run", async () => {
    const dir = exportPackage("rm-sdk-check-ref-");
    cleanup.push(dir);
    cpSync(RECORDING, join(dir, "api-copy"), { recursive: true });
    const inputs = await spawnRunner(["bun", "run", "inputs", "--archive", "api-copy", "--run", RUN_KEY, "--out", join(dir, "api-fill")], { cwd: dir });
    expect(inputs.code, inputs.stderr).toBe(0);
    const row = await spawnRunner(["bun", join(repoRoot, "scripts/release/replay-row.ts"), "--sdk", dir, "--archive", join(dir, "api-copy"), "--run", RUN_KEY, "--inputs", join(dir, "api-fill/inputs.csv"), "--print-row"], { cwd: dir });
    expect(row.code, row.stderr).toBe(0);
    replayed = JSON.parse(text(row.stdout));
    expect(replayed.date).toBe("2026-08-15");
    expect("regime" in replayed && "backtest" in replayed).toBe(true);
  });

  test("passes: the SDK's as-of row equals the published as-of row, and both hashes are reported", async () => {
    await withApi(recordingWithArtifact(replayed), true, async (net) => {
      const r = await quickstartCheck(localDeps(net), COMMIT);
      expect(r.problems).toEqual([]);
      expect(r.found.sdkRowSha256).toBe(r.found.publishedRowSha256);
      expect(String(r.found.sdkRowSha256)).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  test("red: a published row with one field changed fails and names the field and both hashes", async () => {
    await withApi(recordingWithArtifact({ ...replayed, composite: 0.123456 }), true, async (net) => {
      const r = await quickstartCheck(localDeps(net), COMMIT);
      expect(r.problems.join()).toContain("differs from the published one in composite");
      expect(r.problems.join()).toContain("sha256 published");
    });
    await withApi(recordingWithArtifact({ ...replayed, regime: "not-a-label" }), true, async (net) => {
      expect((await quickstartCheck(localDeps(net), COMMIT)).problems.join()).toContain("regime");
    });
  });

  test("red: a published artifact with no row for the as-of day fails; a copy with no artifact at all fails", async () => {
    await withApi(recordingWithArtifact({ ...replayed, date: "2001-01-01" }), true, async (net) => {
      expect((await quickstartCheck(localDeps(net), COMMIT)).problems.join()).toContain("has no as-of row for 2026-08-15");
    });
    await withApi(RECORDING, true, async (net) => {
      expect((await quickstartCheck(localDeps(net), COMMIT)).problems.join()).toContain("has no regime_snapshots artifact");
    });
  });

  test("red: a target with no published run fails with a message that says so, never skips", async () => {
    const r = await quickstartCheck(localDeps(fakeNet({ reports: [] })), COMMIT);
    expect(r.problems).toEqual([noRunMessage("the SDK quickstart")]);
    expect(r.problems[0]).toContain("no published run");
  });

  test("red: a fill that fails (the API answers 404 for the archive) fails the check", async () => {
    const api = fakeServer({ reports: [{ run_key: RUN_KEY, asof: "2026-08-15", bytes: new TextEncoder().encode("{}") }], archiveStatus: 404 });
    try {
      const net = { ...fakeNet(), origin: api.origin, fetch: (u: string, i?: RequestInit) => fetch(u, i) };
      expect((await quickstartCheck(localDeps(net), COMMIT)).problems.join()).toContain("fill api-copy exited");
    } finally {
      api.server.stop(true);
    }
  });
});

describe("the as-of row comparison (PR 1448)", () => {
  const row = { date: "d", regime: "risk_on", composite: 0.5, percentiles: { A: 1 }, correlations: { a: [1, 2] }, backtest: null };
  test("equal rows match whatever the key order; each differing field is named, in compared order; a missing row is a mismatch", () => {
    expect(compareRows(row, row).match).toBe(true);
    expect(compareRows({ backtest: null, correlations: { a: [1, 2] }, percentiles: { A: 1 }, composite: 0.5, regime: "risk_on", date: "x" }, row).match).toBe(true);
    const c = compareRows({ ...row, composite: 0.6, percentiles: { A: 2 } }, row);
    expect([c.match, c.differing, c.firstDiff?.field]).toEqual([false, ["composite", "percentiles"], "composite"]);
    expect(c.publishedSha256).not.toBe(c.replaySha256);
    expect(compareRows(null, row)).toMatchObject({ match: false, differing: ["as-of row"], publishedSha256: null });
    expect(comparisonProblems(compareRows(null, row), "k", "d").join()).toContain("has no as-of row for d");
    expect(publishedAsofRow(JSON.stringify([row]), "d")).toEqual(row);
    expect(publishedAsofRow(JSON.stringify([row]), "e")).toBeNull();
  });
});

describe("Q37-sdk-tests/C25-sdk-tests", () => {
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
  test("Q35 to Q37 and C23 to C25 are control-machine steps with a since, and the sdk-check usage refuses a missing argument", async () => {
    const { loadTemplate } = await import("../../release/runbook.ts");
    const t = loadTemplate();
    for (const id of ["Q35-archive-routes", "Q36-sdk-quickstart", "Q37-sdk-tests", "C23-archive-routes", "C24-sdk-quickstart", "C25-sdk-tests"]) {
      const s = t.steps.find((x) => x.id === id)!;
      expect([s.host, s.phase, s.since, s.standing]).toEqual(["control", s.id[0] === "Q" ? "qa" : "cutover", "v0.7.0", ["SV.8"]]);
    }
    const r = await spawnRunner(["bun", join(repoRoot, "scripts/release/sdk-check.ts"), "--check", "quickstart", "--origin", "http://x"], {});
    expect(r.code).toBe(2);
  });
});
