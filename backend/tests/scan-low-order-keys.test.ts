// Issue #789 — the swarm_member_keys low-order scan.
//
// The code fix stops a low-order key from being REGISTERED; it says nothing
// about keys registered before it shipped. This scan is what answers that, and
// it is only worth anything if it actually finds a planted row and does not
// cry wolf over honest ones. Both are asserted here against a real database.
import { test, expect } from "bun:test";
import { sql } from "../src/db/client.ts";
import { generateKeyPair } from "../src/lib/signing.ts";
import {
  LOW_ORDER_KEYS_B64,
  runLowOrderKeyScan,
  scanSql,
} from "../scripts/scan-low-order-keys.ts";
import { LOW_ORDER_ED25519_PUBLIC_KEYS_B64 } from "./support/low-order-ed25519.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";

useCleanDatabasePerTest(import.meta.file);

const rid = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;

test("the scan's --sql key list is exactly the 14 derived encodings", () => {
  expect([...LOW_ORDER_KEYS_B64].sort()).toEqual([...LOW_ORDER_ED25519_PUBLIC_KEYS_B64].sort());
  expect(LOW_ORDER_KEYS_B64).toHaveLength(14);
  const emitted = scanSql(LOW_ORDER_KEYS_B64);
  for (const key of LOW_ORDER_ED25519_PUBLIC_KEYS_B64) expect(emitted).toContain(`'${key}'`);
  // Read-only: the operator-facing query may never mutate anything.
  expect(/\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER)\b/i.test(emitted)).toBe(false);
});

test("the scan reports clean when every registered key is honest", async () => {
  for (let i = 0; i < 3; i++) {
    const memberId = rid("honest");
    const { publicKeyB64 } = await generateKeyPair();
    await sql`INSERT INTO swarm_members (id, name, status) VALUES (${memberId}, 'Honest Member', 'active')`;
    await sql`INSERT INTO swarm_member_keys (member_id, public_key, active) VALUES (${memberId}, ${publicKeyB64}, true)`;
  }
  const report = await runLowOrderKeyScan();
  expect(report.scannedKeys).toBeGreaterThanOrEqual(3);
  expect(report.hits).toEqual([]);
  // "Clean" has to mean every row was READ, not just that no hit surfaced.
  expect(report.unreadable).toEqual([]);
  expect(report.readKeys).toBe(report.scannedKeys);
});

// A row whose public_key is not canonical base64 for 32 bytes cannot be
// screened — the predicate needs bytes. It used to be dropped silently while
// still counting toward `scannedKeys`, so the operator read "CLEAN — N rows
// scanned" with no signal that some of those N were never looked at. That is
// the difference between "none is low-order" and "none that I could read is
// low-order", and only one of those answers issue #793.
test("an undecodable public_key is REPORTED as unreadable, not silently counted as screened", async () => {
  const honestMember = rid("honest");
  const { publicKeyB64 } = await generateKeyPair();
  await sql`INSERT INTO swarm_members (id, name, status) VALUES (${honestMember}, 'Honest Member', 'active')`;
  await sql`INSERT INTO swarm_member_keys (member_id, public_key, active) VALUES (${honestMember}, ${publicKeyB64}, true)`;

  // Three distinct ways a stored key fails to decode to 32 bytes: not base64
  // at all, the right alphabet but the wrong length, and empty.
  const junk = ["this is not base64 at all!!", Buffer.alloc(31, 7).toString("base64"), ""];
  const junkMembers: string[] = [];
  for (const publicKey of junk) {
    const memberId = rid("junk");
    await sql`INSERT INTO swarm_members (id, name, status) VALUES (${memberId}, 'Junk Key Member', 'active')`;
    await sql`INSERT INTO swarm_member_keys (member_id, public_key, active) VALUES (${memberId}, ${publicKey}, true)`;
    junkMembers.push(memberId);
  }

  const report = await runLowOrderKeyScan();
  // Not hits — an unreadable row is an unanswered question, not a finding.
  expect(report.hits).toEqual([]);
  expect(report.unreadable).toHaveLength(3);
  expect(report.unreadable.map((r) => r.memberId).sort()).toEqual([...junkMembers].sort());
  for (const row of report.unreadable) {
    expect(row.keyId).toBeGreaterThan(0);
    expect(typeof row.publicKeyLength).toBe("number");
  }
  // The counts tell the operator exactly how much of the table was screened.
  expect(report.scannedKeys).toBe(4);
  expect(report.readKeys).toBe(1);
});

test("the scan finds a planted low-order key, active or rotated out", async () => {
  const honestMember = rid("honest");
  const { publicKeyB64 } = await generateKeyPair();
  await sql`INSERT INTO swarm_members (id, name, status) VALUES (${honestMember}, 'Honest Member', 'active')`;
  await sql`INSERT INTO swarm_member_keys (member_id, public_key, active) VALUES (${honestMember}, ${publicKeyB64}, true)`;

  // One planted row per encoding, alternating active/rotated — a rotated-out
  // low-order key still signed whatever it signed while it was active.
  const planted: { memberId: string; publicKey: string; active: boolean }[] = [];
  for (const [i, publicKey] of LOW_ORDER_ED25519_PUBLIC_KEYS_B64.entries()) {
    const memberId = rid("loword");
    const active = i % 2 === 0;
    await sql`INSERT INTO swarm_members (id, name, status) VALUES (${memberId}, 'Low Order Member', 'active')`;
    await sql`INSERT INTO swarm_member_keys (member_id, public_key, active) VALUES (${memberId}, ${publicKey}, ${active})`;
    planted.push({ memberId, publicKey, active });
  }

  const report = await runLowOrderKeyScan();
  expect(report.hits).toHaveLength(14);
  expect(report.unreadable).toEqual([]);
  expect(report.readKeys).toBe(report.scannedKeys);
  for (const { memberId, publicKey, active } of planted) {
    const hit = report.hits.find((h) => h.memberId === memberId);
    expect(hit).toBeDefined();
    expect(hit?.publicKey).toBe(publicKey);
    expect(hit?.active).toBe(active);
    expect(hit?.takeCount).toBe(0);
  }
  // The honest key is not swept up.
  expect(report.hits.some((h) => h.publicKey === publicKeyB64)).toBe(false);
});
