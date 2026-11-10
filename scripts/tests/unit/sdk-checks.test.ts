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
  acquireBlocks, archivedRuns, archiveRouteProblems, archiveRoutesCheck, copyDifferences, fillScript, homeScratch, isFixedProducer, newestArchivedReport, packageTestsCheck, postSealCheck, quickstartCheck,
  spawnRunner, sparseCloneSdk, text, type SdkDeps,
} from "../../release/sdk-lib.ts";
import { compareRows, comparisonProblems, publishedAsofRow } from "../../release/replay-row.ts";
import { gunzipSync, gzipSync } from "node:zlib";
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
function recordingWithArtifact(row: Record<string, unknown>, legacyBuild = false): string {
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
  if (legacyBuild) {
    // The run was made by the old producer: its build identity is a package label, not an image commit.
    const ledger = rec.append_only.analytics_ledger_runs.files[0];
    const lp = join(dir, ledger.path);
    const old = gunzipSync(readFileSync(lp)).toString("utf8");
    const edited = old.replace(/,4b4414c0e5a1d2f3b4c5d6e7f8091a2b3c4d5e6f,/g, ",pkg:0.1.0+bun:1.4.4,");
    writeFileSync(lp, gzipSync(edited));
    ledger.bytes_raw = Buffer.byteLength(edited);
    ledger.sha256_raw = sha256Hex(edited);
  }
  writeFileSync(recPath, JSON.stringify(rec, null, 2));
  return dir;
}

/**
 * An in-process fake of the routes the Q36/C24 contract smoke calls: a listing of `backups` sealed days whose
 * newest record lists two data files and a revision file (gzip of known content), a reports listing with one
 * run, its bytes, and the run's vintage with members. Options plant one failure each. Every request is kept;
 * an include=members request without tool_id is answered 400, as the route does, and counted.
 */
function contractNet(o: { backups?: number; corruptPath?: string; tamperReport?: boolean; members?: number; reports?: boolean } = {}) {
  const API = "/api/public/analytics";
  const ids = Array.from({ length: o.backups ?? 44 }, (_, i) => `${new Date(Date.UTC(2026, 8, 20 + i)).toISOString().slice(0, 10)}T000000Z`);
  const newest = ids.at(-1)!;
  const contents: Record<string, string> = {
    [`csv/${newest}/data/source_value_versions.2026-11-01T010000Z_2026-11-01T020000Z.csv.gz`]: "id,value\n101,1\n102,2\n",
    [`csv/${newest}/data/analytics_ledger_runs.2026-11-01T053000Z_2026-11-01T053000Z.csv.gz`]: "id,run_key\n7,k\n",
    [`csv/${newest}/revisions/analytics_ledger_methodology_versions.csv.gz`]: "op,id\nupsert,1\n",
  };
  const file = (path: string) => ({ path, rows: 2, bytes_raw: Buffer.byteLength(contents[path]!), sha256_raw: sha256Hex(contents[path]!) });
  const [svv, runs, rev] = Object.keys(contents);
  const record = {
    format: 1, backup: newest, source: "api",
    // The newest backup continues each chain from the day before: the smoke parses it without the earlier days.
    append_only: { source_value_versions: { watermark_before: "100", watermark_after: "102", files: [file(svv!)] }, analytics_ledger_runs: { watermark_before: "6", watermark_after: "7", files: [file(runs!)] } },
    revisions: { analytics_ledger_methodology_versions: { key: ["id"], file: file(rev!) } },
  };
  const reportBytes = new TextEncoder().encode('{"asof":"2026-11-01","toolId":"regime","results":{}}');
  const requests: string[] = [];
  let refusedMembers = 0;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const fetchImpl = async (url: string): Promise<Response> => {
    const u = new URL(url);
    requests.push(u.pathname + u.search);
    const p = u.pathname;
    if (p === `${API}/archive/backups`) return json({ schemaVersion: 1, limit: 1000, format: 1, backups: ids.map((b) => ({ backup: b, record: `csv/${b}/backup.json` })), nextCursor: null });
    if (p.startsWith(`${API}/archive/`)) {
      const rel = p.slice(`${API}/archive/`.length);
      if (rel === `csv/${newest}/backup.json`) return json(record);
      if (rel in contents) {
        const body = rel === o.corruptPath ? `I${contents[rel]!.slice(1)}` : contents[rel]!; // same length, other bytes
        return new Response(gzipSync(body), { status: 200, headers: { "Content-Type": "application/gzip" } });
      }
      return json({ error: "not found" }, 404);
    }
    if (p === `${API}/reports`) {
      const run = u.searchParams.get("run");
      if (run === null) return json({ schemaVersion: 1, limit: 1000, reports: o.reports === false ? [] : [{ report_id: 3, run_key: RUN_KEY, asof: "2026-11-01", checksum: sha256Hex(reportBytes), byte_length: reportBytes.length }], nextCursor: null });
      return new Response(o.tamperReport ? new TextEncoder().encode("{}") : reportBytes, { status: 200 });
    }
    if (p === `${API}/vintages`) {
      const runKey = u.searchParams.get("run_key");
      const toolId = u.searchParams.get("tool_id");
      if (u.searchParams.get("include") === "members") {
        if (runKey === null || toolId === null) { refusedMembers++; return json({ error: "include=members needs run_key and tool_id, so exactly one vintage is named" }, 400); }
        const rows = Array.from({ length: o.members ?? 3 }, (_, i) => ({ source_key: "raw_indicator_history:T10Y2Y", source_value_version_id: 101 + i }));
        return json({ schemaVersion: 1, limit: 100, vintages: [{ id: 7, run_key: runKey, tool_id: toolId, members: { rows, nextCursor: null } }], nextCursor: null });
      }
      return json({ schemaVersion: 1, limit: 100, vintages: [{ id: 7, run_key: runKey, tool_id: "regime", member_count: 3 }], nextCursor: null });
    }
    return json({ error: "not found" }, 404);
  };
  return { net: { origin: "http://fake.invalid", fetch: fetchImpl, sleep: async () => {} }, requests, refused: () => refusedMembers, newest, ids, paths: Object.keys(contents) };
}

describe("Q36-sdk-quickstart/C24-sdk-quickstart: a minimal contract smoke", () => {
  const API = "/api/public/analytics";

  test("against a 44-backup listing it makes the seven calls in order: one record and only its files, one report, two vintages calls", async () => {
    const f = contractNet();
    const r = await quickstartCheck(localDeps(f.net), COMMIT);
    expect(r.problems).toEqual([]);
    expect(f.ids.length).toBe(44);
    expect(f.requests).toEqual([
      `${API}/archive/backups?limit=1000`,
      `${API}/archive/csv/${f.newest}/backup.json`,
      ...f.paths.map((p) => `${API}/archive/${p}`),
      `${API}/reports?limit=1000`,
      `${API}/reports?run=${RUN_KEY}`,
      `${API}/vintages?run_key=${RUN_KEY}`,
      `${API}/vintages?run_key=${RUN_KEY}&tool_id=regime&include=members`,
    ]);
    // exactly one backup record of the 44, and no replay
    expect(f.requests.filter((q) => q.endsWith("/backup.json"))).toEqual([`${API}/archive/csv/${f.newest}/backup.json`]);
    expect(r.found).toMatchObject({ backup: f.newest, files: 3, run_key: RUN_KEY, tool_id: "regime", members: 3 });
    expect(r.notes?.join()).toContain("--check post-seal");
  });

  test("the route refuses include=members without tool_id: the smoke never sends such a request", async () => {
    const f = contractNet();
    expect((await quickstartCheck(localDeps(f.net), COMMIT)).problems).toEqual([]);
    expect(f.refused()).toBe(0);
    expect(f.requests.filter((q) => q.includes("include=members") && !q.includes("tool_id="))).toEqual([]);
  });

  test("RED CONTROL: a listed file whose bytes do not match its sha256_raw fails, naming that path", async () => {
    const bad = contractNet().paths[1]!;
    const r = await quickstartCheck(localDeps(contractNet({ corruptPath: bad }).net), COMMIT);
    expect(r.problems.length).toBe(1);
    expect(r.problems[0]).toContain(`GET ${API}/archive/${bad} does not verify`);
    expect(r.problems[0]).toContain("does not match the record's");
  });

  test("RED CONTROL: report bytes whose sha256 differs from the listing's checksum fail, naming the reports route", async () => {
    const f = contractNet({ tamperReport: true });
    const r = await quickstartCheck(localDeps(f.net), COMMIT);
    expect(r.problems.length).toBe(1);
    expect(r.problems[0]).toContain(`GET ${API}/reports?run=${RUN_KEY}`);
    expect(r.problems[0]).toContain("is not the listing's checksum");
    expect(f.requests.some((q) => q.startsWith(`${API}/vintages`))).toBe(false);
  });

  test("RED CONTROL: a vintage with no members fails, naming the vintages route", async () => {
    const r = await quickstartCheck(localDeps(contractNet({ members: 0 }).net), COMMIT);
    expect(r.problems).toEqual([`GET ${API}/vintages?run_key=${RUN_KEY}&tool_id=regime&include=members lists no member for the vintage`]);
  });

  test("red: a target with no published run fails with the no-published-run message, never skips", async () => {
    const r = await quickstartCheck(localDeps(contractNet({ reports: false }).net), COMMIT);
    expect(r.problems).toEqual([noRunMessage("the SDK quickstart")]);
    expect(r.problems[0]).toContain("no published run");
  });

  test("passes against the committed recording of the real archive routes (a chain that starts mid-copy)", async () => {
    const net = fakeNet({ reports: [{ run_key: RUN_KEY, asof: "2026-08-15", bytes: new TextEncoder().encode("{}") }] });
    const r = await quickstartCheck(localDeps(net), COMMIT);
    // fakeNet's vintages carry no tool_id: the smoke stops there, after the archive and reports verified.
    expect(r.problems).toEqual([`GET ${API}/vintages?run_key=${RUN_KEY}: the vintage names no tool_id`]);
    expect(r.found.backup).toBe("2001-01-03T000000Z");
    expect(net.requests.filter((q) => q.endsWith("/backup.json"))).toEqual([`${API}/archive/csv/2001-01-03T000000Z/backup.json`]);
  });

  test("red: a 404 archive listing names the archive route", async () => {
    const r = await quickstartCheck(localDeps(fakeNet({ archiveStatus: 404 })), COMMIT);
    expect(r.problems).toEqual([`GET ${API}/archive/backups?limit=1000 answered 404, not 200`]);
  });
});

describe("post-seal: the full-archive replay (bun scripts/release/sdk-check.ts --check post-seal)", () => {
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

  test("a run of the old producer fails naming the sealed days; a fixed run's whole row must match, and both hashes are reported", async () => {
    await withApi(recordingWithArtifact(replayed, true), true, async (net) => {
      const r = await postSealCheck(localDeps(net), COMMIT);
      expect(r.problems.join()).toContain("old producer");
      expect(r.problems.join()).toContain("sealed backups run through");
    });
    await withApi(recordingWithArtifact(replayed), true, async (net) => {
      const r = await postSealCheck(localDeps(net), COMMIT);
      expect(r.problems).toEqual([]);
      expect(r.found.sdkRowSha256).toBe(r.found.publishedRowSha256);
      expect(String(r.found.sdkRowSha256)).toMatch(/^[0-9a-f]{64}$/);
    });
    await withApi(recordingWithArtifact({ ...replayed, composite: 0.123456 }), true, async (net) => {
      const r = await postSealCheck(localDeps(net), COMMIT);
      expect(r.found.tier).toBe("full");
      expect(r.problems.join()).toContain("differs from the published one in composite");
      expect(r.problems.join()).toContain("sha256 published");
    });
  });

  test("RED CONTROL: a label that differs fails", async () => {
    await withApi(recordingWithArtifact({ ...replayed, regime: "not-a-regime" }), true, async (net) => {
      expect((await postSealCheck(localDeps(net), COMMIT)).problems.join()).toContain("differs from the published one in regime");
    });
  });

  test("RED CONTROL: a run with no archived record fails with the missing-run message", async () => {
    const api = fakeServer({ recording: recordingWithArtifact(replayed), reports: [{ run_key: "99999999-9999-4999-8999-999999999999", asof: "2026-10-27", bytes: new TextEncoder().encode("{}") }] });
    try {
      const r = await postSealCheck(localDeps({ ...fakeNet(), origin: api.origin, fetch: (u: string, i?: RequestInit) => fetch(u, i) }), COMMIT);
      expect(r.problems.join()).toContain("no sealed backup holds a published run yet");
    } finally {
      api.server.stop(true);
    }
  });

  test("red: a published artifact with no row for the as-of day fails; a copy with no artifact at all fails", async () => {
    await withApi(recordingWithArtifact({ ...replayed, date: "2001-01-01" }), true, async (net) => {
      expect((await postSealCheck(localDeps(net), COMMIT)).problems.join()).toContain("has no as-of row for 2026-08-15");
    });
    await withApi(RECORDING, true, async (net) => {
      expect((await postSealCheck(localDeps(net), COMMIT)).problems.join()).toContain("has no regime_snapshots artifact");
    });
  });

  test("red: a target with no published run fails with a message that says so, never skips", async () => {
    const r = await postSealCheck(localDeps(fakeNet({ reports: [] })), COMMIT);
    expect(r.problems).toEqual([noRunMessage("the post-seal check")]);
  });

  test("red: a fill that fails (the API answers 404 for the archive) fails the check", async () => {
    const api = fakeServer({ reports: [{ run_key: RUN_KEY, asof: "2026-08-15", bytes: new TextEncoder().encode("{}") }], archiveStatus: 404 });
    try {
      const net = { ...fakeNet(), origin: api.origin, fetch: (u: string, i?: RequestInit) => fetch(u, i) };
      expect((await postSealCheck(localDeps(net), COMMIT)).problems.join()).toContain("fill api-copy exited");
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
    mkdirSync(join(repo, "backend", "src", "other"), { recursive: true });
    writeFileSync(join(repo, "backend", "src", "other", "x.ts"), "not the SDK\n");
    mkdirSync(join(repo, "backend", "src", "analytics"), { recursive: true });
    writeFileSync(join(repo, "backend", "src", "analytics", "source-tolerance.ts"), "export const SOURCE_TOLERANCES = {};\n");
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
    // the package-tests check also takes the repository folders the package's tests read (Q37/C25).
    const scratch2 = homeScratch("sdk-clone-test-");
    cleanup.push(scratch2);
    const withRepo = await prepare(head, scratch2, true);
    expect("sdkDir" in withRepo, JSON.stringify(withRepo)).toBe(true);
    expect(existsSync(join(scratch2, "clone", "backend", "src", "analytics", "source-tolerance.ts"))).toBe(true);
    expect(existsSync(join(scratch2, "clone", "backend", "src", "other", "x.ts"))).toBe(false);
    // red: not a sha, and a sha the repository does not have.
    expect("problem" in (await prepare("not-a-sha", homeScratch("sdk-clone-test-")))).toBe(true);
    expect(JSON.stringify(await prepare("0".repeat(40), homeScratch("sdk-clone-test-")))).toContain("problem");
  });
});

describe("the quickstart replays the newest published run the archive holds", () => {
  test("a run published after the newest sealed backup is skipped; the build identity splits the producers", () => {
    const dir = homeScratch("sdk-ledger-test-");
    cleanup.push(dir);
    const data = join(dir, "csv", "2026-01-02T000000Z", "data");
    mkdirSync(data, { recursive: true });
    const [k1, k2, k3, k4] = ["1", "2", "3", "4"].map((d) => `${d.repeat(8)}-${d.repeat(4)}-4${d.repeat(3)}-8${d.repeat(3)}-${d.repeat(12)}`);
    const sha = "4b4414c0759305df046a2de511bb446070ee7057";
    writeFileSync(join(data, "analytics_ledger_runs.a_b.csv.gz"), gzipSync([
      "id,run_key,asof,tool_id,source_label,methodology_version_id,build_identity,job_id,created_at",
      `1,${k1},2026-10-20,regime,live,1,pkg:0.1.0+bun:1.4.4,,2026-10-20 21:30:00.5+00`,
      `2,${k2},2026-10-24,regime,live,1,${sha},,2026-10-24 21:30:00.5+00`,
      `3,${k3},2026-10-26,regime,live,1,pkg:0.1.0+bun:1.4.4,,2026-10-26 21:30:00.5+00`,
    ].join("\n") + "\n"));
    const runs = archivedRuns(dir);
    expect([...runs.keys()].sort()).toEqual([k1, k2, k3]);
    const row = (id: number, k: string) => ({ report_id: id, run_key: k, asof: "2026-10-2" + id, checksum: "c", byte_length: 1 });
    // k4 is published but not archived; k3 is the newest archived.
    expect(newestArchivedReport([row(1, k1), row(2, k2), row(3, k3), row(4, k4)], runs)?.run_key).toBe(k3);
    expect(newestArchivedReport([row(4, k4)], runs)).toBeUndefined();
    expect(isFixedProducer(runs.get(k1)!.buildIdentity)).toBe(false);
    expect(isFixedProducer(runs.get(k2)!.buildIdentity)).toBe(true);
    expect(isFixedProducer("")).toBe(false);
    // v0.7.0 predates D78's exact arithmetic: its runs replay equal on the labels only.
    expect(isFixedProducer("8c2690bac11440a8d8ef86733a567066afaea116")).toBe(false);
    expect(isFixedProducer("4928ee57f5bb833dd4b543113b385f1570251eac")).toBe(true);
    expect(archivedRuns(join(dir, "missing")).size).toBe(0);
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
