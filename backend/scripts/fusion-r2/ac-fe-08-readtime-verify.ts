/**
 * AC-FE-08 (round 2, R2): drive the FRONTEND'S OWN read-time verifier over a
 * saved copy of the public receipt, untampered and tampered.
 *
 * The public route backend/src/api/routes/swarm/receipts.ts:27 calls
 * getConsensusReceipt(), which at backend/src/swarm/consensus-receipt.ts:984
 * returns { ...stored, ...(await verifyAssembledReceipt(stored.receipt,
 * stored.canonicalBytes)) }. verifyAssembledReceipt (consensus-receipt.ts:939)
 * is therefore the exact function that produces `verified`, `signatures` and
 * `unverifiedReasons` on the wire. This script imports THAT function from THAT
 * module — no reimplementation.
 */
import { verifyAssembledReceipt, getConsensusReceipt } from "../../src/swarm/consensus-receipt.ts";

const path = process.argv[2];
if (!path) throw new Error("usage: bun ac-fe-08-readtime-verify.ts <saved-receipt.json>");
const served = JSON.parse(await Bun.file(path).text()) as {
  receipt: Record<string, unknown>;
  canonicalBytes: string;
  verified: boolean;
  unverifiedReasons: string[];
};

// Proof the imported symbol is the one the route's helper calls.
console.log("route helper getConsensusReceipt:", typeof getConsensusReceipt);
console.log("verifier under test verifyAssembledReceipt:", typeof verifyAssembledReceipt);
console.log("verifier source:", verifyAssembledReceipt.toString().slice(0, 120).replace(/\s+/g, " "));

function clone<T>(v: T): T { return JSON.parse(JSON.stringify(v)); }

function flipOneByte(sig: string): string {
  // Flip exactly one character of the signature string.
  const i = Math.floor(sig.length / 2);
  const c = sig[i]!;
  const alt = c === "A" ? "B" : c === "a" ? "b" : c === "0" ? "1" : "A";
  return sig.slice(0, i) + alt + sig.slice(i + 1);
}

const entries = served.receipt.analyst_signatures as { member_id: string; signature: string }[];
console.log("\nmembers in receipt order:", entries.map((e) => e.member_id).join(", "));

async function run(label: string, receipt: Record<string, unknown>) {
  const v = await verifyAssembledReceipt(receipt, served.canonicalBytes);
  console.log(`\n=== ${label} ===`);
  console.log("verified:", v.verified);
  console.log("signatures:", JSON.stringify(v.signatures));
  console.log("unverifiedReasons:", JSON.stringify(v.unverifiedReasons, null, 2));
  return v;
}

console.log("\nserved-by-stage verified:", served.verified, "reasons:", JSON.stringify(served.unverifiedReasons));

await run("CONTROL (untampered, local re-verify)", clone(served.receipt));

for (const idx of [0, 1]) {
  const t = clone(served.receipt);
  const te = (t.analyst_signatures as { member_id: string; signature: string }[])[idx]!;
  const before = te.signature;
  te.signature = flipOneByte(before);
  console.log(`\n--- tamper #${idx}: member ${te.member_id}, one byte of its signature flipped ---`);
  console.log("    sig before[mid]:", before[Math.floor(before.length / 2)], "after[mid]:", te.signature[Math.floor(te.signature.length / 2)]);
  await run(`TAMPERED signature of member ${te.member_id}`, t);
}
