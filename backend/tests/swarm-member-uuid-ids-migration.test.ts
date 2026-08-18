import { test, expect, beforeAll, afterAll } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import postgres from "postgres";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const MIGRATION = "0033_swarm_member_uuid_ids.sql";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const MEMBER_ID = "legacy-slug-id";
const SUBJECT = "uuid-migration-subject";

const SIGNED_PAYLOAD = {
  memberId: MEMBER_ID,
  date: "2026-05-26",
  subjectId: SUBJECT,
  nonce: "uuid-migration-nonce",
  stance: "constructive",
  confidence: 0.7,
  body: "signed before 0033 existed",
};
const SIGNATURE = "c2lnbmF0dXJlLW92ZXItdGhlLXBheWxvYWQtYWJvdmU=";

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on("error", rej);
    s.listen(0, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); });
  });
}

let containerName: string;
let db: postgres.Sql<{}>;
let payloadTextBefore: string;
let recommendationId: string;
let memoId: string;
let keyPub: string;

async function applyMigration(): Promise<void> {
  const ddl = await readFile(join(migrationsDir, MIGRATION), "utf8");
  await db.begin(async (tx) => { await tx.unsafe(ddl); });
}

beforeAll(async () => {
  const port = await freePort();
  containerName = `rmtest_uuid_migration_${crypto.randomUUID().slice(0, 8)}`;
  const up = Bun.spawnSync([
    "docker", "run", "-d", "--rm", "--name", containerName,
    "-e", "POSTGRES_PASSWORD=robotmoney", "-e", "POSTGRES_USER=robotmoney", "-e", "POSTGRES_DB=robotmoney",
    "-p", `${port}:5432`, "postgres:17-alpine",
  ]);
  if (up.exitCode !== 0) {
    throw new Error(
      `swarm-member-uuid-ids-migration test requires Docker+Postgres but the container failed to start:\n${up.stderr.toString()}`,
    );
  }
  db = postgres(`postgres://robotmoney:robotmoney@localhost:${port}/robotmoney`, { max: 4, onnotice: () => {} });

  const start = Date.now();
  for (;;) {
    try { await db`SELECT 1`; break; } catch (err) {
      if (Date.now() - start > 30_000) throw err;
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  // Everything up to but NOT including 0033
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  if (!files.includes(MIGRATION)) throw new Error(`${MIGRATION} not found in backend/migrations`);
  const pre = files.filter((f) => f < MIGRATION);
  expect(pre.length).toBeGreaterThan(0);
  
  for (const file of pre) {
    const ddl = await readFile(join(migrationsDir, file), "utf8");
    await db.begin(async (tx) => { await tx.unsafe(ddl); });
  }

  // Seed data
  await db`INSERT INTO swarm_subjects (id, status, name) VALUES (${SUBJECT}, 'active', 'UUID Migration Subject')`;
  await db`INSERT INTO swarm_members (id, handle, status, name) VALUES (${MEMBER_ID}, ${MEMBER_ID}, 'active', 'Legacy Member')`;
  
  // Seed Key
  keyPub = "pubkey-bytes";
  await db`INSERT INTO swarm_member_keys (member_id, public_key, active) VALUES (${MEMBER_ID}, ${keyPub}, true)`;

  // Seed Session
  const [session] = await db<{ id: string }[]>`
    INSERT INTO swarm_sessions (subject_id, convened_at, subject_name, state)
    VALUES (${SUBJECT}, '2026-05-26T09:00:00Z', 'UUID Migration Subject', 'published') RETURNING id`;
  
  // Seed Recommendation
  const [rec] = await db<{ id: string }[]>`
    INSERT INTO swarm_recommendations
      (session_id, member_id, subject_id, date, nonce, stance, confidence, body, payload, signature, verified)
    VALUES (${session!.id}, ${MEMBER_ID}, ${SUBJECT}, '2026-05-26', ${SIGNED_PAYLOAD.nonce},
            ${SIGNED_PAYLOAD.stance}, ${SIGNED_PAYLOAD.confidence}, ${SIGNED_PAYLOAD.body},
            ${db.json(SIGNED_PAYLOAD as any)}, ${SIGNATURE}, true)
    RETURNING id`;
  recommendationId = rec!.id;

  // Seed Memo
  const [memo] = await db<{ id: string }[]>`
    INSERT INTO swarm_memos (session_id, member_id, title, body)
    VALUES (${session!.id}, ${MEMBER_ID}, 'Memo Title', 'Memo Body') RETURNING id`;
  memoId = memo!.id;

  const [before] = await db<{ payload: string }[]>`
    SELECT payload::text AS payload FROM swarm_recommendations WHERE id = ${recommendationId}`;
  payloadTextBefore = before!.payload;
}, 120_000);

afterAll(async () => {
  try { await db?.end({ timeout: 5 }); } catch { /* closing a dead pool is not a failure */ }
  if (containerName) Bun.spawnSync(["docker", "rm", "-f", containerName]);
});

test("AC1: legacy member id is converted to a UUID", async () => {
  await applyMigration();

  const members = await db<{ id: string, handle: string }[]>`
    SELECT id, handle FROM swarm_members WHERE name = 'Legacy Member'`;
  
  expect(members.length).toBe(1);
  const m = members[0]!;
  expect(m.id).toMatch(UUID_RE);
  expect(m.id).not.toBe(MEMBER_ID);
  
  // AC3 logic implies handle was matching id, so handle should equal the new UUID id
  expect(m.handle).toBe(m.id);
});

test("AC6: take/memo/key counts are unchanged and signatures still verify against the original payload text", async () => {
  const members = await db<{ id: string }[]>`SELECT id FROM swarm_members WHERE name = 'Legacy Member'`;
  const newId = members[0]!.id;

  const keys = await db<{ member_id: string }[]>`SELECT member_id FROM swarm_member_keys WHERE public_key = ${keyPub}`;
  expect(keys.length).toBe(1);
  expect(keys[0]!.member_id).toBe(newId);

  const recs = await db<{ member_id: string; payload: string; signature: string }[]>`
    SELECT member_id, payload::text AS payload, signature
    FROM swarm_recommendations WHERE id = ${recommendationId}`;
  expect(recs.length).toBe(1);
  expect(recs[0]!.member_id).toBe(newId);
  expect(recs[0]!.signature).toBe(SIGNATURE);
  expect(recs[0]!.payload).toBe(payloadTextBefore);
  
  // The memberId inside the payload should STILL be the legacy ID
  expect(JSON.parse(recs[0]!.payload).memberId).toBe(MEMBER_ID);

  const memos = await db<{ member_id: string }[]>`SELECT member_id FROM swarm_memos WHERE id = ${memoId}`;
  expect(memos.length).toBe(1);
  expect(memos[0]!.member_id).toBe(newId);
});
