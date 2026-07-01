// One-shot importer: load the canonical rich regime snapshot fixture
// (backend/tests/fixtures/regime/regime-eq-snapshot.json.gz) and upsert it into
// regime_snapshots via the store. Populates the DB behind the reference
// screenshot so GET /api/dashboards/regime-snapshots serves the rich shape.
//
// Explicitly invoked only — NOT called from migrate.ts/seed.ts. Run directly:
//   bun run src/db/import-regime-eq.ts
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { closeDb } from "./client.ts";
import { saveRegimeSnapshots } from "../analytics/store/regime-store.ts";
import { eqSnapshotToRows, type EqSnapshot } from "../analytics/report/regime-eq-map.ts";

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "tests",
  "fixtures",
  "regime",
  "regime-eq-snapshot.json.gz",
);

// Read + gunzip + parse the vendored snapshot (pure fs; no DB).
export function loadEqSnapshot(): EqSnapshot {
  return JSON.parse(gunzipSync(readFileSync(FIXTURE)).toString("utf8")) as EqSnapshot;
}

export async function importRegimeEq(): Promise<void> {
  const snap = loadEqSnapshot();
  const rows = eqSnapshotToRows(snap);
  await saveRegimeSnapshots(rows);
  console.log(`imported regime-eq snapshot: ${rows.length} rows (asof ${snap.asof})`);
}

// Run directly: `bun run src/db/import-regime-eq.ts`
if (import.meta.url === `file://${process.argv[1]}`) {
  importRegimeEq()
    .then(closeDb)
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
      return closeDb();
    });
}
