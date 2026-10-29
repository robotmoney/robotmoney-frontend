// `csvb backup`: add backups to the repo, reading the production READ REPLICA only.
//
// Which backups: format 1's cut rule (packages/analyst-sdk/src/archive/format1.ts, planCuts; issue 1477, D80),
// the same rule the public archive routes cut by. One backup per sealed UTC day boundary after the repo's newest
// backup (`YYYY-MM-DDT000000Z`), with the legacy junction (format1-legacy.ts) as one extra cut point when it
// applies. A run that finds several sealed boundaries writes one backup per boundary, all from one snapshot.
//
// What a backup adds, and nothing else (files in the repo are write-once):
//   * APPEND-ONLY tables: the rows with id above the repo's watermark, up to the cut's watermark, as files named by
//     the period their rows cover.
//   * REVISED tables: one revision file with the rows that are new or changed since the last backup, plus a
//     delete marker for rows that vanished. A revised table's past states are not in the database, so the state at
//     the snapshot is recorded in the newest backup the run writes; the run's earlier backups record no change.
//   * `csv/<id>/backup.json`: what was added, the watermarks, and the database totals it was checked against.
//
// Gentle on the database: one READ ONLY, REPEATABLE READ transaction (one consistent moment), small keyset pages
// (a few MB), a statement timeout per page, a savepoint so a failed page is retried smaller without poisoning
// the snapshot, a pause between pages, a time budget, and a clean rollback on SIGINT/SIGTERM. Memory stays at one
// page plus the revised tables' state (a few MB).
//
// Faithful: before anything is kept, the repo's existing rows are checked against the database (count and
// sum(id) through the watermark; a mismatch means a row was deleted or committed late, and is recorded),
// every page returns exactly the rows its probe promised, the new rows' count and sum(id) equal the database's,
// decoded payloads are re-hashed against the SHA-256 of the stored bytes, and the new revised-table state equals
// the database's. Then the staged files are re-read and verified before they are moved into the repo.
import { mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { GzFile } from "./gzfile.ts";
import { dirname, join, relative } from "node:path";
import postgres from "postgres";
import { APPEND_ONLY, REVISED, type AppendOnlyTable, type RevisedTable, type TimeSpec } from "./config.ts";
import {
  DataFileNamer,
  DAY_CUT_ID_RE,
  encodeCsvRow,
  firstBoundaryMs,
  junctionApplies,
  MAX_PART_BYTES,
  planCuts,
  startsNewPart,
  type Cut,
  type Junction,
} from "@robotmoney/analyst-sdk/src/archive/format1.ts";
import { LEGACY_JUNCTION } from "@robotmoney/analyst-sdk/src/archive/format1-legacy.ts";
import { backupDir, BACKUP_ID_RE, CSV_DIR, dataPath, parseDbTime, recordPath, revisionFile, type Anomaly, type AppendOnlyRecord, type BackupRecord, type FileRecord, type RevisedRecord } from "./model.ts";
import { frontendCheckoutAround, keyOf, loadRecords, loadState, readHeader, resolvePath, scanCsvGz, sha256, stateHash, type Layout } from "./repo.ts";
import { verifyRepo } from "./verify.ts";

type Sql = postgres.Sql<{}>;
type Tx = postgres.TransactionSql<{}>;
/** Anything that can run an `unsafe` statement: the pool, a transaction, a savepoint. */
type Q = { unsafe: Sql["unsafe"] };
type Row = (string | null)[];

export interface BackupOptions {
  sql: Sql;
  repo: string;
  appendOnly: readonly AppendOnlyTable[];
  revised: readonly RevisedTable[];
  /** Max uncompressed bytes in one append-only file (a row is never cut). */
  partBytes: number;
  pauseMs: number;
  maxSeconds: number;
  statementTimeoutS: number;
  /** Stop cleanly (nothing kept, transaction rolled back) if this process's resident memory passes this many MB. */
  maxRssMb: number;
  /** False only in tests (they run on a primary). The command line cannot turn it off. */
  requireReplica: boolean;
  /**
   * The legacy junction (format1-legacy.ts). Tests only: plant a synthetic junction, or null for none. The command
   * line cannot change it.
   */
  junction: Junction | null;
  /** Tests only: the clock the cut rule reads. By default it is the snapshot's own now(). */
  nowMs?: number;
  tool: { name: string; commit: string | null };
  log: (line: string) => void;
}

export const defaultOptions = (sql: Sql, repo: string): BackupOptions => ({
  sql,
  repo,
  appendOnly: APPEND_ONLY,
  revised: REVISED,
  partBytes: MAX_PART_BYTES,
  pauseMs: 50,
  maxSeconds: 3600,
  statementTimeoutS: 90,
  maxRssMb: 1500,
  requireReplica: true,
  junction: LEGACY_JUNCTION,
  tool: { name: "csvb", commit: null },
  log: (l) => console.log(l),
});

let aborted: string | null = null;
export const requestAbort = (why: string): void => {
  aborted = why;
};

const MAX_ATTEMPTS = 3;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const rssMb = (): number => Math.round(process.memoryUsage.rss() / 1048576);
const qi = (c: string): string => `"${c.replace(/"/g, '""')}"`;

// ── reading rows from the database ───────────────────────────────────────────────────────────

async function describe(sp: Q, from: string, select: string): Promise<string[]> {
  const d = await sp.unsafe(`SELECT ${select} FROM ${from} WHERE false`);
  return (d.columns as unknown as { name: string }[]).map((c) => c.name);
}

/**
 * Rows as text. Each column goes through `format('%s', col)`, which prints it with the type's own output
 * function, exactly what COPY writes (`col::text` is not the same: a boolean becomes "true" instead of "t", an
 * inet "::1/128" instead of "::1"). NULL stays NULL. Outputs are aliased c0, c1, ... so that ORDER BY binds to the
 * real, typed columns: under their own names it would sort the TEXT of a key ("12" before "3").
 */
async function selectRows(sp: Q, from: string, select: string, names: string[], where: string, order: string, time?: { expr: string; into: (string | null)[] }): Promise<Row[]> {
  const cast = names.map((c, i) => `CASE WHEN ${qi(c)} IS NULL THEN NULL ELSE format('%s', ${qi(c)}) END AS c${i}`);
  // The row's time is fetched beside it for naming the file; it is not written to the file.
  if (time) cast.push("CASE WHEN _csvb_time IS NULL THEN NULL ELSE format('%s', _csvb_time) END AS ctime");
  const w = where ? `WHERE ${where}` : "";
  const inner = time ? `SELECT ${select}, (${time.expr}) AS _csvb_time FROM ${from} ${w}` : `SELECT ${select} FROM ${from} ${w}`;
  const rows = (await sp.unsafe(`SELECT ${cast.join(", ")} FROM (${inner}) q ORDER BY ${order}`).values()) as unknown as Row[];
  if (time) for (const r of rows) time.into.push(r.pop() ?? null);
  return rows;
}

/** SQL for a row's time: a column of the table, or the time of the row it points to. */
function timeSql(table: string, spec: TimeSpec): string {
  if ("column" in spec) return qi(spec.column);
  const l = spec.lookup;
  return `(SELECT x.${qi(l.timeColumn)} FROM ${l.table} x WHERE x.${qi(l.key)} = ${table}.${qi(l.column)})`;
}

// ── writing files ────────────────────────────────────────────────────────────────────────────

/** Accumulates append-only rows into files named by the period (UTC) their rows cover, streaming to disk. */
class RangeWriter {
  private file: GzFile | null = null;
  private tmp = "";
  private bytes = 0;
  private rows = 0;
  private idMin: bigint | null = null;
  private idMax: bigint | null = null;
  private sum = 0n;
  private tMin: { micros: bigint; text: string } | null = null;
  private tMax: { micros: bigint; text: string } | null = null;
  private seq = 0;
  private namer: DataFileNamer;
  private headerLine: string;
  readonly files: FileRecord[] = [];
  constructor(private staging: string, private backupId: string, private table: string, header: string[], private partBytes: number, private late = false) {
    this.headerLine = encodeCsvRow(header);
    this.namer = new DataFileNamer(table, late);
  }
  async add(fields: Row, id: bigint, time: string | null): Promise<void> {
    if (time === null) throw new Error(`${this.table}: row id ${id} has no time, so the file cannot be named by the period it covers`);
    const micros = parseDbTime(time);
    const line = encodeCsvRow(fields);
    const n = Buffer.byteLength(line);
    if (startsNewPart(this.rows, this.bytes, n, this.partBytes)) await this.flush();
    if (!this.file) {
      this.seq += 1;
      this.tmp = join(this.staging, backupDir(this.backupId), "data", `.part-${this.table}-${this.seq}.tmp`);
      this.file = new GzFile(this.tmp);
      await this.file.write(this.headerLine);
      this.bytes = Buffer.byteLength(this.headerLine);
    }
    await this.file.write(line);
    this.bytes += n;
    this.rows += 1;
    if (this.idMin === null || id < this.idMin) this.idMin = id;
    if (this.idMax === null || id > this.idMax) this.idMax = id;
    this.sum += id;
    if (this.tMin === null || micros < this.tMin.micros) this.tMin = { micros, text: time };
    if (this.tMax === null || micros > this.tMax.micros) this.tMax = { micros, text: time };
  }
  private async flush(): Promise<void> {
    if (!this.file) return;
    const w = await this.file.close();
    const rel = dataPath(this.backupId, this.namer.next(this.tMin!.text, this.tMax!.text));
    const dest = join(this.staging, rel);
    if (existsSync(dest)) throw new Error(`${rel} already exists in the staging area`);
    renameSync(this.tmp, dest);
    this.files.push({
      path: rel,
      rows: this.rows,
      ...w,
      id_min: String(this.idMin),
      id_max: String(this.idMax),
      sum_id: String(this.sum),
      time_min: this.tMin!.text,
      time_max: this.tMax!.text,
      ...(this.late ? { late: true } : {}),
    });
    this.file = null;
    this.bytes = 0;
    this.rows = 0;
    this.idMin = this.idMax = null;
    this.tMin = this.tMax = null;
    this.sum = 0n;
  }
  async finish(): Promise<FileRecord[]> {
    await this.flush();
    return this.files;
  }
}

// ── the backup ───────────────────────────────────────────────────────────────────────────────

/** Add every backup the cut rule has sealed since the repo's newest. Returns the records written, oldest first. */
export async function runBackup(o: BackupOptions): Promise<BackupRecord[]> {
  refuseInsideFrontend(o.repo);
  const staging = join(o.repo, ".staging");
  try {
    return await runBackupInner(o, staging);
  } catch (e) {
    rmSync(staging, { recursive: true, force: true }); // an unfinished run leaves nothing behind
    throw e;
  }
}

/** Backups live outside the robotmoney-frontend checkout that holds csvb (requirements 4.5, Location). */
function refuseInsideFrontend(repo: string): void {
  const checkout = frontendCheckoutAround(repo);
  if (checkout) throw new Error(`refusing to write backups into ${repo}: it is inside the robotmoney-frontend checkout at ${checkout}; name a separate data checkout with --repo`);
}

/** The SQL for a row's time as text, for the first boundary and for naming. */
const timeText = (table: string, spec: TimeSpec): string => `format('%s', ${timeSql(table, spec)})`;

/** The first cut boundary: the UTC midnight after the earliest first row (by id) of the tables backed up. */
async function firstDay(tx: Tx, tables: readonly AppendOnlyTable[]): Promise<number | null> {
  let earliest: bigint | null = null;
  for (const t of tables) {
    const [r] = (await tx.unsafe(`SELECT ${timeText(t.name, t.time)} AS t FROM ${t.name} ORDER BY id LIMIT 1`)) as unknown as [{ t: string | null } | undefined];
    if (!r?.t) continue;
    const us = parseDbTime(r.t);
    if (earliest === null || us < earliest) earliest = us;
  }
  return earliest === null ? null : firstBoundaryMs(earliest);
}

/** Does any table hold an id above its junction watermark? */
async function rowsFollow(tx: Tx, tables: readonly AppendOnlyTable[], j: Junction): Promise<boolean> {
  for (const t of tables) {
    const wm = j.watermarks[t.name];
    if (wm === undefined) throw new Error(`the junction ${j.id} names no watermark for ${t.name}`);
    const [r] = (await tx.unsafe(`SELECT EXISTS (SELECT 1 FROM ${t.name} WHERE id > ${BigInt(wm)}) AS x`)) as unknown as [{ x: boolean }];
    if (r.x) return true;
  }
  return false;
}

/**
 * A table's watermark at a cut (format 1's cut rule): the junction's baked watermark, or at a day boundary the largest
 * id after `after` below the first row stamped at or after the boundary (the newest id when there is none). A table
 * timed through a lookup takes every row whose lookup key is at or below that table's watermark at the cut. No row
 * found: the watermark stays `after`.
 */
async function cutWatermark(tx: Tx, t: AppendOnlyTable, after: bigint | null, cut: Cut, lookupMark: (table: string) => Promise<bigint | null>): Promise<bigint | null> {
  if (cut.kind === "junction") {
    const wm = cut.watermarks[t.name];
    if (wm === undefined) throw new Error(`the junction ${cut.id} names no watermark for ${t.name}`);
    if (after !== null && BigInt(wm) < after) throw new Error(`${t.name}: the junction watermark ${wm} is below the repo's ${after}`);
    return BigInt(wm);
  }
  const above = after === null ? "true" : `x.id > ${after}`;
  let rows: { wm: string | null }[];
  if ("column" in t.time) {
    const boundary = new Date(cut.boundaryMs).toISOString();
    rows = (await tx.unsafe(
      `SELECT (SELECT max(x.id) FROM ${t.name} x WHERE ${above} AND x.id < COALESCE(
         (SELECT x.id FROM ${t.name} x WHERE ${above} AND x.${qi(t.time.column)} >= '${boundary}'::timestamptz ORDER BY x.id LIMIT 1),
         (SELECT max(id) FROM ${t.name}) + 1))::text AS wm`,
    )) as unknown as { wm: string | null }[];
  } else {
    const l = t.time.lookup;
    if (l.key !== "id") throw new Error(`${t.name}: a lookup time must point at the id of ${l.table}`);
    const lw = await lookupMark(l.table);
    if (lw === null) return after;
    rows = (await tx.unsafe(`SELECT max(x.id)::text AS wm FROM ${t.name} x WHERE ${above} AND x.${qi(l.column)} <= ${lw}`)) as unknown as { wm: string | null }[];
  }
  const wm = rows[0]?.wm ?? null;
  return wm === null ? after : BigInt(wm);
}

/** The repo's watermark of a table: the highest id of its non-late files. */
function repoWatermark(records: readonly BackupRecord[], table: string): bigint | null {
  let wm: bigint | null = null;
  for (const r of records) for (const f of r.append_only[table]?.files ?? []) if (!f.late && (wm === null || BigInt(f.id_max!) > wm)) wm = BigInt(f.id_max!);
  return wm;
}

async function runBackupInner(o: BackupOptions, staging: string): Promise<BackupRecord[]> {
  const started = Date.now();
  const deadline = started + o.maxSeconds * 1000;
  const guard = (): void => {
    if (aborted) throw new Error(`stopped: ${aborted}`);
    if (Date.now() > deadline) throw new Error(`--max-seconds ${o.maxSeconds} exceeded; nothing was kept`);
    const rss = rssMb();
    if (rss > o.maxRssMb) throw new Error(`memory budget exceeded: ${rss} MB resident, limit ${o.maxRssMb} MB (--max-rss-mb); stopping so the machine is not run out of memory. Nothing was kept`);
  };
  mkdirSync(o.repo, { recursive: true });
  rmSync(staging, { recursive: true, force: true }); // only ever holds an unfinished earlier run
  mkdirSync(staging, { recursive: true });

  const prior = loadRecords({ root: o.repo });
  const newest = prior.length ? prior[prior.length - 1]!.backup : null;
  if (newest !== null && !DAY_CUT_ID_RE.test(newest) && newest !== o.junction?.id) {
    throw new Error(`the repo's newest backup ${newest} is a snapshot-time backup other than the junction ${o.junction?.id ?? "(none)"}; backups are cut by UTC day and continue only from the junction or a day-cut backup`);
  }
  const written: BackupRecord[] = [];

  await o.sql.begin("ISOLATION LEVEL REPEATABLE READ READ ONLY", async (tx) => {
    await tx.unsafe(`SET LOCAL statement_timeout = '${Math.trunc(o.statementTimeoutS)}s'`);
    await tx.unsafe("SET LOCAL lock_timeout = '5s'");
    await tx.unsafe("SET LOCAL idle_in_transaction_session_timeout = '300s'");
    await tx.unsafe("SET LOCAL application_name = 'csv-backups'");
    await tx.unsafe("SET LOCAL TimeZone = 'UTC'");
    const [rec] = await tx`SELECT pg_is_in_recovery() AS replica`;
    if (o.requireReplica && !rec?.replica) throw new Error("refusing to back up: this server is not a replica (pg_is_in_recovery() is false)");
    const [meta] = await tx`SELECT now()::text AS exported_at_db, pg_last_xact_replay_timestamp()::text AS replica_replay_ts, current_user AS db_user`;
    const nowMs = o.nowMs ?? Number(parseDbTime(meta!.exported_at_db as string) / 1000n);

    const first = await firstDay(tx, o.appendOnly);
    const follow = first !== null && junctionApplies(o.junction, nowMs, true) ? await rowsFollow(tx, o.appendOnly, o.junction!) : false;
    const cuts = planCuts({ firstDayMs: first, nowMs, junction: o.junction, rowsFollowJunction: follow, after: newest });
    if (cuts.length === 0) {
      throw new Error(`no sealed backup is newer than the repo's ${newest ?? "(none)"}: the last sealed day boundary is not past it; backups must be strictly newer`);
    }
    o.log(`snapshot ${meta!.exported_at_db}, replica replay ${meta!.replica_replay_ts ?? "n/a"}${rec?.replica ? " (replica confirmed)" : " (NOT a replica: test run)"}; ${cuts.length} backup(s) to cut: ${cuts.map((c) => c.id).join(", ")}`);

    // Revised tables' state before this run: what the run's earlier backups record as unchanged.
    const unchanged = new Map<string, RevisedRecord>();
    for (const t of o.revised) {
      if (cuts.length === 1) break;
      const st = await loadState({ root: o.repo }, t);
      unchanged.set(t.name, { key: t.key, file: null, upserts: 0, deletes: 0, rows_in_state: st.rows.size, state_sha256: stateHash(st.rows) });
    }

    for (const [i, cut] of cuts.entries()) {
      const id = cut.id;
      const records = [...prior, ...written];
      const marks = new Map<string, bigint | null>();
      const lookupMark = async (table: string): Promise<bigint | null> => {
        if (marks.has(table)) return marks.get(table)!;
        const lt = o.appendOnly.find((x) => x.name === table) ?? APPEND_ONLY.find((x) => x.name === table);
        if (!lt) throw new Error(`no table ${table} to cut`);
        const wm = await cutWatermark(tx, lt, repoWatermark(records, table), cut, lookupMark);
        marks.set(table, wm);
        return wm;
      };
      const appendRecords: Record<string, AppendOnlyRecord> = {};
      const anomalies: Anomaly[] = [];
      for (const t of o.appendOnly) {
        const through = await lookupMark(t.name);
        const r = await backupAppendOnly(o, tx, t, records, id, staging, guard, through, cut.kind === "junction");
        appendRecords[t.name] = r.record;
        anomalies.push(...r.anomalies);
      }

      const revisionRecords: Record<string, RevisedRecord> = {};
      const lastCut = i === cuts.length - 1;
      for (const t of o.revised) revisionRecords[t.name] = lastCut ? await backupRevised(o, tx, t, id, staging, guard) : unchanged.get(t.name)!;

      const record: BackupRecord = {
        format: 1,
        backup: id,
        snapshot: { exported_at_db: meta!.exported_at_db as string, replica_replay_ts: (meta!.replica_replay_ts as string | null) ?? null, db_user: meta!.db_user as string, was_replica: !!rec?.replica },
        tool: o.tool,
        append_only: appendRecords,
        revisions: revisionRecords,
        anomalies,
      };
      mkdirSync(join(staging, backupDir(id)), { recursive: true });
      writeFileSync(join(staging, recordPath(id)), JSON.stringify(record, null, 2) + "\n");
      written.push(record);
      o.log(`backup ${id} (${cut.kind === "junction" ? "the legacy junction" : "day cut"}) staged`);
    }
  });

  if (written.length === 0) throw new Error("no backup record was produced");
  o.log(`staged in ${Math.round((Date.now() - started) / 1000)}s (peak so far ${rssMb()} MB resident); verifying the staged files before they join the repo`);
  await finishStaged(o.repo, o.log);
  return written;
}

/**
 * Verify what is in `<repo>/.staging` (backup records plus their files) and, only if every check passes, move it into
 * the repo. Used at the end of a backup, and on its own (`csvb finish`) to complete a run that was interrupted after
 * its files were staged. Write-once: refuses to replace any existing file. Returns the finished records, oldest first.
 */
export async function finishStaged(repo: string, log: (line: string) => void): Promise<BackupRecord[]> {
  refuseInsideFrontend(repo);
  const staging = join(repo, ".staging");
  const csv = join(staging, CSV_DIR);
  const ids = (existsSync(csv) ? readdirSync(csv).filter((n) => BACKUP_ID_RE.test(n) && existsSync(join(csv, n, "backup.json"))) : []).sort();
  if (ids.length === 0) throw new Error(`${staging} holds no complete backup record; nothing to finish`);
  const problems = await verifyRepo({ root: repo, overlay: staging }, { only: ids });
  if (problems.length) throw new Error(`verification of the new backup(s) failed; nothing was added to the repo:\n  ${problems.join("\n  ")}`);
  log(`verified the staged backup(s) ${ids.join(", ")} (${rssMb()} MB resident); moving them into the repo`);
  const moved: string[] = [];
  for (const abs of walk(staging)) {
    const rel = relative(staging, abs);
    const dest = join(repo, rel);
    if (existsSync(dest)) throw new Error(`${rel} already exists in the repo; files are write-once`);
    mkdirSync(dirname(dest), { recursive: true });
    renameSync(abs, dest);
    moved.push(rel);
  }
  rmSync(staging, { recursive: true, force: true });
  log(`added ${moved.length} file(s) to the repo as backup(s) ${ids.join(", ")}`);
  const all = loadRecords({ root: repo });
  return all.filter((r) => ids.includes(r.backup));
}

function* walk(dir: string): Generator<string> {
  for (const n of readdirSync(dir).sort()) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

// ── append-only tables ───────────────────────────────────────────────────────────────────────

/** One append-only table in one backup: reconcile the repo with the database, then add the rows through the cut's watermark. */
async function backupAppendOnly(o: BackupOptions, tx: Tx, t: AppendOnlyTable, prior: BackupRecord[], backupId: string, staging: string, guard: () => void, through: bigint | null, atJunction: boolean): Promise<{ record: AppendOnlyRecord; anomalies: Anomaly[] }> {
  const anomalies: Anomaly[] = [];
  const layout: Layout = { root: o.repo, overlay: staging };
  // What the repo already holds, and what earlier backups recorded as gone from the database.
  let repoRows = 0n;
  let repoSum = 0n;
  let watermark: bigint | null = null;
  let lastFile: FileRecord | null = null;
  const repoFiles: FileRecord[] = [];
  let goneCount = 0n;
  let goneSum = 0n;
  const goneIds = new Set<string>();
  for (const p of prior) {
    for (const f of p.append_only[t.name]?.files ?? []) {
      repoFiles.push(f);
      repoRows += BigInt(f.rows);
      repoSum += BigInt(f.sum_id ?? "0");
      const hi = BigInt(f.id_max!);
      if (!f.late && (watermark === null || hi > watermark)) {
        watermark = hi;
        lastFile = f;
      }
    }
    for (const an of p.anomalies ?? []) {
      if (an.kind === "deleted_rows" && an.table === t.name) {
        goneCount += BigInt(an.count);
        goneSum += BigInt(an.sum_id);
        for (const id of an.ids) goneIds.add(id);
      }
    }
  }
  const names = await describe(tx, t.name, t.select);
  if (!names.includes("id")) throw new Error(`${t.name}: no id column`);
  const idIdx = names.indexOf("id");
  const tExpr = timeSql(t.name, t.time);
  if (lastFile) {
    const was = await readHeader(resolvePath(layout, lastFile.path));
    if (was.join(",") !== names.join(",")) {
      throw new Error(`${t.name}: the columns changed (${was.join(",")} became ${names.join(",")}); a schema change needs a decision, see the README`);
    }
  }
  const hashed = (t.hashed ?? []).map((p) => ({ t: names.indexOf(p.text), h: names.indexOf(p.sha256), label: `${p.text}/${p.sha256}` }));
  if (hashed.some((p) => p.t < 0 || p.h < 0)) throw new Error(`${t.name}: a hashed column pair is missing from the select list`);
  const check = (r: Row): bigint => {
    const rid = BigInt(r[idIdx]!);
    for (const p of hashed) {
      const text = r[p.t];
      const want = r[p.h];
      const got = text == null ? null : sha256(text);
      if (got !== want) throw new Error(`${t.name}: row id ${rid}: ${p.label} does not hash to the stored bytes' sha256`);
    }
    return rid;
  };

  // 1. Do the repo's rows still match the database's? If not, say how, capture what is missing, and carry on.
  const lateFiles: FileRecord[] = [];
  if (watermark !== null) {
    const [db] = (await tx.unsafe(`SELECT count(*)::text AS n, coalesce(sum(id), 0)::text AS s FROM ${t.name} WHERE id <= ${watermark}`)) as unknown as [{ n: string; s: string }];
    if (db.n !== String(repoRows - goneCount) || db.s !== String(repoSum - goneSum)) {
      const repoIds = new Set<string>();
      for (const f of repoFiles) {
        await scanCsvGz(resolvePath(layout, f.path), (fields, hd) => {
          repoIds.add(fields[hd.indexOf("id")]!);
        });
      }
      const dbIds = new Set<string>();
      for (const r of (await tx.unsafe(`SELECT id::text FROM ${t.name} WHERE id <= ${watermark} ORDER BY id`).values()) as unknown as string[][]) dbIds.add(r[0]!);
      const lateIds = [...dbIds].filter((id) => !repoIds.has(id)).map(BigInt).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
      const nowGone = [...repoIds].filter((id) => !dbIds.has(id) && !goneIds.has(id)).map(BigInt).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
      if (nowGone.length) {
        const sum = nowGone.reduce((a, b) => a + b, 0n);
        anomalies.push({ kind: "deleted_rows", table: t.name, count: nowGone.length, sum_id: String(sum), ids: nowGone.slice(0, 1000).map(String) });
        goneCount += BigInt(nowGone.length);
        goneSum += sum;
        o.log(`${t.name}: ANOMALY ${nowGone.length} row(s) in the repo are gone from the database (ids ${nowGone.slice(0, 5).join(", ")}${nowGone.length > 5 ? ", ..." : ""}); the repo keeps its copy`);
      }
      if (lateIds.length) {
        const w = new RangeWriter(staging, backupId, t.name, names, o.partBytes, true);
        let lateSum = 0n;
        for (let i = 0; i < lateIds.length; i += 500) {
          guard();
          const chunk = lateIds.slice(i, i + 500);
          const times: (string | null)[] = [];
          const rows = await selectRows(tx, t.name, t.select, names, `id IN (${chunk.join(",")})`, "id", { expr: tExpr, into: times });
          if (rows.length !== chunk.length) throw new Error(`${t.name}: asked for ${chunk.length} late rows, the database returned ${rows.length}`);
          for (let k = 0; k < rows.length; k++) {
            const rid = check(rows[k]!);
            await w.add(rows[k]!, rid, times[k]!);
            lateSum += rid;
          }
        }
        const lf = await w.finish();
        lateFiles.push(...lf);
        repoRows += BigInt(lateIds.length);
        repoSum += lateSum;
        anomalies.push({ kind: "late_rows", table: t.name, count: lateIds.length, sum_id: String(lateSum), id_min: String(lateIds[0]), id_max: String(lateIds[lateIds.length - 1]), files: lf.map((f) => f.path) });
        o.log(`${t.name}: ANOMALY ${lateIds.length} row(s) with ids at or below ${watermark} were not in the repo (committed late); captured in ${lf.length} file(s)`);
      }
      // The reconciled repo must now equal the database exactly.
      if (String(repoRows - goneCount) !== db.n || String(repoSum - goneSum) !== db.s) {
        throw new Error(`${t.name}: could not reconcile the repo with the database (repo ${repoRows - goneCount} rows / sum ${repoSum - goneSum}, database ${db.n} / ${db.s}); this is a bug in the tool, not a data anomaly`);
      }
    }
  }

  // 2. Add what is new, through the cut's watermark.
  const writer = new RangeWriter(staging, backupId, t.name, names, o.partBytes);
  let last: bigint | null = watermark;
  let rowsPerPage = t.pageRows;
  let added = 0;
  let addedSum = 0n;
  for (;;) {
    guard();
    let rows: Row[] = [];
    let times: (string | null)[] = [];
    let expect = 0;
    let nextLast: bigint | null = last;
    for (let attempt = 1; ; attempt++) {
      try {
        await tx.savepoint(async (sp) => {
          if (through === null || (last !== null && through <= last)) {
            expect = 0;
            rows = [];
            times = [];
            return;
          }
          const after = `${last === null ? "" : `id > ${last} AND `}id <= ${through}`;
          const [probe] = (await sp.unsafe(
            `SELECT count(*)::int AS c, max(id)::text AS m FROM (SELECT id FROM ${t.name} WHERE ${after} ORDER BY id LIMIT ${rowsPerPage}) p`,
          )) as unknown as [{ c: number; m: string | null }];
          expect = probe.c;
          times = [];
          if (probe.c === 0) {
            rows = [];
            return;
          }
          nextLast = BigInt(probe.m!);
          rows = await selectRows(sp, t.name, t.select, names, `${after} AND id <= ${probe.m}`, "id", { expr: tExpr, into: times });
        });
        break;
      } catch (e) {
        if (attempt >= MAX_ATTEMPTS || aborted) throw e;
        o.log(`${t.name}: page failed (${(e as Error).message.split("\n")[0]}); retry ${attempt}/${MAX_ATTEMPTS - 1} with a smaller page`);
        rowsPerPage = Math.max(1, Math.floor(rowsPerPage / 2));
        await sleep(500 * attempt);
      }
    }
    if (rows.length !== expect) throw new Error(`${t.name}: a page held ${rows.length} rows but its probe promised ${expect}`);
    let prev = last;
    for (let k = 0; k < rows.length; k++) {
      const r = rows[k]!;
      const rid = check(r);
      if (prev !== null && rid <= prev) throw new Error(`${t.name}: ids out of order or repeated at ${rid}`);
      prev = rid;
      await writer.add(r, rid, times[k] ?? null);
      addedSum += rid;
    }
    added += rows.length;
    last = nextLast;
    if (expect === 0 || expect < rowsPerPage) break; // an empty or short page is the last page
    if (o.pauseMs > 0) await sleep(o.pauseMs);
  }
  const files = await writer.finish();
  if (atJunction && through !== null && last !== through) throw new Error(`${t.name}: the junction watermark ${through} names no row in the database (the rows end at ${last ?? "none"})`);

  // 3. The database's totals through the new watermark must equal the repo's (less what was recorded as gone).
  const newMark = last;
  const totalRows = repoRows + BigInt(added) - goneCount;
  const totalSum = repoSum + addedSum - goneSum;
  let dbRows = "0";
  let dbSum = "0";
  if (newMark !== null) {
    const [db] = (await tx.unsafe(`SELECT count(*)::text AS n, coalesce(sum(id), 0)::text AS s FROM ${t.name} WHERE id <= ${newMark}`)) as unknown as [{ n: string; s: string }];
    dbRows = db.n;
    dbSum = db.s;
  }
  if (dbRows !== String(totalRows) || dbSum !== String(totalSum)) {
    throw new Error(`${t.name}: after adding ${added} rows the repo would hold ${totalRows} rows (sum ${totalSum}) through id ${newMark}, but the database holds ${dbRows} (sum ${dbSum})`);
  }
  o.log(`${t.name}: +${added} rows${watermark === null ? " (first backup)" : ""}, ${files.length} file(s), through id ${newMark ?? "none"} (${dbRows} rows, matches the database)`);
  return {
    record: {
      time: t.time,
      watermark_before: watermark === null ? null : String(watermark),
      watermark_after: newMark === null ? null : String(newMark),
      rows_added: added + lateFiles.reduce((n, f) => n + f.rows, 0),
      files: [...lateFiles, ...files],
      db_rows_through_watermark: dbRows,
      db_sum_id_through_watermark: dbSum,
    },
    anomalies,
  };
}

// ── revised tables ───────────────────────────────────────────────────────────────────────────

async function backupRevised(o: BackupOptions, tx: Tx, t: RevisedTable, backupId: string, staging: string, guard: () => void): Promise<RevisedRecord> {
  guard();
  const names = await describe(tx, t.name, t.select);
  const now = new Map<string, Row>();
  for (const r of await selectRows(tx, t.name, t.select, names, "", t.orderBy)) {
    const k = keyOf(names, r, t.key);
    if (now.has(k)) throw new Error(`${t.name}: two rows share the key (${t.key.join(",")}) = ${k.replace(/\u0001/g, ",")}; the key is not unique`);
    now.set(k, r);
  }
  const [{ n }] = (await tx.unsafe(`SELECT count(*)::text AS n FROM ${t.name}`)) as unknown as [{ n: string }];
  if (String(now.size) !== n) throw new Error(`${t.name}: read ${now.size} rows but count(*) is ${n}`);

  const before = await loadState({ root: o.repo }, t);
  if (before.names.length && before.names.join(",") !== names.join(",")) {
    throw new Error(`${t.name}: the columns changed (${before.names.join(",")} became ${names.join(",")}); a schema change needs a decision, see the README`);
  }
  // Changed rows stream to a revision file as they are found; if nothing changed, no file is made.
  const rel = revisionFile(backupId, t.name);
  let out: GzFile | null = null;
  const emit = async (op: "upsert" | "delete", r: Row): Promise<void> => {
    if (!out) {
      out = new GzFile(join(staging, rel));
      await out.write(encodeCsvRow(["_backup", "_op", ...names]));
    }
    await out.write(encodeCsvRow([backupId, op, ...r]));
  };
  let upserts = 0;
  let deletes = 0;
  for (const [k, r] of now) {
    const was = before.rows.get(k);
    if (!was || !sameRow(was, r)) {
      await emit("upsert", r);
      upserts += 1;
    }
  }
  for (const [k, r] of before.rows) {
    if (!now.has(k)) {
      await emit("delete", r);
      deletes += 1;
    }
  }
  const stateAfter = stateHash(now);
  let file: FileRecord | null = null;
  if (out) file = { path: rel, rows: upserts + deletes, ...(await (out as GzFile).close()) };
  o.log(`${t.name}: ${upserts} new or changed, ${deletes} removed, ${now.size} rows in the table${file ? "" : " (no revision file: nothing changed)"}`);
  return { key: t.key, file, upserts, deletes, rows_in_state: now.size, state_sha256: stateAfter };
}

function sameRow(a: Row, b: Row): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if ((a[i] ?? null) !== (b[i] ?? null)) return false;
  return true;
}
