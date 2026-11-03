// The shape of a backup record (`csv/<id>/backup.json`), the only place a backup's facts are written down.
// Names, paths and times are format 1's own (packages/analyst-sdk/src/archive/format1.ts), re-exported here.
export {
  BACKUP_ID_RE,
  backupDir,
  CSV_DIR,
  dataFileName,
  dataPath,
  DAY_CUT_ID_RE,
  parseDbTime,
  recordPath,
  revisionFile,
  stamp,
} from "@robotmoney/analyst-sdk/src/archive/format1.ts";

export interface FileRecord {
  /** Path relative to the repo root. */
  path: string;
  /** Data rows (header excluded). */
  rows: number;
  bytes_raw: number;
  bytes_gz: number;
  sha256_raw: string;
  sha256_gz: string;
  /** Append-only files only: the id range the file covers, and the sum of its ids (as strings; they are bigint). */
  id_min?: string;
  id_max?: string;
  sum_id?: string;
  /** Append-only files only: the earliest and latest row time in the file, as the database printed them (UTC). */
  time_min?: string;
  time_max?: string;
  /** True for a file of rows that committed late, with ids at or below the watermark of an earlier backup. */
  late?: boolean;
}

export interface AppendOnlyRecord {
  /** Where a row's time comes from (see config.ts). Recorded so the files can be checked without the tool's config. */
  time: import("./config.ts").TimeSpec;
  /** Highest id in the repo before this backup, or null for the first. */
  watermark_before: string | null;
  /** Highest id in the repo after this backup. */
  watermark_after: string | null;
  rows_added: number;
  files: FileRecord[];
  /** What the database held for ids <= watermark_after at the snapshot. Must equal the repo's cumulative totals. */
  db_rows_through_watermark: string;
  db_sum_id_through_watermark: string;
}

export interface RevisedRecord {
  /** The columns that identify a row (recorded here so the repo can be read without the tool's config). */
  key: string[];
  /** The revision file added by this backup, or null when nothing changed. */
  file: FileRecord | null;
  upserts: number;
  deletes: number;
  /** Rows in the table's state at this backup, and the SHA-256 of that state (see state.ts). */
  rows_in_state: number;
  state_sha256: string;
}

/**
 * Something a backup found that does not match what the repo expected. A backup records it and carries on; it never
 * stops for these (the repo's copy of a deleted row is still the backup), and the command exits non-zero so it is noticed.
 */
export type Anomaly =
  /** Rows the repo holds that the database no longer has. The repo keeps its copy. */
  | { kind: "deleted_rows"; table: string; count: number; sum_id: string; ids: string[] }
  /** Rows the database has with ids at or below the watermark that the repo did not hold (committed late). Now captured. */
  | { kind: "late_rows"; table: string; count: number; sum_id: string; id_min: string; id_max: string; files: string[] };

export interface BackupRecord {
  format: 1;
  /** Backup id: a UTC day boundary, `YYYY-MM-DDT000000Z`, or a legacy snapshot time (format1-legacy.ts). Sorts chronologically. */
  backup: string;
  snapshot: { exported_at_db: string; replica_replay_ts: string | null; db_user: string; was_replica: boolean };
  tool: { name: string; commit: string | null };
  append_only: Record<string, AppendOnlyRecord>;
  revisions: Record<string, RevisedRecord>;
  /** Absent in older records, which means none. */
  anomalies?: Anomaly[];
}
