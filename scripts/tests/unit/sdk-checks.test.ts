// The template's SDK soak steps (issue 1476, SV.8): Q35-archive-routes/C23-archive-routes,
// Q36-sdk-quickstart/C24-sdk-quickstart, Q37-sdk-tests/C25-sdk-tests (scripts/release/sdk-check.ts, sdk-lib.ts).
// Each check's decision has a passing case and a red control. The checks that
// run the SDK use a local export of the working tree for the sparse clone, a
// fake API for the target and the real `bun`, `bash`, `curl` and `jq`.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { latestReport, noRunMessage, retryAfterMs, sha256Hex, getWithRetry } from "../../release/public-analytics-read.ts";
import {
  acquireBlocks, archivedRuns, archiveRouteProblems, archiveRoutesCheck, copyDifferences, fillScript, homeScratch, isFixedProducer, newestArchivedReport, packageTestsCheck, postSealCheck, quickstartCheck,
  spawnRunner, sparseCloneSdk, text, type SdkDeps,
} from "../../release/sdk-lib.ts";
import { comparisonProblems, labelProblems, loadReplaySdk, SDK_TOO_OLD, type ReplaySdk } from "../../release/replay-row.ts";
import { compareRows, labelMismatches, MISSING_ROW } from "../../../packages/analyst-sdk/src/replay/index.ts";
import { REGIME_ARTIFACT_KIND } from "../../../packages/analyst-sdk/src/analyze/regime-versions.ts";
import { encodeCsvRow, parseCopyCsv, toObjects, type Row } from "../../../packages/analyst-sdk/src/archive/format1.ts";
import { openBackupsDir } from "../../../packages/analyst-sdk/bin/backups-dir.ts";
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

// The recorded model runs (packages/analyst-sdk/tests/fixtures/archive/model-runs, issue 1765): one v4 run with its
// published regime_snapshots artifact, then three v5 runs on the beside line, and the listing the fake API serves.
// Never regenerated; a scenario edits a scratch copy.
const MODEL_RUNS = join(repoRoot, "packages/analyst-sdk/tests/fixtures/archive/model-runs");
const MODEL_FACTS = JSON.parse(readFileSync(join(MODEL_RUNS, "facts.json"), "utf8")) as { v4: { runKey: string; asof: string }; v5: { runKey: string; asof: string }[] };
// The published reports of the four runs in run order: the newest report is a v5 run's.
const MODEL_REPORTS = [MODEL_FACTS.v4, ...MODEL_FACTS.v5].map((r) => ({ run_key: r.runKey, asof: r.asof, bytes: new TextEncoder().encode("{}") }));

/**
 * A scratch copy of the recorded model runs with each row of `table` passed through `edit`. The file is rewritten
 * and listed again with its bytes and hash, as csvb writes it; the row count and ids are unchanged.
 */
function modelRunsWith(table?: string, edit?: (r: Row) => Row): string {
  const dir = homeScratch("sdk-model-runs-");
  cleanup.push(dir);
  cpSync(MODEL_RUNS, dir, { recursive: true });
  if (table === undefined || edit === undefined) return dir;
  const [backup] = readdirSync(join(dir, "csv"));
  const recPath = join(dir, "csv", backup!, "backup.json");
  const rec = JSON.parse(readFileSync(recPath, "utf8"));
  const file = rec.append_only[table].files[0];
  const csv = parseCopyCsv(gunzipSync(readFileSync(join(dir, file.path))).toString("utf8"));
  const rows = toObjects(csv).map(edit);
  const text = [encodeCsvRow(csv.header), ...rows.map((r) => encodeCsvRow(csv.header.map((h) => r[h] ?? null)))].join("");
  writeFileSync(join(dir, file.path), gzipSync(text));
  Object.assign(file, { bytes_raw: Buffer.byteLength(text), sha256_raw: sha256Hex(text) });
  writeFileSync(recPath, JSON.stringify(rec, null, 2));
  return dir;
}

// The v4 run's ledger id in the recorded copy.
const MODEL_V4_ID = openBackupsDir(MODEL_RUNS).table("analytics_ledger_runs").find((r) => r.run_key === MODEL_FACTS.v4.runKey)!.id!;

/** An edit of the v4 run's published main-line artifact: `change` alters its as-of row; the payload hash is recomputed unless `rehash` is false. */
const tamperV4Asof = (change: (row: Record<string, unknown>) => void, rehash = true) => (o: Row): Row => {
  if (o.run_id !== MODEL_V4_ID || o.artifact_kind !== REGIME_ARTIFACT_KIND.main) return o;
  const rows = JSON.parse(o.payload_json!) as Record<string, unknown>[];
  change(rows.find((r) => r.date === MODEL_FACTS.v4.asof)!);
  const text = JSON.stringify(rows);
  return { ...o, payload_json: text, payload_sha256: rehash ? sha256Hex(text) : o.payload_sha256 };
};

/** Add one data file of an append-only table to a backup record of a copy, listed with its hash as csvb writes it. */
function addTableFile(dir: string, rec: Record<string, any>, backup: string, table: string, csv: string, rows: number, at: string): void {
  const rel = `csv/${backup}/data/${table}.${at}_${at}.csv.gz`;
  writeFileSync(join(dir, rel), gzipSync(csv));
  rec.append_only[table] = {
    time: { column: "created_at" }, watermark_before: null, watermark_after: String(rows), rows_added: rows,
    files: [{ path: rel, rows, bytes_raw: Buffer.byteLength(csv), sha256_raw: sha256Hex(csv), id_min: "1", id_max: String(rows), sum_id: String(rows), time_min: "2001-01-02 05:30:00+00", time_max: "2001-01-02 05:30:00+00" }],
    db_rows_through_watermark: String(rows), db_sum_id_through_watermark: String(rows),
  };
}

/**
 * A copy of the API recording whose run published a report and no regime artifact: its recorded inputs are too
 * short to label a day, so the recording serves the cases that stop before a row is compared.
 */
function recordingWithReportOnly(): string {
  const dir = homeScratch("sdk-recording-");
  cleanup.push(dir);
  cpSync(RECORDING, dir, { recursive: true });
  const backup = "2001-01-03T000000Z";
  const recPath = join(dir, `csv/${backup}/backup.json`);
  const rec = JSON.parse(readFileSync(recPath, "utf8"));
  const report = '{"asof":"2026-08-15","results":{},"toolId":"regime"}';
  const csv = `id,run_id,asof,checksum,byte_length,created_at,report_json,report_sha256\n1,2,2026-08-15,${sha256Hex(report)},${report.length},2001-01-02 05:30:00+00,"${report.replaceAll('"', '""')}",${sha256Hex(report)}\n`;
  addTableFile(dir, rec, backup, "analytics_report_snapshots", csv, 1, "2001-01-02T053000Z");
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
  const withApi = async (recording: string, reports: typeof MODEL_REPORTS, body: (net: SdkDeps["net"]) => Promise<void>) => {
    const api = fakeServer({ recording, reports });
    try {
      await body({ ...fakeNet(), origin: api.origin, fetch: (u: string, i?: RequestInit) => fetch(u, i) });
    } finally {
      api.server.stop(true);
    }
  };
  const recordedReport = [{ run_key: RUN_KEY, asof: "2026-08-15", bytes: new TextEncoder().encode("{}") }];

  test("replay-row --print-row prints the SDK's computed as-of row, equal in every compared field to the published one", async () => {
    const dir = exportPackage("rm-sdk-check-ref-");
    cleanup.push(dir);
    const row = await spawnRunner(["bun", join(repoRoot, "scripts/release/replay-row.ts"), "--sdk", dir, "--archive", MODEL_RUNS, "--run", MODEL_FACTS.v4.runKey, "--print-row"], { cwd: dir });
    expect(row.code, row.stderr).toBe(0);
    const printed = JSON.parse(text(row.stdout)) as Record<string, unknown>;
    expect(printed.date).toBe(MODEL_FACTS.v4.asof);
    expect("regime" in printed && "backtest" in printed && "indicators" in printed).toBe(true);
    const sdk = (await loadReplaySdk(dir))!;
    const published = sdk.replayRun(sdk.openBackupsDir(MODEL_RUNS), MODEL_FACTS.v4.runKey).published.asof!;
    expect(compareRows(published, printed).match).toBe(true);
  });

  test("issue 1765 D-c, end to end: the newest report is a v5 run; the check replays the newest main-line run (v4), its whole row matches, and both hashes are reported", async () => {
    await withApi(MODEL_RUNS, MODEL_REPORTS, async (net) => {
      const r = await postSealCheck(localDeps(net), COMMIT);
      expect(r.found.newestPublishedRun).toBe(MODEL_FACTS.v5.at(-1)!.runKey);
      expect(r.found).toMatchObject({ run_key: MODEL_FACTS.v4.runKey, asof: MODEL_FACTS.v4.asof, methodology: "v4", tier: "full", fixedProducer: true });
      expect(r.problems).toEqual([]);
      expect(r.found.sdkRowSha256).toBe(r.found.publishedRowSha256);
      expect(String(r.found.sdkRowSha256)).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  test("a run of the old producer fails naming the sealed days; a fixed run's tampered number fails naming the field and both hashes", async () => {
    const legacy = modelRunsWith("analytics_ledger_runs", (r) => (r.run_key === MODEL_FACTS.v4.runKey ? { ...r, build_identity: "pkg:0.1.0+bun:1.4.4" } : r));
    await withApi(legacy, MODEL_REPORTS, async (net) => {
      const r = await postSealCheck(localDeps(net), COMMIT);
      expect(r.problems.join()).toContain("old producer");
      expect(r.problems.join()).toContain("sealed backups run through");
    });
    await withApi(modelRunsWith("analytics_output_snapshots", tamperV4Asof((row) => void (row.composite = 0.123456))), MODEL_REPORTS, async (net) => {
      const r = await postSealCheck(localDeps(net), COMMIT);
      expect(r.found.tier).toBe("full");
      expect(r.problems.join()).toContain("differs from the published one in composite");
      expect(r.problems.join()).toContain("sha256 published");
    });
  });

  test("RED CONTROL: a label that differs fails", async () => {
    await withApi(modelRunsWith("analytics_output_snapshots", tamperV4Asof((row) => void (row.regime = "not-a-regime"))), MODEL_REPORTS, async (net) => {
      expect((await postSealCheck(localDeps(net), COMMIT)).problems.join()).toContain("differs from the published one in regime");
    });
  });

  test("RED CONTROL: a published payload that does not match its stored payload_sha256 fails, never compared", async () => {
    await withApi(modelRunsWith("analytics_output_snapshots", tamperV4Asof((row) => void (row.composite = 0.123456), false)), MODEL_REPORTS, async (net) => {
      const r = await postSealCheck(localDeps(net), COMMIT);
      expect(r.problems.join()).toContain("does not match its stored payload_sha256");
    });
  });

  test("RED CONTROL: a run with no archived record fails with the missing-run message", async () => {
    await withApi(MODEL_RUNS, [{ run_key: "99999999-9999-4999-8999-999999999999", asof: "2026-10-27", bytes: new TextEncoder().encode("{}") }], async (net) => {
      expect((await postSealCheck(localDeps(net), COMMIT)).problems.join()).toContain("no sealed backup holds a published run yet");
    });
  });

  test("red: a published artifact with no row for the as-of day fails; a published run with no artifact in the copy fails", async () => {
    await withApi(modelRunsWith("analytics_output_snapshots", tamperV4Asof((row) => void (row.date = "2001-01-01"))), MODEL_REPORTS, async (net) => {
      expect((await postSealCheck(localDeps(net), COMMIT)).problems.join()).toContain(`has no as-of row for ${MODEL_FACTS.v4.asof}`);
    });
    // The run published (its report is in the copy) but its regime artifact is not.
    await withApi(recordingWithReportOnly(), recordedReport, async (net) => {
      expect((await postSealCheck(localDeps(net), COMMIT)).problems.join()).toContain(`has no ${REGIME_ARTIFACT_KIND.main} artifact`);
    });
    // A run that froze a vintage and published nothing (no report, no artifact) is no candidate (D-c).
    await withApi(RECORDING, recordedReport, async (net) => {
      expect((await postSealCheck(localDeps(net), COMMIT)).problems.join()).toContain("no sealed backup holds a published run yet");
    });
  });

  test("red: an SDK commit without src/replay (before issue 1765) is refused by name before the fill", async () => {
    const old: SdkDeps["prepareSdk"] = async () => {
      const dir = exportPackage("rm-sdk-check-old-");
      cleanup.push(dir);
      rmSync(join(dir, "src", "replay"), { recursive: true, force: true });
      return { sdkDir: dir };
    };
    const net = fakeNet({ reports: recordedReport });
    const r = await postSealCheck({ ...localDeps(net), prepareSdk: old }, COMMIT);
    expect(r.problems).toEqual([SDK_TOO_OLD]);
    expect(SDK_TOO_OLD).toContain("predates its replay module (issue 1765)");
    expect(net.requests.some((q) => q.includes("/archive/"))).toBe(false);
  });

  test("red: a target with no published run fails with a message that says so, never skips", async () => {
    const r = await postSealCheck(localDeps(fakeNet({ reports: [] })), COMMIT);
    expect(r.problems).toEqual([noRunMessage("the post-seal check")]);
  });

  test("red: a fill that fails (the API answers 404 for the archive) fails the check", async () => {
    const api = fakeServer({ reports: recordedReport, archiveStatus: 404 });
    try {
      const net = { ...fakeNet(), origin: api.origin, fetch: (u: string, i?: RequestInit) => fetch(u, i) };
      expect((await postSealCheck(localDeps(net), COMMIT)).problems.join()).toContain("fill api-copy exited");
    } finally {
      api.server.stop(true);
    }
  });
});

// The comparison is the SDK's compareRows (issue 1765); replay-row.ts turns it into the check's problems.
describe("the as-of row comparison (PR 1448)", () => {
  const row = { date: "d", regime: "risk_on", composite: 0.5, macroRegime: "neutral", percentiles: { A: 1 }, correlations: { a: [1, 2] }, backtest: null };
  test("equal rows match whatever the key order; each differing field is named, in compared order; a missing row is a mismatch", () => {
    expect(compareRows(row, row).match).toBe(true);
    expect(comparisonProblems(compareRows(row, row), "k", "d")).toEqual([]);
    expect(compareRows({ backtest: null, correlations: { a: [1, 2] }, percentiles: { A: 1 }, macroRegime: "neutral", composite: 0.5, regime: "risk_on", date: "x" }, row).match).toBe(true);
    const c = compareRows({ ...row, composite: 0.6, percentiles: { A: 2 } }, row);
    expect([c.match, c.differing, c.firstDiff?.field]).toEqual([false, ["composite", "percentiles"], "composite"]);
    expect(c.publishedSha256).not.toBe(c.replaySha256);
    expect(comparisonProblems(c, "k", "d").join()).toContain("differs from the published one in composite, percentiles");
    expect(compareRows(null, row)).toMatchObject({ match: false, differing: [MISSING_ROW], publishedSha256: null });
    expect(comparisonProblems(compareRows(null, row), "k", "d").join()).toContain("has no as-of row for d");
  });

  test("a missing computed row is a mismatch, never a pass, on either tier", () => {
    const c = compareRows(row, null);
    expect(c).toMatchObject({ match: false, differing: [MISSING_ROW], replaySha256: null });
    expect(c.publishedSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(comparisonProblems(c, "k", "d")).toEqual(["run k: the SDK computed no as-of row for d"]);
    expect(labelMismatches(c)).toEqual([MISSING_ROW]);
    expect(labelProblems(c, labelMismatches(c), "k", "d")).toEqual(["run k: the SDK computed no as-of row for d"]);
  });

  test("the label tier (labelMismatches): only the as-of labels must be equal; a missing published row is a problem", () => {
    // A number moved (a pre-1421 run): info on the label tier, a problem on the full tier.
    const moved = compareRows({ ...row, composite: 0.500001, percentiles: { A: 1.000001 } }, row);
    expect(labelMismatches(moved)).toEqual([]);
    expect(labelProblems(moved, labelMismatches(moved), "k", "d")).toEqual([]);
    expect(comparisonProblems(moved, "k", "d").length).toBe(1);
    // A label moved, with a number: only the label is named.
    const flipped = compareRows({ ...row, macroRegime: "risk_off", composite: 0.6 }, row);
    expect(labelMismatches(flipped)).toEqual(["macroRegime"]);
    expect(labelProblems(flipped, labelMismatches(flipped), "k", "d")).toEqual(["run k as of d: the SDK's as-of label differs from the published one in macroRegime"]);
    const both = compareRows({ ...row, regime: "risk_off", macroRegime: "risk_off" }, row);
    expect(labelMismatches(both)).toEqual(["regime", "macroRegime"]);
    // red: no published row is a problem on the label tier too, never a pass.
    const absent = compareRows(null, row);
    expect(labelMismatches(absent)).toEqual([MISSING_ROW]);
    expect(labelProblems(absent, labelMismatches(absent), "k", "d").join()).toContain("has no as-of row for d");
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

/** A format 1 local copy of one backup holding these append-only tables, listed with their hashes, as the SDK reader opens it. */
function writeCopy(dir: string, backup: string, tables: Record<string, { header: string[]; rows: (string | null)[][] }>): void {
  mkdirSync(join(dir, "csv", backup, "data"), { recursive: true });
  const append_only: Record<string, unknown> = {};
  for (const [table, t] of Object.entries(tables)) {
    const csv = [t.header, ...t.rows].map((r) => encodeCsvRow(r)).join("");
    const rel = `csv/${backup}/data/${table}.2026-01-01T000000Z_2026-01-01T000000Z.csv.gz`;
    writeFileSync(join(dir, rel), gzipSync(csv));
    append_only[table] = { watermark_before: null, watermark_after: String(t.rows.length), rows_added: t.rows.length, files: [{ path: rel, rows: t.rows.length, bytes_raw: Buffer.byteLength(csv), sha256_raw: sha256Hex(csv) }] };
  }
  writeFileSync(join(dir, "csv", backup, "backup.json"), JSON.stringify({ format: 1, backup, append_only }, null, 2));
}

describe("the post-seal check replays the newest published main-line run the archive holds (issue 1765, D-c)", () => {
  let sdk: ReplaySdk;
  beforeAll(async () => {
    sdk = (await loadReplaySdk(join(repoRoot, "packages/analyst-sdk")))!;
  });
  const [k1, k2, k3, k4, k5] = ["1", "2", "3", "4", "5"].map((d) => `${d.repeat(8)}-${d.repeat(4)}-4${d.repeat(3)}-8${d.repeat(3)}-${d.repeat(12)}`) as [string, string, string, string, string];
  const sha = "4b4414c0759305df046a2de511bb446070ee7057";
  const pkg = "pkg:0.1.0+bun:1.4.4";
  /**
   * A filled copy: v4 runs 1 to 3 (old producer, fixed, old producer) and the newest run 5 under methodology 2,
   * labelled `label2` ("v5": a beside run). Each froze a vintage and published a report. Run 4 is published but
   * made after the newest sealed backup, so it is not in the copy.
   */
  const filledCopy = (label2: string): string => {
    const dir = homeScratch("sdk-ledger-test-");
    cleanup.push(dir);
    const runs: [string, string, string, string, string][] = [["1", k1, "2026-10-20", "1", pkg], ["2", k2, "2026-10-24", "1", sha], ["3", k3, "2026-10-26", "1", pkg], ["5", k5, "2026-10-28", "2", sha]];
    const report = '{"asof":"2026-10-20","results":{},"toolId":"regime"}';
    writeCopy(dir, "2026-11-01T000000Z", {
      analytics_ledger_methodology_versions: {
        header: ["id", "tool_id", "version_label", "config", "config_digest", "created_at"],
        rows: [["1", "regime", "v4", "{}", "d".repeat(64), "2026-10-01 00:00:00+00"], ["2", "regime", label2, "{}", "e".repeat(64), "2026-10-01 00:00:00+00"]],
      },
      analytics_ledger_runs: {
        header: ["id", "run_key", "asof", "tool_id", "source_label", "methodology_version_id", "build_identity", "job_id", "created_at"],
        rows: runs.map(([id, key, asof, meth, build]) => [id, key, asof, "regime", "live", meth, build, null, `${asof} 21:30:00.5+00`]),
      },
      analytics_data_vintages: {
        header: ["id", "run_id", "tool_id", "knowledge_time_cutoff", "market_time_cutoff", "member_count", "created_at"],
        rows: runs.map(([id, , asof]) => [id, id, "regime", `${asof} 21:00:00+00`, asof, "0", `${asof} 21:31:00+00`]),
      },
      analytics_report_snapshots: {
        header: ["id", "run_id", "asof", "checksum", "byte_length", "created_at", "report_json", "report_sha256"],
        rows: runs.map(([id, , asof]) => [id, id, asof, sha256Hex(report), String(report.length), `${asof} 21:31:00+00`, report, sha256Hex(report)]),
      },
    });
    return dir;
  };
  const row = (id: number, k: string) => ({ report_id: id, run_key: k, asof: "2026-10-2" + id, checksum: "c", byte_length: 1 });
  const published = [row(1, k1), row(2, k2), row(3, k3), row(4, k4), row(5, k5)];

  test("the newest report is a v5 run: the choice skips it, and the run published after the newest sealed backup, for the newest main-line run", () => {
    const runs = archivedRuns(sdk, filledCopy("v5"));
    // Main-line runs only, newest first (publicationCandidates over the copy, opened with the SDK's reader).
    expect([...runs.keys()]).toEqual([k3, k2, k1]);
    expect(runs.get(k3)).toMatchObject({ methodology: "v4", asof: "2026-10-26", buildIdentity: pkg });
    expect(latestReport(published)?.run_key).toBe(k5);
    expect(newestArchivedReport(published, runs)?.run_key).toBe(k3);
    expect(newestArchivedReport([row(4, k4)], runs)).toBeUndefined();
    expect(newestArchivedReport([row(5, k5)], runs)).toBeUndefined();
  });

  test("RED CONTROL: with the v5 run relabelled v4 (a main-line run), the same copy's choice is that run", () => {
    const runs = archivedRuns(sdk, filledCopy("v4"));
    expect([...runs.keys()]).toEqual([k5, k3, k2, k1]);
    expect(newestArchivedReport(published, runs)?.run_key).toBe(k5);
  });

  test("the build identity splits the producers; a folder with no csv/ is no copy", () => {
    const runs = archivedRuns(sdk, filledCopy("v5"));
    expect(isFixedProducer(runs.get(k1)!.buildIdentity)).toBe(false);
    expect(isFixedProducer(runs.get(k2)!.buildIdentity)).toBe(true);
    expect(isFixedProducer("")).toBe(false);
    // v0.7.0 predates D78's exact arithmetic: its runs replay equal on the labels only.
    expect(isFixedProducer("8c2690bac11440a8d8ef86733a567066afaea116")).toBe(false);
    expect(isFixedProducer("4928ee57f5bb833dd4b543113b385f1570251eac")).toBe(true);
    const empty = homeScratch("sdk-ledger-test-");
    cleanup.push(empty);
    expect(archivedRuns(sdk, join(empty, "missing")).size).toBe(0);
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
