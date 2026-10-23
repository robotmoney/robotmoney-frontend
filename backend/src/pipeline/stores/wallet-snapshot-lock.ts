// The wallet snapshot date lock, taken by the api inside every transaction that
// writes a wallet snapshot date (issue 1034, decision D75): the live samplers'
// writes (pipeline/stores/wallet.ts) and the repair pass's day write
// (pipeline/stores/wallet-backfill.ts).
import { onStatement, registerStatement, type RegistryDb } from "../../db/registry.ts";

/**
 * One lock protocol for every writer that can touch a wallet snapshot date.
 *
 * Row locks cannot protect a natural key that does not exist yet. Without this
 * advisory lock, a live INSERT could commit after repair copied the old rows
 * but before its DELETE, and that newly committed row would be deleted without
 * ever reaching evidence. Both live samplers and historical repair acquire
 * this transaction-scoped lock before writing a date.
 */
export async function lockWalletSnapshotDate(db: RegistryDb, sampleDate: string): Promise<void> {
  await onStatement(db, snapshotDateLock)`SELECT pg_advisory_xact_lock(hashtext('wallet-aum-snapshot'), hashtext(${sampleDate}))`;
}

// Object-less (D55 (13)): an advisory lock names no relation.
const snapshotDateLock = registerStatement({
  role: "rm_app",
  shape: "walletSnapshotLock",
  site: "src/pipeline/stores/wallet-snapshot-lock:lockWalletSnapshotDate",
  purpose: "Serialize every live sampler and historical repair writing one wallet snapshot date.",
  callers: ["src/api/routes/pipeline"],
});

