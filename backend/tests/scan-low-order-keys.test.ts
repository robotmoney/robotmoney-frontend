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
