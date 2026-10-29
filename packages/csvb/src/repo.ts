// Reading a backup repo: its records, its files, and the replayed state of revised tables.
//
// All file lookups go through `Layout`, which may carry an `overlay` directory (a backup being assembled but
// not yet moved into place), so a new backup can be verified before it joins the repo.
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createGunzip } from "node:zlib";
import { encodeCsvRow, parseCsvRow, splitCsv } from "@robotmoney/analyst-sdk/src/archive/format1.ts";
import { BACKUP_ID_RE, CSV_DIR, recordPath, type BackupRecord } from "./model.ts";

export interface Layout {
  root: string;
  /** A directory holding files (and `backups/<id>.json`) not yet moved into root. Looked at first. */
  overlay?: string;
}

/**
 * The robotmoney-frontend checkout a directory lies in, or null: the nearest directory at or above it that holds this
 * tool's own package (packages/csvb/package.json). Backups live outside that checkout (requirements 4.5, Location).
 */
export function frontendCheckoutAround(dir: string): string | null {
  let d = resolve(dir);
  for (;;) {
    const pkg = join(d, "packages", "csvb", "package.json");
    if (existsSync(pkg)) {
      try {
        if ((JSON.parse(readFileSync(pkg, "utf8")) as { name?: string }).name === "@robotmoney/csvb") return d;
      } catch {
        // not this tool's package
      }
    }
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

export const sha256 = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");

export function resolvePath(l: Layout, rel: string): string {
  if (l.overlay) {
    const o = join(l.overlay, rel);
    if (existsSync(o)) return o;
  }
  return join(l.root, rel);
}

function backupDirs(root: string): string[] {
  const d = join(root, CSV_DIR);
  return existsSync(d) ? readdirSync(d).filter((n) => BACKUP_ID_RE.test(n) && existsSync(join(d, n, "backup.json"))) : [];
}

/** Every backup record, oldest first (the id sorts chronologically). Includes the overlay's. */
export function loadRecords(l: Layout): BackupRecord[] {
  const ids = new Set<string>(backupDirs(l.root));
  if (l.overlay) for (const id of backupDirs(l.overlay)) ids.add(id);
  const out: BackupRecord[] = [];
  for (const id of [...ids].sort()) {
    const rec = JSON.parse(readFileSync(resolvePath(l, recordPath(id)), "utf8")) as BackupRecord;
    if (rec.backup !== id) throw new Error(`${recordPath(id)}: record says backup ${rec.backup}`);
    out.push(rec);
  }
  return out;
}

/**
 * Stream a gzipped CSV file through `onRow`, one row at a time, in constant memory (no more than one 64 KB
 * chunk, plus the row being assembled, is ever held). Also returns what a verifier needs from the same single
 * pass: row count, header, sizes and SHA-256 of the compressed and uncompressed bytes.
 */
export interface Scanned {
  header: string[];
  rows: number;
  bytes_gz: number;
  bytes_raw: number;
  sha256_gz: string;
  sha256_raw: string;
}

export async function scanCsvGz(abs: string, onRow: (fields: (string | null)[], header: string[]) => void): Promise<Scanned> {
  const gzHash = createHash("sha256");
  const rawHash = createHash("sha256");
  let gzBytes = 0;
  let rawBytes = 0;
  let header: string[] = [];
  let rows = 0;
  const src = createReadStream(abs, { highWaterMark: 64 * 1024 });
  const gunzip = createGunzip();
  src.on("data", (c) => {
    gzHash.update(c);
    gzBytes += (c as Buffer).length;
  });
  src.on("error", (e) => gunzip.destroy(e));
  src.pipe(gunzip);
  async function* chunks(): AsyncGenerator<Uint8Array> {
    for await (const c of gunzip) {
      rawHash.update(c as Buffer);
      rawBytes += (c as Buffer).length;
      yield c as Buffer;
    }
  }
  try {
    await splitCsv(chunks(), {
      maxPartBytes: Number.MAX_SAFE_INTEGER,
      openPart: () => ({ write() {}, close: async () => null }),
      onHeader: (h) => {
        header = parseCsvRow(h) as string[];
      },
      onRow: (r) => {
        rows += 1;
        onRow(parseCsvRow(r), header);
      },
    });
  } finally {
    src.destroy();
    gunzip.destroy();
  }
  return { header, rows, bytes_gz: gzBytes, bytes_raw: rawBytes, sha256_gz: gzHash.digest("hex"), sha256_raw: rawHash.digest("hex") };
}

/** The header row of a gzipped CSV file, reading only as far as it. */
export async function readHeader(abs: string): Promise<string[]> {
  const src = createReadStream(abs, { highWaterMark: 64 * 1024 });
  const gunzip = createGunzip();
  src.on("error", (e) => gunzip.destroy(e));
  src.pipe(gunzip);
  let buf = Buffer.alloc(0);
  let inQ = false;
  try {
    for await (const c of gunzip) {
      const start = buf.length;
      buf = Buffer.concat([buf, c as Buffer]);
      for (let i = start; i < buf.length; i++) {
        if (buf[i] === 0x22) inQ = !inQ;
        else if (buf[i] === 0x0a && !inQ) return parseCsvRow(buf.subarray(0, i + 1)) as string[];
      }
    }
  } finally {
    src.destroy();
    gunzip.destroy();
  }
  return parseCsvRow(buf) as string[];
}

// ── revised tables: replaying revision files ────────────────────────────────────────────────

export interface State {
  /** Column names of the table's own columns (without the _backup/_op markers). */
  names: string[];
  rows: Map<string, (string | null)[]>;
}

export const KEY_SEP = "\u0001";

export function keyOf(names: string[], fields: (string | null)[], key: string[]): string {
  return key.map((k) => {
    const i = names.indexOf(k);
    if (i < 0) throw new Error(`key column ${k} is not among the columns (${names.join(",")})`);
    return fields[i] ?? "";
  }).join(KEY_SEP);
}

/** The state of a revised table as of `upTo` (a backup id, inclusive), by replaying revision files in order. */
export async function loadState(l: Layout, table: { name: string; key: string[] }, upTo: string | null = null): Promise<State> {
  const state: State = { names: [], rows: new Map() };
  for (const rec of loadRecords(l)) {
    if (upTo !== null && rec.backup > upTo) break;
    const r = rec.revisions[table.name];
    if (!r?.file) continue;
    await scanCsvGz(resolvePath(l, r.file.path), (f, header) => {
      if (header[0] !== "_backup" || header[1] !== "_op") throw new Error(`${r.file!.path}: header must start with _backup,_op`);
      const names = header.slice(2);
      if (state.names.length === 0) state.names = names;
      else if (state.names.join(",") !== names.join(",")) throw new Error(`${r.file!.path}: columns changed (${state.names.join(",")} became ${names.join(",")}); a schema change needs a decision, see the README`);
      const fields = f.slice(2);
      const k = keyOf(names, fields, table.key);
      if (f[1] === "delete") state.rows.delete(k);
      else state.rows.set(k, fields);
    });
  }
  return state;
}

/** SHA-256 of a whole table state: the rows as canonical CSV lines, in key order. */
export function stateHash(rows: Map<string, (string | null)[]>): string {
  const h = createHash("sha256");
  for (const k of [...rows.keys()].sort()) h.update(encodeCsvRow(rows.get(k)!));
  return h.digest("hex");
}

/** What the records say a table is: append-only, or revised with these key columns. */
export function tableInfo(records: BackupRecord[], table: string): { kind: "append-only" } | { kind: "revised"; key: string[] } {
  for (const r of records) {
    if (r.append_only[table]) return { kind: "append-only" };
    if (r.revisions[table]) return { kind: "revised", key: r.revisions[table]!.key };
  }
  const known = new Set<string>();
  for (const r of records) for (const t of [...Object.keys(r.append_only), ...Object.keys(r.revisions)]) known.add(t);
  throw new Error(`no table ${table} in the repo. Tables: ${[...known].sort().join(", ") || "(none; the repo has no backups yet)"}`);
}
