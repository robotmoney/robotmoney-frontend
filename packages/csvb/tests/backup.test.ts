// The backup, end to end, against a real Postgres: what it adds, what it refuses, and that the bytes are
// faithful. (A test database is a primary, so `requireReplica` is off here; one test proves the real default
// refuses a primary.)
//
// Backups are cut at UTC day boundaries (format 1's cut rule, issue 1477), so the tests run on a synthetic calendar:
// rows are stamped on the current test day, and each backup runs with the clock two hours past the next midnight
// (`nowMs`), which seals exactly the boundaries up to it. The legacy junction is off (`junction: null`) except where
// a test plants a synthetic one.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { AppendOnlyTable, RevisedTable } from "../src/config.ts";
import { defaultOptions, runBackup, type BackupOptions } from "../src/backup.ts";
import type { BackupRecord } from "../src/model.ts";
import { sha256 } from "../src/repo.ts";
import { diffBackups, historyOf, listBackups, resolveBackup, resolveTable } from "../src/query.ts";
import { verifyRepo } from "../src/verify.ts";
import { startPg, type TestPg } from "./pg.ts";

let pg: TestPg;
const dirs: string[] = [];
const newRepo = (): string => {
  const d = mkdtempSync(join(tmpdir(), "csvb-test-"));
  dirs.push(d);
  return join(d, "repo");
};
const DAY = 86_400_000;
// The synthetic calendar: rows are stamped on `day`; a backup runs at two hours past the following midnight.
let day = Date.UTC(2026, 0, 1);
const nextDay = (): void => {
  day += DAY;
};
const sealedNow = (): number => day + DAY + 2 * 3_600_000;
const idOf = (ms: number): string => `${new Date(ms).toISOString().slice(0, 10)}T000000Z`;
const stampAt = (i: number): string => new Date(day + 12 * 3_600_000 + i * 1000).toISOString();
/** The newest record a run wrote. */
const last = (recs: BackupRecord[]): BackupRecord => recs[recs.length - 1]!;

const AO: AppendOnlyTable = {
  name: "t_ao",
  time: { column: "created_at" },
  select: "id, name, convert_from(payload_bytes, 'UTF8') AS payload_json, encode(sha256(payload_bytes), 'hex') AS payload_sha256, ok, created_at",
  pageRows: 3,
  hashed: [{ text: "payload_json", sha256: "payload_sha256" }],
};
const REV: RevisedTable = { name: "t_rev", select: "*", key: ["k"], orderBy: "k" };

const opts = (repo: string, extra: Partial<BackupOptions> = {}): BackupOptions => ({
  ...defaultOptions(pg.sql, repo),
  appendOnly: [AO],
  revised: [REV],
  partBytes: 700,
  pauseMs: 0,
  maxSeconds: 120,
  statementTimeoutS: 30,
  requireReplica: false,
  junction: null,
  nowMs: sealedNow(),
  log: () => {},
  ...extra,
});

const payload = (i: number) => JSON.stringify({ i, text: `line one\nline "two", with, commas\n😀 é ${"x".repeat(i * 5)}` });
async function addAo(n: number, from = 1): Promise<void> {
  for (let i = from; i < from + n; i++) {
    await pg.sql`INSERT INTO t_ao (name, payload_bytes, ok, created_at) VALUES (${i % 3 === 0 ? null : i % 3 === 1 ? "" : `n"${i},`}, ${Buffer.from(payload(i), "utf8")}, ${i % 2 === 0}, ${stampAt(i)})`;
  }
}
const files = (repo: string, sub: string): string[] => (existsSync(join(repo, sub)) ? readdirSync(join(repo, sub), { recursive: true }).map(String).sort() : []);
/** sha256 of every file under csv/, by path. */
const snapshotOf = (repo: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const f of files(repo, "csv")) if (/\.(gz|json)$/.test(f)) out[`csv/${f}`] = sha256(readFileSync(join(repo, "csv", f)));
  return out;
};
/** Backup ids in the repo, oldest first. */
const backupIds = (repo: string): string[] => readdirSync(join(repo, "csv")).filter((n) => /^\d{4}-\d{2}-\d{2}T\d{6}Z$/.test(n)).sort();
/** Data files of one table in one backup. */
const dataFilesOf = (repo: string, id: string, table: string): string[] => files(repo, `csv/${id}/data`).filter((f) => f.startsWith(`${table}.`) && f.endsWith(".csv.gz"));

beforeAll(async () => {
  pg = await startPg();
  await pg.sql.unsafe(`
    CREATE TABLE t_ao (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text, payload_bytes bytea NOT NULL, ok boolean, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE t_rev (k text PRIMARY KEY, grp int, v text);
    CREATE TABLE t_plain (id bigint PRIMARY KEY, v text, at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE t_parent (id bigint PRIMARY KEY, created_at timestamptz NOT NULL);
    CREATE TABLE t_child (id bigint PRIMARY KEY, parent_id bigint NOT NULL, note text);
  `);
}, 120_000);
afterAll(async () => {
  await pg?.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true }); // d is the directory this test made, never its parent
});

describe("a growing repo", () => {
  const repo = newRepo();
  let first: Record<string, string>;

  test("the first backup holds everything, split into files named by period, and verifies", async () => {
    await addAo(8);
    for (const [k, g, v] of [["a", 1, "one"], ["b", 1, null], ["c", 2, ""], ["d", 2, 'q"uote,\nnl'], ["e", 3, "five"]] as const) await pg.sql`INSERT INTO t_rev VALUES (${k}, ${g}, ${v})`;
    const recs = await runBackup(opts(repo));
    expect(recs.map((r) => r.backup)).toEqual([idOf(day + DAY)]); // one sealed day boundary: the next midnight
    const rec = recs[0]!;
    const a = rec.append_only.t_ao!;
    expect(a.watermark_before).toBeNull();
    expect(a.rows_added).toBe(8);
    expect(a.files.length).toBeGreaterThan(1); // 700-byte parts: really split
    expect(a.files[0]!.path).toMatch(/^csv\/\d{4}-\d{2}-\d{2}T000000Z\/data\/t_ao\.\d{4}-\d{2}-\d{2}T\d{6}Z_\d{4}-\d{2}-\d{2}T\d{6}Z\.csv\.gz$/);
    expect(a.files.reduce((n, f) => n + f.rows, 0)).toBe(8);
    expect(rec.revisions.t_rev!.upserts).toBe(5);
    expect(rec.revisions.t_rev!.file?.path).toBe(`csv/${rec.backup}/revisions/t_rev.csv.gz`);
    expect(await verifyRepo({ root: repo })).toEqual([]);
    expect(existsSync(join(repo, ".staging"))).toBe(false);
    first = snapshotOf(repo);
  }, 60_000);

  test("the second backup adds only new rows and only changed revisions, and never touches an existing file", async () => {
    nextDay();
    await addAo(3, 9);
    await pg.sql`UPDATE t_rev SET v = 'FIVE' WHERE k = 'e'`;
    await pg.sql`INSERT INTO t_rev VALUES ('f', 4, 'six')`;
    await pg.sql`DELETE FROM t_rev WHERE k = 'a'`;
    const rec = last(await runBackup(opts(repo)));
    expect(rec.backup).toBe(idOf(day + DAY));
    const a = rec.append_only.t_ao!;
    expect(a.rows_added).toBe(3);
    expect(BigInt(a.files[0]!.id_min!)).toBeGreaterThan(BigInt(a.watermark_before!));
    expect(rec.revisions.t_rev).toMatchObject({ upserts: 2, deletes: 1, rows_in_state: 5 });
    expect(await verifyRepo({ root: repo })).toEqual([]);
    const now = snapshotOf(repo);
    for (const [path, h] of Object.entries(first)) expect(now[path]).toBe(h); // write-once
    expect(Object.keys(now).length).toBeGreaterThan(Object.keys(first).length);
  }, 60_000);

  test("a backup with nothing new adds a record and no data file", async () => {
    nextDay();
    const before = snapshotOf(repo);
    const rec = last(await runBackup(opts(repo)));
    expect(rec.append_only.t_ao!.rows_added).toBe(0);
    expect(rec.append_only.t_ao!.files).toEqual([]);
    expect(rec.revisions.t_rev!.file).toBeNull();
    const after = snapshotOf(repo);
    expect(Object.keys(after).filter((p) => !(p in before))).toEqual([`csv/${rec.backup}/backup.json`]);
    expect(await verifyRepo({ root: repo })).toEqual([]);
  }, 60_000);

  test("resolve gives the table as of any backup, and equals the database now", async () => {
    const recs = backupIds(repo);
    expect(recs.length).toBe(3);
    const out: string[] = [];
    const now = await resolveTable({ root: repo }, "t_rev", "latest", [], (s) => out.push(s));
    const db = await pg.sql`SELECT k FROM t_rev ORDER BY k`;
    expect(now.rows).toBe(db.length);
    expect(out.join("")).toContain("FIVE");
    const was: string[] = [];
    const id1 = recs[0]!;
    await resolveTable({ root: repo }, "t_rev", id1, [], (s) => was.push(s));
    expect(was.join("")).toContain("five");
    expect(was.join("")).not.toContain("FIVE");
    expect(was.join("")).toContain("a,"); // row a still existed then
    // Append-only: as of the first backup only the first 8 rows.
    const ao: string[] = [];
    const r1 = await resolveTable({ root: repo }, "t_ao", id1, [], (s) => ao.push(s));
    expect(r1.rows).toBe(8);
    const rl = await resolveTable({ root: repo }, "t_ao", "latest", [{ col: "id", val: "10" }], () => {});
    expect(rl.rows).toBe(1);
  });

  test("history shows each version of a row, and diff summarises what changed between backups", async () => {
    const h = await historyOf({ root: repo }, "t_rev", [{ col: "k", val: "e" }]);
    expect(h.length).toBe(2);
    expect(h[0]).toContain("first seen");
    expect(h[1]).toContain("changed");
    expect(h[1]).toContain("five -> FIVE");
    const gone = await historyOf({ root: repo }, "t_rev", [{ col: "k", val: "a" }]);
    expect(gone[gone.length - 1]).toContain("delete");
    const ids = backupIds(repo);
    const d = await diffBackups({ root: repo }, "t_rev", ids[0]!, ids[1]!);
    expect(d.join("\n")).toContain("1 new, 1 changed, 1 removed");
    const dao = await diffBackups({ root: repo }, "t_ao", ids[0]!, ids[1]!);
    expect(dao.join("\n")).toContain("3 rows added");
    expect(listBackups({ root: repo }).join("\n")).toContain("t_ao+3");
  });
});

describe("the cut rule", () => {
  test("a run that finds several sealed days writes one backup per day, each ending at its boundary; the revised state goes in the newest", async () => {
    const repo = newRepo();
    const recs = await runBackup(opts(repo));
    const firstRow = await pg.sql`SELECT created_at::text AS t FROM t_ao ORDER BY id LIMIT 1`;
    const firstDay = Math.floor(Date.parse(firstRow[0]!.t.replace(" ", "T").replace(/\+00$/, "Z")) / DAY) * DAY + DAY;
    const want: string[] = [];
    for (let d = firstDay; d <= day + DAY; d += DAY) want.push(idOf(d));
    expect(recs.map((r) => r.backup)).toEqual(want);
    expect(recs.length).toBeGreaterThan(1);
    // Each backup holds exactly the rows stamped before its boundary and after the previous one.
    for (const r of recs) {
      for (const f of r.append_only.t_ao!.files) expect(Date.parse(f.time_max!.replace(" ", "T").replace(/\+00$/, "Z"))).toBeLessThan(Date.parse(r.backup.replace(/T000000Z$/, "T00:00:00Z")));
    }
    expect(recs.slice(0, -1).every((r) => r.revisions.t_rev!.file === null && r.revisions.t_rev!.rows_in_state === 0)).toBe(true);
    expect(last(recs).revisions.t_rev!.file).not.toBeNull();
    expect(await verifyRepo({ root: repo })).toEqual([]);
  }, 90_000);

  test("a planted junction is one extra cut between the day cuts around it, and the next day chains from it", async () => {
    const repo = newRepo();
    nextDay();
    await addAo(2, 800);
    const [j] = await pg.sql`SELECT max(id)::text AS wm FROM t_ao WHERE id < (SELECT max(id) FROM t_ao)`;
    const junctionId = `${new Date(day).toISOString().slice(0, 10)}T130000Z`;
    const recs = await runBackup(opts(repo, { revised: [], junction: { id: junctionId, watermarks: { t_ao: j!.wm } } }));
    const ids = recs.map((r) => r.backup);
    const at = ids.indexOf(junctionId);
    expect(at).toBeGreaterThan(0);
    expect(ids[at - 1]).toBe(idOf(day));
    expect(ids[at + 1]).toBe(idOf(day + DAY));
    const jr = recs[at]!.append_only.t_ao!;
    expect(jr.watermark_before).toBe(recs[at - 1]!.append_only.t_ao!.watermark_after);
    expect(jr.watermark_after).toBe(j!.wm);
    expect(recs[at + 1]!.append_only.t_ao!.watermark_before).toBe(j!.wm);
    expect(recs[at + 1]!.append_only.t_ao!.rows_added).toBe(1);
    expect(await verifyRepo({ root: repo })).toEqual([]);
    // A junction no row follows is no cut at all.
    const [mx] = await pg.sql`SELECT max(id)::text AS wm FROM t_ao`;
    const plain = await runBackup(opts(newRepo(), { revised: [], junction: { id: junctionId, watermarks: { t_ao: mx!.wm } } }));
    expect(plain.map((r) => r.backup)).not.toContain(junctionId);
    expect(plain.map((r) => r.backup).every((id) => id.endsWith("T000000Z"))).toBe(true);
  }, 90_000);
});

describe("what it refuses", () => {
  test("a row deleted from the database is recorded as gone, the repo keeps its copy, and the backup still happens", async () => {
    const repo = newRepo();
    nextDay();
    await addAo(3, 100);
    await runBackup(opts(repo));
    const [{ id }] = await pg.sql`SELECT min(id)::text AS id FROM t_ao WHERE id > (SELECT coalesce(max(id), 0) - 3 FROM t_ao)`;
    await pg.sql`DELETE FROM t_ao WHERE id = ${id}`;
    nextDay();
    await addAo(1, 200);
    const rec = last(await runBackup(opts(repo)));
    expect(rec.anomalies).toHaveLength(1);
    expect(rec.anomalies![0]).toMatchObject({ kind: "deleted_rows", table: "t_ao", count: 1, ids: [id] });
    expect(rec.append_only.t_ao!.rows_added).toBe(1); // new data was still backed up
    expect(await verifyRepo({ root: repo })).toEqual([]); // an anomaly is not corruption
    // The repo still holds the deleted row.
    const out: string[] = [];
    const r = await resolveTable({ root: repo }, "t_ao", "latest", [{ col: "id", val: id! }], (x) => out.push(x));
    expect(r.rows).toBe(1);
    // Once recorded, it is not reported again.
    nextDay();
    const next = last(await runBackup(opts(repo)));
    expect(next.anomalies).toEqual([]);
    expect(await verifyRepo({ root: repo })).toEqual([]);
    expect(listBackups({ root: repo }).join("\n")).toContain("ANOMALY");
  }, 90_000);

  test("a row that commits later with a lower id than the watermark is captured as a late row, and the backup still happens", async () => {
    const repo = newRepo();
    const plain: AppendOnlyTable = { name: "t_plain", time: { column: "at" }, select: "*", pageRows: 10 };
    const o = (): BackupOptions => opts(repo, { appendOnly: [plain], revised: [] });
    nextDay();
    await pg.sql`INSERT INTO t_plain VALUES (1, 'a', ${stampAt(1)}), (3, 'c', ${stampAt(3)})`;
    await runBackup(o());
    nextDay();
    await pg.sql`INSERT INTO t_plain VALUES (2, 'b', ${stampAt(2)}), (4, 'd', ${stampAt(4)})`;
    const rec = last(await runBackup(o()));
    expect(rec.anomalies).toHaveLength(1);
    expect(rec.anomalies![0]).toMatchObject({ kind: "late_rows", table: "t_plain", count: 1, id_min: "2", id_max: "2" });
    const a = rec.append_only.t_plain!;
    expect(a.rows_added).toBe(2); // the late row and the new row
    expect(a.files.some((f) => f.late)).toBe(true);
    expect(a.watermark_after).toBe("4");
    expect(await verifyRepo({ root: repo })).toEqual([]);
    const out: string[] = [];
    const r = await resolveTable({ root: repo }, "t_plain", "latest", [{ col: "id", val: "2" }], (x) => out.push(x));
    expect(r.rows).toBe(1); // the late row is in the repo
    expect(out.join("")).toContain("2,b");
    nextDay();
    expect(last(await runBackup(o())).anomalies).toEqual([]);
    expect(await verifyRepo({ root: repo })).toEqual([]);
    await pg.sql`DELETE FROM t_plain`;
  }, 90_000);

  test("a payload that does not hash to the stored bytes' sha256 fails the backup", async () => {
    const lie: AppendOnlyTable = { ...AO, select: AO.select.replace("encode(sha256(payload_bytes), 'hex')", "'deadbeef'") };
    await expect(runBackup(opts(newRepo(), { appendOnly: [lie], revised: [] }))).rejects.toThrow("does not hash");
  }, 60_000);

  test("a changed column layout needs a decision, not a silent mix", async () => {
    const repo = newRepo();
    await runBackup(opts(repo, { revised: [REV] }));
    const narrower: RevisedTable = { ...REV, select: "k, v" };
    nextDay();
    await expect(runBackup(opts(repo, { revised: [narrower] }))).rejects.toThrow("columns changed");
  }, 60_000);

  test("the command's real default refuses a primary", async () => {
    await expect(runBackup(opts(newRepo(), { requireReplica: true }))).rejects.toThrow("not a replica");
  });

  test("a backup is not accepted at or before the repo's newest", async () => {
    const repo = newRepo();
    await runBackup(opts(repo, { revised: [REV] }));
    // The same clock again: no newer boundary is sealed, so nothing is cut rather than overwritten.
    await expect(runBackup(opts(repo, { revised: [REV] }))).rejects.toThrow("strictly newer");
  }, 60_000);

  test("a repo inside a robotmoney-frontend checkout is refused, and nothing is written there", async () => {
    const inside = join(import.meta.dir, "fixtures", "never-a-repo");
    await expect(runBackup(opts(inside))).rejects.toThrow("inside the robotmoney-frontend checkout");
    expect(existsSync(inside)).toBe(false);
  });

  test("a repo whose newest backup is a snapshot-time backup other than the junction is refused", async () => {
    const repo = newRepo();
    cpSync(join(import.meta.dir, "fixtures", "legacy"), repo, { recursive: true });
    await expect(runBackup(opts(repo, { junction: { id: "2001-01-01T000000Z", watermarks: {} } }))).rejects.toThrow("snapshot-time backup other than the junction");
  });
});

describe("files are named by the period (UTC) their rows cover", () => {
  test("a file's name carries the earliest and latest time of its rows, to the second; a row stamped early waits for the cut its id falls in", async () => {
    const repo = newRepo();
    await pg.sql`DELETE FROM t_plain`;
    await pg.sql`INSERT INTO t_plain (id, v, at) VALUES (1, 'a', '2026-09-21 01:59:32.748+00'), (2, 'b', '2026-10-05 20:58:31.9+00'), (3, 'c', '2026-09-30 12:00:00+00')`;
    const plain: AppendOnlyTable = { name: "t_plain", time: { column: "at" }, select: "*", pageRows: 10 };
    const recs = await runBackup(opts(repo, { appendOnly: [plain], revised: [], partBytes: 50_000_000, nowMs: Date.parse("2026-10-06T02:00:00Z") }));
    expect(recs[0]!.backup).toBe("2026-09-22T000000Z");
    expect(last(recs).backup).toBe("2026-10-06T000000Z");
    const f1 = recs[0]!.append_only.t_plain!.files;
    expect(f1.map((f) => f.path)).toEqual(["csv/2026-09-22T000000Z/data/t_plain.2026-09-21T015932Z_2026-09-21T015932Z.csv.gz"]);
    expect(f1[0]!.time_min).toContain("2026-09-21 01:59:32.748");
    // Row 3 is stamped 09-30 but its id follows row 2 (10-05): the cut is by id below the first late-stamped row.
    const f = last(recs).append_only.t_plain!.files;
    expect(f).toHaveLength(1);
    expect(f[0]!.path).toBe("csv/2026-10-06T000000Z/data/t_plain.2026-09-30T120000Z_2026-10-05T205831Z.csv.gz");
    expect(recs.slice(1, -1).every((r) => r.append_only.t_plain!.files.length === 0)).toBe(true);
    expect(await verifyRepo({ root: repo })).toEqual([]);
    await pg.sql`DELETE FROM t_plain`;
  }, 60_000);

  test("two files of one table with the same period get -2, -3 (and verify)", async () => {
    const repo = newRepo();
    await pg.sql`DELETE FROM t_plain`;
    for (let i = 1; i <= 6; i++) await pg.sql`INSERT INTO t_plain (id, v, at) VALUES (${i}, ${"x".repeat(200)}, '2026-01-01 00:00:00+00')`;
    const plain: AppendOnlyTable = { name: "t_plain", time: { column: "at" }, select: "*", pageRows: 10 };
    const rec = last(await runBackup(opts(repo, { appendOnly: [plain], revised: [], partBytes: 300, nowMs: Date.parse("2026-01-02T02:00:00Z") })));
    expect(rec.backup).toBe("2026-01-02T000000Z");
    const names = rec.append_only.t_plain!.files.map((x) => x.path.split("/").pop()!);
    expect(names.length).toBeGreaterThan(2);
    expect(names[0]).toBe("t_plain.2026-01-01T000000Z_2026-01-01T000000Z.csv.gz");
    expect(names[1]).toBe("t_plain.2026-01-01T000000Z_2026-01-01T000000Z-2.csv.gz");
    expect(new Set(names).size).toBe(names.length);
    expect(await verifyRepo({ root: repo })).toEqual([]);
    await pg.sql`DELETE FROM t_plain`;
  }, 60_000);

  test("a table whose rows carry no time is named, and cut, by the time of the row it points to", async () => {
    const repo = newRepo();
    await pg.sql`INSERT INTO t_parent VALUES (1, '2026-03-01 10:00:00+00'), (2, '2026-03-02 11:30:15+00')`;
    await pg.sql`INSERT INTO t_child VALUES (1, 1, 'a'), (2, 1, 'b'), (3, 2, 'c')`;
    const parent: AppendOnlyTable = { name: "t_parent", time: { column: "created_at" }, select: "*", pageRows: 10 };
    const child: AppendOnlyTable = { name: "t_child", time: { lookup: { column: "parent_id", table: "t_parent", key: "id", timeColumn: "created_at" } }, select: "*", pageRows: 10 };
    const recs = await runBackup(opts(repo, { appendOnly: [parent, child], revised: [], partBytes: 50_000_000, nowMs: Date.parse("2026-03-03T02:00:00Z") }));
    expect(recs.map((r) => r.backup)).toEqual(["2026-03-02T000000Z", "2026-03-03T000000Z"]);
    expect(recs[0]!.append_only.t_child!.files.map((f) => f.path)).toEqual(["csv/2026-03-02T000000Z/data/t_child.2026-03-01T100000Z_2026-03-01T100000Z.csv.gz"]);
    expect(recs[1]!.append_only.t_child!.files.map((f) => f.path)).toEqual(["csv/2026-03-03T000000Z/data/t_child.2026-03-02T113015Z_2026-03-02T113015Z.csv.gz"]);
    expect(await verifyRepo({ root: repo })).toEqual([]);
    await pg.sql.unsafe("DELETE FROM t_child; DELETE FROM t_parent");
  }, 60_000);

  test("a row with no time stops the backup (a name must not be guessed)", async () => {
    await pg.sql.unsafe("CREATE TABLE t_untimed (id bigint PRIMARY KEY, at timestamptz)");
    try {
      await pg.sql`INSERT INTO t_untimed VALUES (1, '2026-01-01 00:00:00+00'), (2, NULL)`;
      const t: AppendOnlyTable = { name: "t_untimed", time: { column: "at" }, select: "*", pageRows: 10 };
      await expect(runBackup(opts(newRepo(), { appendOnly: [t], revised: [], nowMs: Date.parse("2026-01-02T02:00:00Z") }))).rejects.toThrow("has no time");
    } finally {
      await pg.sql.unsafe("DROP TABLE t_untimed");
    }
  }, 60_000);

  test("verify catches a file renamed to a different period, and a record edited to a different period", async () => {
    const repo = newRepo();
    nextDay();
    await addAo(2, 700);
    const rec = last(await runBackup(opts(repo, { revised: [] })));
    expect(await verifyRepo({ root: repo })).toEqual([]);
    // rename the file on disk and in the record to claim another period
    const f = rec.append_only.t_ao!.files[0]!;
    const dir = join(repo, "csv", rec.backup, "data");
    const bogus = "t_ao.2020-01-01T000000Z_2020-01-02T000000Z.csv.gz";
    renameSync(join(repo, f.path), join(dir, bogus));
    const rp = join(repo, "csv", rec.backup, "backup.json");
    const j = JSON.parse(readFileSync(rp, "utf8"));
    j.append_only.t_ao.files[0].path = `csv/${rec.backup}/data/${bogus}`;
    writeFileSync(rp, JSON.stringify(j));
    expect((await verifyRepo({ root: repo })).some((p) => p.includes("name does not match"))).toBe(true);
    // keep the right name but edit the record's period: the rows no longer match it
    renameSync(join(dir, bogus), join(repo, f.path));
    j.append_only.t_ao.files[0].path = f.path;
    j.append_only.t_ao.files[0].time_min = "2020-01-01 00:00:00+00";
    writeFileSync(rp, JSON.stringify(j));
    const probs = await verifyRepo({ root: repo });
    expect(probs.some((p) => p.includes("name does not match") || p.includes("different period"))).toBe(true);
  }, 60_000);
});

describe("faithful bytes", () => {
  test("every column type, NULL, empty string, quotes, CR/LF and unicode are written exactly as COPY writes them", async () => {
    await pg.sql.unsafe(`CREATE TABLE t_types (
      id bigint PRIMARY KEY, flag boolean, n2 smallint, n4 integer, n8 bigint, num numeric(20,6), f4 real, f8 double precision,
      txt text, vc varchar(20), d date, ts timestamp, tstz timestamptz, iv interval, u uuid, jb jsonb, j json, ba bytea,
      ta text[], ia integer[], ip inet, bits bit(5), mny money, at timestamptz NOT NULL DEFAULT '2026-01-01 12:00:00+00')`);
    await pg.sql.unsafe(`INSERT INTO t_types VALUES
      (1, true, 1, 2, 3, 1.5, 1.25, 0.1, 'plain', 'v', '2026-10-05', '2026-10-05 14:54:20.893174', '2026-10-05 14:54:20.893174+00', '1 day 02:03:04', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', '{"a": [1, 2], "b": "x\\\\ny"}', '{"k" :  1}', '\\\\xdeadbeef', '{a,"b c",NULL}', '{1,2,3}', '10.0.0.1/24', B'10101', 12.34),
      (2, false, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
      (3, NULL, -1, -2, -3, -0.000001, 'NaN', 'Infinity', '', '', '1999-12-31', '2000-01-01 00:00:00', '2000-01-01 00:00:00+02', '-1 mon', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12', '[]', '"q"', '\\\\x', '{}', '{}', '::1', B'00000', -0.5),
      (4, true, 0, 0, 0, 0, 0, -0.0, E'q"uote, comma\\nnew\\r\\nline \\\\ back é😀', E'  sp  ', NULL, NULL, NULL, NULL, NULL, '{"s": "\\\\u00e9"}', NULL, NULL, '{"x,y","z q"}', NULL, NULL, NULL, NULL),
      (5, false, 32767, 2147483647, 9223372036854775807, 99999999999999.999999, 3.4e38, 1.7976931348623157e308, '\\\\.', 'null', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`);
    const t: AppendOnlyTable = { name: "t_types", time: { column: "at" }, select: "*", pageRows: 2 };
    const repo = newRepo();
    await runBackup(opts(repo, { appendOnly: [t], revised: [], partBytes: 50_000_000, nowMs: Date.parse("2026-01-02T02:00:00Z") }));
    const id = backupIds(repo)[0]!;
    expect(id).toBe("2026-01-02T000000Z");
    const file = dataFilesOf(repo, id, "t_types")[0]!;
    const mine = gunzipSync(readFileSync(join(repo, "csv", id, "data", file)));
    const chunks: Buffer[] = [];
    const copy = await pg.sql.unsafe(`COPY (SELECT * FROM t_types ORDER BY id) TO STDOUT WITH (FORMAT csv, HEADER true)`).readable();
    for await (const b of copy as AsyncIterable<Buffer>) chunks.push(Buffer.from(b));
    expect(mine.toString("utf8")).toBe(Buffer.concat(chunks).toString("utf8"));
    expect(mine.toString("utf8")).toContain(",t,"); // booleans are t/f, as COPY writes them
  }, 60_000);
});

describe("verify catches damage (planted-violation controls)", () => {
  let good = "";
  beforeAll(async () => {
    good = newRepo();
    nextDay();
    await addAo(2, 200);
    await runBackup(opts(good));
    nextDay();
    await addAo(2, 300);
    await pg.sql`UPDATE t_rev SET v = 'changed again' WHERE k = 'b'`;
    await runBackup(opts(good));
  }, 120_000);
  const copy = (): string => {
    const r = newRepo();
    cpSync(good, r, { recursive: true });
    return r;
  };
  const firstDataFile = (repo: string): string => {
    const id = backupIds(repo).find((b) => dataFilesOf(repo, b, "t_ao").length > 0)!;
    return join(repo, "csv", id, "data", dataFilesOf(repo, id, "t_ao")[0]!);
  };
  /** The backups that hold a t_rev revision file: the newest of each run. */
  const withRevision = (repo: string): string[] => backupIds(repo).filter((id) => existsSync(join(repo, "csv", id, "revisions", "t_rev.csv.gz")));

  test("the untouched repo verifies", async () => {
    expect(await verifyRepo({ root: good })).toEqual([]);
  });
  test("a flipped byte in a data file", async () => {
    const r = copy();
    const f = firstDataFile(r);
    const b = readFileSync(f);
    b[Math.floor(b.length / 2)] ^= 0xff;
    writeFileSync(f, b);
    expect((await verifyRepo({ root: r })).length).toBeGreaterThan(0);
  });
  test("a missing file", async () => {
    const r = copy();
    rmSync(firstDataFile(r));
    expect((await verifyRepo({ root: r })).some((p) => p.includes("missing"))).toBe(true);
  });
  test("a file slipped in that no record lists", async () => {
    const r = copy();
    writeFileSync(join(r, "csv", backupIds(r)[0]!, "data", "t_ao.2099-01-01T000000Z_2099-01-01T000000Z.csv.gz"), "x");
    expect((await verifyRepo({ root: r })).some((p) => p.includes("not in any backup record"))).toBe(true);
  });
  test("an edited state hash, an edited watermark chain and an edited database total", async () => {
    for (const edit of [
      (j: any) => (j.revisions.t_rev.state_sha256 = "0".repeat(64)),
      (j: any) => (j.append_only.t_ao.watermark_before = "1"),
      (j: any) => (j.append_only.t_ao.db_rows_through_watermark = "999"),
    ]) {
      const r = copy();
      const rp = join(r, "csv", backupIds(r).pop()!, "backup.json");
      const j = JSON.parse(readFileSync(rp, "utf8"));
      edit(j);
      writeFileSync(rp, JSON.stringify(j));
      expect((await verifyRepo({ root: r })).length).toBeGreaterThan(0);
    }
  });
  test("a revision file swapped for another backup's", async () => {
    const r = copy();
    const ids = withRevision(r);
    expect(ids.length).toBe(2);
    writeFileSync(join(r, "csv", ids[0]!, "revisions", "t_rev.csv.gz"), readFileSync(join(r, "csv", ids[1]!, "revisions", "t_rev.csv.gz")));
    expect((await verifyRepo({ root: r })).length).toBeGreaterThan(0);
  });
});

describe("naming a backup", () => {
  const rec = (backup: string) => ({ backup }) as never;
  const recs = [rec("2026-10-05T145420Z"), rec("2026-10-05T190749Z"), rec("2026-10-06T000000Z"), rec("2026-10-07T000000Z")];
  test("latest, an id, a date and a time resolve to the newest backup at or before, for snapshot-time and day-cut ids alike", () => {
    expect(resolveBackup(recs, undefined).backup).toBe("2026-10-07T000000Z");
    expect(resolveBackup(recs, "2026-10-05").backup).toBe("2026-10-05T190749Z");
    expect(resolveBackup(recs, "2026-10-06").backup).toBe("2026-10-06T000000Z");
    expect(resolveBackup(recs, "2026-10-05T14:54").backup).toBe("2026-10-05T145420Z");
    expect(resolveBackup(recs, "2026-10-05T190749Z").backup).toBe("2026-10-05T190749Z");
    expect(resolveBackup(recs, "2026-10-07T000000Z").backup).toBe("2026-10-07T000000Z");
    expect(() => resolveBackup(recs, "2026-10-04")).toThrow("no backup at or before");
    expect(() => resolveBackup(recs, "yesterday")).toThrow("cannot read");
  });
});
