// The generic gap detector (issue #614 AC3 — "the core of this issue"). One
// function, driven entirely by series-registry.ts, replaces what the
// Motivation section found: "No generate_series, no LAG(date) OVER (…), no
// expected-vs-actual comparison anywhere in .ts or .sql." and "Latest-point
// age alone... is not sufficient" (report/regime-projection.ts,
// admin/overview.ts's pre-#614 MONITORED_KINDS check) — this reports interior
// gaps and a stale head SEPARATELY, per series.
//
// DESIGN NOTE — why the expected/observed diff happens in JS, not SQL
// generate_series: every daily-cadence column in the registry is a plain
// Postgres `date` (no timezone), and the hourly columns are timestamptz
// values the writer ALREADY truncated to a UTC hour boundary
// (worker/handlers/vault.ts: `sampleHour.setUTCMinutes(0,0,0)`). Comparing
// those against a SQL-side `generate_series` boundary computed from a literal
// depends on the Postgres session's `TimeZone` setting for date/timestamptz
// casts — correct only as long as that setting is UTC. Building both the
// expected-slot list and the "which slot is this row in" answer from JS
// `Date`'s explicit UTC methods removes that dependency entirely: the only
// SQL responsibility left is "return the distinct persisted slots", which is
// tz-agnostic once cast to timestamptz and compared as epoch millis.
import { sql as defaultSql, type DbHandle } from "../db/client.ts";
import { QUARANTINED_PROVENANCE } from "../chain/wallet-valuation.ts";
import { on, registerQuery } from "../db/registry.ts";
import { SERIES_REGISTRY, type Cadence, type RemediationClass, type SeriesDef } from "./series-registry.ts";

const read_wallet_balance_samples_app = registerQuery({
  role: "rm_app",
  object: "wallet_balance_samples",
  privileges: ["SELECT"],
  site: "src/ops/gap-detector:detectGaps.wallet_balance_samples.app",
  purpose: "Read the distinct persisted slots of the wallet_balance_samples series for the gap report.",
  callers: ["src/api/routes/admin", "src/api/routes/analytics"],
  probe: {
    statement: `SELECT DISTINCT sample_date::timestamptz AS slot, symbol
      FROM wallet_balance_samples
     WHERE sample_date::timestamptz >= $1
       AND provenance <> $2
       AND superseded_at IS NULL
     ORDER BY slot`,
    params: ["2000-01-01T00:00:00Z", QUARANTINED_PROVENANCE],
  },
});

const read_wallet_balance_samples_worker = registerQuery({
  role: "rm_worker",
  object: "wallet_balance_samples",
  privileges: ["SELECT"],
  site: "src/ops/gap-detector:detectGaps.wallet_balance_samples.worker",
  purpose: "Read the distinct persisted slots of the wallet_balance_samples series for the gap report.",
  callers: ["src/worker/handlers/repair"],
  probe: {
    statement: `SELECT DISTINCT sample_date::timestamptz AS slot, symbol
      FROM wallet_balance_samples
     WHERE sample_date::timestamptz >= $1
       AND provenance <> $2
       AND superseded_at IS NULL
     ORDER BY slot`,
    params: ["2000-01-01T00:00:00Z", QUARANTINED_PROVENANCE],
  },
});

const read_wallet_sleeve_samples_app = registerQuery({
  role: "rm_app",
  object: "wallet_sleeve_samples",
  privileges: ["SELECT"],
  site: "src/ops/gap-detector:detectGaps.wallet_sleeve_samples.app",
  purpose: "Read the distinct persisted slots of the wallet_sleeve_samples series for the gap report.",
  callers: ["src/api/routes/admin", "src/api/routes/analytics"],
  probe: {
    statement: `SELECT DISTINCT sample_date::timestamptz AS slot, wallet_address, symbol
      FROM wallet_sleeve_samples
     WHERE sample_date::timestamptz >= $1
       AND provenance <> $2
       AND superseded_at IS NULL
     ORDER BY slot`,
    params: ["2000-01-01T00:00:00Z", QUARANTINED_PROVENANCE],
  },
});

const read_wallet_sleeve_samples_worker = registerQuery({
  role: "rm_worker",
  object: "wallet_sleeve_samples",
  privileges: ["SELECT"],
  site: "src/ops/gap-detector:detectGaps.wallet_sleeve_samples.worker",
  purpose: "Read the distinct persisted slots of the wallet_sleeve_samples series for the gap report.",
  callers: ["src/worker/handlers/repair"],
  probe: {
    statement: `SELECT DISTINCT sample_date::timestamptz AS slot, wallet_address, symbol
      FROM wallet_sleeve_samples
     WHERE sample_date::timestamptz >= $1
       AND provenance <> $2
       AND superseded_at IS NULL
     ORDER BY slot`,
    params: ["2000-01-01T00:00:00Z", QUARANTINED_PROVENANCE],
  },
});

const read_vault_share_price_history_app = registerQuery({
  role: "rm_app",
  object: "vault_share_price_history",
  privileges: ["SELECT"],
  site: "src/ops/gap-detector:detectGaps.vault_share_price_history.app",
  purpose: "Read the distinct persisted slots of the vault_share_price_history series for the gap report.",
  callers: ["src/api/routes/admin", "src/api/routes/analytics"],
  probe: {
    statement: `SELECT DISTINCT sample_hour::timestamptz AS slot
      FROM vault_share_price_history
     WHERE sample_hour::timestamptz >= $1
     ORDER BY slot`,
    params: ["2000-01-01T00:00:00Z"],
  },
});

const read_vault_share_price_history_worker = registerQuery({
  role: "rm_worker",
  object: "vault_share_price_history",
  privileges: ["SELECT"],
  site: "src/ops/gap-detector:detectGaps.vault_share_price_history.worker",
  purpose: "Read the distinct persisted slots of the vault_share_price_history series for the gap report.",
  callers: ["src/worker/handlers/repair"],
  probe: {
    statement: `SELECT DISTINCT sample_hour::timestamptz AS slot
      FROM vault_share_price_history
     WHERE sample_hour::timestamptz >= $1
     ORDER BY slot`,
    params: ["2000-01-01T00:00:00Z"],
  },
});

const read_vault_adapter_samples_app = registerQuery({
  role: "rm_app",
  object: "vault_adapter_samples",
  privileges: ["SELECT"],
  site: "src/ops/gap-detector:detectGaps.vault_adapter_samples.app",
  purpose: "Read the distinct persisted slots of the vault_adapter_samples series for the gap report.",
  callers: ["src/api/routes/admin", "src/api/routes/analytics"],
  probe: {
    statement: `SELECT DISTINCT sample_hour::timestamptz AS slot
      FROM vault_adapter_samples
     WHERE sample_hour::timestamptz >= $1
     ORDER BY slot`,
    params: ["2000-01-01T00:00:00Z"],
  },
});

const read_vault_adapter_samples_worker = registerQuery({
  role: "rm_worker",
  object: "vault_adapter_samples",
  privileges: ["SELECT"],
  site: "src/ops/gap-detector:detectGaps.vault_adapter_samples.worker",
  purpose: "Read the distinct persisted slots of the vault_adapter_samples series for the gap report.",
  callers: ["src/worker/handlers/repair"],
  probe: {
    statement: `SELECT DISTINCT sample_hour::timestamptz AS slot
      FROM vault_adapter_samples
     WHERE sample_hour::timestamptz >= $1
     ORDER BY slot`,
    params: ["2000-01-01T00:00:00Z"],
  },
});

const read_daily_coin_snapshots_app = registerQuery({
  role: "rm_app",
  object: "daily_coin_snapshots",
  privileges: ["SELECT"],
  site: "src/ops/gap-detector:detectGaps.daily_coin_snapshots.app",
  purpose: "Read the distinct persisted slots of the daily_coin_snapshots series for the gap report.",
  callers: ["src/api/routes/admin", "src/api/routes/analytics"],
  probe: {
    statement: `SELECT DISTINCT snapshot_date::timestamptz AS slot
      FROM daily_coin_snapshots
     WHERE snapshot_date::timestamptz >= $1
     ORDER BY slot`,
    params: ["2000-01-01T00:00:00Z"],
  },
});

const read_daily_coin_snapshots_worker = registerQuery({
  role: "rm_worker",
  object: "daily_coin_snapshots",
  privileges: ["SELECT"],
  site: "src/ops/gap-detector:detectGaps.daily_coin_snapshots.worker",
  purpose: "Read the distinct persisted slots of the daily_coin_snapshots series for the gap report.",
  callers: ["src/worker/handlers/repair"],
  probe: {
    statement: `SELECT DISTINCT snapshot_date::timestamptz AS slot
      FROM daily_coin_snapshots
     WHERE snapshot_date::timestamptz >= $1
     ORDER BY slot`,
    params: ["2000-01-01T00:00:00Z"],
  },
});

const read_daily_agent_snapshots_app = registerQuery({
  role: "rm_app",
  object: "daily_agent_snapshots",
  privileges: ["SELECT"],
  site: "src/ops/gap-detector:detectGaps.daily_agent_snapshots.app",
  purpose: "Read the distinct persisted slots of the daily_agent_snapshots series for the gap report.",
  callers: ["src/api/routes/admin", "src/api/routes/analytics"],
  probe: {
    statement: `SELECT DISTINCT snapshot_date::timestamptz AS slot
      FROM daily_agent_snapshots
     WHERE snapshot_date::timestamptz >= $1
     ORDER BY slot`,
    params: ["2000-01-01T00:00:00Z"],
  },
});

const read_daily_agent_snapshots_worker = registerQuery({
  role: "rm_worker",
  object: "daily_agent_snapshots",
  privileges: ["SELECT"],
  site: "src/ops/gap-detector:detectGaps.daily_agent_snapshots.worker",
  purpose: "Read the distinct persisted slots of the daily_agent_snapshots series for the gap report.",
  callers: ["src/worker/handlers/repair"],
  probe: {
    statement: `SELECT DISTINCT snapshot_date::timestamptz AS slot
      FROM daily_agent_snapshots
     WHERE snapshot_date::timestamptz >= $1
     ORDER BY slot`,
    params: ["2000-01-01T00:00:00Z"],
  },
});

const read_daily_wallet_snapshots_app = registerQuery({
  role: "rm_app",
  object: "daily_wallet_snapshots",
  privileges: ["SELECT"],
  site: "src/ops/gap-detector:detectGaps.daily_wallet_snapshots.app",
  purpose: "Read the distinct persisted slots of the daily_wallet_snapshots series for the gap report.",
  callers: ["src/api/routes/admin", "src/api/routes/analytics"],
  probe: {
    statement: `SELECT DISTINCT snapshot_date::timestamptz AS slot
      FROM daily_wallet_snapshots
     WHERE snapshot_date::timestamptz >= $1
     ORDER BY slot`,
    params: ["2000-01-01T00:00:00Z"],
  },
});

const read_daily_wallet_snapshots_worker = registerQuery({
  role: "rm_worker",
  object: "daily_wallet_snapshots",
  privileges: ["SELECT"],
  site: "src/ops/gap-detector:detectGaps.daily_wallet_snapshots.worker",
  purpose: "Read the distinct persisted slots of the daily_wallet_snapshots series for the gap report.",
  callers: ["src/worker/handlers/repair"],
  probe: {
    statement: `SELECT DISTINCT snapshot_date::timestamptz AS slot
      FROM daily_wallet_snapshots
     WHERE snapshot_date::timestamptz >= $1
     ORDER BY slot`,
    params: ["2000-01-01T00:00:00Z"],
  },
});

const read_daily_tvl_snapshots_app = registerQuery({
  role: "rm_app",
  object: "daily_tvl_snapshots",
  privileges: ["SELECT"],
  site: "src/ops/gap-detector:detectGaps.daily_tvl_snapshots.app",
  purpose: "Read the distinct persisted slots of the daily_tvl_snapshots series for the gap report.",
  callers: ["src/api/routes/admin", "src/api/routes/analytics"],
  probe: {
    statement: `SELECT DISTINCT snapshot_date::timestamptz AS slot
      FROM daily_tvl_snapshots
     WHERE snapshot_date::timestamptz >= $1
     ORDER BY slot`,
    params: ["2000-01-01T00:00:00Z"],
  },
});

const read_daily_tvl_snapshots_worker = registerQuery({
  role: "rm_worker",
  object: "daily_tvl_snapshots",
  privileges: ["SELECT"],
  site: "src/ops/gap-detector:detectGaps.daily_tvl_snapshots.worker",
  purpose: "Read the distinct persisted slots of the daily_tvl_snapshots series for the gap report.",
  callers: ["src/worker/handlers/repair"],
  probe: {
    statement: `SELECT DISTINCT snapshot_date::timestamptz AS slot
      FROM daily_tvl_snapshots
     WHERE snapshot_date::timestamptz >= $1
     ORDER BY slot`,
    params: ["2000-01-01T00:00:00Z"],
  },
});

const read_research_signals_app = registerQuery({
  role: "rm_app",
  object: "research_signals",
  privileges: ["SELECT"],
  site: "src/ops/gap-detector:detectGaps.research_signals.app",
  purpose: "Read the distinct persisted slots of the research_signals series for the gap report.",
  callers: ["src/api/routes/admin", "src/api/routes/analytics"],
  probe: {
    statement: `SELECT DISTINCT date::timestamptz AS slot
      FROM research_signals
     WHERE date::timestamptz >= $1
     ORDER BY slot`,
    params: ["2000-01-01T00:00:00Z"],
  },
});

const read_research_signals_worker = registerQuery({
  role: "rm_worker",
  object: "research_signals",
  privileges: ["SELECT"],
  site: "src/ops/gap-detector:detectGaps.research_signals.worker",
  purpose: "Read the distinct persisted slots of the research_signals series for the gap report.",
  callers: ["src/worker/handlers/repair"],
  probe: {
    statement: `SELECT DISTINCT date::timestamptz AS slot
      FROM research_signals
     WHERE date::timestamptz >= $1
     ORDER BY slot`,
    params: ["2000-01-01T00:00:00Z"],
  },
});

const read_raw_indicator_history_app = registerQuery({
  role: "rm_app",
  object: "raw_indicator_history",
  privileges: ["SELECT"],
  site: "src/ops/gap-detector:detectGaps.raw_indicator_history.app",
  purpose: "Read the distinct persisted slots of the raw_indicator_history series for the gap report.",
  callers: ["src/api/routes/admin", "src/api/routes/analytics"],
  probe: {
    statement: `SELECT DISTINCT date::timestamptz AS slot
      FROM raw_indicator_history
     WHERE date::timestamptz >= $1
     ORDER BY slot`,
    params: ["2000-01-01T00:00:00Z"],
  },
});

const read_raw_indicator_history_worker = registerQuery({
  role: "rm_worker",
  object: "raw_indicator_history",
  privileges: ["SELECT"],
  site: "src/ops/gap-detector:detectGaps.raw_indicator_history.worker",
  purpose: "Read the distinct persisted slots of the raw_indicator_history series for the gap report.",
  callers: ["src/worker/handlers/repair"],
  probe: {
    statement: `SELECT DISTINCT date::timestamptz AS slot
      FROM raw_indicator_history
     WHERE date::timestamptz >= $1
     ORDER BY slot`,
    params: ["2000-01-01T00:00:00Z"],
  },
});

type SlotRow = Record<string, unknown> & { slot: Date };
type SlotReader = (db: DbHandle, since: Date) => Promise<SlotRow[]>;

// ONE STATEMENT PER SERIES, chosen by the series key. A series is a table, a
// date column and, for the two wallet series, the columns that name what a
// slot must hold, so each of them is a statement of its own with its own
// declaration (spec §7.1). The table and column are not values a registry
// declaration can take, which is why this is not one statement over
// `def.table`. The api reads them as rm_app and the repair handler as
// rm_worker, so each declares both.
const SLOT_READERS: Readonly<Record<string, SlotReader>> = {
  wallet_balance_samples: (db, since) => on(db, read_wallet_balance_samples_app, read_wallet_balance_samples_worker)<SlotRow>`
    SELECT DISTINCT sample_date::timestamptz AS slot, symbol
      FROM wallet_balance_samples
     WHERE sample_date::timestamptz >= ${since}
       AND provenance <> ${QUARANTINED_PROVENANCE}
       AND superseded_at IS NULL
     ORDER BY slot
  `,
  wallet_sleeve_samples: (db, since) => on(db, read_wallet_sleeve_samples_app, read_wallet_sleeve_samples_worker)<SlotRow>`
    SELECT DISTINCT sample_date::timestamptz AS slot, wallet_address, symbol
      FROM wallet_sleeve_samples
     WHERE sample_date::timestamptz >= ${since}
       AND provenance <> ${QUARANTINED_PROVENANCE}
       AND superseded_at IS NULL
     ORDER BY slot
  `,
  vault_share_price_history: (db, since) => on(db, read_vault_share_price_history_app, read_vault_share_price_history_worker)<SlotRow>`
    SELECT DISTINCT sample_hour::timestamptz AS slot
      FROM vault_share_price_history
     WHERE sample_hour::timestamptz >= ${since}
     ORDER BY slot
  `,
  vault_adapter_samples: (db, since) => on(db, read_vault_adapter_samples_app, read_vault_adapter_samples_worker)<SlotRow>`
    SELECT DISTINCT sample_hour::timestamptz AS slot
      FROM vault_adapter_samples
     WHERE sample_hour::timestamptz >= ${since}
     ORDER BY slot
  `,
  daily_coin_snapshots: (db, since) => on(db, read_daily_coin_snapshots_app, read_daily_coin_snapshots_worker)<SlotRow>`
    SELECT DISTINCT snapshot_date::timestamptz AS slot
      FROM daily_coin_snapshots
     WHERE snapshot_date::timestamptz >= ${since}
     ORDER BY slot
  `,
  daily_agent_snapshots: (db, since) => on(db, read_daily_agent_snapshots_app, read_daily_agent_snapshots_worker)<SlotRow>`
    SELECT DISTINCT snapshot_date::timestamptz AS slot
      FROM daily_agent_snapshots
     WHERE snapshot_date::timestamptz >= ${since}
     ORDER BY slot
  `,
  daily_wallet_snapshots: (db, since) => on(db, read_daily_wallet_snapshots_app, read_daily_wallet_snapshots_worker)<SlotRow>`
    SELECT DISTINCT snapshot_date::timestamptz AS slot
      FROM daily_wallet_snapshots
     WHERE snapshot_date::timestamptz >= ${since}
     ORDER BY slot
  `,
  daily_tvl_snapshots: (db, since) => on(db, read_daily_tvl_snapshots_app, read_daily_tvl_snapshots_worker)<SlotRow>`
    SELECT DISTINCT snapshot_date::timestamptz AS slot
      FROM daily_tvl_snapshots
     WHERE snapshot_date::timestamptz >= ${since}
     ORDER BY slot
  `,
  research_signals: (db, since) => on(db, read_research_signals_app, read_research_signals_worker)<SlotRow>`
    SELECT DISTINCT date::timestamptz AS slot
      FROM research_signals
     WHERE date::timestamptz >= ${since}
     ORDER BY slot
  `,
  raw_indicator_history: (db, since) => on(db, read_raw_indicator_history_app, read_raw_indicator_history_worker)<SlotRow>`
    SELECT DISTINCT date::timestamptz AS slot
      FROM raw_indicator_history
     WHERE date::timestamptz >= ${since}
     ORDER BY slot
  `,
};

export interface GapReport {
  key: string;
  label: string;
  table: string;
  remediationClass: RemediationClass;
  cadence: Cadence;
  seriesStart: string; // ISO
  expectedHead: string; // ISO — the latest slot that should exist by `now`
  headDate: string | null; // ISO — the latest slot actually observed; null = zero rows
  interiorGaps: string[]; // ISO slots missing strictly at-or-before the observed head
  interiorGapCount: number; // interiorGaps.length, surfaced separately so a huge array is not the only signal
  staleHead: boolean; // the observed head is behind expectedHead by more than the slack budget
  clean: boolean; // no interior gaps and not stale
}

function truncateToSlot(d: Date, cadence: Cadence): Date {
  const t = new Date(d.getTime());
  if (cadence === "hourly") t.setUTCMinutes(0, 0, 0);
  else t.setUTCHours(0, 0, 0, 0);
  return t;
}

const STEP_MS: Record<Cadence, number> = { daily: 86_400_000, hourly: 3_600_000 };
// Slack before a fresh-but-behind head counts as "stale" — generous enough
// that an ordinary tick/worker-restart delay (or the sampler simply not
// having fired yet for the CURRENT slot) never flickers the alert; tight
// enough that a genuinely wedged producer is still caught quickly relative to
// its own cadence.
const STALE_TICKS = 2;

export async function detectGaps(def: SeriesDef, db: DbHandle = defaultSql, now: Date = new Date(), asOf?: string): Promise<GapReport> {
  const seriesStart = truncateToSlot(new Date(def.seriesStart), def.cadence);
  const expectedHead = truncateToSlot(now, def.cadence);
  const stepMs = STEP_MS[def.cadence];

  // A row the serving layer is not allowed to serve does not cover its slot
  // (SeriesDef.uncounted), and neither does a tombstoned one
  // (SeriesDef.tombstoneColumn, D55 (6)). Filtering here keeps quarantine and
  // supersession aligned between the operator report and repair planner.
  // `expectedKeys` additionally makes the P0 planner reject partial snapshots;
  // publishing completeness is P1 scope.
  const uncounted = def.uncounted;
  const expectedKeys = def.expectedKeys;
  const read = SLOT_READERS[def.key];
  if (!read) throw new Error(`gap-detector: series ${def.key} has no registered slot reader (add its statement and declaration)`);
  const rows = await read(db, seriesStart);
  const keyToken = (parts: readonly string[]): string => JSON.stringify(parts);
  const observedBySlot = new Map<number, Set<string>>();
  for (const row of rows) {
    const slot = new Date(row.slot).getTime();
    let keys = observedBySlot.get(slot);
    if (!keys) {
      keys = new Set();
      observedBySlot.set(slot, keys);
    }
    if (expectedKeys) keys.add(keyToken(expectedKeys.columns.map((column) => String(row[column]))));
  }

  // Per-slot filtering: when expectedKeys is present, each slot is checked
  // against only the assets deployed on or before that slot's date. This
  // prevents pre-deployment dates (e.g. March days before SP500's May
  // addition) from being flagged as incomplete — the root cause of the
  // infinite retry loop in #709.
  const observed = new Set<number>();
  for (const [slot, keys] of observedBySlot) {
    if (expectedKeys) {
      const slotDate = new Date(slot).toISOString().slice(0, 10);
      const expected = new Set(expectedKeys.resolve(slotDate).map((parts) => keyToken(parts)));
      if ([...expected].every((key) => keys.has(key))) observed.add(slot);
    } else {
      observed.add(slot);
    }
  }
  const headMs = observed.size > 0 ? Math.max(...observed) : null;

  const interiorGaps: string[] = [];
  for (let t = seriesStart.getTime(); t <= expectedHead.getTime(); t += stepMs) {
    // A slot AFTER the observed head is stale-head territory (the series
    // hasn't caught up to `now` yet), never counted as an interior gap — an
    // interior gap is specifically a HOLE the series jumped over.
    if (headMs != null && t > headMs) break;
    if (!observed.has(t)) interiorGaps.push(new Date(t).toISOString());
  }

  const staleHead = headMs == null
    ? expectedHead.getTime() >= seriesStart.getTime() // an expected series with zero rows at all
    : expectedHead.getTime() - headMs > stepMs * STALE_TICKS;

  return {
    key: def.key,
    label: def.label,
    table: def.table,
    remediationClass: def.remediationClass,
    cadence: def.cadence,
    seriesStart: seriesStart.toISOString(),
    expectedHead: expectedHead.toISOString(),
    headDate: headMs == null ? null : new Date(headMs).toISOString(),
    interiorGaps,
    interiorGapCount: interiorGaps.length,
    staleHead,
    clean: interiorGaps.length === 0 && !staleHead,
  };
}

/** Every registered series, detected in parallel — the operator-surface feed
 *  (GET /api/admin/gaps). */
export async function detectAllGaps(db: DbHandle = defaultSql, now: Date = new Date(), asOf?: string): Promise<GapReport[]> {
  return Promise.all(SERIES_REGISTRY.map((def) => detectGaps(def, db, now, asOf)));
}
