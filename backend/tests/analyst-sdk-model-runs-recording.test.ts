// Issue 1765 (phase 0): a committed v4 and v5 archive of real model runs,
// recorded from today's backend code.
//
// One clean database, four regime runs through the production orchestrator
// (runAnalytics) and DIRECT persistence (directAnalyticsPersistence, the
// harness default at tests/support/regime-v5.ts runRegime): a v4 run for the
// fixture's as-of day, then three v5 runs for three consecutive days ending on
// it. That is v5's kept chain (tests/regime-v5-sdk-equivalence.test.ts): the
// first v5 run computes the whole walk forward and freezes it, each later run
// freezes one row. The inputs are the committed fixture source plus the five
// collected series v5's derived indicators read (tests/support/regime-v5.ts).
//
// With RECORD_ANALYST_SDK_MODEL_RUNS=1 the test acquires the runs' archive
// through the REAL public archive routes (handlePublicAnalytics), the way the
// README's API-only fill does: list `archive/backups`, fetch each
// `backup.json`, then each archive it lists, checking every archive's
// sha256_raw. The archive clock is set past the UTC day the runs were written
// in, so that day is sealed. It writes the copy to
// packages/analyst-sdk/tests/fixtures/archive/model-runs/ (backups.json and
// csv/...) with facts.json naming each run's key, as-of day and methodology
// label. The run keys are beginRun's random UUIDs. Record once and commit the
// files. Never regenerate their payloads from the SDK: phase 1 compares the
// SDK's published rows with these payloads, so an SDK-made copy would make that
// comparison circular.
//
// Without the variable (CI) the test reruns the four runs on a clean database
// and holds the committed copy to them, per (label, as-of day): each regime
// artifact's payload_sha256 in the copy equals the fresh run's
// analytics_output_snapshots.checksum, and each v5 report's
// results.regime.kept.sha256 equals the fresh one. runAnalytics stamps
// database-clock times (created_at, knowledge_time, the backup ids and file
// names that follow from them), so no time column is ever compared.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { ROUTES } from "@robotmoney/contract";
import { sql } from "../src/db/client.ts";
import { _resetPublicAnalyticsCacheForTests, _resetPublicAnalyticsRateLimitForTests, handlePublicAnalytics } from "../src/api/routes/public-analytics.ts";
import { _resetArchiveForTests, _setArchiveClockForTests } from "../src/analytics/store/public-archive-store.ts";
import { directAnalyticsPersistence } from "../src/analytics/store/direct.ts";
import { REGIME_ARTIFACT_KIND } from "../src/analytics/output-snapshots.ts";
import { openBackupsDir, type Archive } from "../../packages/analyst-sdk/bin/backups-dir.ts";
import { DAY_MS, SETTLE_MS } from "../../packages/analyst-sdk/src/archive/format1.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { ASOF, DAYS, runRegime, sourceFor, v5Observations } from "./support/regime-v5.ts";

useCleanDatabase(import.meta.file);

const P = ROUTES.publicAnalytics;
const SDK = join(import.meta.dir, "../../packages/analyst-sdk");
const RECORDING = join(SDK, "tests/fixtures/archive/model-runs");
const RECORD = process.env.RECORD_ANALYST_SDK_MODEL_RUNS === "1";
const REGIME_KINDS: readonly string[] = Object.values(REGIME_ARTIFACT_KIND);
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

interface RunFact {
  runKey: string;
  asof: string;
  label: string;
}
interface Facts {
  v4: RunFact;
  v5: RunFact[];
}

/** What a run published that its replay is held to: its regime artifacts' checksums by kind, and its report's kept sha256. */
interface Published {
  fact: RunFact;
  checksums: Record<string, string>;
  keptSha256: string | null;
}

beforeAll(() => {
  _resetArchiveForTests();
});

afterAll(() => {
  _setArchiveClockForTests(null);
  _resetArchiveForTests();
});

async function get(path: string): Promise<Uint8Array> {
  // A record is built in the background: the route answers 503 until it is ready.
  for (let i = 0; i < 1200; i++) {
    _resetPublicAnalyticsRateLimitForTests();
    _resetPublicAnalyticsCacheForTests();
    const req = new Request(`http://api.test${path}`);
    const res = await handlePublicAnalytics(req, new URL(req.url), "192.0.2.17");
    if (res.status === 503) {
      await Bun.sleep(250);
      continue;
    }
    expect(res.status, path).toBe(200);
    return new Uint8Array(await res.arrayBuffer());
  }
  throw new Error(`${path} kept answering 503`);
}

/** One run as the database holds it now. */
async function freshPublished(runId: string): Promise<Published> {
  const [run] = await sql<{ run_key: string; asof: string; label: string }[]>`
    SELECT r.run_key, r.asof::text AS asof, m.version_label AS label
    FROM analytics_ledger_runs r JOIN analytics_ledger_methodology_versions m ON m.id = r.methodology_version_id
    WHERE r.id = ${runId}::bigint`;
  const outputs = await sql<{ artifact_kind: string; checksum: string }[]>`
    SELECT artifact_kind, checksum FROM analytics_output_snapshots WHERE run_id = ${runId}::bigint ORDER BY id`;
  const checksums: Record<string, string> = {};
  for (const o of outputs) if (REGIME_KINDS.includes(o.artifact_kind)) checksums[o.artifact_kind] = o.checksum;
  const [report] = await sql<{ report_bytes: Uint8Array }[]>`SELECT report_bytes FROM analytics_report_snapshots WHERE run_id = ${runId}::bigint`;
  const parsed = JSON.parse(new TextDecoder().decode(report!.report_bytes)) as { results?: { regime?: { kept?: { sha256?: string } } } };
  return { fact: { runKey: run!.run_key, asof: run!.asof, label: run!.label }, checksums, keptSha256: parsed.results?.regime?.kept?.sha256 ?? null };
}

/** One run as the committed copy holds it, by its run key. */
function committedPublished(copy: Archive, runKey: string): Published {
  const runs = copy.table("analytics_ledger_runs").filter((r) => r.run_key === runKey);
  expect(runs.length, runKey).toBe(1);
  const run = runs[0]!;
  const meth = copy.table("analytics_ledger_methodology_versions").find((m) => m.id === run.methodology_version_id);
  const checksums: Record<string, string> = {};
  for (const o of copy.table("analytics_output_snapshots")) {
    if (o.run_id !== run.id || !REGIME_KINDS.includes(o.artifact_kind!)) continue;
    // The copy's own checksum is its payload's hash.
    expect(o.payload_sha256, `${runKey} ${o.artifact_kind}`).toBe(sha256(o.payload_json!));
    expect(o.checksum, `${runKey} ${o.artifact_kind}`).toBe(o.payload_sha256!);
    checksums[o.artifact_kind!] = o.payload_sha256!;
  }
  const reports = copy.table("analytics_report_snapshots").filter((r) => r.run_id === run.id);
  expect(reports.length, runKey).toBe(1);
  const parsed = JSON.parse(reports[0]!.report_json!) as { results?: { regime?: { kept?: { sha256?: string } } } };
  return { fact: { runKey, asof: run.asof!, label: meth?.version_label ?? "" }, checksums, keptSha256: parsed.results?.regime?.kept?.sha256 ?? null };
}

/** Acquire the whole archive through the public routes, as the README's API-only fill does. */
async function acquire(): Promise<Map<string, Uint8Array>> {
  const served = new Map<string, Uint8Array>();
  const listBytes = await get(`${P.archiveBackups}?limit=1000`);
  const list = JSON.parse(new TextDecoder().decode(listBytes)) as { backups: { backup: string; record: string }[]; nextCursor: string | null };
  expect(list.nextCursor).toBeNull();
  expect(list.backups.length).toBeGreaterThan(0);
  // Day cuts only: the test database never reaches the legacy junction's watermarks.
  for (const b of list.backups) expect(b.backup, b.backup).toMatch(/^\d{4}-\d{2}-\d{2}T000000Z$/);
  served.set("backups.json", listBytes);
  for (const { record } of list.backups) {
    const recBytes = await get(`${P.archiveFiles}${record}`);
    served.set(record, recBytes);
    const rec = JSON.parse(new TextDecoder().decode(recBytes)) as { append_only: Record<string, { files: { path: string; sha256_raw: string }[] }> };
    for (const t of Object.values(rec.append_only)) {
      for (const f of t.files) {
        const body = await get(`${P.archiveFiles}${f.path}`);
        expect(sha256(gunzipSync(body)), f.path).toBe(f.sha256_raw);
        served.set(f.path, body);
      }
    }
  }
  return served;
}

test(
  "the committed model-runs archive holds the regime artifacts and the kept sha256 that today's backend code publishes for a v4 run and three chained v5 runs",
  async () => {
    // ── The four runs, on one clean database ───────────────────────────────
    const obs = await v5Observations();
    await directAnalyticsPersistence.saveRawHistory({ MNA: obs.mna }, "fixture");
    const source = sourceFor(obs);
    const runIds: { v4: string; v5: string[] } = { v4: "", v5: [] };
    try {
      runIds.v4 = (await runRegime(ASOF, source, "v4")).runId;
      for (const day of DAYS) runIds.v5.push((await runRegime(day, source, "v5")).runId);
    } finally {
      source.restore();
    }
    const fresh = { v4: await freshPublished(runIds.v4), v5: await Promise.all(runIds.v5.map(freshPublished)) };
    expect(fresh.v4.fact).toMatchObject({ asof: ASOF, label: "v4" });
    expect(fresh.v5.map((r) => r.fact.asof)).toEqual([...DAYS]);
    for (const r of fresh.v5) expect(r.fact.label).toBe("v5");
    expect(Object.keys(fresh.v4.checksums)).toContain(REGIME_ARTIFACT_KIND.main);
    expect(fresh.v4.keptSha256).toBeNull();
    for (const r of fresh.v5) {
      expect(Object.keys(r.checksums)).toContain(REGIME_ARTIFACT_KIND.beside);
      expect(r.keptSha256).toMatch(/^[0-9a-f]{64}$/);
    }

    // ── Record: acquire through the real routes, write the copy and its facts ──
    if (RECORD) {
      // Past the UTC day of every row written so far, plus the settle hour: that day is sealed.
      const sealed = Math.floor(Date.now() / DAY_MS) * DAY_MS + DAY_MS + SETTLE_MS + 60_000;
      _resetArchiveForTests();
      _setArchiveClockForTests(() => sealed);
      const served = await acquire();
      expect([...served.keys()].some((k) => k.includes("/data/source_value_versions."))).toBe(true);
      expect([...served.keys()].some((k) => k.includes("/data/analytics_output_snapshots."))).toBe(true);
      rmSync(RECORDING, { recursive: true, force: true });
      for (const [rel, bytes] of served) {
        mkdirSync(dirname(join(RECORDING, rel)), { recursive: true });
        writeFileSync(join(RECORDING, rel), bytes);
      }
      const facts: Facts = { v4: fresh.v4.fact, v5: fresh.v5.map((r) => r.fact) };
      writeFileSync(join(RECORDING, "facts.json"), JSON.stringify(facts, null, 2) + "\n");
    }

    // ── The committed copy against the fresh runs, per (label, as-of day) ──
    expect(existsSync(join(RECORDING, "facts.json")), `${RECORDING}/facts.json: record it with RECORD_ANALYST_SDK_MODEL_RUNS=1`).toBe(true);
    const facts = JSON.parse(readFileSync(join(RECORDING, "facts.json"), "utf8")) as Facts;
    expect(facts.v4).toMatchObject({ asof: ASOF, label: "v4" });
    expect(facts.v5.map((f) => [f.label, f.asof])).toEqual(DAYS.map((d) => ["v5", d]));
    const copy = openBackupsDir(RECORDING);
    const pairs: [RunFact, Published][] = [[facts.v4, fresh.v4], ...facts.v5.map((f, i): [RunFact, Published] => [f, fresh.v5[i]!])];
    for (const [fact, now] of pairs) {
      const committed = committedPublished(copy, fact.runKey);
      const at = `${fact.label} ${fact.asof}`;
      expect({ label: committed.fact.label, asof: committed.fact.asof }, at).toEqual({ label: fact.label, asof: fact.asof });
      expect({ label: now.fact.label, asof: now.fact.asof }, at).toEqual({ label: fact.label, asof: fact.asof });
      // Every regime artifact, by kind: the committed payload's hash is the fresh checksum.
      expect(committed.checksums, at).toEqual(now.checksums);
      // The kept sha256 of each v5 report (a v4 report keeps no history: null on both sides).
      expect(committed.keptSha256, at).toBe(now.keptSha256);
    }
  },
  900_000,
);
