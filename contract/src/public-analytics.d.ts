export const PUBLIC_ANALYTICS_SCHEMA_VERSION: 1;
export const PUBLIC_ANALYTICS_DEFAULT_LIMIT: 100;
export const PUBLIC_ANALYTICS_MAX_LIMIT: 1000;
export const PUBLIC_ANALYTICS_GZIP_MIN_BYTES: number;
export const PUBLIC_ANALYTICS_CACHE_CONTROL: string;
export const PUBLIC_ANALYTICS_SCHEMAS: Record<string, string>;

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
  /** Present only with ?include=members (and then run_key and tool_id). */
  members?: { rows: PublicVintageMember[]; nextCursor: string | null };
}
export interface PublicVintagesResponse extends PublicAnalyticsPage {
  vintages: PublicVintage[];
}

export interface PublicOverwriteEvent {
  id: number;
  table_name: "raw_indicator_history" | "regime_snapshots" | "research_signals";
  operation: "update" | "delete";
  natural_key: Record<string, unknown>;
  previous_row: Record<string, unknown>;
  replacement_row: Record<string, unknown> | null;
  recorded_at: string;
}
export interface PublicOverwriteEventsResponse extends PublicAnalyticsPage {
  events: PublicOverwriteEvent[];
}
