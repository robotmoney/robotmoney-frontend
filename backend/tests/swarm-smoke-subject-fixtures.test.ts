// Issue #780: ensureSmokeSubjectFixtures (backend/src/swarm/domain.ts) upserts
// a subject row on every smoke session start. Before this fix, `name` and
// `recommendation_type` were clobbered on conflict — only `thesis_blurb` was
// protected. That clobber is reachable against a real deployment (not just a
// scratch database): DEMO_SUBJECTS reuses the live portfolio's own id ("woon"),
// and the simulation initializer (scripts/lib/swarm/session.ts) calls this
// same admin action for it before every smoke session. The regression: every
// live subject — including robotmoney-vault and robotmoney-allocation, whose
// manifests declare bucket_weights — got silently rewritten to
// recommendation_type = 'position_actions', which is why the vault stopped
// showing a recommended allocation.
//
// A fixture seeder should fill an empty row, never restate an existing one:
// this file asserts the fix (COALESCE on name and recommendation_type, same
// treatment thesis_blurb already got) and pins the fill-when-empty case so it
// can't regress back into "always overwrite".
import { expect, test } from "bun:test";
import * as ic from "../src/swarm/domain.ts";
import { sql } from "../src/db/client.ts";
import { useCleanDatabase } from "./support/clean-db.ts";

useCleanDatabase(import.meta.file);

const rid = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;

async function subjectRow(id: string) {
  const rows = await sql<{ name: string; recommendation_type: string; thesis_blurb: string | null }[]>`
    SELECT name, recommendation_type, thesis_blurb FROM swarm_subjects WHERE id = ${id}`;
  return rows[0];
}

test("ensureSmokeSubjectFixtures never overwrites a live subject's name or recommendation_type", async () => {
  const id = rid("subj");
  // A real subject a human has already set up, exactly like robotmoney-vault:
  // a curated name, an editorial thesis, and recommendation_type = 'bucket_weights'.
  await sql`INSERT INTO swarm_subjects (id, status, name, thesis_blurb, recommendation_type)
            VALUES (${id}, 'active', 'RobotMoney Vault', 'Curated editorial thesis.', 'bucket_weights')`;

  // The simulation path calls this with its own smoke-fixture name and always
  // seeds recommendation_type = 'position_actions' internally.
  await ic.ensureSmokeSubjectFixtures(id, "Smoke Fixture Name", "2026-01-01");

  const row = await subjectRow(id);
  expect(row.name).toBe("RobotMoney Vault");
  expect(row.recommendation_type).toBe("bucket_weights");
  expect(row.thesis_blurb).toBe("Curated editorial thesis.");
});

test("ensureSmokeSubjectFixtures fills name, thesis_blurb, and recommendation_type for a subject that doesn't exist yet", async () => {
  const id = rid("subj");
  const result = await ic.ensureSmokeSubjectFixtures(id, "Fresh Fixture", "2026-01-01");
  expect(result.subjectId).toBe(id);

  const row = await subjectRow(id);
  expect(row.name).toBe("Fresh Fixture");
  expect(row.recommendation_type).toBe("position_actions");
  expect(row.thesis_blurb).not.toBeNull();
});

test("ensureSmokeSubjectFixtures fills a field left empty by a prior insert, without touching the fields already set", async () => {
  const id = rid("subj");
  // A row seeded with a name and recommendation type but no thesis yet (the
  // "not there yet" case this fixture seeder exists to serve for that one
  // field) — mirrors ensureSubject()'s bare insert.
  await sql`INSERT INTO swarm_subjects (id, status, name, recommendation_type)
            VALUES (${id}, 'active', 'Curated Name', 'bucket_weights')`;

  await ic.ensureSmokeSubjectFixtures(id, "Smoke Fixture Name", "2026-01-01");

  const row = await subjectRow(id);
  expect(row.name).toBe("Curated Name");
  expect(row.recommendation_type).toBe("bucket_weights");
  expect(row.thesis_blurb).not.toBeNull();
});
