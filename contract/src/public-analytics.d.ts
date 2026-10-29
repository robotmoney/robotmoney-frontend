export const PUBLIC_ANALYTICS_SCHEMA_VERSION: 1;
export const PUBLIC_ANALYTICS_DEFAULT_LIMIT: 100;
export const PUBLIC_ANALYTICS_MAX_LIMIT: 1000;
export const PUBLIC_ANALYTICS_GZIP_MIN_BYTES: number;
export const PUBLIC_ANALYTICS_CACHE_CONTROL: string;
export const PUBLIC_ANALYTICS_IMMUTABLE_CACHE_CONTROL: string;
export const PUBLIC_ANALYTICS_MAX_CONCURRENT_QUERIES: 2;
export const PUBLIC_ANALYTICS_QUERY_TIMEOUT_MS: 5000;
export const PUBLIC_ANALYTICS_TOKENS_PER_MINUTE: 100;
export const PUBLIC_ANALYTICS_LIST_COST: 1;
export const PUBLIC_ANALYTICS_HEAVY_COST: 10;
export const PUBLIC_ANALYTICS_BYTES_PER_MINUTE: number;
export const ARCHIVE_FORMAT: 1;
export const ARCHIVE_PART_BYTES: number;
export const ARCHIVE_SETTLE_MS: number;
export const PUBLIC_ANALYTICS_SCHEMAS: Record<string, string>;
export const ARCHIVE_BACKUP_RECORD_SCHEMA: string;

/** Fields every list response carries. `nextCursor` is null on the last page. */
export interface PublicAnalyticsPage {
  schemaVersion: 1;
  limit: number;
  nextCursor: string | null;
}

export interface PublicRawHistoryRow {
  date: string;
  indicator: string;
  value: number;
  source: string;
}
export interface PublicRawHistoryResponse extends PublicAnalyticsPage {
  rows: PublicRawHistoryRow[];
}

export interface PublicAssetPriceRow {
  price_date: string;
  symbol: string;
  time_basis: "utc-daily-close";
  price_usd: number;
  currency: "USD";
  source: string;
  pool_key: string | null;
  token_address: string | null;
  observed_at: string;
  fetched_at: string;
  config_identity: string;
}
export interface PublicAssetPricesResponse extends PublicAnalyticsPage {
  rows: PublicAssetPriceRow[];
}

export interface PublicVintageMember {
  source_key: string;
  source_value_version_id: number;
}
export interface PublicVintage {
  /** The vintage id: what ?vintage= on the reports route names. */
  id: number;
  run_key: string;
  tool_id: string;
  asof: string;
  source_label: "live" | "hermetic" | "fixture";
  knowledge_time_cutoff: string;
  market_time_cutoff: string;
  manifest_digest: string;
  member_count: number;
  build_identity: string;
  methodology: { tool_id: string; version_label: string; config_digest: string };
  created_at: string;
  /** The report the run published, or null when it published none. Its bytes: reports?vintage=<id>. */
  report: { report_id: number; checksum: string; byte_length: number } | null;
  /** Present only with ?include=members (and then run_key and tool_id). */
  members?: { rows: PublicVintageMember[]; nextCursor: string | null };
}
export interface PublicVintagesResponse extends PublicAnalyticsPage {
  vintages: PublicVintage[];
}

export interface PublicOverwriteEvent {
  id: number;
  table_name: "raw_indicator_history" | "regime_snapshots" | "research_signals" | "asset_prices";
  operation: "update" | "delete";
  natural_key: Record<string, unknown>;
  previous_row: Record<string, unknown>;
  replacement_row: Record<string, unknown> | null;
  recorded_at: string;
}
export interface PublicOverwriteEventsResponse extends PublicAnalyticsPage {
  events: PublicOverwriteEvent[];
}

/** One collected version of source data (`source_value_versions`). */
export interface PublicSourceVersion {
  id: number;
  /** The storage key the version was collected under, e.g. `raw_indicator_history:VIX`. */
  series: string;
  market_date: string | null;
  market_instant: string | null;
  value: number;
  revision_kind: "legacy_baseline" | "initial" | "unchanged" | "revision";
  prior_version_id: number | null;
  /** When the value was observed (collected). */
  knowledge_time: string;
}
export interface PublicSourceVersionsResponse extends PublicAnalyticsPage {
  /** The `asof` the versions are in force at, or null for every version. */
  asof: string | null;
  rows: PublicSourceVersion[];
}

/** A published report's identity. Its bytes are served by ?run= or ?vintage=. */
export interface PublicReportEntry {
  report_id: number;
  run_key: string;
  asof: string;
  checksum: string;
  byte_length: number;
  created_at: string;
}
export interface PublicReportsResponse extends PublicAnalyticsPage {
  reports: PublicReportEntry[];
}

export interface PublicArchiveBackupEntry {
  backup: string;
  /** Path of the backup's record under ROUTES.publicAnalytics.archiveFiles. */
  record: string;
}
export interface PublicArchiveBackupsResponse extends PublicAnalyticsPage {
  format: 1;
  backups: PublicArchiveBackupEntry[];
}

export interface ArchiveFileRecord {
  path: string;
  rows: number;
  bytes_raw: number;
  sha256_raw: string;
  id_min: string;
  id_max: string;
  sum_id: string;
  time_min: string;
  time_max: string;
}
export interface ArchiveAppendOnlyRecord {
  time: { column: string } | { lookup: { column: string; table: string; key: string; timeColumn: string } };
  watermark_before: string | null;
  watermark_after: string | null;
  rows_added: number;
  files: ArchiveFileRecord[];
  db_rows_through_watermark: string;
  db_sum_id_through_watermark: string;
}
/** A format 1 `backup.json` as the API serves it. */
export interface ArchiveBackupRecord {
  format: 1;
  backup: string;
  source: "api";
  consistency: "paged";
  snapshot: { exported_at_db: string; replica_replay_ts: null; db_user: "api"; was_replica: false };
  tool: { name: string; commit: null };
  append_only: Record<string, ArchiveAppendOnlyRecord>;
  revisions: Record<string, never>;
}
