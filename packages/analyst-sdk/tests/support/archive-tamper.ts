// A format 1 copy held in memory, for tamper controls (issue 1765). The reader
// verifies every file it reads against its backup record (sha256 of the
// uncompressed bytes, row count, bytes_raw), so a tampered table is rebuilt the
// way a writer would write it: each row re-encoded with encodeCsvRow, gzipped,
// and its file entry in backup.json given the new sha256_raw, bytes_raw and rows.
// An edit that changes nothing reproduces the recorded sha256, so the encoding
// itself changes no byte (asserted by the tests that use this).
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { encodeCsvRow, parseCopyCsv, toObjects, type Row } from "../../src/archive/format1.ts";
import { openArchive, type Archive } from "../../src/archive/reader.ts";
import { canonicalStringify } from "../../src/report/canonical.ts";

export const sha256 = (b: string | Uint8Array): string => createHash("sha256").update(b).digest("hex");

interface FileEntry {
  path: string;
  rows: number;
  bytes_raw: number;
  sha256_raw: string;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

export class ArchiveCopy {
  readonly files = new Map<string, Uint8Array>();

  /** Every file of the folder at `root`, by its path relative to it with "/" separators. */
  constructor(root: string | ArchiveCopy) {
    if (root instanceof ArchiveCopy) for (const [p, b] of root.files) this.files.set(p, b);
    else for (const p of walk(root)) this.files.set(relative(root, p).split(sep).join("/"), new Uint8Array(readFileSync(p)));
  }

  /** An independent copy: an edit to it leaves this one unchanged (edits replace files, never change their bytes in place). */
  clone(): ArchiveCopy {
    return new ArchiveCopy(this);
  }

  /** The copy opened by the SDK's reader core. */
  open(): Archive {
    const files = this.files;
    return openArchive({
      root: "memory",
      backupDirs: () => [...new Set([...files.keys()].filter((p) => p.startsWith("csv/")).map((p) => p.split("/")[1]!))],
      read: (path) => files.get(path) ?? null,
    });
  }

  /** The backup ids, oldest first. */
  backups(): string[] {
    return [...new Set([...this.files.keys()].filter((p) => p.startsWith("csv/") && p.endsWith("/backup.json")).map((p) => p.split("/")[1]!))].sort();
  }

  record(backup: string): any {
    return JSON.parse(new TextDecoder().decode(this.files.get(`csv/${backup}/backup.json`)!));
  }

  setRecord(backup: string, record: unknown): void {
    this.files.set(`csv/${backup}/backup.json`, new TextEncoder().encode(JSON.stringify(record, null, 2) + "\n"));
  }

  /**
   * Rewrite every data file of an append-only table: `edit` gets each row and
   * returns it (changed or not). The file is re-encoded, gzipped and its record
   * entry updated. Returns how many rows `edit` changed.
   */
  editTable(table: string, edit: (row: Row) => Row): number {
    let changed = 0;
    for (const backup of this.backups()) {
      const record = this.record(backup);
      const entry = record.append_only?.[table] as { files: FileEntry[] } | undefined;
      if (!entry) continue;
      for (const f of entry.files) {
        const text = new TextDecoder().decode(gunzipSync(this.files.get(f.path)!));
        const csv = parseCopyCsv(text);
        const lines = [encodeCsvRow(csv.header)];
        for (const row of toObjects(csv)) {
          const before = JSON.stringify(row);
          const after = edit({ ...row });
          if (JSON.stringify(after) !== before) changed++;
          lines.push(encodeCsvRow(csv.header.map((c) => after[c] ?? null)));
        }
        const raw = new TextEncoder().encode(lines.join(""));
        this.files.set(f.path, new Uint8Array(gzipSync(raw)));
        Object.assign(f, { rows: lines.length - 1, bytes_raw: raw.length, sha256_raw: sha256(raw) });
      }
      this.setRecord(backup, record);
    }
    return changed;
  }

  /** Drop an append-only table from every backup record and the copy. */
  dropTable(table: string): void {
    for (const backup of this.backups()) {
      const record = this.record(backup);
      const entry = record.append_only?.[table] as { files: FileEntry[] } | undefined;
      if (!entry) continue;
      for (const f of entry.files) this.files.delete(f.path);
      delete record.append_only[table];
      this.setRecord(backup, record);
    }
  }

  /** Write the copy to `dir`. */
  writeTo(dir: string): void {
    for (const [p, bytes] of this.files) {
      const abs = join(dir, ...p.split("/"));
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, bytes);
    }
  }
}

/**
 * An output artifact whose payload rows `mutate` changes, re-canonicalised,
 * with its payload_sha256 (and checksum, byte_length) recomputed unless
 * `keepHash` is set. `mutate` gets the parsed rows.
 */
export function rewritePayload(row: Row, mutate: (rows: Record<string, any>[]) => void, keepHash = false): Row {
  const rows = JSON.parse(row.payload_json!) as Record<string, any>[];
  mutate(rows);
  const text = canonicalStringify(rows);
  if (keepHash) return { ...row, payload_json: text };
  const digest = sha256(text);
  return { ...row, payload_json: text, payload_sha256: digest, checksum: digest, byte_length: String(new TextEncoder().encode(text).length) };
}

/** Change one published row of a run's artifact (by artifact id), recomputing its hash. Returns the copy for chaining. */
export function tamperArtifact(copy: ArchiveCopy, artifactId: string, mutate: (rows: Record<string, any>[]) => void, keepHash = false): ArchiveCopy {
  const n = copy.editTable("analytics_output_snapshots", (o) => (o.id === artifactId ? rewritePayload(o, mutate, keepHash) : o));
  if (n !== 1) throw new Error(`artifact ${artifactId}: ${n} rows changed, expected 1`);
  return copy;
}
