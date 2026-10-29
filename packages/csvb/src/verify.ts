// `csvb verify`: prove the repo is intact, from the files alone (no database).
//
// For every backup record, in order:
//   * every file it lists exists, is byte-identical to what was recorded (compressed and uncompressed SHA-256),
//     and holds exactly the rows, id range and sum of ids the record says;
//   * append-only tables: ids strictly increase across the whole history, each file starts above the watermark
//     before it, the watermarks chain from backup to backup, and the totals equal the database's totals that were
//     recorded when the backup was made (less rows an anomaly recorded as gone from the database);
//   * revised tables: replaying the revision files reproduces, at every backup, the recorded row count and the
//     recorded state SHA-256, and the counts of upserts and deletes match;
//   * no file in `append-only/` or `revisions/` is missing from the records (nothing was slipped in).
//
// Memory is constant: every file is read once, as a stream, and never held whole. With `only` (one or more backup ids), the files of other
// backups are not re-read (their records are trusted for the chain), except revision files, which are small and
// are needed to replay the state.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { TimeSpec } from "./config.ts";
import { BACKUP_ID_RE, CSV_DIR, backupDir, dataFileName, dataPath, parseDbTime, revisionFile, type BackupRecord, type FileRecord } from "./model.ts";
import { keyOf, loadRecords, resolvePath, scanCsvGz, stateHash, type Layout, type Scanned, type State } from "./repo.ts";

function compare(f: FileRecord, s: Scanned, out: string[]): void {
  if (s.sha256_gz !== f.sha256_gz || s.bytes_gz !== f.bytes_gz) out.push(`${f.path}: compressed bytes differ from the record`);
  if (s.sha256_raw !== f.sha256_raw || s.bytes_raw !== f.bytes_raw) out.push(`${f.path}: uncompressed bytes differ from the record`);
}

/** key -> time (micros) for a lookup table (e.g. vintages), from every backup that holds it. Built once, on first use. */
async function loadLookup(l: Layout, records: BackupRecord[], spec: Extract<TimeSpec, { lookup: unknown }>["lookup"]): Promise<Map<string, bigint>> {
  const m = new Map<string, bigint>();
  for (const rec of records) {
    for (const f of rec.append_only[spec.table]?.files ?? []) {
      await scanCsvGz(resolvePath(l, f.path), (fields, hd) => {
        const k = fields[hd.indexOf(spec.key)];
        const t = fields[hd.indexOf(spec.timeColumn)];
        if (k != null && t != null) m.set(k, parseDbTime(t));
      });
    }
  }
  return m;
}

export async function verifyRepo(l: Layout, opts: { only?: string | readonly string[] } = {}): Promise<string[]> {
  const only = opts.only === undefined ? null : typeof opts.only === "string" ? [opts.only] : opts.only;
  const problems: string[] = [];
  let records;
  try {
    records = loadRecords(l);
  } catch (e) {
    return [(e as Error).message];
  }
  for (const id of only ?? []) if (!records.some((r) => r.backup === id)) return [`no backup ${id}`];
  const referenced = new Set<string>();
  const lookups = new Map<string, Map<string, bigint>>();

  const mark = new Map<string, bigint | null>();
  const cumRows = new Map<string, bigint>();
  const cumSum = new Map<string, bigint>();
  const goneRows = new Map<string, bigint>();
  const goneSum = new Map<string, bigint>();
  const header = new Map<string, string>();
  const states = new Map<string, State>();
  const keys = new Map<string, string[]>();

  for (const rec of records) {
    const check = only === null || only.includes(rec.backup);
    const tag = `backup ${rec.backup}`;

    // ── append-only tables ──
    for (const [table, a] of Object.entries(rec.append_only)) {
      let wm = mark.get(table) ?? null;
      if ((a.watermark_before === null ? null : BigInt(a.watermark_before)) !== wm) problems.push(`${tag} ${table}: watermark_before ${a.watermark_before} does not continue from ${wm}`);
      let rows = cumRows.get(table) ?? 0n;
      let sum = cumSum.get(table) ?? 0n;
      let addedRows = 0;
      for (const f of a.files) {
        referenced.add(f.path);
        if (!a.time || !f.time_min || !f.time_max) {
          problems.push(`${f.path}: the record does not say which time the file's name was built from`);
        } else {
          const base = dataPath(rec.backup, dataFileName(table, !!f.late, f.time_min, f.time_max)).replace(/\.csv\.gz$/, "");
          const ok = f.path === `${base}.csv.gz` || new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d+\\.csv\\.gz$`).test(f.path);
          if (!ok) problems.push(`${f.path}: name does not match the period its record says it covers (${f.time_min} to ${f.time_max}); expected ${base}.csv.gz`);
        }
        if (check) {
          const abs = resolvePath(l, f.path);
          if (!existsSync(abs)) {
            problems.push(`${f.path}: missing`);
            continue;
          }
          let n = 0;
          let lo: bigint | null = null;
          let hi: bigint | null = null;
          let s = 0n;
          let prev: bigint | null = f.late ? null : wm;
          let bad = false;
          let tLo: bigint | null = null;
          let tHi: bigint | null = null;
          let tBad = 0;
          let lookup: Map<string, bigint> | null = null;
          if (a.time && "lookup" in a.time) {
            const key = JSON.stringify(a.time.lookup);
            if (!lookups.has(key)) lookups.set(key, await loadLookup(l, records, a.time.lookup));
            lookup = lookups.get(key)!;
          }
          try {
            const sc = await scanCsvGz(abs, (fields, hd) => {
              const id = BigInt(fields[hd.indexOf("id")]!);
              if (prev !== null && id <= prev) bad = true;
              prev = id;
              if (lo === null) lo = id;
              hi = id;
              s += id;
              n += 1;
              if (a.time) {
                let t: bigint | undefined;
                if ("column" in a.time) {
                  const v = fields[hd.indexOf(a.time.column)];
                  t = v == null ? undefined : parseDbTime(v);
                } else {
                  const ref = fields[hd.indexOf(a.time.lookup.column)];
                  t = ref == null ? undefined : lookup!.get(ref);
                }
                if (t === undefined) tBad += 1;
                else {
                  if (tLo === null || t < tLo) tLo = t;
                  if (tHi === null || t > tHi) tHi = t;
                }
              }
            });
            compare(f, sc, problems);
            const hs = sc.header.join(",");
            if (!header.has(table)) header.set(table, hs);
            else if (header.get(table) !== hs) problems.push(`${f.path}: columns differ from the table's earlier files`);
          } catch (e) {
            problems.push(`${f.path}: unreadable (${(e as Error).message})`);
            continue;
          }
          if (bad) problems.push(`${f.path}: ids are not strictly increasing${f.late ? "" : ` above ${wm}`}`);
          if (n !== f.rows) problems.push(`${f.path}: ${n} rows, record says ${f.rows}`);
          if (String(lo) !== f.id_min || String(hi) !== f.id_max) problems.push(`${f.path}: id range ${lo}..${hi}, record says ${f.id_min}..${f.id_max}`);
          if (String(s) !== f.sum_id) problems.push(`${f.path}: sum of ids ${s}, record says ${f.sum_id}`);
          if (a.time && f.time_min && f.time_max) {
            if (tBad) problems.push(`${f.path}: ${tBad} row(s) have no time`);
            else if (tLo !== parseDbTime(f.time_min) || tHi !== parseDbTime(f.time_max)) problems.push(`${f.path}: its rows cover a different period than the record (and the file name) says`);
          }
        }
        // The chain advances on the record's own numbers (checked above when this backup is the one verified).
        rows += BigInt(f.rows);
        sum += BigInt(f.sum_id ?? "0");
        addedRows += f.rows;
        if (!f.late) wm = BigInt(f.id_max!);
      }
      // Rows this backup recorded as gone from the database (the repo keeps them).
      let gr = goneRows.get(table) ?? 0n;
      let gs = goneSum.get(table) ?? 0n;
      for (const an of rec.anomalies ?? []) {
        if (an.table !== table) continue;
        if (an.kind === "deleted_rows") {
          gr += BigInt(an.count);
          gs += BigInt(an.sum_id);
          if (an.ids.length > an.count) problems.push(`${tag} ${table}: a deleted_rows anomaly lists more ids than its count`);
        } else {
          const inFiles = a.files.filter((f) => f.late && an.files.includes(f.path));
          if (inFiles.length !== an.files.length) problems.push(`${tag} ${table}: a late_rows anomaly names files the record does not list`);
          if (inFiles.reduce((n, f) => n + f.rows, 0) !== an.count) problems.push(`${tag} ${table}: a late_rows anomaly's count does not match its files`);
        }
      }
      goneRows.set(table, gr);
      goneSum.set(table, gs);
      if (a.rows_added !== addedRows) problems.push(`${tag} ${table}: rows_added ${a.rows_added}, files hold ${addedRows}`);
      if ((a.watermark_after === null ? null : BigInt(a.watermark_after)) !== wm) problems.push(`${tag} ${table}: watermark_after ${a.watermark_after}, files end at ${wm}`);
      if (a.db_rows_through_watermark !== String(rows - gr)) problems.push(`${tag} ${table}: the database held ${a.db_rows_through_watermark} rows through the watermark, the repo holds ${rows}${gr ? ` of which ${gr} were recorded as gone from the database` : ""}`);
      if (a.db_sum_id_through_watermark !== String(sum - gs)) problems.push(`${tag} ${table}: the database's sum(id) was ${a.db_sum_id_through_watermark}, the repo's is ${sum}${gs ? ` less ${gs} recorded as gone` : ""}`);
      mark.set(table, wm);
      cumRows.set(table, rows);
      cumSum.set(table, sum);
    }

    // ── revised tables ──
    for (const [table, r] of Object.entries(rec.revisions)) {
      if (!Array.isArray(r.key) || r.key.length === 0) {
        problems.push(`${tag}: ${table} has no key columns recorded`);
        continue;
      }
      const earlier = keys.get(table);
      if (earlier && earlier.join(",") !== r.key.join(",")) problems.push(`${tag} ${table}: key columns ${r.key.join(",")} differ from the earlier ${earlier.join(",")}`);
      keys.set(table, r.key);
      const state = states.get(table) ?? { names: [], rows: new Map() };
      states.set(table, state);
      let ups = 0;
      let dels = 0;
      if (r.file) {
        const f = r.file;
        referenced.add(f.path);
        if (f.path !== revisionFile(rec.backup, table)) problems.push(`${f.path}: not the expected revision path for ${tag} (expected ${revisionFile(rec.backup, table)})`);
        const abs = resolvePath(l, f.path);
        if (!existsSync(abs)) problems.push(`${f.path}: missing`);
        else {
          let n = 0;
          try {
            const sc = await scanCsvGz(abs, (fields, hd) => {
              if (hd[0] !== "_backup" || hd[1] !== "_op") throw new Error("header must start with _backup,_op");
              const names = hd.slice(2);
              if (state.names.length === 0) state.names = names;
              else if (state.names.join(",") !== names.join(",")) throw new Error("columns differ from the table's earlier revisions");
              if (fields[0] !== rec.backup) throw new Error(`a row is labelled backup ${fields[0]}`);
              const row = fields.slice(2);
              const k = keyOf(names, row, r.key);
              n += 1;
              if (fields[1] === "upsert") {
                state.rows.set(k, row);
                ups += 1;
              } else if (fields[1] === "delete") {
                if (!state.rows.has(k)) throw new Error(`delete of a row that is not in the state (${k.replace(/\u0001/g, ",")})`);
                state.rows.delete(k);
                dels += 1;
              } else throw new Error(`unknown _op ${fields[1]}`);
            });
            if (check) compare(f, sc, problems);
          } catch (e) {
            problems.push(`${f.path}: ${(e as Error).message}`);
          }
          if (n !== f.rows) problems.push(`${f.path}: ${n} rows, record says ${f.rows}`);
        }
      }
      if (ups !== r.upserts || dels !== r.deletes) problems.push(`${tag} ${table}: ${ups} upserts and ${dels} deletes in the file, record says ${r.upserts} and ${r.deletes}`);
      if (state.rows.size !== r.rows_in_state) problems.push(`${tag} ${table}: replay gives ${state.rows.size} rows, record says ${r.rows_in_state}`);
      if (stateHash(state.rows) !== r.state_sha256) problems.push(`${tag} ${table}: replayed state hash differs from the record`);
    }
  }

  // Nothing under csv/ that no record lists: every file is a record or a listed data or revision file.
  if (only === null) {
    const top = join(l.root, CSV_DIR);
    if (existsSync(top)) {
      for (const entry of readdirSync(top).sort()) {
        const dir = join(top, entry);
        if (!statSync(dir).isDirectory()) {
          problems.push(`${CSV_DIR}/${entry}: a file where a backup directory is expected`);
          continue;
        }
        if (!BACKUP_ID_RE.test(entry)) {
          problems.push(`${CSV_DIR}/${entry}: not a backup directory (expected YYYY-MM-DDTHHMMSSZ)`);
          continue;
        }
        for (const f of walkFiles(dir)) {
          const rel = relative(l.root, f);
          const inside = relative(dir, f);
          if (inside === "backup.json" || referenced.has(rel)) continue;
          problems.push(`${rel}: on disk but not in any backup record`);
        }
      }
    }
  }
  return problems;
}

function* walkFiles(dir: string): Generator<string> {
  for (const n of readdirSync(dir).sort()) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) yield* walkFiles(p);
    else yield p;
  }
}
