// Issue 1765 (phase 1, acceptance box 2): replayRun over the committed
// model-runs copy (a v4 run and three chained v5 runs, recorded through the
// production persistence by backend/tests/analyst-sdk-model-runs-recording.test.ts).
// Each run replays with an empty diff; a v5 run's published rows come from its
// line's artifact kind; the computed rows equal every published row; a later v5
// run computes one day from the kept days its report names. Every control
// tampers an in-memory copy and must be reported by name: a derived-indicator
// percentile, each compared field, a payload whose hash does not match, and a
// kept day a fresh walk would never read.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openBackupsDir } from "../bin/backups-dir.ts";
import { CURRENT_REGIME_VERSION, REGIME_ARTIFACT_KIND, REGIME_PUBLISHED_PANELS, regimeArtifactKindOf } from "../src/analyze/regime-versions.ts";
import { V5_DERIVED_SERIES } from "../src/transform/derived.ts";
import { PANELS } from "../src/analyze/indicators.ts";
import { canonicalStringify } from "../src/report/canonical.ts";
import type { FileRecord, Row } from "../src/archive/format1.ts";
import type { Archive } from "../src/archive/reader.ts";
import { COMPARED_FIELDS, LABEL_FIELDS, publicationCandidates, replayRun, UnknownRunError, type ReplayResult } from "../src/replay/index.ts";
import { ArchiveCopy, sha256, tamperArtifact } from "./support/archive-tamper.ts";

const ARCHIVE = join(import.meta.dir, "fixtures/archive");
const MODEL_RUNS = join(ARCHIVE, "model-runs");
const API_RECORDED = join(ARCHIVE, "api-recorded");
type Fact = { runKey: string; asof: string; label: string };
const FACTS = JSON.parse(readFileSync(join(MODEL_RUNS, "facts.json"), "utf8")) as { v4: Fact; v5: Fact[] };
const [V5_FIRST, V5_SECOND, V5_THIRD] = FACTS.v5 as [Fact, Fact, Fact];
const OUTPUTS = "analytics_output_snapshots";
const REPORTS = "analytics_report_snapshots";

// The clean replays, each computed once for the whole file.
const copy = openBackupsDir(MODEL_RUNS);
const clean = new Map<string, ReplayResult>();
const replayed = (f: Fact): ReplayResult => {
  let r = clean.get(f.runKey);
  if (!r) clean.set(f.runKey, (r = replayRun(copy, f.runKey)));
  return r;
};
const asofRowOf = (rows: Record<string, any>[], asof: string) => rows.find((r) => r.date === asof)!;
const BASE = new ArchiveCopy(MODEL_RUNS);

describe("replayRun over the committed model-runs copy (issue 1765)", () => {
  test("the platform tables: each line's artifact kind, and the panels each version's published runs averaged", () => {
    expect(REGIME_ARTIFACT_KIND.beside).toBe("regime_beside_snapshots");
    expect(Object.keys(REGIME_ARTIFACT_KIND)).toEqual(["main", "beside"]);
    expect(REGIME_PUBLISHED_PANELS).toEqual({ v3: ["macro", "onchain"], v4: PANELS, v5: PANELS });
    expect(Object.isFrozen(REGIME_PUBLISHED_PANELS.v3)).toBe(true);
  });

  test("the v4 run and each of the three v5 runs replay with an empty diff, under the version of their label", () => {
    for (const f of [FACTS.v4, ...FACTS.v5]) {
      const r = replayed(f);
      expect({ run: f.runKey, version: r.version, problems: r.problems, match: r.diff?.match, differing: r.diff?.differing }).toEqual({ run: f.runKey, version: f.label as any, problems: [], match: true, differing: [] });
      expect(r.run.asof).toBe(f.asof);
      expect(r.panels).toEqual(REGIME_PUBLISHED_PANELS[r.version!]);
      expect(r.diff!.publishedSha256).toBe(r.diff!.replaySha256);
      expect(Object.keys(r.diff!.fields)).toEqual([...COMPARED_FIELDS]);
    }
  }, 300_000);

  test("a v5 run's published rows are its beside artifact; its main-line artifact is the empty list; the v4 run's are the main line's", () => {
    expect(regimeArtifactKindOf("v5")).toBe(REGIME_ARTIFACT_KIND.beside);
    expect(regimeArtifactKindOf("v4")).toBe(REGIME_ARTIFACT_KIND.main);
    const outputs = copy.table(OUTPUTS);
    for (const f of FACTS.v5) {
      const r = replayed(f);
      expect(r.line).toBe("beside");
      expect(r.published.kind).toBe(REGIME_ARTIFACT_KIND.beside);
      const own = outputs.filter((o) => o.run_id === r.run.id);
      expect(own.find((o) => o.id === r.published.artifactId)!.artifact_kind).toBe(REGIME_ARTIFACT_KIND.beside);
      const main = own.filter((o) => o.artifact_kind === REGIME_ARTIFACT_KIND.main);
      expect(main.length).toBe(1);
      expect(JSON.parse(main[0]!.payload_json!)).toEqual([]);
      expect(r.published.rows!.length).toBeGreaterThan(0);
    }
    const v4 = replayed(FACTS.v4);
    expect(v4.line).toBe("main");
    expect(v4.published.kind).toBe(REGIME_ARTIFACT_KIND.main);
  });

  test("the computed rows equal the published rows for every published day, byte for byte", () => {
    const outputs = copy.table(OUTPUTS);
    for (const f of [FACTS.v4, ...FACTS.v5]) {
      const r = replayed(f);
      const payload = outputs.find((o) => o.id === r.published.artifactId)!.payload_json!;
      expect(r.computed.rows.map((x) => x.date)).toEqual(r.published.rows!.map((x) => x.date));
      expect(canonicalStringify(r.computed.rows) === payload).toBe(true);
      expect(r.computed.asof!.date).toBe(f.asof);
    }
    // The first v5 run publishes every day it walked that has a composite mean; the later two one day each.
    expect(replayed(V5_FIRST).computed.rows.length).toBeGreaterThan(1000);
    expect(replayed(V5_SECOND).computed.rows.length).toBe(1);
    expect(replayed(V5_THIRD).computed.rows.length).toBe(1);
  });

  test("the later v5 runs read the kept days their reports name and compute exactly one new day; the first walks forward", () => {
    const first = replayed(V5_FIRST).kept!;
    expect(first.days.length).toBe(0);
    expect(first.artifactIds).toEqual([]);
    expect(first.computedDays).toBeGreaterThan(1000);
    const firstArtifact = replayed(V5_FIRST).published.artifactId!;
    const second = replayed(V5_SECOND).kept!;
    expect(second.artifactIds).toEqual([firstArtifact]);
    expect(second.days.length).toBe(replayed(V5_FIRST).published.rows!.length);
    expect(second.computedDays).toBe(1);
    const third = replayed(V5_THIRD).kept!;
    expect(third.artifactIds).toEqual([firstArtifact, replayed(V5_SECOND).published.artifactId!]);
    expect(third.days.length).toBe(second.days.length + 1);
    expect(third.days.at(-1)!.date).toBe(V5_SECOND.asof);
    expect(third.computedDays).toBe(1);
    // The v4 run keeps no history.
    expect(replayed(FACTS.v4).kept).toBeNull();
  });

  test("an unknown run key throws UnknownRunError", () => {
    expect(() => replayRun(copy, "00000000-0000-0000-0000-000000000000")).toThrow(UnknownRunError);
  });
});

// The third v5 run, replayed from a tampered in-memory copy.
const replayThird = (c: ArchiveCopy): ReplayResult => replayRun(c.open(), V5_THIRD.runKey);

describe("tamper controls: every change to a published row is reported by name (issue 1765)", () => {
  test("the in-memory copy, rewritten unchanged, keeps every recorded hash and replays clean", () => {
    const c = BASE.clone();
    const before = JSON.stringify(c.backups().map((b) => c.record(b)));
    expect(c.editTable(OUTPUTS, (o) => o)).toBe(0);
    expect(JSON.stringify(c.backups().map((b) => c.record(b)))).toBe(before);
    expect(replayThird(c).diff!.match).toBe(true);
  }, 120_000);

  test("a mutated derived-indicator percentile on the v5 as-of row is reported as percentiles.<ID>", () => {
    const artifact = replayed(V5_THIRD).published.artifactId!;
    const derived = V5_DERIVED_SERIES.map((d) => d.id);
    expect(derived.length).toBe(4);
    for (const id of derived) {
      expect(replayed(V5_THIRD).published.asof!.percentiles).toHaveProperty(id);
      const c = tamperArtifact(BASE.clone(), artifact, (rows) => {
        const p = asofRowOf(rows, V5_THIRD.asof).percentiles;
        p[id] = Number((p[id] > 0.5 ? p[id] - 0.25 : p[id] + 0.25).toFixed(6));
      });
      const r = replayThird(c);
      expect({ id, problems: r.problems, differing: r.diff!.differing, details: r.diff!.details }).toEqual({ id, problems: [], differing: ["percentiles"], details: [`percentiles.${id}`] });
      expect(r.diff!.firstDiff!.field).toBe("percentiles");
      expect(r.diff!.beyondRounding).toEqual(["percentiles"]);
    }
  }, 300_000);

  test("a mutation of each COMPARED_FIELDS field is reported by that field's name", () => {
    const artifact = replayed(V5_THIRD).published.artifactId!;
    const labels = new Set<string>(LABEL_FIELDS);
    for (const field of COMPARED_FIELDS) {
      const c = tamperArtifact(BASE.clone(), artifact, (rows) => {
        const row = asofRowOf(rows, V5_THIRD.asof);
        const v = row[field];
        if (labels.has(field)) row[field] = v === "risk_on" ? "risk_off" : "risk_on";
        else if (field === "percentiles") row[field] = { ...v, BTC_MVRV: v.BTC_MVRV + 0.125 };
        else if (v !== null && typeof v === "object") row[field] = { ...v, tampered: true };
        else row[field] = v === null ? 0.5 : v + 0.125;
      });
      const r = replayThird(c);
      expect({ field, problems: r.problems, match: r.diff!.match, differing: r.diff!.differing }).toEqual({ field, problems: [], match: false, differing: [field] });
      expect(r.diff!.firstDiff!.field).toBe(field);
      expect(r.diff!.details.every((d) => d === field || d.startsWith(`${field}.`))).toBe(true);
    }
  }, 600_000);

  test("a payload whose bytes do not match its payload_sha256 is a problem, and its rows are not compared", () => {
    const artifact = replayed(V5_THIRD).published.artifactId!;
    const c = tamperArtifact(BASE.clone(), artifact, (rows) => void (asofRowOf(rows, V5_THIRD.asof).composite = 0.123), true);
    const r = replayThird(c);
    expect(r.problems.length).toBe(1);
    expect(r.problems[0]).toContain("does not match its stored payload_sha256");
    expect(r.published.rows).toBeNull();
    expect(r.diff!.match).toBe(false);
    expect(r.diff!.differing).toEqual(["as-of row"]);
  }, 120_000);

  test("kept-days control: a changed kept day, with every hash recomputed, changes the replayed composite (a fresh walk would not read it)", () => {
    const named = replayed(V5_THIRD).kept!.artifactIds;
    const secondArtifact = replayed(V5_SECOND).published.artifactId!;
    expect(named).toContain(secondArtifact);
    const c = BASE.clone();
    // Move the second run's day (kept by the third) from below the third day's composite mean to above it.
    const third = replayed(V5_THIRD).published.asof!;
    const mean = (x: Record<string, any>) => (x.macroIndex + x.onchainIndex + x.factorIndex) / 3;
    tamperArtifact(c, secondArtifact, (rows) => {
      const day = asofRowOf(rows, V5_SECOND.asof);
      expect(mean(day)).toBeLessThan(mean(third));
      day.macroIndex = day.macroIndex + 3 * (mean(third) + 0.01 - mean(day));
      expect(mean(day)).toBeGreaterThan(mean(third));
    });
    // The third run's report names the kept days by their sha256: recompute it from the tampered artifacts.
    const outputs = c.open().table(OUTPUTS);
    const byDate = new Map<string, Record<string, any>>();
    for (const id of named) for (const row of JSON.parse(outputs.find((o) => o.id === id)!.payload_json!)) if (row.date < V5_THIRD.asof) byDate.set(row.date, row);
    const days = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1)).map((r) => ({ date: r.date, macroIndex: r.macroIndex ?? null, onchainIndex: r.onchainIndex ?? null, factorIndex: r.factorIndex ?? null }));
    const oldSha = replayed(V5_THIRD).kept!.sha256;
    const newSha = sha256(canonicalStringify(days));
    expect(newSha).not.toBe(oldSha);
    const thirdId = replayed(V5_THIRD).run.id;
    const changed = c.editTable(REPORTS, (x) => {
      if (x.run_id !== thirdId) return x;
      const text = x.report_json!.replace(oldSha, newSha);
      return { ...x, report_json: text, report_sha256: sha256(text), checksum: sha256(text) };
    });
    expect(changed).toBe(1);
    const r = replayThird(c);
    expect(r.problems).toEqual([]);
    expect(r.kept!.sha256).toBe(newSha);
    expect(r.diff!.match).toBe(false);
    expect(r.diff!.differing.some((f) => f === "composite" || f === "regime")).toBe(true);
    // Without the recomputed report hash the kept days are refused, not replayed.
    const unsigned = tamperArtifact(BASE.clone(), secondArtifact, (rows) => void (asofRowOf(rows, V5_SECOND.asof).macroIndex += 0.01));
    const refused = replayThird(unsigned);
    expect(refused.diff).toBeNull();
    expect(refused.problems.join("\n")).toContain("its report names");
  }, 300_000);
});

describe("the methodology label picks the version (issue 1765)", () => {
  const apiRun = () => openBackupsDir(API_RECORDED).table("analytics_ledger_runs")[0]!;

  test("an api-recorded regime-v3 run gives the named unknown-methodology problem and no diff", () => {
    const run = apiRun();
    const r = replayRun(openBackupsDir(API_RECORDED), run.run_key!);
    expect(r.run.methodology.label).toBe("regime-v3");
    expect(r.version).toBeNull();
    expect(r.problems).toEqual(["methodology regime-v3 is not one this SDK computes"]);
    expect(r.diff).toBeNull();
  });

  test("with fallbackVersion v4 the same run replays under v4, with a note", () => {
    const run = apiRun();
    const r = replayRun(openBackupsDir(API_RECORDED), run.run_key!, { fallbackVersion: "v4" });
    expect(r.version).toBe("v4");
    expect(r.notes[0]).toBe("methodology regime-v3 is not one this SDK computes; replayed under v4 as asked");
    expect(r.problems.some((p) => p.includes("is not one this SDK computes"))).toBe(false);
    expect(r.inputs).not.toBeNull();
    expect(r.diff).not.toBeNull();
  }, 120_000);

  test("a copy with no methodology table replays under the current version, with a note", () => {
    const c = BASE.clone();
    c.dropTable("analytics_ledger_methodology_versions");
    const r = replayRun(c.open(), FACTS.v4.runKey);
    expect(r.run.methodology.label).toBeNull();
    expect(r.version).toBe(CURRENT_REGIME_VERSION);
    expect(r.notes).toEqual([`the copy records no methodology label for the run; replayed under the current version ${CURRENT_REGIME_VERSION}`]);
    expect(r.diff!.match).toBe(true);
  }, 120_000);
});

describe("publicationCandidates (issue 1765, D-c)", () => {
  /** The archive, recording every table it is asked for. */
  const spy = (a: Archive, seen: Set<string>): Archive => ({ ...a, table: (n) => (seen.add(n), a.table(n)), files: (n) => (seen.add(n), a.files(n)) });

  test("the runs that published, newest first; filtered by line and by methodology; the run events are never read", () => {
    const seen = new Set<string>();
    const all = publicationCandidates(spy(openBackupsDir(MODEL_RUNS), seen), "regime");
    expect(all.map((c) => c.runKey)).toEqual([V5_THIRD.runKey, V5_SECOND.runKey, V5_FIRST.runKey, FACTS.v4.runKey]);
    expect(all.every((c) => c.reportId !== null && c.vintageId !== "")).toBe(true);
    expect(seen.has("analytics_ledger_run_events")).toBe(false);
    const main = publicationCandidates(copy, "regime", { line: "main" });
    expect(main.map((c) => [c.runKey, c.methodology, c.line])).toEqual([[FACTS.v4.runKey, "v4", "main"]]);
    const v5 = publicationCandidates(copy, "regime", { methodology: "v5" });
    expect(v5.map((c) => c.runKey)).toEqual([V5_THIRD.runKey, V5_SECOND.runKey, V5_FIRST.runKey]);
    expect(v5.every((c) => c.line === "beside")).toBe(true);
    expect(publicationCandidates(copy, "research")).toEqual([]);
  });

  test("a missing label, or one this SDK does not compute, counts as the main line; a run with no report and no artifact is no candidate", () => {
    const unlabelled = BASE.clone();
    unlabelled.dropTable("analytics_ledger_methodology_versions");
    const main = publicationCandidates(unlabelled.open(), "regime", { line: "main" });
    expect(main.length).toBe(4);
    expect(main.every((c) => c.methodology === null && c.line === "main")).toBe(true);
    const relabelled = BASE.clone();
    expect(relabelled.editTable("analytics_ledger_methodology_versions", (m) => (m.version_label === "v4" ? { ...m, version_label: "regime-v3" } : m))).toBe(1);
    const old = publicationCandidates(relabelled.open(), "regime", { line: "main" });
    expect(old.map((c) => [c.runKey, c.methodology])).toEqual([[FACTS.v4.runKey, "regime-v3"]]);
    // The api-recorded copy's runs froze vintages but hold no report or artifact.
    expect(openBackupsDir(API_RECORDED).table("analytics_data_vintages").length).toBeGreaterThan(0);
    expect(publicationCandidates(openBackupsDir(API_RECORDED), "regime")).toEqual([]);
  }, 120_000);

  test("red control: a failed run (failure artifacts only, no report) is no candidate", () => {
    const c = BASE.clone();
    const v4 = replayed(FACTS.v4).run.id;
    c.editTable(OUTPUTS, (o) => (o.run_id === v4 ? { ...o, artifact_kind: "warnings" } : o));
    c.editTable(REPORTS, (x) => (x.run_id === v4 ? { ...x, run_id: "999999" } : x));
    const keys = publicationCandidates(c.open(), "regime").map((x) => x.runKey);
    expect(keys).not.toContain(FACTS.v4.runKey);
    expect(keys.length).toBe(3);
  }, 120_000);
});

// ── publicationCandidates streams the report and artifact tables (issue 1765) ──
// The release post-seal check runs publicationCandidates over a full filled
// copy, whose artifact payloads do not fit in memory. It must read the report
// and artifact tables one file at a time and keep no row past its file.

/** The table a data file belongs to. */
const tableOfFile = (f: FileRecord): string => f.path.split("/").pop()!.split(".")[0]!;

/** Rows valid only while their file is iterated: each is a revocable proxy, revoked when the iteration ends. `fields` records every field read. */
function* liveRows(rows: Row[], fields: Set<string>): Generator<Row> {
  const revokes: Array<() => void> = [];
  try {
    for (const r of rows) {
      const p = Proxy.revocable(r, { get: (o, k, receiver) => (typeof k === "string" && fields.add(k), Reflect.get(o, k, receiver)) });
      revokes.push(p.revoke);
      yield p.proxy;
    }
  } finally {
    for (const revoke of revokes) revoke();
  }
}

/**
 * The archive with `tables` readable only as a stream: table() and readRows(),
 * which keep a table's rows, throw for them, and scanRows gives rows that die
 * when their file's iteration ends, so a caller that keeps a row and reads it
 * later throws. `read` records the fields read from those rows, by table.
 */
function streamOnly(a: Archive, tables: ReadonlySet<string>, read: Map<string, Set<string>>): Archive {
  return {
    ...a,
    table: (name) => {
      if (tables.has(name)) throw new Error(`table(${name}) holds the whole table in memory`);
      return a.table(name);
    },
    readRows: (f) => {
      if (tables.has(tableOfFile(f))) throw new Error(`readRows(${f.path}) keeps the file's rows`);
      return a.readRows(f);
    },
    scanRows: (f) => {
      const t = tableOfFile(f);
      if (!tables.has(t)) return a.scanRows(f);
      const rows = a.scanRows(f);
      let fields = read.get(t);
      if (!fields) read.set(t, (fields = new Set()));
      const seen = fields;
      return { [Symbol.iterator]: () => liveRows(rows, seen) } as unknown as Row[];
    },
  };
}

/** The shape publicationCandidates had before it streamed: every kept row collected, then read. */
function collectedShape(a: Archive): { reports: Map<string, string>; kinds: Map<string, string[]> } {
  const collect = (table: string, keep: (r: Row) => boolean): Row[] => {
    const out: Row[] = [];
    for (const f of a.files(table)) for (const r of a.scanRows(f)) if (keep(r)) out.push(r);
    return out;
  };
  const reports = new Map<string, string>();
  for (const x of collect(REPORTS, () => true)) reports.set(x.run_id!, x.id!);
  const kinds = new Map<string, Set<string>>();
  for (const x of collect(OUTPUTS, (o) => !["warnings", "logs", "exceptions"].includes(o.artifact_kind ?? ""))) {
    let s = kinds.get(x.run_id!);
    if (!s) kinds.set(x.run_id!, (s = new Set()));
    s.add(x.artifact_kind!);
  }
  return { reports, kinds: new Map([...kinds].map(([k, v]) => [k, [...v].sort()])) };
}

describe("publicationCandidates streams the report and artifact tables (issue 1765)", () => {
  const STREAMED = new Set([REPORTS, OUTPUTS]);

  test("the same candidates through a stream-only archive: no whole-table read, no row kept past its file, only ids and kinds read", () => {
    const plain = openBackupsDir(MODEL_RUNS);
    for (const t of STREAMED) expect(plain.files(t).length, t).toBeGreaterThan(0);
    const read = new Map<string, Set<string>>();
    const streamed = publicationCandidates(streamOnly(openBackupsDir(MODEL_RUNS), STREAMED, read), "regime");
    const expected = publicationCandidates(plain, "regime");
    expect(streamed).toEqual(expected);
    expect(streamed.map((c) => c.runKey)).toEqual([V5_THIRD.runKey, V5_SECOND.runKey, V5_FIRST.runKey, FACTS.v4.runKey]);
    // The report ids and artifact kinds are the ones the collected shape gave.
    const old = collectedShape(openBackupsDir(MODEL_RUNS));
    expect(streamed.map((c) => [c.runId, c.reportId, c.artifactKinds])).toEqual(streamed.map((c) => [c.runId, old.reports.get(c.runId) ?? null, old.kinds.get(c.runId) ?? []]));
    expect(streamed.every((c) => c.artifactKinds.length > 0)).toBe(true);
    // Neither payload is ever read: only the ids and the kind.
    expect([...read.get(REPORTS)!].sort()).toEqual(["id", "run_id"]);
    expect([...read.get(OUTPUTS)!].sort()).toEqual(["artifact_kind", "run_id"]);
    for (const opts of [{ line: "main" as const }, { line: "beside" as const }, { methodology: "v5" }]) {
      expect(publicationCandidates(streamOnly(openBackupsDir(MODEL_RUNS), STREAMED, new Map()), "regime", opts), JSON.stringify(opts)).toEqual(publicationCandidates(plain, "regime", opts));
    }
  }, 120_000);

  test("a failed run's artifacts are skipped while streaming, as before", () => {
    const c = BASE.clone();
    const v4 = replayed(FACTS.v4).run.id;
    c.editTable(OUTPUTS, (o) => (o.run_id === v4 ? { ...o, artifact_kind: "warnings" } : o));
    const streamed = publicationCandidates(streamOnly(c.open(), STREAMED, new Map()), "regime");
    expect(streamed).toEqual(publicationCandidates(c.open(), "regime"));
    const v4Candidate = streamed.find((x) => x.runKey === FACTS.v4.runKey)!;
    expect(v4Candidate.reportId).not.toBeNull();
    expect(v4Candidate.artifactKinds).toEqual([]);
  }, 120_000);

  test("red control: the collected shape, and a whole-table read, trip the stream-only archive", () => {
    const wrapped = () => streamOnly(openBackupsDir(MODEL_RUNS), STREAMED, new Map());
    // The collected shape reads its rows after their file's iteration ended.
    expect(() => collectedShape(wrapped())).toThrow(/revoked/);
    // The same shape over the plain archive works, so the wrapper is what it trips.
    expect(() => collectedShape(openBackupsDir(MODEL_RUNS))).not.toThrow();
    const w = wrapped();
    expect(() => w.table(REPORTS)).toThrow(/holds the whole table/);
    expect(() => w.table(OUTPUTS)).toThrow(/holds the whole table/);
    expect(() => w.readRows(w.files(OUTPUTS)[0]!)).toThrow(/keeps the file's rows/);
    // A table outside the streamed set still reads whole.
    expect(w.table("analytics_ledger_runs").length).toBeGreaterThan(0);
  }, 120_000);
});
