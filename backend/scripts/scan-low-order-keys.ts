// Issue #789 — scan swarm_member_keys for already-registered low-order Ed25519
// public keys.
//
// WHY THIS EXISTS. Until the fix in src/lib/signing.ts, POST /api/swarm/apply
// accepted any 32 bytes WebCrypto could decode, including the 14 low-order
// (torsion-subgroup) point encodings. For such a key the single PUBLIC 64-byte
// constant `0x01 || 0x00*63` satisfies the Ed25519 verification equation over
// EVERY message, so anyone can produce a "valid" signature as that member with
// nothing secret. The code fix stops new ones being registered; it cannot tell
// you whether one was already registered before the fix shipped. That is what
// this script is for, and the answer is a real finding either way:
//
//   - clean  → no member key is forgeable, and every historical take's
//              signature carries the weight it appears to.
//   - a hit  → every take ever filed by that member carries NO cryptographic
//              weight, whatever the stored `verified` flag says. The key must
//              be rotated (admin key rotation) and the affected takes reviewed;
//              record the finding on issue #789 before doing either.
//
// It reads only. It never writes, never deletes, and never rotates a key.
//
// The predicate is imported from src/lib/signing.ts — the same table the
// registration path now rejects with — so this scan and the gate can never
// disagree about what "low-order" means.
//
// Exit-code contract:
//   0 — scanned successfully, NO low-order key found
//   1 — scanned successfully, at least one low-order key FOUND (see stdout)
//   2 — the scan could not run (connection/query failure)
//
// USAGE (run against production, from a host with DATABASE_URL for it):
//
//   cd backend
//   DATABASE_URL='postgres://…' bun run scripts/scan-low-order-keys.ts
//
// Add --json for a machine-readable report on stdout.
//
// If you cannot run Bun against the database, the equivalent read-only SQL is
// printed by --sql; it inlines the same 14 encodings as base64 and can be
// pasted into psql:
//
//   bun run scripts/scan-low-order-keys.ts --sql
//
// db/client.ts is imported LAZILY: it builds a pool from DATABASE_URL at module
// load, and `--sql` (and the unit test for the encoding table) must work on a
// machine that has no database configured at all.
import { isLowOrderEd25519PublicKey } from "../src/lib/signing.ts";

export interface LowOrderKeyHit {
  keyId: number;
  memberId: string;
  memberHandle: string | null;
  memberName: string | null;
  memberStatus: string | null;
  publicKey: string;
  active: boolean;
  createdAt: string;
  takeCount: number; // takes filed by this member — all of them now suspect
}

export interface LowOrderKeyScanReport {
  scannedKeys: number;
  hits: LowOrderKeyHit[];
}

/** Decode a stored base64 public key to bytes, or null if it is not decodable. */
function decode(publicKey: string): Uint8Array | null {
  if (typeof publicKey !== "string" || publicKey.length === 0) return null;
  const bytes = Buffer.from(publicKey, "base64");
  // Re-encode check: rules out padded/whitespace/alternate-alphabet junk that
  // Buffer would otherwise decode leniently into a wrong 32 bytes.
  if (bytes.length !== 32 || bytes.toString("base64") !== publicKey) return null;
  return Uint8Array.from(bytes);
}

export async function runLowOrderKeyScan(): Promise<LowOrderKeyScanReport> {
  const { sql } = await import("../src/db/client.ts");
  // ALL rows — active and rotated. A rotated-out low-order key still signed
  // whatever it signed while it was active, so it is just as much a finding.
  const rows = await sql<{
    id: string | number;
    member_id: string;
    public_key: string;
    active: boolean;
    created_at: Date | string;
    handle: string | null;
    name: string | null;
    status: string | null;
    take_count: string | number;
  }[]>`
    SELECT k.id, k.member_id, k.public_key, k.active, k.created_at,
           m.handle, m.name, m.status,
           (SELECT count(*) FROM swarm_recommendations r WHERE r.member_id = k.member_id) AS take_count
    FROM swarm_member_keys k
    LEFT JOIN swarm_members m ON m.id = k.member_id
    ORDER BY k.created_at ASC, k.id ASC
  `;

  const hits: LowOrderKeyHit[] = [];
  for (const row of rows) {
    const bytes = decode(row.public_key);
    if (bytes === null || !isLowOrderEd25519PublicKey(bytes)) continue;
    hits.push({
      keyId: Number(row.id),
      memberId: row.member_id,
      memberHandle: row.handle,
      memberName: row.name,
      memberStatus: row.status,
      publicKey: row.public_key,
      active: row.active,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      takeCount: Number(row.take_count),
    });
  }
  return { scannedKeys: rows.length, hits };
}

/** The read-only SQL equivalent, for an operator who only has psql. */
export function scanSql(lowOrderKeysB64: readonly string[]): string {
  const list = lowOrderKeysB64.map((k) => `    '${k}'`).join(",\n");
  return `-- Issue #789: low-order Ed25519 keys registered in swarm_member_keys.
-- Read-only. Zero rows = clean.
SELECT k.id AS key_id, k.member_id, m.handle, m.name, m.status,
       k.public_key, k.active, k.created_at,
       (SELECT count(*) FROM swarm_recommendations r WHERE r.member_id = k.member_id) AS take_count
FROM swarm_member_keys k
LEFT JOIN swarm_members m ON m.id = k.member_id
WHERE k.public_key IN (
${list}
)
ORDER BY k.created_at;`;
}

// The 14 encodings, spelled out here ONLY so --sql can emit a standalone query.
// The scan itself uses isLowOrderEd25519PublicKey(); these must agree, and
// tests/scan-low-order-keys.test.ts asserts they do.
export const LOW_ORDER_KEYS_B64: readonly string[] = [
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0000000000000000000000000000000000000000000000000000000000000080",
  "0100000000000000000000000000000000000000000000000000000000000000",
  "0100000000000000000000000000000000000000000000000000000000000080",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
  "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
  "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
].map((hex) => Buffer.from(hex, "hex").toString("base64"));

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  if (argv.includes("--sql")) {
    console.log(scanSql(LOW_ORDER_KEYS_B64));
    return 0;
  }

  let report: LowOrderKeyScanReport;
  try {
    report = await runLowOrderKeyScan();
  } catch (err) {
    console.error(`[scan-low-order-keys] SCAN DID NOT RUN — ${(err as Error).message}`);
    console.error("[scan-low-order-keys] this is NOT a clean result; fix the connection and re-run");
    return 2;
  }

  if (argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.hits.length === 0) {
    console.log(
      `[scan-low-order-keys] CLEAN — ${report.scannedKeys} key row(s) scanned (active and rotated), ` +
        "none is a low-order Ed25519 point",
    );
  } else {
    console.log(
      `[scan-low-order-keys] FOUND ${report.hits.length} low-order key row(s) out of ${report.scannedKeys} scanned:`,
    );
    for (const hit of report.hits) {
      console.log(
        `  key ${hit.keyId}  member ${hit.memberId} (${hit.memberHandle ?? "no handle"}, status ${hit.memberStatus ?? "unknown"})  ` +
          `active=${hit.active}  registered ${hit.createdAt}  takes=${hit.takeCount}`,
      );
      console.log(`    publicKey ${hit.publicKey}`);
    }
    console.log(
      "[scan-low-order-keys] every take filed by these members is cryptographically unauthenticated — " +
        "record this on issue #789, rotate the key, and review the takes",
    );
  }
  return report.hits.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  const code = await main();
  if (!process.argv.slice(2).includes("--sql")) {
    const { closeDb } = await import("../src/db/client.ts");
    await closeDb();
  }
  process.exit(code);
}
